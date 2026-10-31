/**
 * lib/host.js —— dsh-injection-tune 的 host 半边插件。
 *
 * 作用：两条并行的注入精简路径，共 6 个独立功能开关：
 *   A. system-prompt/assemble waterfall hook（初始系统提示词 + 动态 runtime-context）
 *      AI-4  ACP 规范劫持：过滤 billion-context 等压缩插件注册的 section
 *      AI-5  auto-memory runtime-context 过滤
 *   B. agent/pre-step waterfall 内改写每轮消息
 *      AI-1  runtime-context 内部去重（同条消息内折叠重复段）
 *      AI-2  技能目录增量改写
 *      AI-3  项目/全局指令延迟注入
 *      AI-6  session-kit 任务看板消息过滤
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
 *   AI-4  ACP section：billion-context 通过 systemPrompt.section({
 *         name:"billion-context", ... }) 注册初始系统提示词段落；
 *         dsh-system-prompt/lib/index.js:310-362 的 assemble() 返回最终合并结果
 *         前，会经历 system-prompt/assemble waterfall——hook 它就能过滤 section。
 *   AI-5  auto-memory runtime-context：通过 systemPrompt.context({
 *         name:"dsh:auto-memory-pre", ... }) 注册动态快照，assemble 时合并进
 *         contexts 数组 → 同样在 system-prompt/assemble waterfall 里过滤。
 *   AI-6  session-kit tasks：dsh-session-kit/lib/task.js 在 agent/pre-step 后
 *         自己 createUserMessage 追加到 decision.messages，
 *         source.kind === "dsh-session-kit-tasks"。
 *
 * 注册顺序：agent/pre-step 用 prepend:true 注册——**早于**上游的 AI-1/AI-2/AI-3
 * listener，所以 await next() 后拿到的是完整消息列表，包含 dsh-tool-skill
 * 和 dsh-agent-instructions 产出的注入。system-prompt/assemble hook 在
 * apply 内尽早注册（等 systemPrompt 服务就绪）。
 *
 * 降级策略：任何单个 feature 抛错都只记录并跳过该 feature，其余 feature 与
 * 上游决策照常生效（fail-open），绝不让插件成为单点故障。所有依赖服务
 * （systemPrompt）均为可选——拿不到就跳过对应 hook。
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
          // 诊断日志：运行时状态一览（只在首次、无 previous、entries 缺失等关键拐点输出）
          if (!previous || entries === null || entries.length === 0) {
            ctx.logger.info(
              `dsh-injection-tune AI-2 diag: agent=${agentKey}, hasPrev=${!!previous}, `
              + `entries=${entries === null ? 'null' : entries.length}, textLen=${text.length}`,
            );
          }
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
            } else if (previous && entries && entries.length > 0) {
              // 有 previous 但没省到字符——说明 entries 完全没变，输出的"无变更"说明
              // 反而比全量长。这种极罕见场景也打一下日志便于排查。
              ctx.logger.info(
                `dsh-injection-tune AI-2 diag: savedChars=0 despite previous `
                + `(${entries.length} entries unchanged); keeping full catalog`,
              );
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

      // AI-6：过滤 dsh-session-kit-tasks 任务看板消息
      if (getBool(pluginConfig.suppressSessionKitTasks)) {
        const originalCount = messages.length;
        const filtered = messages.filter((message) => {
          const kind = message.source?.kind;
          if (kind === 'dsh-session-kit-tasks') {
            notes.push(`AI-6 suppressed ${kind}`);
            return false;
          }
          return true;
        });
        if (filtered.length !== originalCount) {
          messages = filtered;
        }
      }

      if (notes.length > 0) ctx.logger.info(`dsh-injection-tune: ${notes.join('; ')}`);
      return { ...outcome, messages };
    },
    { prepend: true },
  );

  // ── AI-4 / AI-5：system-prompt/assemble waterfall hook ──────────────────
  // 这条 hook 在**初始系统提示词组装阶段**就过滤掉不该有的 section 和 context，
  // 不让它们出现在 pre-step 的 messages 里。跟 AI-1~AI-6 那条 agent/pre-step 并行。
  //
  // 为什么用 system-prompt/assemble 而不是 agent/pre-step：
  //   · AI-4 ACP section 是 systemPrompt.section() 注册的，在初始系统提示词里，
  //     根本不会出现在 agent/pre-step 的 messages 数组里——pre-step 拿到的只是
  //     组装好的 messages，初始 system prompt 本身是另外一条路径组装的。
  //   · AI-5 auto-memory runtime-context 虽然最终变成了 agent/pre-step 的 messages
  //     里的一条 runtime-context 消息，但拦截更上游（assemble 阶段）更干净。
  //
  // 降级策略：systemPrompt 服务可能还没注册（启动顺序依赖）——直接监听事件，
  // 如果 systemPrompt 没启动这条 hook 永远不会被调用，就是个 no-op。
  //
  // 注：这里不用 ctx.inject(['systemPrompt']) —— inject 会让插件强依赖
  // systemPrompt，拿不到就整个插件不加载。但 systemPrompt 应该总是存在的，
  // 用 inject 也没问题。不过为了保持 fail-open 姿态，直接 ctx.on 更安全。
  const systemPromptHook = ctx.on(
    'system-prompt/assemble',
    async (assembly, _context, next) => {
      if (!assembly || typeof assembly !== 'object') return next();
      try {
        // AI-4：过滤 billion-context 等压缩插件注册的 section
        if (getBool(pluginConfig.suppressACPSection)) {
          const originalSections = assembly.sections;
          if (Array.isArray(originalSections)) {
            const filtered = originalSections.filter((section) => {
              const name = section?.name ?? '';
              if (name === 'billion-context') {
                ctx.logger.info(`dsh-injection-tune AI-4: suppressing section "${name}"`);
                return false;
              }
              return true;
            });
            if (filtered.length !== originalSections.length) {
              // 关键：必须直接 mutate assembly.sections（JS 函数参数是按值传递引用，
              // 这里只有改属性才能让后续 listener 看到修改）
              assembly.sections = filtered;
            }
          }
        }

        // AI-5：过滤 auto-memory 注册的 runtime-context
        if (getBool(pluginConfig.suppressAutoMemoryRuntimeContext)) {
          const originalContexts = assembly.contexts;
          if (Array.isArray(originalContexts)) {
            const filtered = originalContexts.filter((entry) => {
              const name = entry?.name ?? '';
              if (name.includes('auto-memory')) {
                ctx.logger.info(`dsh-injection-tune AI-5: suppressing context "${name}"`);
                return false;
              }
              return true;
            });
            if (filtered.length !== originalContexts.length) {
              assembly.contexts = filtered;
            }
          }
        }
      } catch (error) {
        ctx.logger.warn(`dsh-injection-tune: system-prompt/assemble hook failed, skipped: %o`, error);
      }
      // 让 waterfall 链条继续——我们对 assembly 的属性修改已经传递到调用方了
      return next();
    },
  );

  // ── 工具可见性门（下方的 ctx.inject 区块） ───────────────────────────
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
              // 预览是按需现算的轻查询：不落盘、不返回全量快照。
              if (body && typeof body.preview === 'string') {
                sendJson(res, 200, toolGate.preview(body.preview));
                return;
              }
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
    try { systemPromptHook?.(); } catch { /* hook 已随宿主卸载 */ }
  };
}

const inject = [];
const name = 'dsh-injection-tune';

export { inject, name, Config, apply };
