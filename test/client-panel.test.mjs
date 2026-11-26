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

const SECTION_KEYS = ['suppress', 'dedupe', 'skillCatalog', 'instructions', 'toolList', 'skillList', 'orderList'];

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

test('默认全部折叠：7 张卡片 body 都是 display:none，且门面板仍挂载', () => {
  const { tree, tokens, captured } = renderPanel();
  const styles = captured.STYLES;
  assert.equal(styles.cardBodyHidden.display, 'none', '折叠态必须是 display:none');
  assert.equal(styles.cardBody.display, 'flex', '展开态必须是 display:flex');
  assert.equal(countStyle(tree, styles.cardBodyHidden), 7, '默认 7 个模块全部折叠');
  assert.equal(countStyle(tree, styles.cardBody), 0, '默认无展开的卡片');
  assert.ok(tokens.includes('foldState{"n":0,"total":7}'), '顶部应显示已展开 0/7');
  const components = findNodes(tree, (n) => typeof n.type === 'function');
  // 两扇门 + 注入源排序面板：三者都必须在卡片内保持挂载，折叠不卸载。
  assert.equal(components.length, 3, '两扇门与排序面板必须保持挂载，折叠不卸载');
  const gates = components.filter((node) => node.props.embedded === true);
  assert.equal(gates.length, 2, '两扇门都以 embedded 挂载');
  for (const node of gates) {
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
  assert.equal(Object.keys(opened).length, 7, '全部展开应写入 7 个模块');
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
  assert.equal(countStyle(tree, captured.STYLES.cardBodyHidden), 6);
  assert.ok(tokens.includes('foldState{"n":1,"total":7}'), '计数应反映恢复后的展开数');

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
  assert.ok(tokens.includes('badgeOn{"on":2,"total":4}'), '外部拦截应有 2/4 项启用');
  assert.ok(tokens.includes('badgeOn{"on":1,"total":1}'), '去重卡片应显示 1/1');
  assert.ok(tokens.includes('badgeGateOn{"count":45,"denied":3}'), '工具名单徽标应显示已隐藏数');
  assert.ok(tokens.includes('badgeLoading'), '技能名单尚未回传时应显示读取中');

  const off = renderPanel({ values: [{}, { tools: { enabled: false, count: 45, denied: 0 }, skills: { error: true } }] });
  assert.ok(off.tokens.includes('badgeGateOff'), '名单关闭时徽标应说明未启用');
  assert.ok(off.tokens.includes('badgeGateFail'), '读取失败时徽标应说明不可用');
});

test('模型切换提示拦截开关已挂进外部拦截卡片且中英字典成对', () => {
  const { tokens } = renderPanel({ values: [allOpen()] });
  assert.ok(tokens.includes('fieldSupModelSel'), '卡片里应出现模型切换提示勾选项');
  for (const key of ['fieldSupModelSel', 'fieldSupModelSelHint']) {
    const count = (source.match(new RegExp(`(?<![A-Za-z0-9_])${key}:`, 'g')) || []).length;
    assert.equal(count, 2, `${key} 应中英各一处，实际 ${count}`);
  }
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

test('卡片头展开折叠按钮有亮色底色与边框，各模块格式一致', () => {
  const { tree, captured } = renderPanel();
  const s = captured.STYLES;
  assert.ok(s.cardHead.border && !/none/.test(String(s.cardHead.border)),
    '卡片头按钮必须有可见边框');
  assert.ok(s.cardHead.background && !/transparent/.test(String(s.cardHead.background)),
    '卡片头按钮必须有亮色底色');
  assert.ok(s.cardArrow.border && s.cardArrow.color,
    '展开折叠箭头本身也应高亮，便于看清');
  // 每张卡片都用一个 cardHead 按钮作为展开折叠入口。
  const heads = findNodes(tree, (n) => n.type === 'button' && n.props && n.props.style === s.cardHead);
  assert.equal(heads.length, 7, '7 个模块都应有同款的展开折叠按钮');
});

test('界面全部文案与注释无 AI- 代号残留', () => {
  assert.ok(!/AI-\d/.test(source), '源码中不应残留 AI-1/AI-4 等内部代号');
});

test('注入源管理新增能力中英字典成对：展开/编辑/恢复默认/隐藏', () => {
  for (const key of [
    'orderHideHint', 'orderExpand', 'orderCollapse', 'orderResetOne',
    'orderResetAll', 'orderEdited', 'orderFullText', 'orderEdit',
    'orderCancelEdit', 'orderEmptyText',
  ]) {
    const count = (source.match(new RegExp(`(?<![A-Za-z0-9_])${key}:`, 'g')) || []).length;
    assert.equal(count, 2, `${key} 应中英各一处，实际 ${count}`);
  }
});

test('注入源排序面板渲染全文、展开/折叠、编辑、隐藏复选框', () => {
  // 直接渲染 InjectOrderSection：按 useState/useRef 调用顺序喂入快照与草案。
  let captured = null;
  const data = {
    ok: true,
    sections: [{ name: 'sec-a', order: 0, text: 'FULL SECTION TEXT', summary: 'FULL SECTION TEXT', overridden: false, hidden: false }],
    contexts: [{ name: 'ctx-a', order: 0, text: 'CTX FULL TEXT', summary: 'CTX FULL TEXT', overridden: false, hidden: false }],
    capturedAt: 0,
  };
  const draft = {
    sections: ['sec-a'], contexts: ['ctx-a'],
    texts: { 'sec-a': 'FULL SECTION TEXT', 'ctx-a': 'CTX FULL TEXT' },
    hidden: { 'sec-a': false, 'ctx-a': true }, edits: {}, reset: [],
  };
  // 槽序（useRef 不消耗 useState 槽位）：0 data / 1 err / 2 busy / 3 status / 4 draft / 5 expanded / 6 editing
  const seed = { values: [data, '', false, '', draft, {}, {}], cursor: 0, effects: [] };
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
  const styles = captured.STYLES;
  const tree = captured.InjectOrderSection({ t, styles });

  // 两条注入项各一个激活复选框，其中隐藏项 unchecked。
  const checkboxes = findNodes(tree, (n) => n.type === 'input' && n.props.type === 'checkbox');
  assert.equal(checkboxes.length, 2, '每条注入项都应有激活/隐藏复选框');
  assert.equal(checkboxes[0].props.checked, true, '未隐藏项复选框应为选中');
  assert.equal(checkboxes[1].props.checked, false, '隐藏项复选框应为未选中');

  const tokens = tokensOf(tree);
  assert.ok(tokens.includes('orderResetAll'), '应有全部恢复默认按钮');

  // 展开/上移/下移按钮用 title 暴露文案，逐一定位。
  const expandBtns = findNodes(tree, (n) => n.type === 'button' && n.props.title === 'orderExpand');
  const upBtns = findNodes(tree, (n) => n.type === 'button' && n.props.title === 'orderUp');
  const downBtns = findNodes(tree, (n) => n.type === 'button' && n.props.title === 'orderDown');
  assert.ok(upBtns.length > 0 && downBtns.length > 0, '上下移按钮仍在');
  assert.equal(expandBtns.length, 2, '每项一个展开按钮');
  expandBtns[0].props.onClick();
  const nextExpanded = typeof seed.values[5] === 'function' ? seed.values[5]({}) : seed.values[5];
  assert.equal(nextExpanded['sections:sec-a'], true, '点击展开应记录该行展开态');

  assert.ok(styles.orderPre && styles.orderTextarea && styles.orderRowHidden,
    '样式表应含全文展示、编辑框、隐藏态三套样式');
});

test('设置页注册为一级独立页面 settings.section，不再挂在内置插件页签下', () => {
  assert.ok(source.includes("ctx.slots.inject(\n                'settings.section'"),
    '必须注册到 settings.section 一级导航槽位');
  assert.ok(!/slots\.inject\(\s*['"]settings\.plugins\.tab['"]/.test(source),
    '不应再注册到 settings.plugins.tab（内置插件页内标签）');
  assert.ok(source.includes("name: 'settings.section'"), '注册的槽位名必须是 settings.section');
  assert.ok(/id: 'injection-tune'/.test(source), '独立页面 id 应保持 injection-tune');
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

test('工具门徽标：后端只给 deniedCount 时也要报出隐藏数（回归）', async () => {
  // 组件用的是模块闭包里的 react，必须复用 renderPanel 建的那份 seed。
  const { captured, seed } = renderPanel();
  // 后端 tool-gate.js snapshot() 的真实形状：有 deniedCount，没有 hiddenCount。
  const backendJson = {
    ok: true, enabled: true, budget: 320,
    groups: [], agents: 0,
    totals: { count: 76, deniedCount: 41, chars: 1000, tokens: 250, deniedTokens: 120 },
  };

  const reports = [];
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve(backendJson) });

  const tree = captured.ToolGateSection({
    t: (key, params) => (params ? `${key}${JSON.stringify(params)}` : key),
    styles: captured.STYLES,
    onStats: (stats) => reports.push(stats),
  });
  assert.ok(tree, '工具门组件应能渲染');

  // 触发 useEffect 里的首次 GET，并等 fetch 链跑完。
  for (const fn of seed.effects.slice()) fn();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(reports.length > 0, true, '首次加载必须回传统计');
  const last = reports[reports.length - 1];
  assert.equal(last.error, undefined, '不应报错');
  assert.equal(last.count, 76, '总数应取 totals.count');
  assert.equal(last.denied, 41, '隐藏数必须取 totals.deniedCount，而不是恒为 0');
});
