/**
 * lib/config.js —— 插件配置 schema 与直接调用默认值（CommonJS，与 lib/host.js 同格式）。
 *
 * 三个实验性功能各自独立开关，默认全部关闭（off），
 * 保证插件加载后行为与未安装时完全一致（fail-safe）。
 */

const schema = require('@deepseek-ai/schemastery');

/** Loader 可见的配置 schema 与默认值。 */
const Config = schema.object({
  dedupeRuntimeContext: schema.boolean().default(false),
  incrementalSkillCatalog: schema.boolean().default(false),
  deferredAgentInstructions: schema.boolean().default(false),
  skillCatalogKeepDescription: schema.boolean().default(true),
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
    config.deferredAgentInstructions === true
  );
}

module.exports = { Config, resolveConfig, isAnyEnabled };
