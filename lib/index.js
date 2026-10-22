/**
 * lib/index.js —— dsh-injection-tune 的对外入口（ESM，Loader 直接加载）。
 * 只做 re-export，真实逻辑在 lib/host.js。
 */

export * from './host.js';
