/**
 * test/client-panel.test.mjs —— 设置页「注入调优」面板的结构回归。
 *
 * 覆盖：
 *   1. 6 个模块按「自动精简 → 注入名单」两类重排，顺序固定；
 *   2. 默认全部折叠，顶部总折叠开关可一键全展开/全折叠；
 *   3. 折叠状态读写 localStorage，node 环境缺 localStorage 时安全退化；
 *   4. 卡片头状态徽标（自动精简计数 / 名单异步统计）；
 *   5. 界面标题不再暴露 AI-x 内部代号，中英字典成对；
 *   6. 两扇门以 embedded + onStats 挂进卡片（折叠不卸载、统计可回传）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const FILE = new URL('../lib/client.js', import.meta.url);
const source = fs.readFileSync(FILE, 'utf8');

const SECTION_KEYS = ['suppress', 'dedupe', 'skillCatalog', 'instructions', 'toolList', 'skillList'];

/** 假 localStorage：每个用例独立一份，避免互相污染。 */
function makeStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
  };
}

/** 最小 react 替身：useState 按调用序号取值，组件函数只建节点不执行。 */
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

/** 把渲染树拉平成文本 token 列表。 */
function tokensOf(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) tokensOf(child, out); return out; }
  for (const child of node.children || []) tokensOf(child, out);
  return out;
}

/** 找出所有满足条件的节点。 */
function findNodes(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) findNodes(child, predicate, out); return out; }
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) findNodes(child, predicate, out);
  return out;
}

/** 面板用模块级样式对象；按引用计数，不会把内联 display:flex 误算成展开卡片。 */
function countStyle(node, styleObject) {
  return findNodes(node, (n) => n.props && n.props.style === styleObject).length;
}

/**
 * 渲染 InjectionTuneTab。
 *
 * @param {{values?: Array, storage?: object|null, config?: object}} options 种子。
 * @returns {{tree: object, tokens: Array<string>, seed: object}} 渲染结果。
 */
function renderPanel(options = {}) {
  const { values = [], storage = null, config = {} } = options;
  if (storage === null) delete globalThis.localStorage;
  else globalThis.localStorage = storage;

  let captured = null;
  const seed = { values: values.slice(), cursor: 0, effects: [] };
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

  const t = (key, params) => (params ? `${key}${JSON.stringify(params)}` : key);
  const scope = {
    getSnapshot: () => ({
      value: config, base: {}, user: {}, revision: 1, status: 'ready', writable: true,
    }),
    mutate: () => {},
    subscribe: () => () => {},
  };
  const tree = captured.InjectionTuneTab({ t, scope });
  return { tree, tokens: tokensOf(tree), seed, captured };
}

/** 全部展开的 openMap 种子。 */
function allOpen() {
  const map = {};
  for (const key of SECTION_KEYS) map[key] = true;
  return map;
}

test('模块分成两类并重排：自动精简在前、注入名单在后', () => {
  const { tokens } = renderPanel();
  const order = ['catAutoTitle', 'sectionSup', 'sectionDedupe', 'sectionSkill', 'sectionInstr',
    'catListTitle', 'gateTitle', 'skillGateTitle'];
  let previous = -1;
  for (const key of order) {
    const at = tokens.indexOf(key);
    assert.ok(at >= 0, `缺少标题：${key}`);
    assert.ok(at > previous, `${key} 应排在上一项之后（实际 index ${at} <= ${previous}）`);
    previous = at;
  }
  // 分类提示语必须紧随分类标题，且不在卡片内部重复。
  assert.equal(tokens.filter((x) => x === 'catAutoHint').length, 1);
  assert.equal(tokens.filter((x) => x === 'catListHint').length, 1);
});

test('默认全部折叠：6 张卡片 body 都是 display:none，且门面板仍挂载', () => {
  const { tree, tokens, captured } = renderPanel();
  const styles = captured.STYLES;
  assert.equal(styles.cardBodyHidden.display, 'none', '折叠态必须是 display:none');
  assert.equal(styles.cardBody.display, 'flex', '展开态必须是 display:flex');
  assert.equal(countStyle(tree, styles.cardBodyHidden), 6, '默认 6 个模块全部折叠');
  assert.equal(countStyle(tree, styles.cardBody), 0, '默认无展开的卡片');
  assert.ok(tokens.includes('foldState{"n":0,"total":6}'), '顶部应显示已展开 0/6');
  const components = findNodes(tree, (n) => typeof n.type === 'function');
  assert.equal(components.length, 2, '两扇门必须保持挂载，折叠不卸载');
  for (const node of components) {
    assert.equal(node.props.embedded, true, '门面板在卡片内不应重复渲染自己的标题框');
    assert.equal(typeof node.props.onStats, 'function', '门面板必须能回传统计给卡片徽标');
  }
});

test('顶部总折叠开关：全部展开 / 全部折叠都写回状态与 localStorage', () => {
  const storage = makeStorage();
  const { tree, seed } = renderPanel({ storage });
  const buttons = findNodes(tree, (n) => n.type === 'button');
  const expand = buttons.find((n) => (n.children || []).includes('unfoldAll'));
  const collapse = buttons.find((n) => (n.children || []).includes('foldAll'));
  assert.ok(expand && collapse, '两个总折叠按钮都要在');

  expand.props.onClick();
  const opened = seed.values[0];
  assert.equal(Object.keys(opened).length, 6, '全部展开应写入 6 个模块');
  assert.ok(SECTION_KEYS.every((key) => opened[key] === true));
  const saved = JSON.parse(storage.map.get('dsh-injection-tune:fold-v1'));
  assert.ok(SECTION_KEYS.every((key) => saved[key] === true), '展开状态应持久化');

  collapse.props.onClick();
  const closed = seed.values[0];
  assert.ok(SECTION_KEYS.every((key) => closed[key] === false), '全部折叠应写入全 false');
});

test('逐卡片折叠 + 从 localStorage 恢复', () => {
  const storage = makeStorage({ 'dsh-injection-tune:fold-v1': JSON.stringify({ suppress: true }) });
  const { tree, tokens, captured } = renderPanel({ storage });
  assert.equal(countStyle(tree, captured.STYLES.cardBody), 1, '只恢复展开了 suppress 一张卡片');
  assert.equal(countStyle(tree, captured.STYLES.cardBodyHidden), 5);
  assert.ok(tokens.includes('foldState{"n":1,"total":6}'), '计数应反映恢复后的展开数');

  // 点击第 2 张卡片头切换折叠：setOpenMap 收到翻转后的 map。
  const { tree: tree2, seed, captured: captured2 } = renderPanel({ storage });
  const heads = findNodes(tree2, (n) => n.type === 'button' && n.props && n.props.style === captured2.STYLES.cardHead);
  assert.ok(heads.length >= 6, `应有 6 个可点击卡片头，实际 ${heads.length}`);
  heads[1].props.onClick();
  assert.equal(seed.values[0].dedupe, true, '点击第二张卡片头应展开它');
  assert.equal(seed.values[0].suppress, true, '已展开的第一张应保持展开');
});

test('卡片头状态徽标：自动精简计数 + 名单异步统计', () => {
  const stats = {
    tools: { enabled: true, count: 45, denied: 3 },
    skills: null,
  };
  const { tokens } = renderPanel({
    values: [{}, stats],
    config: { dedupeRuntimeContext: true, suppressACPSection: false },
  });
  assert.ok(tokens.includes('badgeOn{"on":2,"total":3}'), '外部拦截应有 2/3 项启用');
  assert.ok(tokens.includes('badgeOn{"on":1,"total":1}'), '去重卡片应显示 1/1');
  assert.ok(tokens.includes('badgeGateOn{"count":45,"denied":3}'), '工具名单徽标应显示已隐藏数');
  assert.ok(tokens.includes('badgeLoading'), '技能名单尚未回传时应显示读取中');

  const off = renderPanel({ values: [{}, { tools: { enabled: false, count: 45, denied: 0 }, skills: { error: true } }] });
  assert.ok(off.tokens.includes('badgeGateOff'), '名单关闭时徽标应说明未启用');
  assert.ok(off.tokens.includes('badgeGateFail'), '读取失败时徽标应说明不可用');
});

test('界面标题不再出现 AI-x 代号，中英字典成对', () => {
  assert.ok(!/sectionSup: 'AI-/.test(source), '外部拦截标题不应带 AI-4/5/6');
  assert.ok(!/gateTitle: 'AI-/.test(source), '工具名单标题不应带 AI-4');
  assert.ok(!/skillGateTitle: 'AI-/.test(source), '技能名单标题不应带 AI-7');
  for (const key of ['catAutoTitle', 'catAutoHint', 'catListTitle', 'catListHint',
    'foldAll', 'unfoldAll', 'foldState', 'badgeOn', 'badgeGateOff', 'badgeGateOn',
    'badgeLoading', 'badgeGateFail', 'sectionSup', 'sectionDedupe', 'sectionSkill',
    'sectionInstr', 'gateTitle', 'skillGateTitle']) {
    const count = (source.match(new RegExp(`(?<![A-Za-z0-9_])${key}:`, 'g')) || []).length;
    assert.equal(count, 2, `${key} 应中英各一处，实际 ${count}`);
  }
});

test('挂载链路：InjectionTuneTab 作为组件节点渲染，钩子独立', () => {
  assert.ok(source.includes('react.createElement(InjectionTuneTab, { t: t, scope: scope })'),
    '不能退回直接调用（hooks 会挂到父组件上，折叠态会串）');
  assert.ok(source.includes('exports.InjectionTuneTab'), '需导出供测试渲染');
  // unavailable 分支在 hooks 之后，早退不会打乱 hook 顺序。
  const early = source.indexOf("if (snap.status === 'unavailable')");
  const firstHook = source.indexOf('react.useState(readFoldState())');
  assert.ok(firstHook > 0 && firstHook < early, '两个视图 state 必须在早退之前');
});
