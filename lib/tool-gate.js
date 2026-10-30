/**
 * lib/tool-gate.js —— 「工具可见性门」：按工具逐条停用，让它整份 schema 不进请求。
 *
 * 与 AI-1~AI-3 的区别在于省钱的量级：那三个改的是注入正文（每请求约 2k 字符），
 * 这里改的是工具表本身 —— 108 条 schema 合计约 90k 字符（≈31k token），**每个请求
 * 都随提示词重发一次**。停用一条就少一条，且不占缓存前缀的便宜。
 *
 * 上游契约（0.2.0-rc.2 实测，勿跨版本复用）：
 *   · `tools.restrict({deny})` **要求 agent 作用域**，插件级 ctx 调用直接抛
 *     "requires a scoped context"。因此本模块对每个 agent 各自装一层限制。
 *   · `restrict()` 对**未知工具名**直接抛错，所以下发前必须与
 *     `view(agent).restrictableNames` 取交集（工具可能被插件卸载或改名）。
 *   · 限制是**叠加**的（`dsh-scope` 的 AnonymousEntries 以 Symbol 键 append、
 *     admits() 遍历取 AND），所以本插件与 tool-management 之类共存不会互相覆盖。
 *   · 限制只作用于**继承来的**工具（全局层与祖先层），agent 自己注册的工具不受
 *     影响 —— 这正是"不能把子代理应答机制一起摘掉"所需要的语义。
 *   · 每个 agent 一条有效限制：名单变化时必须先撤旧层再装新层，否则越叠越多。
 *
 * 注册来源（UI 的分框依据）三层解析，优先级从高到低，判定依据随条目一起回传，
 * 便于界面上如实标注"这条归属是怎么来的"：
 *   1. capture —— 运行时包裹 `tools.register`，取 `this.ctx.fiber.name`（Cordis 的
 *      fiber 名称会向上继承到最近一个有名字的祖先，即插件名）。只有在本插件加载
 *      **之后**注册的工具才抓得到；
 *   2. learned —— 上一条抓到的结果落盘，跨重启复用；
 *   3. table/prefix —— 内置对照表，仅收录已按注册调用点核过的包；
 *   4. none —— 都不命中，归入「未识别来源」，仍可正常停用。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 侧车目录：与本插件其它状态放在一起，便于整体备份/回滚。 */
function stateFilePath() {
  return path.join(os.homedir(), '.dsh', 'injection-tune', 'tool-gate.json');
}

/** 归属学习结果（跨重启复用）。 */
function sourcesFilePath() {
  return path.join(os.homedir(), '.dsh', 'injection-tune', 'tool-sources.json');
}

/** 出厂状态：门关着、空名单（= 行为与未安装本特性完全一致）。 */
const DEFAULT_STATE = { version: 1, enabled: false, deny: [], updatedAt: null };

/**
 * 内置「工具名 → 注册它的包」对照表。
 *
 * 只收已核对过注册调用点的条目（例如 `@deepseek-ai/dsh-tool-fs/lib/index.js`
 * 里 `ctx.tools.register(defineTool({ name: "read" …`）。**名字由代码拼接出来的
 * 工具（如 `browser_*`、`task_board_*`、`acp_*`、子代理一族）不写在这里** ——
 * 它们靠运行时捕获，写死会造出错误的归属。
 */
const TOOL_SOURCE_TABLE = Object.freeze({
  read: '@deepseek-ai/dsh-tool-fs',
  write: '@deepseek-ai/dsh-tool-fs',
  edit: '@deepseek-ai/dsh-tool-fs',
  read_image: '@deepseek-ai/dsh-tool-fs',
  glob: '@deepseek-ai/dsh-tool-fs-search',
  grep: '@deepseek-ai/dsh-tool-fs-search',
  pwsh: '@deepseek-ai/dsh-tool-pwsh',
  present: '@deepseek-ai/dsh-tool-present',
  web_fetch: '@deepseek-ai/dsh-tool-web',
  web_search: '@deepseek-ai/dsh-tool-web',
  ask_user_question: '@deepseek-ai/dsh-tool-ask-user',
  todo_write: '@deepseek-ai/dsh-tool-todo',
  get_goal: '@deepseek-ai/dsh-tool-goal',
  update_goal: '@deepseek-ai/dsh-tool-goal',
  job_list: '@deepseek-ai/dsh-tool-jobs',
  job_output: '@deepseek-ai/dsh-tool-jobs',
  job_kill: '@deepseek-ai/dsh-tool-jobs',
  skill: '@deepseek-ai/dsh-tool-skill',
  exit_plan_mode: '@deepseek-ai/dsh-plan-mode',
  // billion-context 的三个上下文压块工具：名字不带 acp_ 前缀，前缀表兜不住，
  // 已按 `dist/index.js` 的 `COMPRESS_TOOL_NAME` 与工具注册处核对。
  compress: 'billion-context-dsh',
  decompress: 'billion-context-dsh',
  search_context: 'billion-context-dsh',
});

/**
 * 前缀对照表：仅用于「运行时没抓到」时的兜底，且只收录单值、无歧义的前缀
 * （`browser_*` 只可能来自内置浏览器；`task_board_*` 只可能来自 fusion-board）。
 */
const PREFIX_SOURCE_TABLE = Object.freeze([
  // 内置浏览器注册的名字带 `dsh_browser_` 前缀（模型侧呈现时才去掉 dsh_），
  // 长前缀必须排在短前缀前面，否则会被 `browser_` 规则先吃掉（这里顺序有意义）。
  ['dsh_browser_', 'dsh-builtin-browser'],
  ['browser_', 'dsh-builtin-browser'],
  ['task_board_', 'dsh-fusion-board'],
  ['memory_', '@a9i5k4/dsh-auto-memory'],
  ['calendar_', '@a9i5k4/dsh-auto-memory'],
  ['acp_', 'billion-context-dsh'],
]);

/**
 * 核心工具：停用后 agent 会明显变瘸，界面上标一个「核心」徽章，
 * 但不阻断 —— 用户要的就是完全控制权，这里只负责说清楚代价。
 */
const CRITICAL_TOOLS = Object.freeze(new Set([
  'read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'present', 'ask_user_question',
]));

/** 运行时捕获用的原型标记：同一进程内多个实例（HMR/多 profile）共用一张表。 */
const WRAP_MARK = Symbol.for('dsh-injection-tune.tool-register-wrap');

/**
 * 摘要长度硬上限：仅用于挡住异常体量的描述（整篇文档级说明），正常工具描述
 * 一律完整下发给界面。界面侧会自动换行，不再做省略号截断。
 */
const SUMMARY_HARD_LIMIT = 2000;

/**
 * 描述正文 → 功能说明：去掉 Markdown 记号后**完整**返回（压成单段纯文本）。
 *
 * 早先这里按 58 字符截断并补省略号，界面上一行放不下就看不见后半句，
 * 而摘要正是"要不要隐藏这个工具"的唯一判据，截断等于让人盲选。
 * 现在只保留 Markdown 清洗，换行交给界面（CSS 自动换行 + 断词）。
 */
function summarizeDescription(description) {
  if (typeof description !== 'string') return '';
  const flat = description
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= SUMMARY_HARD_LIMIT) return flat;
  return `${flat.slice(0, SUMMARY_HARD_LIMIT - 1)}…`;
}

/** 与宿主同一把尺子（`ceil(字符数 / 4) + 4`）粗略折算 token，仅供界面比较用。 */
function estimateTokens(chars) {
  return chars > 0 ? Math.ceil(chars / 4) + 4 : 0;
}

/** 读 JSON 文件，任何异常都退回默认值（fail-safe：读不出来就当没配过）。 */
function readJsonFile(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** 原子写 JSON：先写临时文件再 rename，避免半截文件把下一次读取带崩。 */
function writeJsonFile(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/** 状态归一：只保留布尔开关与去重后的非空字符串名单。 */
function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const deny = Array.isArray(source.deny)
    ? [...new Set(source.deny.filter((name) => typeof name === 'string' && name.length > 0))]
    : [];
  return {
    version: 1,
    enabled: source.enabled === true,
    deny,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  };
}

/**
 * 从调用栈推断注册来源的**包名**。
 *
 * 比 fiber 名可靠：bundle 化之后，有些插件的 fiber 名是模块导出函数名
 * （实测 session-kit 半边报的是 `Include`），而调用栈里一定带着真实文件路径
 * `…/node_modules/<包名>/lib/…`。取第一个在 node_modules 下、且不是 dsh-tools
 * 自己的栈帧。
 *
 * @returns {string|null} 包名（含 scope），推断不出返回 null。
 */
function sourceFromStack() {
  // 这些包是"中间人"：工具注册调用常常发生在它们的回调/包装里，取到它们
  // 只会把归属记成框架名，所以要继续往深处找真正的调用方。
  const FRAMEWORK = new Set(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery']);
  try {
    const stack = new Error().stack;
    if (typeof stack !== 'string') return null;
    for (const line of stack.split('\n')) {
      if (!line.includes('node_modules')) continue;
      if (line.includes('dsh-injection-tune')) continue;
      // pnpm 布局的路径形如 `.pnpm/<pkg>@<ver>/node_modules/<pkg>/lib/…`，
      // 第一段 node_modules 后面跟的是 `.pnpm`，真正的包在**最后**一段，
      // 所以取所有匹配里的最后一个。
      const segments = [...line.replace(/\\/g, '/').matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)(?=\/)/g)];
      const last = segments[segments.length - 1];
      if (!last || last[1] === '.pnpm' || FRAMEWORK.has(last[1])) continue;
      return last[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 从上下文取注册来源（插件名）—— 调用栈推断失败时的兜底。
 *
 * 取**最外层**有名字的 fiber：Cordis 的 `fiber.name` 只向上找到最近一个有名字的
 * 祖先，插件内部再 `ctx.plugin(...)` 注册子插件时拿到的是子插件名（实测
 * auto-memory 半边叫 `auto-memory-pre`、内置浏览器半边叫 `tool-browser`），
 * 按来源分框要的是包级名字，所以一路走到根，取最外层那个。
 *
 * `Loader` / `Include` 这类不算名字：它们是加载器/模块导出名，不是"来源"，
 * 遇到就退到就近的子插件名，实在没有就返回 null。
 */
function sourceOfContext(context) {
  const IGNORED = new Set(['root', 'Loader', 'Include', 'Plugin', 'default']);
  try {
    let fiber = context?.fiber;
    if (fiber === undefined || fiber === null) return null;
    let found = null;
    let nearest = null;
    for (let depth = 0; depth < 32 && fiber; depth += 1) {
      const raw = fiber.runtime?.name;
      if (typeof raw === 'string') {
        const name = raw.trim();
        if (name.length > 0 && !IGNORED.has(name)) {
          found = name;
          if (nearest === null) nearest = name;
        }
      }
      const parent = fiber.parent?.fiber;
      if (parent === undefined || parent === null || parent === fiber) break;
      fiber = parent;
    }
    return found ?? nearest;
  } catch {
    return null;
  }
}

/**
 * 包裹 `tools.register`，把「工具名 → 注册它的插件」记下来。
 *
 * 只包裹原型一次（进程级共享表），本插件卸载时不还原 —— 还原会把后加载插件的
 * 捕获一起切断，而这里只是读多写一，留着无害。捕获失败一律静默：这是界面
 * 归属信息，不能因为拿不到就让工具注册失败。
 *
 * @param {object} toolsService 任意一个 tools 服务实例（用它的原型）。
 * @param {(name: string, source: string) => void} onCapture 捕获回调。
 * @returns {() => void} 摘掉本回调的清理函数。
 */
function instrumentRegistry(toolsService, onCapture) {
  const prototype = Object.getPrototypeOf(toolsService);
  if (prototype === null || typeof prototype.register !== 'function') return () => {};
  if (prototype[WRAP_MARK] === undefined) {
    const listeners = new Set();
    const original = prototype.register;
    prototype.register = function patchedRegister(definition) {
      try {
        const name = definition?.name;
        const source = sourceFromStack() ?? sourceOfContext(this?.ctx);
        if (typeof name === 'string' && source !== null) {
          for (const listener of listeners) {
            try { listener(name, source); } catch { /* 归属信息失败不影响注册 */ }
          }
        }
      } catch { /* 同上 */ }
      return original.apply(this, arguments);
    };
    Object.defineProperty(prototype, WRAP_MARK, { value: listeners, enumerable: false });
  }
  const listeners = prototype[WRAP_MARK];
  listeners.add(onCapture);
  return () => { listeners.delete(onCapture); };
}

/**
 * 创建工具可见性门。
 *
 * @param {object} scope 已注入 `tools` / `agents` 的 Cordis 上下文（`ctx.inject` 回调参数）。
 * @param {object} [logger] 日志器（缺省用 scope.logger）。
 * @returns {{snapshot: Function, update: Function, refresh: Function, dispose: Function}} 控制器。
 */
function createToolGate(scope, logger) {
  // 服务必须来自**已声明注入**的上下文：未声明时 `ctx.get` 查的是 isolate 映射，
  // 拿不到实例，`ctx.tools` 更是直接抛 "cannot get property without inject"。
  const ctx = scope;
  const toolsService = typeof scope?.tools?.view === 'function' ? scope.tools : null;
  const log = logger ?? scope?.logger ?? { info() {}, warn() {} };
  if (toolsService === null) {
    // 没有工具服务：门不成立，返回一个只读空壳，让界面如实显示"读不到工具表"。
    const emptySnapshot = () => ({
      ok: false,
      error: 'host exposes no tools service',
      enabled: false,
      deny: [],
      updatedAt: null,
      groups: [],
      agents: 0,
      totals: { count: 0, deniedCount: 0, chars: 0, tokens: 0, deniedTokens: 0 },
    });
    return { snapshot: emptySnapshot, update: emptySnapshot, refresh: emptySnapshot, dispose: () => {} };
  }

  /** 当前生效状态（内存权威，落盘只是持久化）。 */
  let state = normalizeState(readJsonFile(stateFilePath(), DEFAULT_STATE));
  /** 运行时捕获到的归属（本次进程）。 */
  const captured = new Map();
  /** 上一次抓到的归属（跨重启），仅在没有新捕获时使用。 */
  const learned = new Map(
    Object.entries(readJsonFile(sourcesFilePath(), {})).filter(
      ([name, source]) => typeof name === 'string' && typeof source === 'string',
    ),
  );
  /** agent → 撤掉本插件那层限制的 disposer。 */
  const appliedByAgent = new Map();
  /** agent → 已应用的名单键（相同则跳过，避免自激式重装）。 */
  const appliedKeyByAgent = new Map();
  /** 归属表落盘节流。 */
  let persistTimer = null;
  /** 工具表变化后的重放节流。 */
  let refreshTimer = null;
  /** 当前开启时应当被拒绝执行的工具名（执行侧兜底，见下面的 guard）。 */
  let deniedNow = new Set(state.enabled ? state.deny : []);

  function schedulePersistSources() {
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const merged = { ...Object.fromEntries(learned) };
      for (const [name, source] of captured) merged[name] = source;
      writeJsonFile(sourcesFilePath(), merged);
    }, 1500);
    persistTimer.unref?.();
  }

  const detach = instrumentRegistry(toolsService, (name, source) => {
    if (captured.get(name) === source) return;
    captured.set(name, source);
    schedulePersistSources();
    // 新归属可能改变分框，通知界面数据已过期；节流后重放限制。
    scheduleRefresh();
  });

  /** 当前所有 agent（拿不到就当成空列表：不影响设置读写）。 */
  function listAgents() {
    try {
      const agents = scope.agents;
      if (agents && typeof agents.list === 'function') return agents.list();
    } catch { /* 忽略 */ }
    return [];
  }

  /** 解析一条工具的注册来源。 */
  function resolveSource(name) {
    if (captured.has(name)) return { source: captured.get(name), reason: 'capture' };
    if (learned.has(name)) return { source: learned.get(name), reason: 'learned' };
    if (Object.prototype.hasOwnProperty.call(TOOL_SOURCE_TABLE, name)) {
      return { source: TOOL_SOURCE_TABLE[name], reason: 'table' };
    }
    for (const [prefix, source] of PREFIX_SOURCE_TABLE) {
      if (name.startsWith(prefix)) return { source, reason: 'prefix' };
    }
    return { source: null, reason: 'none' };
  }

  /**
   * 汇总一份工具清单：跨所有 agent 作用域并集，保留最完整的定义。
   * 全局视图取不到的工具（由 agent 预设注册的）只能从各 agent 的视图里补。
   */
  function collectTools() {
    const byName = new Map();
    const scopes = [undefined, ...listAgents().map((agent) => agent)];

    for (const scope of scopes) {
      let definitions;
      try {
        const view = scope === undefined ? toolsService.view() : toolsService.view(scope);
        definitions = view?.visible;
      } catch {
        continue;
      }
      if (!definitions || typeof definitions.forEach !== 'function') continue;
      definitions.forEach((definition, name) => {
        if (typeof name !== 'string') return;
        if (byName.has(name)) return;
        const chars = (() => {
          try {
            return JSON.stringify({
              name: definition.name ?? name,
              description: definition.description ?? '',
              parameters: definition.parameters ?? {},
            }).length;
          } catch {
            return 0;
          }
        })();
        byName.set(name, {
          name,
          summary: summarizeDescription(definition?.description),
          chars,
          tokens: estimateTokens(chars),
          critical: CRITICAL_TOOLS.has(name),
        });
      });
    }
    return byName;
  }

  /** 组装给界面用的快照：工具按注册来源分框，框内按体积降序。 */
  function snapshot() {
    const tools = collectTools();
    const denySet = new Set(state.deny);
    const groups = new Map();
    let totalChars = 0;
    let deniedChars = 0;
    let deniedCount = 0;

    for (const tool of tools.values()) {
      const { source, reason } = resolveSource(tool.name);
      const key = source ?? '\u0000unknown';
      if (!groups.has(key)) {
        groups.set(key, {
          source,
          label: source ?? '未识别来源',
          reason,
          tools: [],
          tokens: 0,
          chars: 0,
          deniedCount: 0,
        });
      }
      const group = groups.get(key);
      const denied = denySet.has(tool.name);
      group.tools.push({ ...tool, denied });
      group.tokens += tool.tokens;
      group.chars += tool.chars;
      if (denied) {
        group.deniedCount += 1;
        deniedChars += tool.chars;
        deniedCount += 1;
      }
      totalChars += tool.chars;
    }

    const ordered = [...groups.values()]
      .map((group) => ({ ...group, tools: group.tools.sort((a, b) => b.tokens - a.tokens) }))
      .sort((a, b) => {
        if (a.source === null) return 1;
        if (b.source === null) return -1;
        return b.tokens - a.tokens;
      });

    return {
      ok: true,
      enabled: state.enabled,
      deny: state.deny,
      updatedAt: state.updatedAt,
      groups: ordered,
      agents: listAgents().length,
      totals: {
        count: tools.size,
        deniedCount,
        chars: totalChars,
        tokens: estimateTokens(totalChars),
        deniedTokens: estimateTokens(deniedChars),
      },
    };
  }

  /** 把当前名单同步到每个 agent 作用域（先撤旧层，再按需装新层）。 */
  function applyRestrictions() {
    const agents = listAgents();
    const seen = new Set();
    for (const agent of agents) {
      seen.add(agent);
      let scoped;
      try {
        scoped = agent?.ctx?.tools;
      } catch {
        continue;
      }
      if (!scoped || typeof scoped.restrict !== 'function') continue;

      const wanted = state.enabled ? state.deny : [];
      let known;
      try {
        known = scoped.view(agent)?.restrictableNames;
      } catch {
        known = undefined;
      }
      const names = known instanceof Set ? wanted.filter((name) => known.has(name)) : wanted;
      const key = names.slice().sort().join('\u0000');
      if (appliedKeyByAgent.get(agent) === key) continue;

      const previous = appliedByAgent.get(agent);
      if (typeof previous === 'function') {
        appliedByAgent.delete(agent);
        appliedKeyByAgent.delete(agent);
        try { previous(); } catch { /* 已随 agent 销毁 */ }
      }
      if (names.length === 0) {
        appliedKeyByAgent.set(agent, key);
        continue;
      }
      try {
        const dispose = scoped.restrict({ deny: names });
        appliedByAgent.set(agent, typeof dispose === 'function' ? dispose : () => {});
        appliedKeyByAgent.set(agent, key);
        log.info(`dsh-injection-tune: 工具门已对 agent ${agent.id ?? '?'} 隐藏 ${names.length} 个工具`);
      } catch (error) {
        log.warn(`dsh-injection-tune: 工具门在 agent ${agent.id ?? '?'} 上未生效：%o`, error);
      }
    }
    // agent 已下线：撤层并清账，避免持有已销毁对象。
    for (const [agent, dispose] of [...appliedByAgent]) {
      if (seen.has(agent)) continue;
      appliedByAgent.delete(agent);
      appliedKeyByAgent.delete(agent);
      try { dispose(); } catch { /* 忽略 */ }
    }
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      try { applyRestrictions(); } catch (error) { log.warn('dsh-injection-tune: 工具门重放失败 %o', error); }
    }, 250);
    refreshTimer.unref?.();
  }

  /** 落盘 + 立刻生效。 */
  function persist() {
    state = { ...state, updatedAt: new Date().toISOString() };
    deniedNow = new Set(state.enabled ? state.deny : []);
    writeJsonFile(stateFilePath(), state);
    applyRestrictions();
    return state;
  }

  /**
   * 处理界面提交：允许只带其中一个字段。
   *
   * @param {object} patch `{enabled?: boolean, deny?: string[], toggle?: {name, denied}}`
   * @returns {object} 应用后的完整快照。
   */
  function update(patch) {
    const source = patch && typeof patch === 'object' ? patch : {};
    if (typeof source.enabled === 'boolean') state = { ...state, enabled: source.enabled };
    if (Array.isArray(source.deny)) state = normalizeState({ ...state, deny: source.deny });
    if (source.toggle && typeof source.toggle === 'object') {
      const name = source.toggle.name;
      if (typeof name === 'string' && name.length > 0) {
        const denySet = new Set(state.deny);
        if (source.toggle.denied === true) denySet.add(name);
        else denySet.delete(name);
        state = normalizeState({ ...state, deny: [...denySet] });
      }
    }
    state = persist();
    return snapshot();
  }

  // agent 上线：立刻装当前名单；下线：撤层。
  scope.on('agent/created', () => { scheduleRefresh(); });
  scope.on('agent/disposed', () => { scheduleRefresh(); });
  // 工具表变化（插件装载/卸载可能会重新注册工具）：节流后重放。
  scope.on('tools/change', () => { scheduleRefresh(); });

  /**
   * 执行侧兜底：`restrict()` 只过滤**继承来的**工具，agent 自己那一层注册的工具
   * 摘不掉。那种情况下可见性半边做不到，但至少不能让人以为"停用了却还能跑"——
   * 由全局 guard 拒绝执行并说明去哪儿恢复。
   */
  const releaseGuard = typeof toolsService.guard === 'function'
    ? toolsService.guard((exec) => {
      const name = typeof exec?.name === 'string' ? exec.name : '';
      if (name.length === 0 || !deniedNow.has(name)) return undefined;
      return `工具 "${name}" 已在「注入调优 → 工具可见性门」中停用；需要时到该设置页取消勾选。`;
    })
    : () => {};

  // 插件加载时若已有会话在跑，也要把当前名单装上。
  scheduleRefresh();

  return {
    snapshot,
    update,
    refresh: () => { applyRestrictions(); return snapshot(); },
    dispose: () => {
      if (persistTimer !== null) clearTimeout(persistTimer);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      persistTimer = null;
      refreshTimer = null;
      detach();
      try { releaseGuard(); } catch { /* 忽略 */ }
      for (const dispose of appliedByAgent.values()) {
        try { dispose(); } catch { /* 忽略 */ }
      }
      appliedByAgent.clear();
      appliedKeyByAgent.clear();
    },
  };
}

export {
  createToolGate,
  summarizeDescription,
  estimateTokens,
  normalizeState,
  TOOL_SOURCE_TABLE,
  PREFIX_SOURCE_TABLE,
  CRITICAL_TOOLS,
  stateFilePath,
  sourcesFilePath,
};
