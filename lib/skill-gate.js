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

/** 出厂状态：门关着、空名单（= 行为与未安装本特性完全一致）。 */
const DEFAULT_STATE = { version: 1, enabled: false, deny: [], updatedAt: null };

/** 上游 dsh-tool-skill 的 catalogDescription 硬上限（DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH）。 */
const CATALOG_DESCRIPTION_MAX_LENGTH = 500;

/** 原型包装标记：同一进程内多个实例（HMR/多 profile）共用一层包装。 */
const SNAPSHOT_WRAP_MARK = Symbol.for('dsh-injection-tune.skill-snapshot-wrap');

/**
 * 当前生效的隐藏名单（由 createSkillGate 设置 / dispose 清除）。
 * null = 透传。模块级单槽：多个 gate 实例后建者接管，dispose 只在自己仍是
 * 活跃者时清除，避免旧实例把新实例的名单抹掉。
 */
let activeDeny = null;
/** 当前活跃 gate 的身份标记。 */
let activeOwner = null;

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
 * 包裹 `skills.snapshot` 原型，返回**未经包装的原始方法**供设置页读全量清单。
 *
 * 包装只装一次；本插件卸载时不还原原型（还原会切断后加载实例的捕获，而
 * activeDeny=null 时它就是纯透传，留着无害）。任何异常一律回退原始结果，
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
      const deny = activeDeny;
      if (deny === null || deny.size === 0) return observation;
      // 全局视图（无 scope）不受影响：设置页、技能管理器仍能看到全部技能。
      if (options === undefined || options === null || options.scope === undefined || options.scope === null) {
        return observation;
      }
      if (!Array.isArray(observation?.skills)) return observation;
      const skills = observation.skills.filter((skill) => !deny.has(skill?.name));
      if (skills.length === observation.skills.length) return observation;
      return { ...observation, skills };
    } catch {
      return observation;
    }
  };
  Object.defineProperty(prototype, SNAPSHOT_WRAP_MARK, { value: original, enumerable: false });
  return original;
}

/** 目录单行的字符数：与上游 `- \`name\`: description` 同口径（含换行）。 */
function catalogLineChars(skill) {
  const description = typeof skill.description === 'string' ? skill.description : '';
  const normalized = description.replace(/\s+/g, ' ').trim();
  const clipped = normalized.length <= CATALOG_DESCRIPTION_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, CATALOG_DESCRIPTION_MAX_LENGTH - 3)}...`;
  return `- \`${skill.name}\`: ${clipped}`.length + 1;
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
  activeDeny = new Set(state.enabled ? state.deny : []);

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
        const chars = catalogLineChars(skill);
        const source = typeof skill.source === 'string' && skill.source.length > 0 ? skill.source : null;
        byName.set(name, {
          name,
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
    const denySet = new Set(state.deny);
    const groups = new Map();
    let totalChars = 0;
    let deniedChars = 0;
    let deniedCount = 0;

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
          deniedCount: 0,
        });
      }
      const group = groups.get(key);
      const denied = denySet.has(skill.name);
      group.skills.push({ ...skill, denied });
      group.tokens += skill.tokens;
      group.chars += skill.chars;
      if (denied) {
        group.deniedCount += 1;
        deniedChars += skill.chars;
        deniedCount += 1;
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
      deny: state.deny,
      updatedAt: state.updatedAt,
      groups: ordered,
      agents: listAgents().length,
      totals: {
        count: skills.size,
        deniedCount,
        chars: totalChars,
        tokens: estimateTokens(totalChars),
        deniedTokens: estimateTokens(deniedChars),
      },
    };
  }

  /** 落盘 + 立刻生效（过滤是投影式实时读取，无需重放任何限制层）。 */
  function persist() {
    state = { ...state, updatedAt: new Date().toISOString() };
    activeDeny = new Set(state.enabled ? state.deny : []);
    writeJsonFile(stateFilePath(), state);
    if (state.enabled && state.deny.length > 0) {
      log.info(`dsh-injection-tune: 技能门已隐藏 ${state.deny.length} 个技能（下一轮目录生效）`);
    }
    return state;
  }

  /**
   * 处理界面提交：允许只带其中一个字段。
   *
   * @param {object} patch `{enabled?: boolean, deny?: string[], toggle?: {name, denied}}`
   * @returns {Promise<object>} 应用后的完整快照。
   */
  async function update(patch) {
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
        activeDeny = null;
      }
    },
  };
}

export {
  createSkillGate,
  catalogLineChars,
  normalizeState,
  stateFilePath,
  DEFAULT_STATE,
  CATALOG_DESCRIPTION_MAX_LENGTH,
  SNAPSHOT_WRAP_MARK,
};
