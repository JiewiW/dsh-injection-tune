/**
 * lib/features/dedupe-runtime-context.js —— AI-1 实现。
 *
 * 功能口径（用户 2026-10-22 裁定为方案B）：只做**同一条 runtime-context 消息内部**
 * 的重复片段折叠，不跨消息 diff。
 *
 * 内核实证依据（不可跨消息 diff 的原因）：
 *   D:\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js:428-443
 *   `RuntimeContextProjection.project()` 在 retained.text 与本次渲染逐字相同时
 *   直接 `return`（无新消息），因此「前一条完整版」不作为独立消息存在于
 *   decision.messages 中，无法跨消息取到。
 *
 * 可检测的重复来源：runtime-context 快照由 renderContextSections() 把多个
 * context section 拼接而成，其中同一插件（如 dsh-auto-memory）可能同时注册了
 * 完整版与精简版两个 context，二者共享大段逐字相同的前缀。本模块在消息文本内
 * 找出「被更长的相同文本完全包含的重复行段」，替换为单行指针。
 *
 * 安全约束：
 *   1. 只折叠长度 ≥ minRepeatChars（默认 400）的整块重复，避免误伤短行；
 *   2. 保留首次出现的完整内容，只把后续重复折叠为指针；
 *   3. 任何解析异常都返回原文（fail-open），绝不抛错中断 pre-step 瀑布。
 */

/** 触发折叠所需的最小重复块字符数。 */
const MIN_REPEAT_CHARS = 400;

/** 指针行的统一格式。 */
const POINTER_FORMAT = (chars) =>
  `[dsh-injection-tune] 上方已给出同样内容（约 ${chars} 字符），此处不再重复；以上方那一份为准。`;

/**
 * 在单条消息文本内折叠逐字重复的长块。
 *
 * 算法：按「段落」切分（空行分段），对每个段落计算指纹；若某段落与之前某个
 * 段落逐字相同且长度 ≥ MIN_REPEAT_CHARS，则折叠为指针行。段落级比较而非行级，
 * 可避免把多段结构拆碎后误判。
 *
 * @param {string} text 原始消息文本。
 * @param {object} [options] 可选参数。
 * @param {number} [options.minRepeatChars] 最小重复块字符数。
 * @returns {{ text: string, foldedChars: number, foldedBlocks: number }} 折叠结果。
 */
function dedupeWithinMessage(text, options = {}) {
  const minRepeat = options.minRepeatChars ?? MIN_REPEAT_CHARS;
  if (typeof text !== 'string' || text.length === 0) {
    return { text, foldedChars: 0, foldedBlocks: 0 };
  }
  const paragraphs = text.split(/\n{2,}/);
  const seen = new Map();
  let foldedChars = 0;
  let foldedBlocks = 0;
  const out = paragraphs.map((paragraph) => {
    if (paragraph.length < minRepeat) return paragraph;
    const previous = seen.get(paragraph);
    if (previous === undefined) {
      seen.set(paragraph, paragraph.length);
      return paragraph;
    }
    foldedBlocks += 1;
    foldedChars += paragraph.length;
    return POINTER_FORMAT(previous);
  });
  return {
    text: out.join('\n\n'),
    foldedChars,
    foldedBlocks,
  };
}

export { dedupeWithinMessage, MIN_REPEAT_CHARS };
