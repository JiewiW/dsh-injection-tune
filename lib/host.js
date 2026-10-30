/**
 * lib/host.js —— dsh-injection-tune 的 host 半边插件。
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
 *
 * 配置热更新：所有 Config 字段标了 .volatile()，运行时传入的 config 是 volatile
 * 引用对象，每个字段用 .get() 读实时值。因此 listener 注册后，用户在设置页
 * 改开关会立即生效（下一轮会话就按新值判断），无需重挂插件。
 */

import { Config } from './config.js';
import { dedupeWithinMessage } from './features/dedupe-runtime-context.js';
import { toIncrementalCatalog } from './features/incremental-skill-catalog.js';
import { deferSections } from './features/deferred-agent-instructions.js';
import { createToolGate } from './tool-gate.js';

/** 工具可见性门的设置路由（与 step-governor 同构：kind:"exact" + GET/POST）。 */
const TOOL_GATE_ROUTE = '/plugins/injection-tune/tool-gate';

/** 写回 JSON 响应。 */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** 读完整个请求体并解析 JSON；空体当空对象。 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (body.trim().length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

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

/** 安全读取 volatile 引用值——不是引用对象本身就原样返回（测试/直接调用场景兜底）。 */
function getBool(field, fallback = false) {
  if (typeof field?.get === 'function') {
    const value = field.get();
    return typeof value === 'boolean' ? value : fallback;
  }
  return typeof field === 'boolean' ? field : fallback;
}

/**
 * 插件入口：注册 pre-step 改写 listener。
 *
 * listener 始终注册（不再因 all-off 提前 dispose），因为 volatile 配置允许
 * 用户在设置页热启功能；提前 dispose 会导致热启后无法生效。
 *
 * @param {object} ctx Cordis 插件上下文。
 * @param {object} pluginConfig Loader 提供的配置（volatile 引用对象）。
 * @returns {() => void} dispose 函数。
 */
function apply(ctx, pluginConfig) {
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

      // AI-1：runtime-context 内部去重
      if (getBool(pluginConfig.dedupeRuntimeContext)) {
        const target = messages.find((message) => message.source?.kind === 'runtime-context');
        const text = target && singleText(target);
        if (target && text) {
          try {
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
          } catch (error) {
            ctx.logger.warn(`dsh-injection-tune: AI-1 failed, skipped: %o`, error);
          }
        }
      }

      // AI-2：技能目录增量改写
      if (getBool(pluginConfig.incrementalSkillCatalog)) {
        const target = messages.find((message) => message.source?.kind === 'skill-catalog');
        const text = target && singleText(target);
        if (target && text) {
          const entries = Array.isArray(target.source?.entries) ? target.source.entries : null;
          const agentKey = payload?.agent?.id ?? 'unknown-agent';
          const previous = previousEntriesByAgent.get(agentKey) ?? null;
          if (entries !== null) previousEntriesByAgent.set(agentKey, entries);
          try {
            const rewritten = toIncrementalCatalog(text, previous, entries, {
              keepDescription: getBool(pluginConfig.skillCatalogKeepDescription, true),
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
          } catch (error) {
            ctx.logger.warn(`dsh-injection-tune: AI-2 failed, skipped: %o`, error);
          }
        }
      }

      // AI-3：项目指令延迟注入
      if (getBool(pluginConfig.deferredAgentInstructions)) {
        const target = messages.find((message) => message.source?.kind === 'agent-instructions');
        const text = target && singleText(target);
        if (target && text) {
          try {
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
          } catch (error) {
            ctx.logger.warn(`dsh-injection-tune: AI-3 failed, skipped: %o`, error);
          }
        }
      }

      if (notes.length > 0) ctx.logger.info(`dsh-injection-tune: ${notes.join('; ')}`);
      return { ...outcome, messages };
    },
    { prepend: true },
  );

  // ── AI-4：工具可见性门 ─────────────────────────────────────────────────
  // 门改的是**工具表**而不是注入消息，但省的是同一份预算，因此与三个注入特性
  // 共用一次加载。它需要三个服务：tools（读写工具表）、agents（逐会话装限制）、
  // webServer（设置页读写名单）。
  //
  // 为什么用 ctx.inject 而不是读 ctx.tools：本插件 `inject = []`，未声明的服务
  // 直接读会抛 "cannot get property without inject"，把整个插件打成未激活；
  // 而 `ctx.get` 查的是 isolate 映射，未声明时同样拿不到实例（实测返回 undefined）。
  // 用 ctx.inject 声明后，三个服务缺任一就只是**不初始化门**，本插件的三个
  // 注入精简特性照常工作 —— 这是必须保住的降级边界。
  ctx.inject(['tools', 'agents', 'webServer'], (gateCtx) => {
    let toolGate;
    try {
      toolGate = createToolGate(gateCtx, ctx.logger);
    } catch (error) {
      ctx.logger.warn('dsh-injection-tune: 工具可见性门初始化失败，已跳过：%o', error);
      return undefined;
    }

    let unregisterRoute = null;
    try {
      const registration = gateCtx.webServer.register({
        kind: 'exact',
        path: TOOL_GATE_ROUTE,
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              sendJson(res, 200, toolGate.snapshot());
              return;
            }
            if (req.method === 'POST') {
              const body = await readRequestBody(req);
              sendJson(res, 200, toolGate.update(body));
              return;
            }
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      });
      unregisterRoute = typeof registration === 'function' ? registration : null;
    } catch (error) {
      ctx.logger.warn('dsh-injection-tune: 工具门设置路由注册失败：%o', error);
    }

    return () => {
      try { unregisterRoute?.(); } catch { /* 路由已随宿主卸载 */ }
      try { toolGate.dispose(); } catch { /* 忽略 */ }
    };
  });

  return () => {
    previousEntriesByAgent.clear();
  };
}

const inject = [];
const name = 'dsh-injection-tune';

export { inject, name, Config, apply };
