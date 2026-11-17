/**
 * lib/skill-gate.js —— 「技能可见性门」（AI-7）：按技能逐条停用目录注入。
 *
 * 与工具可见性门对偶：那边停用工具 schema，这边停用技能目录条目。技能目录
 * 由 dsh-tool-skill 在 agent/pre-step 里每轮重算，48 个条目约 15.9KB，每个
 * 请求都要跟着前缀重发一遍；隐藏一条就少一条，且不吃缓存前缀的便宜。
 *
 * 上游契约（0.2.0-rc.2 实测，勿跨版本复用）：
 *   · dsh-tool-skill/lib/index.js:203-236 用 `ctx.skills.snapshot({cwd, signal,
 *     scope: agent})` 取技能，`.filter(isModelInvocable)` 后映射成 entries，
 *     再用 `digestCatalogEntries(entries)` 与会话历史比较决定是否重发目录。
 *   · dsh-tool-skill/lib/index.js:145 的 `skill` 工具 execute 先用
 *     `ctx.skills.list(lookup)`（lookup 也带 `scope: exec.agent`）找名字，
 *     找不到就抛 "unknown or no longer available"。
 *   · dsh-skill/lib/index.js:224-240：`list()` 内部就是 `await this.snapshot()`，
 *     `get()` 走的是另一条 collect 路径，不受 snapshot 包装影响。
 *
 * 因此包装 `SkillRegistry.prototype.snapshot` 一处即可同时覆盖「目录注入」与
 * 「模型通过 skill 工具加载」两条路径，且**必须**在投影层过滤：
 *   · 上游 digest 基于过滤后的 skills 计算，历史里落盘的也是过滤后的 entries，
 *     两边一致 ⇒ 只在名单变化时重发一次目录，不会每轮抖动（改消息文本而不改
 *     entries 会让 digest 永远不等，等于每轮重发）。
 *   · 只过滤带 `scope` 的查询：模型目录与 skill 工具都带 agent scope，设置页 /
 *     技能管理器之类的全局视图不带，保持与工具门「只影响 agent 视图」同语义。
 *   · 存储里的技能定义一概不改，开关与名单改动下一步请求即时生效，卸载即透传。
 *
 * 用户显式 `/name` 手势走 `skills.get()`，属于人直接点名，故意不拦 —— 与上游
 * userInvocable / modelInvocable 的分离一致。界面上如实标注这个边界。
 *
 * 分组依据：技能注册表 summary 的 `source` 字段（user-dsh / project-dsh /
 * bundled / custom / runtime / 插件 provider 自定义值），与工具门按注册来源
 * 分框是同一套交互。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { estimateTokens, summarizeDescription } from './tool-gate.js';

/** 侧车目录：与工具门的状态放在一起，便于整体备份/回滚。 */
function stateFilePath() {
  return path.join(os.homedir(), '.dsh', 'injection-tune', 'skill-gate.json');
}

/**
 * 三档隐藏模式（2026-11-16 扩展；同日改为**逐技能独立设置**）。
 *
 * 每个技能各自持有档位，互不影响：
 *
 *   hide      —— 整条从 snapshot 移除。模型看不到名字，skill 工具也加载不了。
 *                省得最彻底（100%），代价是模型不知道这个技能存在。
 *   name      —— 保留名字、描述清空。目录只剩 `- \`name\`: `，模型仍能发现
 *                并可用 skill 工具加载正文。约省 91%。
 *   headline  —— 保留名字 + 描述前 N 字（默认 60）。留住"这技能干什么"的
 *                功能摘要，砍掉触发词长尾，约省 75%，判别力最好。
 *
 * 不在规则表里的技能 = 激活（原样下发）。三档都意味着"隐藏到某种程度"，
 * 所以界面需要第四个状态「激活」，否则无法把技能恢复成正常下发。
 *
 * 投影必须**稳定**：同一份规则表每轮产出同一份 entries，否则上游
 * digestCatalogEntries 每轮都不等，会每轮重发完整目录（见文件头注释）。
 */
const HIDE_MODES = ['hide', 'name', 'headline'];

/** 出厂状态：门关着、无规则、默认截断字数（= 行为与扩展前完全一致）。 */
const DEFAULT_STATE = { version: 2, enabled: false, rules: {}, headlineChars: 60, updatedAt: null };

/** headline 模式的字数上限（含省略号，与上游 catalogDescription 同口径）。 */
const DEFAULT_HEADLINE_CHARS = 60;
const MIN_HEADLINE_CHARS = 10;
const MAX_HEADLINE_CHARS = 500;

/** 上游 dsh-tool-skill 的 catalogDescription 硬上限（DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH）。 */
const CATALOG_DESCRIPTION_MAX_LENGTH = 500;

/** 原型包装标记：同一进程内多个实例（HMR/多 profile）共用一层包装。 */
const SNAPSHOT_WRAP_MARK = Symbol.for('dsh-injection-tune.skill-snapshot-wrap');

/**
 * 当前生效的规则表（由 createSkillGate 设置 / dispose 清除）。
 * null = 透传；Map<技能名, 'hide'|'name'|'headline'>，不在表里 = 激活。
 * 模块级单槽：多个 gate 实例后建者接管，dispose 只在自己仍是活跃者时清除，
 * 避免旧实例把新实例的规则抹掉。
 */
let activeRules = null;
/** 当前生效的截断字数（与 activeRules 同生命周期）。 */
let activeHeadlineChars = DEFAULT_HEADLINE_CHARS;
/** 当前活跃 gate 的身份标记。 */
let activeOwner = null;

/**
 * 把状态里的 rules 对象转成运行时 Map（只保留合法档位）。
 *
 * @param {object} rules `{ 技能名: 档位 }`
 * @returns {Map<string, string>}
 */
function rulesToMap(rules) {
  const map = new Map();
  if (!rules || typeof rules !== 'object') return map;
  for (const [name, mode] of Object.entries(rules)) {
    if (typeof name === 'string' && name.length > 0 && HIDE_MODES.includes(mode)) {
      map.set(name, mode);
    }
  }
  return map;
}

/** 读 JSON 文件，任何异常都退回默认值（fail-safe：读不出来就当没配过）。 */
function readJsonFile(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
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

/**
 * 状态归一：只保留布尔开关、逐技能规则表、截断字数。
 *
 * **兼容旧版（version 1）**：旧格式是 `{ deny: [...], mode: 'hide' }`（全局统一
 * 档位）。读到旧格式时把 deny 里每个技能按当时的 mode 展开成规则，行为与升级前
 * 完全一致，用户无需重新配置。缺 mode 时按 hide 处理（正是旧版出厂默认）。
 *
 * @param {object} raw 磁盘或内存里的原始状态。
 * @returns {object} 归一化后的状态。
 */
function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rules = {};
  // 新格式：逐技能规则表。
  if (source.rules && typeof source.rules === 'object' && !Array.isArray(source.rules)) {
    for (const [name, mode] of Object.entries(source.rules)) {
      if (typeof name === 'string' && name.length > 0 && HIDE_MODES.includes(mode)) {
        rules[name] = mode;
      }
    }
  }
  // 旧格式迁移：deny 数组 + 全局 mode → 每个技能各一条规则。
  if (Array.isArray(source.deny)) {
    const legacyMode = HIDE_MODES.includes(source.mode) ? source.mode : 'hide';
    for (const name of source.deny) {
      if (typeof name === 'string' && name.length > 0 && rules[name] === undefined) {
        rules[name] = legacyMode;
      }
    }
  }
  const rawChars = Number(source.headlineChars);
  const headlineChars = Number.isFinite(rawChars)
    ? Math.min(MAX_HEADLINE_CHARS, Math.max(MIN_HEADLINE_CHARS, Math.round(rawChars)))
    : DEFAULT_HEADLINE_CHARS;
  return {
    version: 2,
    enabled: source.enabled === true,
    rules,
    headlineChars,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  };
}

/**
 * 把一条技能按 mode 投影成模型可见形态。
 *
 * 只做浅拷贝替换 `description`，不动 `invocation` / `provider` / `path`：
 * `skill` 工具后续会用同一个名字走 `ctx.skills.get()`，而 `get()` 走的是
 * 另一条 collect 路径、不受 snapshot 包装影响，所以正文仍能正常加载。
 *
 * @param {object} skill 上游 snapshot 的 summary。
 * @param {string} mode 'hide' | 'name' | 'headline'。
 * @param {number} headlineChars headline 模式保留的字数。
 * @returns {object|null} 投影后的技能；hide 模式返回 null 表示整条移除。
 */
function projectSkill(skill, mode, headlineChars) {
  if (mode === 'hide') return null;
  if (mode === 'name') return { ...skill, description: '' };
  const description = typeof skill?.description === 'string' ? skill.description : '';
  const normalized = description.replace(/\s+/g, ' ').trim();
  const clipped = normalized.length <= headlineChars
    ? normalized
    : `${normalized.slice(0, headlineChars - 3)}...`;
  return { ...skill, description: clipped };
}

/**
 * 包裹 `skills.snapshot` 原型，返回**未经包装的原始方法**供设置页读全量清单。
 *
 * 包装只装一次；本插件卸载时不还原原型（还原会切断后加载实例的捕获，而
 * activeRules=null 时它就是纯透传，留着无害）。任何异常一律回退原始结果，
 * 绝不让界面功能弄坏技能发现。
 *
 * @param {object} skillsService 任意一个 skills 服务实例（用它的原型）。
 * @returns {Function|null} 原始 snapshot 方法；服务形态不符时返回 null。
 */
function instrumentSnapshot(skillsService) {
  const prototype = Object.getPrototypeOf(skillsService);
  if (prototype === null || typeof prototype.snapshot !== 'function') return null;
  if (prototype[SNAPSHOT_WRAP_MARK] !== undefined) return prototype[SNAPSHOT_WRAP_MARK];
  const original = prototype.snapshot;
  prototype.snapshot = async function patchedSnapshot(options) {
    const observation = await original.apply(this, arguments);
    try {
      const rules = activeRules;
      if (rules === null || rules.size === 0) return observation;
      // 全局视图（无 scope）不受影响：设置页、技能管理器仍能看到全部技能。
      if (options === undefined || options === null || options.scope === undefined || options.scope === null) {
        return observation;
      }
      if (!Array.isArray(observation?.skills)) return observation;
      const headlineChars = activeHeadlineChars;
      let changed = false;
      const skills = [];
      for (const skill of observation.skills) {
        // 逐技能取档位：不在规则表里的技能 = 激活，原样下发。
        const mode = rules.get(skill?.name);
        if (mode === undefined) {
          skills.push(skill);
          continue;
        }
        // 命中规则：按该技能自己的档位投影。name/headline 保留条目（模型仍能
        // 发现与加载），hide 整条移除（模型完全看不到）。
        const projected = projectSkill(skill, mode, headlineChars);
        changed = true;
        if (projected !== null) skills.push(projected);
      }
      if (!changed) return observation;
      return { ...observation, skills };
    } catch {
      return observation;
    }
  };
  Object.defineProperty(prototype, SNAPSHOT_WRAP_MARK, { value: original, enumerable: false });
  return original;
}

/**
 * 目录单行的字符数：与上游 `- \`name\`: description` 同口径（含换行）。
 *
 * 不传 `mode` 时保持扩展前的语义（按上游 500 字符上限算整行占位），
 * 供「未开启本门时该技能占多少」的基线统计使用；传 `mode` 才做投影估算。
 *
 * @param {object} skill 技能 summary。
 * @param {string} [mode] 投影模式；缺省 = 完整描述。
 * @param {number} [headlineChars] headline 模式的截断字数。
 * @returns {number} 该行在模型目录里实际占用的字符数。
 */
function catalogLineChars(skill, mode, headlineChars = DEFAULT_HEADLINE_CHARS) {
  if (mode === 'hide') return 0;
  const description = typeof skill.description === 'string' ? skill.description : '';
  const normalized = description.replace(/\s+/g, ' ').trim();
  let shown;
  if (mode === 'name') {
    shown = '';
  } else if (mode === 'headline') {
    shown = normalized.length <= headlineChars
      ? normalized
      : `${normalized.slice(0, headlineChars - 3)}...`;
  } else {
    shown = normalized.length <= CATALOG_DESCRIPTION_MAX_LENGTH
      ? normalized
      : `${normalized.slice(0, CATALOG_DESCRIPTION_MAX_LENGTH - 3)}...`;
  }
  return `- \`${skill.name}\`: ${shown}`.length + 1;
}

/**
 * 创建技能可见性门。
 *
 * @param {object} scope 已注入 `skills` / `agents` 的 Cordis 上下文（`ctx.inject` 回调参数）。
 * @param {object} [logger] 日志器（缺省用 scope.logger）。
 * @returns {{snapshot: Function, update: Function, refresh: Function, dispose: Function}} 控制器。
 *          snapshot/update/refresh 均为 async（技能发现本身是异步的）。
 */
function createSkillGate(scope, logger) {
  const skillsService = typeof scope?.skills?.snapshot === 'function' ? scope.skills : null;
  const log = logger ?? scope?.logger ?? { info() {}, warn() {} };
  if (skillsService === null) {
    const emptySnapshot = () => Promise.resolve({
      ok: false,
      error: 'host exposes no skills service',
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
  /** 原始 snapshot：设置页读全量，绕过本门自己的过滤。 */
  const originalSnapshot = instrumentSnapshot(skillsService);
  const self = {};
  activeOwner = self;
  activeRules = rulesToMap(state.enabled ? state.rules : {});
  activeHeadlineChars = state.headlineChars;

  /** 当前所有 agent（拿不到就当成空列表：不影响设置读写）。 */
  function listAgents() {
    try {
      const agents = scope.agents;
      if (agents && typeof agents.list === 'function') return agents.list();
    } catch { /* 忽略 */ }
    return [];
  }

  /** agent 的工作目录：项目级技能依赖它，取不到就不带。 */
  function cwdOf(agent) {
    try {
      const cwd = agent?.session?.header?.cwd;
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 汇总一份技能清单：全局视图 + 各 agent 作用域并集，保留最完整的定义。
   * 一律走原始 snapshot —— 设置页必须看得到已隐藏的条目，否则无法恢复。
   */
  async function collectSkills() {
    const byName = new Map();
    const lookups = [{}];
    for (const agent of listAgents()) {
      const lookup = { scope: agent };
      const cwd = cwdOf(agent);
      if (cwd !== undefined) lookup.cwd = cwd;
      lookups.push(lookup);
    }
    for (const lookup of lookups) {
      let observation;
      try {
        observation = await originalSnapshot.call(skillsService, lookup);
      } catch {
        continue;
      }
      if (!Array.isArray(observation?.skills)) continue;
      for (const skill of observation.skills) {
        const name = skill?.name;
        if (typeof name !== 'string' || name.length === 0 || byName.has(name)) continue;
        // 完整形态的行宽：按上游 500 字符上限截断，与未开启本门时目录里的占位一致。
        const chars = catalogLineChars(skill, 'headline', CATALOG_DESCRIPTION_MAX_LENGTH);
        const source = typeof skill.source === 'string' && skill.source.length > 0 ? skill.source : null;
        byName.set(name, {
          name,
          // 原始描述必须留存：snapshot() 里要按当前 mode 重算投影后的行宽，
          // 只有 summary（清洗后的摘要）无法还原 headline 截断的结果。
          description: typeof skill.description === 'string' ? skill.description : '',
          summary: summarizeDescription(skill.description),
          source,
          provider: typeof skill.provider === 'string' ? skill.provider : '',
          chars,
          tokens: estimateTokens(chars),
          modelInvocable: skill.invocation?.modelInvocable !== false,
          userInvocable: skill.invocation?.userInvocable !== false,
        });
      }
    }
    return byName;
  }

  /** 组装给界面用的快照：按 source 分框，框内按体积降序。 */
  async function snapshot() {
    const skills = await collectSkills();
    const rules = state.rules;
    const groups = new Map();
    let totalChars = 0;
    let hiddenChars = 0;
    let hiddenCount = 0;
    // 按各技能自己的档位投影后，被隐藏条目仍占用的字符（hide=0）。
    let hiddenKeptChars = 0;

    for (const skill of skills.values()) {
      const key = skill.source ?? '\u0000unknown';
      if (!groups.has(key)) {
        groups.set(key, {
          source: skill.source,
          label: skill.source ?? '未识别来源',
          reason: skill.source === null ? 'none' : 'registry',
          skills: [],
          tokens: 0,
          chars: 0,
          hiddenCount: 0,
        });
      }
      const group = groups.get(key);
      // 每个技能按自己的档位计算；无规则 = 激活（keptChars 即整行宽度）。
      const mode = rules[skill.name];
      const hidden = mode !== undefined;
      const keptChars = hidden ? catalogLineChars(skill, mode, state.headlineChars) : skill.chars;
      group.skills.push({ ...skill, mode: mode ?? null, hidden, denied: hidden, keptChars, keptTokens: estimateTokens(keptChars) });
      group.tokens += skill.tokens;
      group.chars += skill.chars;
      if (hidden) {
        group.hiddenCount += 1;
        hiddenChars += skill.chars;
        hiddenKeptChars += keptChars;
        hiddenCount += 1;
      }
      totalChars += skill.chars;
    }

    const ordered = [...groups.values()]
      .map((group) => ({ ...group, skills: group.skills.sort((a, b) => b.tokens - a.tokens) }))
      .sort((a, b) => {
        if (a.source === null) return 1;
        if (b.source === null) return -1;
        return b.tokens - a.tokens;
      });

    return {
      ok: true,
      enabled: state.enabled,
      rules: state.rules,
      headlineChars: state.headlineChars,
      modes: HIDE_MODES,
      updatedAt: state.updatedAt,
      groups: ordered,
      agents: listAgents().length,
      totals: {
        count: skills.size,
        // hiddenCount / hiddenTokens 保留旧字段名，便于既有消费方平滑过渡。
        hiddenCount,
        deniedCount: hiddenCount,
        chars: totalChars,
        tokens: estimateTokens(totalChars),
        hiddenTokens: estimateTokens(hiddenChars),
        deniedTokens: estimateTokens(hiddenChars),
        // 隐藏后实际仍占用的 token（hide=0，name/headline>0），
        // 界面用它显示"真正省下"的量，而不是"整条抹掉"的假想值。
        keptTokens: estimateTokens(hiddenKeptChars),
        savedTokens: estimateTokens(Math.max(0, hiddenChars - hiddenKeptChars)),
      },
    };
  }

  /** 落盘 + 立刻生效（过滤是投影式实时读取，无需重放任何限制层）。 */
  function persist() {
    state = { ...state, updatedAt: new Date().toISOString() };
    activeRules = rulesToMap(state.enabled ? state.rules : {});
    activeHeadlineChars = state.headlineChars;
    writeJsonFile(stateFilePath(), state);
    const names = Object.keys(state.rules);
    if (state.enabled && names.length > 0) {
      // 按档位汇总一行日志，便于排查"为什么某个技能没出现在目录里"。
      const byMode = {};
      for (const mode of names.map((n) => state.rules[n])) {
        byMode[mode] = (byMode[mode] ?? 0) + 1;
      }
      const detail = HIDE_MODES
        .filter((mode) => byMode[mode] > 0)
        .map((mode) => `${mode}×${byMode[mode]}`)
        .join(' / ');
      log.info(`dsh-injection-tune: 技能门已设置 ${names.length} 个技能（${detail}，下一轮目录生效）`);
    }
    return state;
  }

  /**
   * 处理界面提交：允许只带其中一个字段。
   *
   * `setMode` 是逐技能设置档位的入口：
   *   `{ name, mode }`  mode 为合法档位 → 写入规则；
   *                     mode 为 null / '' / 'active' → 删除规则（恢复激活）。
   *
   * @param {object} patch `{enabled?, rules?, headlineChars?, setMode?, clear?}`
   * @returns {Promise<object>} 应用后的完整快照。
   */
  async function update(patch) {
    const source = patch && typeof patch === 'object' ? patch : {};
    if (typeof source.enabled === 'boolean') state = { ...state, enabled: source.enabled };
    // 整体替换规则表（批量操作）。
    if (source.rules && typeof source.rules === 'object' && !Array.isArray(source.rules)) {
      state = normalizeState({ ...state, rules: source.rules, deny: undefined });
    }
    if (source.headlineChars !== undefined) {
      state = normalizeState({ ...state, headlineChars: source.headlineChars });
    }
    // 单个技能改档位。
    if (source.setMode && typeof source.setMode === 'object') {
      const name = source.setMode.name;
      const mode = source.setMode.mode;
      if (typeof name === 'string' && name.length > 0) {
        const rules = { ...state.rules };
        if (mode === null || mode === undefined || mode === '' || mode === 'active') {
          delete rules[name];
        } else if (HIDE_MODES.includes(mode)) {
          rules[name] = mode;
        }
        state = normalizeState({ ...state, rules, deny: undefined });
      }
    }
    // 批量清空（恢复全部激活）。
    if (source.clear === true) {
      state = normalizeState({ ...state, rules: {}, deny: undefined });
    }
    persist();
    return snapshot();
  }

  return {
    snapshot,
    update,
    refresh: snapshot,
    dispose: () => {
      if (activeOwner === self) {
        activeOwner = null;
        activeRules = null;
        activeHeadlineChars = DEFAULT_HEADLINE_CHARS;
      }
    },
  };
}

export {
  createSkillGate,
  catalogLineChars,
  normalizeState,
  projectSkill,
  rulesToMap,
  stateFilePath,
  DEFAULT_STATE,
  DEFAULT_HEADLINE_CHARS,
  HIDE_MODES,
  CATALOG_DESCRIPTION_MAX_LENGTH,
  SNAPSHOT_WRAP_MARK,
};
