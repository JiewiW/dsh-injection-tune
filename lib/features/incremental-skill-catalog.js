/**
 * lib/features/incremental-skill-catalog.js —— AI-2 实现。
 *
 * 上游行为（内核实证）：
 *   D:\dsh\node_modules\@deepseek-ai\dsh-tool-skill\lib\index.js:203-236
 *   `agent/pre-step` 监听里，只要 digest 变化就重新发布**完整**目录（首版
 *   renderCatalogMessage:238-261 或替换版 renderCatalogUpdate:262-286），
 *   消息级整体替换。实测本会话 48 个技能、单条目录约 15.9KB。
 *
 * 本模块策略：在同一 pre-step 瀑布内**后置**拦截（注册晚于 dsh-tool-skill，
 * 或无条件每轮重写），把完整目录文本改写为增量形态：
 *   - 首次：发布完整清单（与上游一致，不改变首次语义）；
 *   - 后续：只列出自上次以来新增/变更的条目，并附一行「其余 N 项未变」。
 *
 * 关键约束：必须保留 `source.entries`（上游 :226 用
 * `digestCatalogEntries(existing.entries) === digest` 判断是否已有目录，
 * 丢掉 entries 会被判为外来消息而每轮重发完整目录）。因此只替换
 * `content[0].text`，不动 source。
 */

/** 增量头行。 */
const INCREMENTAL_HEADER =
  'The available skill catalog changed. The entries below are the only additions or changes since the previous catalog; all other skills from the previous catalog remain available. This catalog replaces every earlier available-skills list in this session:';

/** 增量尾行（无变更时的兜底，正常不会走到）。 */
const NO_CHANGE_NOTE =
  'No skill catalog entries changed since the previous catalog; every earlier available-skills list remains fully in effect.';

/**
 * 把完整目录文本改写为增量目录文本。
 *
 * @param {string} text 上游发布的完整目录文本。
 * @param {Array<{name: string, description: string}>} previousEntries 上一次的条目。
 * @param {Array<{name: string, description: string}>} currentEntries 本次条目。
 * @param {object} [options] 可选参数。
 * @param {boolean} [options.keepDescription] 是否在增量行内保留描述正文。
 * @returns {{ text: string, savedChars: number }} 改写结果。
 */
function toIncrementalCatalog(text, previousEntries, currentEntries, options = {}) {
  const keepDescription = options.keepDescription !== false;
  if (typeof text !== 'string' || text.length === 0) {
    return { text, savedChars: 0 };
  }
  if (!Array.isArray(currentEntries) || currentEntries.length === 0) {
    return { text, savedChars: 0 };
  }
  const hasPrevious = Array.isArray(previousEntries) && previousEntries.length > 0;
  if (!hasPrevious) {
    return { text, savedChars: 0 };
  }
  const previousByName = new Map(
    (Array.isArray(previousEntries) ? previousEntries : []).map((entry) => [entry.name, entry]),
  );
  const changed = currentEntries.filter((entry) => {
    const previous = previousByName.get(entry.name);
    return previous === undefined || previous.description !== entry.description;
  });
  const removedCount = previousByName.size - currentEntries.filter((entry) => previousByName.has(entry.name)).length;
  const lines = ['<system-reminder>', INCREMENTAL_HEADER, '', '<available_skills>'];
  if (changed.length === 0) {
    lines.push(NO_CHANGE_NOTE);
  } else {
    for (const entry of changed) {
      const marker = previousByName.has(entry.name) ? ' (changed)' : '';
      if (keepDescription) {
        lines.push(`- \`${entry.name}\`${marker}: ${escapeText(entry.description)}`);
      } else {
        lines.push(`- \`${entry.name}\`${marker}`);
      }
    }
  }
  lines.push('</available_skills>', '');
  if (removedCount > 0) {
    lines.push(
      `${removedCount} skill(s) from the previous catalog are no longer available. Do not use their names.`,
      '',
    );
  }
  const unchanged = currentEntries.length - changed.length;
  lines.push(
    `All other ${unchanged} skill(s) are unchanged from the previous catalog and remain available.`,
    'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    '</system-reminder>',
  );
  const incremental = lines.join('\n');
  return { text: incremental, savedChars: Math.max(0, text.length - incremental.length) };
}

/**
 * 伪 XML 转义（与上游 dsh-skill/lib/index.js:91-93 的 escapeText 同口径）。
 *
 * @param {string} value 原始描述。
 * @returns {string} 转义后文本。
 */
function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export { toIncrementalCatalog, INCREMENTAL_HEADER, NO_CHANGE_NOTE };
