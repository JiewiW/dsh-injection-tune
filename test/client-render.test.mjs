/**
 * test/client-render.test.mjs —— 在 node 里把 lib/client.js 当 cordis client bundle
 * 跑一遍，用假 react 渲染 ToolGateSection，守住 AI-4 列表的交互语义。
 *
 * 覆盖：
 *   1. 三种数据态（加载中 / 有数据 / 出错）都能渲染；
 *   2. 勾选语义 = 激活（deny 里的工具不勾）；
 *   3. 排序只改框内顺序：按名称正/倒序、按激活情况；
 *   4. 折叠后不渲染工具行，框头保留；
 *   5. 排序条与正/倒序切换都在；
 *   6. 中英字典成对。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const FILE = new URL('../lib/client.js', import.meta.url);
const source = fs.readFileSync(FILE, 'utf8');

/**
 * 造一个最小 react 替身。
 *
 * useState 按**调用序号**取值：给多少种子就用多少，剩下的走 initial。
 * 这样测试可以只覆盖关心的那几个 state（排序、正倒序、折叠表）而不必列全。
 *
 * @param {{values: Array, cursor: number, effects: Array}} seed 状态种子。
 * @returns {object} react 替身。
 */
function makeReact(seed) {
  return {
    createElement(type, props, ...children) {
      const flat = children.flat ? children.flat(Infinity) : children;
      return { type, props: props || {}, children: flat.filter((c) => c !== null && c !== undefined) };
    },
    useState(initial) {
      const slot = seed.cursor;
      seed.cursor += 1;
      const value = slot < seed.values.length ? seed.values[slot] : initial;
      return [value, (next) => { seed.values[slot] = next; }];
    },
    useRef(initial) { return { current: initial }; },
    useEffect(fn) { seed.effects.push(fn); },
    useSyncExternalStore(get) { return get(); },
  };
}

/** 把渲染树拉平成文本，用来做"这段文案有没有出现"的断言。 */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return (node.children || []).map(textOf).join(' ');
}

/** 按渲染顺序收集所有 checkbox 的 props（第一个是总开关，其后是各分框的工具行）。 */
function checkboxes(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) checkboxes(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (node.type === 'input' && node.props && node.props.type === 'checkbox') out.push(node.props);
  for (const child of node.children || []) checkboxes(child, out);
  return out;
}

/** 加载 bundle 并渲染一次。 */
function render(values) {
  let captured = null;
  const seed = { values, cursor: 0, effects: [] };
  const react = makeReact(seed);
  const requireStub = (id) => {
    if (id === 'react') return react;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
    throw new Error(`unexpected require: ${id}`);
  };
  globalThis.window = {
    __ModuleLoader__: { load({ factory }) { captured = factory(requireStub); } },
  };
  new Function(source)();

  const t = (key, params) => {
    if (!params) return key;
    return Object.keys(params).reduce(
      (acc, name) => acc.replace(new RegExp(`\\{${name}\\}`, 'g'), String(params[name])),
      key,
    );
  };
  const styles = new Proxy({}, { get: () => ({}) });
  const tree = captured.ToolGateSection({ t, styles });
  return { text: textOf(tree), tree, effects: seed.effects };
}

const SNAPSHOT = {
  ok: true,
  enabled: true,
  deny: ['browser_open'],
  updatedAt: '2026-10-30T00:00:00.000Z',
  agents: 2,
  totals: { count: 2, deniedCount: 1, chars: 800, tokens: 204, deniedTokens: 120 },
  groups: [{
    source: 'dsh-builtin-browser',
    label: 'dsh-builtin-browser',
    reason: 'prefix',
    tokens: 150,
    chars: 600,
    deniedCount: 1,
    tools: [
      { name: 'browser_open', summary: '打开一个浏览器标签页并导航到指定 URL。', chars: 400, tokens: 104, critical: false, denied: true },
      { name: 'read', summary: 'Read a UTF-8 text file.', chars: 200, tokens: 54, critical: true, denied: false },
    ],
  }],
};

test('三种数据态都能渲染', () => {
  const loading = render([null, '', true]);
  assert.ok(loading.text.includes('gateTitle'));
  assert.ok(loading.text.includes('gateLoading'));
  assert.equal(loading.effects.length, 1, '应注册一次拉取 effect');

  const ready = render([SNAPSHOT, '', false]);
  for (const token of ['gateEnable', 'gateSummary', 'gateRefresh', 'gateAgents',
    'dsh-builtin-browser', 'gateReason_prefix', 'browser_open', '打开一个浏览器标签页并导航到指定 URL。',
    'gateFuncPrefix', 'gateCritical', 'gateHiddenTag', '≈104 tok']) {
    assert.ok(ready.text.includes(token), `有数据渲染缺少：${token}`);
  }

  const failed = render([null, 'boom', false]);
  assert.ok(failed.text.includes('boom'));
});

test('勾选语义是激活：deny 里的工具不勾', () => {
  const boxes = checkboxes(render([SNAPSHOT, '', false]).tree);
  // 1 总开关 + 1 精简开关 + 每工具 2 个（激活 + 豁免）× 2 工具 = 6。
  assert.equal(boxes.length, 6, `应有 1 总开关 + 1 精简开关 + 2×(激活+豁免)，实际 ${boxes.length}`);
  assert.equal(boxes[0].checked, true, '总开关应勾选');
  assert.equal(boxes[1].checked, false, '精简开关默认关闭');
  // 默认按名称正序：browser_open（已隐藏）在 read 之前；每行先激活框后豁免框。
  assert.equal(boxes[2].checked, false, '被隐藏的 browser_open 不应勾选');
  assert.equal(boxes[3].checked, false, '豁免框默认不勾');
  assert.equal(boxes[4].checked, true, '已激活的 read 应勾选');
  assert.equal(boxes[5].checked, false, 'read 的豁免框默认不勾');
});

test('排序只改框内顺序', () => {
  const asc = checkboxes(render([SNAPSHOT, '', false, 'name', false]).tree);
  const desc = checkboxes(render([SNAPSHOT, '', false, 'name', true]).tree);
  const byState = checkboxes(render([SNAPSHOT, '', false, 'state', false]).tree);
  // 跳过前 2 个（总开关+精简开关），每工具 2 个框，只看激活框（偶数位）。
  const activeBoxes = (list) => list.slice(2).filter((_, i) => i % 2 === 0).map((b) => b.checked);
  assert.deepEqual(activeBoxes(asc), [false, true], '按名称正序：browser_open, read');
  assert.deepEqual(activeBoxes(desc), [true, false], '按名称倒序应翻转');
  assert.deepEqual(activeBoxes(byState), [true, false], '按激活情况：激活的排前');
});

test('折叠后不渲染工具行但保留框头', () => {
  const folded = render([SNAPSHOT, '', false, 'name', false, { 'dsh-builtin-browser': true }]);
  assert.equal(checkboxes(folded.tree).length, 2, '折叠后只剩总开关与精简开关');
  assert.ok(folded.text.includes('dsh-builtin-browser'));
  assert.ok(!folded.text.includes('browser_open'), '折叠后不应渲染工具行');
  assert.ok(folded.text.includes('▸'), '折叠时箭头应为 ▸');
});

test('排序条与正倒序切换都在', () => {
  const ready = render([SNAPSHOT, '', false]);
  for (const token of ['gateSortLabel', 'gateSortName', 'gateSortState']) {
    assert.ok(ready.text.includes(token), `排序条缺少：${token}`);
  }
  assert.ok(ready.text.includes('gateSortAsc'), '默认应显示正序');
  assert.ok(render([SNAPSHOT, '', false, 'name', true]).text.includes('gateSortDesc'), '倒序时应显示倒序');
});

test('中英字典成对', () => {
  for (const key of ['gateTitle', 'gateHint', 'gateEnable', 'gateGroupMeta', 'gateReason_capture',
    'gateSortLabel', 'gateSortName', 'gateSortState', 'gateSortAsc', 'gateSortDesc',
    'gateExpand', 'gateCollapse', 'gateHiddenTag']) {
    const count = (source.match(new RegExp(`${key}:`, 'g')) || []).length;
    assert.equal(count, 2, `${key} 应中英各一处，实际 ${count}`);
  }
});
