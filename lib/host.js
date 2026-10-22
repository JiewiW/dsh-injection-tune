/**
 * lib/host.js —— dsh-injection-tune 的 host 半边插件（CommonJS，Loader 直接加载）。
 *
 * 作用：在 `agent/pre-step` 瀑布里按开关改写三类注入消息，削减上下文冗余。
 *
 * 上游契约（均已逐行核对行号，勿跨版本复用）：
 *   AI-1  runtime-context 快照：dsh-agent-loop/lib/index.js:1020-1024
 *         systemPrompt.assemble → renderContextSections → runtimeContext.project()
 *         → dispatch.waterfall("agent/pre-step", ..., () => ({kind:"enter",
 *         messages: context === void 0 ? claimed : [...claimed, context]}))
 *         runtime-context 消息由 :428-443 的 RuntimeContextProjection.project()
 *         生成，source.kind === "runtime-context"。
 *   AI-2  技能目录：dsh-tool-skill/lib/index.js:203-236 在 agent/pre-step 内做
 *         消息级整体替换，source.kind === "skill-catalog"，source.entries 为
 *         {name, description}[]；:226 用 digestCatalogEntries(existing.entries)
 *         比对，**必须保留 source** 否则每轮重发完整目录。
 *   AI-3  项目/全局指令：dsh-agent-instructions/lib/index.js:1271-1289 在
 *         agent/pre-step 内 insert 到 claimed 之后，source.kind ===
 *         "agent-instructions"，正文为 <system-reminder> 包裹的 baseline。
 *
 * 注册顺序：本插件的 listener 用 prepend: true 注册，**早于**上述三个上游
 * listener，因此在本 listener 内先 await next() 拿到它们的决策结果，再改写
 * decision.messages 后返回。改写一律返回全新消息对象（上游消息已 deepFreeze）。
 *
 * 降级策略：任何单个 feature 抛错都只记录并跳过该 feature，其余 feature 与
 * 上游决策照常生效（fail-open），绝不让插件成为单点故障。
 */

import { Config } from './config.js';
import { resolveConfig, isAnyEnabled } from './config.js';
import { dedupeWithinMessage } from './features/dedupe-runtime-context.js';
import { toIncrementalCatalog } from './features/incremental-skill-catalog.js';
import { deferSections } from './features/deferred-agent-instructions.js';

/** 单条消息的 content[0] 文本；非单 text block 返回 undefined。 */
function singleText(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks) || blocks.length !== 1) return undefined;
  const block = blocks[0];
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
}

/**
 * 用新文本替换消息 content[0]，保留其余 content block 与 source。
 *
 * @param {object} message 上游消息（已冻结）。
 * @param {string} text 新文本。
 * @returns {object} 新消息对象。
 */
function withText(message, text) {
  return {
    ...message,
    content: message.content.map((block, index) => (index === 0 ? { ...block, text } : block)),
  };
}

/**
 * 定位目标消息在列表中的下标。
 *
 * 用引用相等而非 id 相等：session surface 投影出来的消息 id 可能为 null，
 * 按 id 比较会误改写所有 id 为 null 的消息。
 *
 * @param {object[]} messages 消息列表。
 * @param {object|undefined} target 目标消息。
 * @returns {number} 下标；未找到返回 -1。
 */
function indexOfMessage(messages, target) {
  if (target === undefined) return -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index] === target) return index;
  }
  return -1;
}

/**
 * 应用单个 feature 到消息列表；失败时返回原列表并记录原因。
 *
 * @param {string} name feature 名（用于日志）。
 * @param {Function} transform 改写函数 (messages) => { messages, note }。
 * @param {object[]} messages 当前消息列表。
 * @param {object} ctx 插件 ctx（打日志用）。
 * @returns {{ messages: object[], note?: string }} 改写结果。
 */
function applyFeature(name, transform, messages, ctx) {
  try {
    const result = transform(messages);
    if (result && result.note) ctx.logger.info(`dsh-injection-tune: ${result.note}`);
    return result?.messages ?? messages;
  } catch (error) {
    ctx.logger.warn(`dsh-injection-tune: ${name} failed, skipped: %o`, error);
    return messages;
  }
}

/**
 * 插件入口：注册 pre-step 改写 listener。
 *
 * @param {object} ctx Cordis 插件上下文。
 * @param {object} pluginConfig Loader 提供的配置（已按 Config 解析）。
 * @returns {() => void} dispose 函数。
 */
function apply(ctx, pluginConfig) {
  const config = resolveConfig(pluginConfig);
  if (!isAnyEnabled(config)) {
    ctx.logger.info('dsh-injection-tune: all features off, plugin idle');
    return () => {};
  }

  /**
   * 每个会话各自维护的「上一轮技能目录条目」，用于 AI-2 增量渲染。
   * 键为 agent.id（内核保证 agent.id === agent.session.id），避免多会话并发时
   * 互相把对方的目录当成「上一轮」而产出错误的增量内容。
   *
   * @type {Map<string, Array<{name: string, description: string}>>}
   */
  const previousEntriesByAgent = new Map();

  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const outcome = await next();
      if (!outcome || outcome.kind === 'reject' || !Array.isArray(outcome.messages)) return outcome;
      let messages = outcome.messages;
      const notes = [];

      if (config.dedupeRuntimeContext === true) {
        const target = messages.find((message) => message.source?.kind === 'runtime-context');
        const text = target && singleText(target);
        if (target && text) {
          const folded = dedupeWithinMessage(text);
          if (folded.foldedBlocks > 0) {
            const index = indexOfMessage(messages, target);
            if (index >= 0) {
              messages = messages.map((message, position) =>
                position === index ? withText(message, folded.text) : message,
              );
              notes.push(`AI-1 folded ${folded.foldedBlocks} block(s), ${folded.foldedChars} chars`);
            }
          }
        }
      }

      if (config.incrementalSkillCatalog === true) {
        const target = messages.find((message) => message.source?.kind === 'skill-catalog');
        const text = target && singleText(target);
        if (target && text) {
          const entries = Array.isArray(target.source?.entries) ? target.source.entries : null;
          const agentKey = payload?.agent?.id ?? 'unknown-agent';
          const previous = previousEntriesByAgent.get(agentKey) ?? null;
          if (entries !== null) previousEntriesByAgent.set(agentKey, entries);
          const rewritten = toIncrementalCatalog(text, previous, entries, {
            keepDescription: config.skillCatalogKeepDescription,
          });
          if (rewritten.savedChars > 0) {
            const index = indexOfMessage(messages, target);
            if (index >= 0) {
              messages = messages.map((message, position) =>
                position === index ? withText(message, rewritten.text) : message,
              );
              notes.push(`AI-2 incremental catalog saved ${rewritten.savedChars} chars`);
            }
          }
        }
      }

      if (config.deferredAgentInstructions === true) {
        const target = messages.find((message) => message.source?.kind === 'agent-instructions');
        const text = target && singleText(target);
        if (target && text) {
          const deferred = deferSections(text);
          if (deferred.deferredSections > 0) {
            const index = indexOfMessage(messages, target);
            if (index >= 0) {
              messages = messages.map((message, position) =>
                position === index ? withText(message, deferred.text) : message,
              );
              notes.push(
                `AI-3 deferred ${deferred.deferredSections} section(s), ${deferred.savedChars} chars`,
              );
            }
          }
        }
      }

      if (notes.length > 0) ctx.logger.info(`dsh-injection-tune: ${notes.join('; ')}`);
      return { ...outcome, messages };
    },
    { prepend: true },
  );

  return () => {
    previousEntriesByAgent.clear();
  };
}

const inject = [];
const name = 'dsh-injection-tune';

export { inject, name, Config, apply };
