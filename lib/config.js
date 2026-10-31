/**
 * lib/config.js —— 插件配置 schema 与直接调用默认值（CommonJS，与 lib/host.js 同格式）。
 *
 * 所有功能独立开关，默认全部关闭（off），
 * 保证插件加载后行为与未安装时完全一致（fail-safe）。
 */

import schema from '@deepseek-ai/schemastery';

/** Loader 可见的配置 schema 与默认值。 */
const Config = schema.object({
  dedupeRuntimeContext: schema.boolean().default(false).volatile(),
  incrementalSkillCatalog: schema.boolean().default(false).volatile(),
  deferredAgentInstructions: schema.boolean().default(false).volatile(),
  skillCatalogKeepDescription: schema.boolean().default(true).volatile(),
  // ── 新增：压缩插件互斥与注入过滤 ──────────────────────────
  /**
   * 当检测到外部压缩插件（billion-context 等）已向 systemPrompt 注册 section 时，
   * 将其劫持移除——避免同一套 ACP 规范在初始系统提示词里重复注入。
   * 底层：hook system-prompt/assemble waterfall，在最终输出里过滤掉同名 section。
   */
  suppressACPSection: schema.boolean().default(true).volatile(),
  /**
   * 过滤 auto-memory 注册的 runtime-context 动态快照——不再每轮把完整版/精简版
   * <memory_system> 块追加到历史尾部。保留 auto-memory 的所有其他功能（写盘、
   * tool、配置等），只去掉那条注入到对话里的 user 消息。
   * 底层：hook system-prompt/assemble waterfall，把 contexts 里名字包含
   * "auto-memory" 的条目剥离。
   */
  suppressAutoMemoryRuntimeContext: schema.boolean().default(true).volatile(),
  /**
   * 过滤 dsh-session-kit 每轮追加的「未完任务提醒」user 消息（source.kind ===
   * "dsh-session-kit-tasks"）。session-kit 的任务管理核心逻辑、task_list /
   * task_inject 工具均不受影响——只是每轮不再自动注入。
   */
  suppressSessionKitTasks: schema.boolean().default(true).volatile(),
});

/**
 * 为绕过 Cordis Loader 的直接调用方解析同一套默认值。
 *
 * @param {object} [config] 部分序列化配置。
 * @returns {object} 应用全部默认值后的配置。
 */
function resolveConfig(config) {
  const source = config ?? {};
  return {
    dedupeRuntimeContext: source.dedupeRuntimeContext ?? false,
    incrementalSkillCatalog: source.incrementalSkillCatalog ?? false,
    deferredAgentInstructions: source.deferredAgentInstructions ?? false,
    skillCatalogKeepDescription: source.skillCatalogKeepDescription ?? true,
    suppressACPSection: source.suppressACPSection ?? true,
    suppressAutoMemoryRuntimeContext: source.suppressAutoMemoryRuntimeContext ?? true,
    suppressSessionKitTasks: source.suppressSessionKitTasks ?? true,
  };
}

/**
 * 配置是否至少启用一项功能。
 *
 * @param {object} config 已解析配置。
 * @returns {boolean} 任一功能开启即为 true。
 */
function isAnyEnabled(config) {
  return (
    config.dedupeRuntimeContext === true ||
    config.incrementalSkillCatalog === true ||
    config.deferredAgentInstructions === true ||
    config.suppressACPSection === true ||
    config.suppressAutoMemoryRuntimeContext === true ||
    config.suppressSessionKitTasks === true
  );
}

export { Config, resolveConfig, isAnyEnabled };
