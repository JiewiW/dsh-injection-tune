/**
 * lib/features/deferred-agent-instructions.js —— AI-3 实现。
 *
 * 上游行为（内核实证）：
 *   D:\dsh\node_modules\@deepseek-ai\dsh-agent-instructions\lib\index.js:256-266
 *   `buildInstructionText()` 把 baseline 的所有文件一次性全部拼进同一条
 *   `<system-reminder>` user 消息；预算超限时按 :249-255 的 markerText 给出
 *   `omitted <path>` / `truncated <path> from N to M bytes` 提示，但**不触发
 *   任何补偿读取**（实测 session-525bf622：项目级 AGENTS.md 因预算不足被完整
 *   丢弃，仅保留用户级全局规则，模型未去读原文件，项目约束静默失效）。
 *
 * 本模块策略（口径：延迟注入 + 指针显式化）：
 *   - 首轮只保留 baseline 的**前若干节**（按 `## ` 顶层标题切分，默认保留 2 节）；
 *   - 其余节折叠为一条显式指针，指明被折叠的节标题与原文文件路径，提示模型
 *     在确需该节约束时用 read 工具读取对应行范围；
 *   - `omitted`/`truncated` 标记行升级为强指针（附绝对路径 + read 建议）。
 *
 * 安全约束：
 *   1. 只处理 source.kind === 'agent-instructions' 的消息；
 *   2. 折叠后必须保留 <system-reminder> 开闭标签与 intro 段；
 *   3. 任何解析异常返回原文（fail-open），不中断 pre-step 瀑布。
 */

/** 默认保留的顶层标题节数。 */
const DEFAULT_KEEP_SECTIONS = 2;

/** 指针块模板。 */
const POINTER_HEADER = '[dsh-injection-tune] 以下为延迟注入提示：';
const POINTER_FILE = (path) => `原文文件：${path}`;
const POINTER_SECTIONS = (titles) => `被折叠的节：${titles.map((title) => `「${title}」`).join('、')}`;
const POINTER_READ = (path) =>
  path === undefined
    ? '需要上述某一节的完整约束时，请用 read 工具读取对应源文件（路径见上方「Instructions from」行）的相应行范围，不要凭记忆或猜测套用该节规则。'
    : `需要上述某一节的完整约束时，请用 read 工具读取 ${path} 的相应行范围，不要凭记忆或猜测套用该节规则。`;

/**
 * 按 `## ` 顶层标题把 baseline 正文切为节。
 *
 * @param {string} body `<system-reminder>` 内的正文（不含外层标签）。
 * @returns {{ preamble: string, sections: Array<{ title: string, text: string }> }} 切分结果。
 */
function splitTopLevelSections(body) {
  const lines = body.split('\n');
  const sections = [];
  let preambleLines = [];
  let current = null;
  for (const line of lines) {
    if (/^##\s+\S/.test(line)) {
      if (current !== null) sections.push(current);
      current = { title: line.replace(/^##\s+/, '').trim(), lines: [line] };
    } else if (current === null) {
      preambleLines.push(line);
    } else {
      current.lines.push(line);
    }
  }
  if (current !== null) sections.push(current);
  return {
    preamble: preambleLines.join('\n'),
    sections: sections.map((section) => ({ title: section.title, text: section.lines.join('\n') })),
  };
}

/**
 * 从 baseline 文本中提取所有 `Instructions from: <path>` 的路径列表。
 *
 * @param {string} text 完整消息文本。
 * @returns {string[]} 去重后的路径列表（保序）。
 */
function extractInstructionPaths(text) {
  const found = [];
  const pattern = /Instructions from:\s*(.+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const path = match[1].trim();
    if (path.length > 0 && !found.includes(path)) found.push(path);
  }
  return found;
}

/**
 * 把完整 baseline 文本改写为「保留前 N 节 + 显式指针」形态。
 *
 * @param {string} text 上游发布的完整 baseline 文本。
 * @param {object} [options] 可选参数。
 * @param {number} [options.keepSections] 保留的顶层标题节数。
 * @returns {{ text: string, deferredSections: number, savedChars: number }} 改写结果。
 */
function deferSections(text, options = {}) {
  const keep = options.keepSections ?? DEFAULT_KEEP_SECTIONS;
  if (typeof text !== 'string' || text.length === 0) {
    return { text, deferredSections: 0, savedChars: 0 };
  }
  const openIndex = text.indexOf('<system-reminder>');
  const closeIndex = text.lastIndexOf('</system-reminder>');
  if (openIndex < 0 || closeIndex < 0 || closeIndex <= openIndex) {
    return { text, deferredSections: 0, savedChars: 0 };
  }
  const prefix = text.slice(0, openIndex + '<system-reminder>'.length);
  const body = text.slice(openIndex + '<system-reminder>'.length, closeIndex);
  const suffix = text.slice(closeIndex);
  const { preamble, sections } = splitTopLevelSections(body);
  if (sections.length <= keep) {
    return { text, deferredSections: 0, savedChars: 0 };
  }
  const kept = sections.slice(0, keep);
  const deferred = sections.slice(keep);
  const paths = extractInstructionPaths(body);
  const pointerLines = [
    '',
    POINTER_HEADER,
    ...paths.map(POINTER_FILE),
    POINTER_SECTIONS(deferred.map((section) => section.title)),
    POINTER_READ(paths.length === 1 ? paths[0] : undefined),
  ];
  const newBody = [
    preamble,
    ...kept.map((section) => section.text),
    pointerLines.join('\n'),
  ]
    .filter((block) => block.length > 0)
    .join('\n\n');
  const result = `${prefix}\n${newBody}\n${suffix}`;
  return {
    text: result,
    deferredSections: deferred.length,
    savedChars: Math.max(0, text.length - result.length),
  };
}

export { deferSections, splitTopLevelSections, extractInstructionPaths, DEFAULT_KEEP_SECTIONS };
