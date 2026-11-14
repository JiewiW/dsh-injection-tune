/**
 * test/tool-gate.test.mjs —— 工具可见性门的单元测试（node:test + ESM）。
 *
 * 为什么单独一个 .mjs：`test/host.test.js` 是 CJS 的 `require(...)`，而本包已转 ESM
 * （type: module），那个文件在 Node 22 下会直接报错。这里不再往坏掉的壳里加用例，
 * 用 `.mjs` + `npm run test:gate` 单独跑。
 *
 * 覆盖：
 *   1. 工具清单按注册来源分框（对照表 / 前缀 / 未识别）；
 *   2. 描述 → 完整功能说明（去 Markdown、压成单段、不截断）；
 *   3. 开启后对每个 agent 装 restrict({deny})，关闭后撤销；
 *   4. 未知工具名（已卸载）必须被交集筛掉，绝不把 restrict 打挂；
 *   5. toggle 单条、名单去重。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** 每个用例一个独立 HOME，避免用例之间共享 sidecar 状态。 */
function isolateHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gate-'));
  process.env.USERPROFILE = dir;
  process.env.HOME = dir;
  return dir;
}

/** tools 服务替身：原型有 register；view(scope) 按作用域返回不同视图。 */
class FakeTools {
  constructor(views) {
    this.views = views;
    this.restrictCalls = [];
    this.active = null;
  }
  register(definition) { this.registered = definition?.name; return () => {}; }
  view(scope) {
    const map = scope === undefined ? this.views.global : this.views.agent;
    return { visible: map, restrictableNames: new Set(map.keys()) };
  }
  restrict(filter) {
    this.restrictCalls.push(filter);
    this.active = filter;
    return () => { this.active = null; };
  }
  /** 与内核 schemaOf 同语义的单条投影（包装测试的基准）。 */
  schemaOf(definition) {
    return { name: definition.name, description: definition.description, parameters: definition.parameters };
  }
}

const AGENT_DEFS = new Map([
  // 描述故意超过旧版 58 字符上限：断言完整下发，不补省略号（界面负责换行）。
  // 四个完整句：精简模式用例需要「多于 3 句」的夹具，3 句会按原样返回。
  ['read', { name: 'read', description: 'Read a UTF-8 text file. Use offset/limit to page.\n\nPaths are resolved against the workspace root; binary files are rejected. Never read files above the workspace root.', parameters: { type: 'object' } }],
  ['browser_open', { name: 'browser_open', description: '打开一个浏览器标签页并导航到指定 URL。', parameters: {} }],
  ['memory_note', { name: 'memory_note', description: 'Write a note into long-term memory. Notes persist across sessions. Keep each note short. Use tags to group related notes. Notes are visible to later sessions through recall.', parameters: {} }],
  ['mystery_tool', { name: 'mystery_tool', description: 'Something nobody claims.', parameters: {} }],
]);

/** 搭一个最小宿主：ctx.tools / ctx.logger / ctx.on / ctx.get('agents')。 */
async function createHarness(moduleUrl) {
  const { createToolGate } = await import(moduleUrl);
  const scopedTools = new FakeTools({ global: new Map(), agent: AGENT_DEFS });
  const globalTools = new FakeTools({ global: new Map(), agent: AGENT_DEFS });
  const agents = [{ id: 'a1', ctx: { tools: scopedTools } }];
  const logs = [];
  // createToolGate 收到的是 `ctx.inject` 回调里的上下文：服务直接挂在它上面。
  const scope = {
    tools: globalTools,
    agents: { list: () => agents },
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    on: () => () => {},
  };
  return { gate: createToolGate(scope, scope.logger), scopedTools, logs };
}

const MODULE_URL = new URL('../lib/tool-gate.js', import.meta.url).href;

/**
 * 真实内核的 Tools 服务是**单实例**：agent.ctx.tools 与插件级 ctx.tools 指向它，
 * restrict 装在 layers 上，view(agent).visible 会过滤 deny，而 knownNames /
 * restrictableNames 保留限制之前的名字事实。上面那个 FakeTools 两个实例是老用例
 * 的历史夹具，这里另做一个能复现「已隐藏工具从 visible 消失」的替身。
 */
class ScopedFakeTools {
  constructor(allDefs, globalNames) {
    this.allDefs = allDefs;
    this.globalNames = globalNames;
    this.deny = new Set();
  }
  register() { return () => {}; }
  view(scope) {
    const isGlobal = scope === undefined;
    const names = isGlobal ? this.globalNames : [...this.allDefs.keys()];
    const visible = new Map();
    for (const name of names) {
      if (!isGlobal && this.deny.has(name)) continue;
      visible.set(name, this.allDefs.get(name));
    }
    return { visible, knownNames: new Set(names), restrictableNames: new Set(names) };
  }
  restrict(filter) {
    this.deny = new Set(filter.deny ?? []);
    return () => { this.deny = new Set(); };
  }
  schemaOf(definition) {
    return { name: definition.name, description: definition.description, parameters: definition.parameters };
  }
}

/** 只有 read 注册在全局层；mystery_tool 只活在 agent 层，且来源未识别。 */
async function createScopedHarness(moduleUrl) {
  const { createToolGate } = await import(moduleUrl);
  const defs = new Map([
    ['read', { name: 'read', description: 'Read a UTF-8 text file.', parameters: { type: 'object' } }],
    ['mystery_tool', { name: 'mystery_tool', description: 'Agent-plane only, source unknown.', parameters: {} }],
  ]);
  const tools = new ScopedFakeTools(defs, ['read']);
  const agents = [{ id: 'a1', ctx: { tools } }];
  const scope = {
    tools,
    agents: { list: () => agents },
    logger: { info: () => {}, warn: () => {} },
    on: () => () => {},
  };
  return { gate: createToolGate(scope, scope.logger), tools };
}

test('按注册来源分框、描述完整下发（不省略）', async () => {
  isolateHome();
  const { gate } = await createHarness(MODULE_URL);
  try {
    const snapshot = gate.snapshot();
    assert.equal(snapshot.totals.count, 4);
    const reasons = Object.fromEntries(snapshot.groups.map((g) => [g.label, g.reason]));
    assert.equal(reasons['@deepseek-ai/dsh-tool-fs'], 'table');
    assert.equal(reasons['dsh-builtin-browser'], 'prefix');
    assert.equal(reasons['@a9i5k4/dsh-auto-memory'], 'prefix');
    assert.equal(reasons['未识别来源'], 'none');

    const tools = snapshot.groups.flatMap((g) => g.tools);
    const read = tools.find((t) => t.name === 'read');
    // 跨行的 Markdown 正文压成单段，但内容一个字都不许少。
    assert.equal(read.summary, 'Read a UTF-8 text file. Use offset/limit to page. Paths are resolved against the workspace root; binary files are rejected. Never read files above the workspace root.');
    assert.ok(!read.summary.includes('…'), '长描述不得补省略号');
    assert.equal(read.critical, true);
    assert.equal(tools.find((t) => t.name === 'browser_open').summary, '打开一个浏览器标签页并导航到指定 URL。');
  } finally {
    gate.dispose();
  }
});

test('开启后装 restrict，关闭后撤销', async () => {
  isolateHome();
  const { gate, scopedTools } = await createHarness(MODULE_URL);
  try {
    const updated = gate.update({ enabled: true, deny: ['browser_open'] });
    assert.equal(updated.enabled, true);
    assert.deepEqual(scopedTools.restrictCalls, [{ deny: ['browser_open'] }]);
    assert.equal(updated.groups.flatMap((g) => g.tools).find((t) => t.name === 'browser_open').denied, true);
    assert.ok(updated.totals.deniedTokens > 0);

    gate.update({ enabled: false });
    assert.equal(scopedTools.active, null);
  } finally {
    gate.dispose();
  }
});

test('未知工具名被交集筛掉，不会打挂 restrict', async () => {
  isolateHome();
  const { gate, scopedTools } = await createHarness(MODULE_URL);
  try {
    gate.update({ enabled: true, deny: ['read', 'ghost_tool'] });
    assert.deepEqual(scopedTools.restrictCalls[0], { deny: ['read'] });
  } finally {
    gate.dispose();
  }
});

test('toggle 单条并去重落盘', async () => {
  isolateHome();
  const { gate } = await createHarness(MODULE_URL);
  try {
    const once = gate.update({ toggle: { name: 'memory_note', denied: true } });
    assert.deepEqual(once.deny, ['memory_note']);
    const twice = gate.update({ deny: ['memory_note', 'memory_note', ''] });
    assert.deepEqual(twice.deny, ['memory_note']);
    const off = gate.update({ toggle: { name: 'memory_note', denied: false } });
    assert.deepEqual(off.deny, []);
  } finally {
    gate.dispose();
  }
});

// ── 精简模式（slim）─────────────────────────────────────────────────────────

test('slimDescription：加权裁剪——预算内原样，超预算保纪律句、裁叙述句', async () => {
  const { slimDescription } = await import(MODULE_URL);
  const four = 'First sentence. Second one! Third? Fourth here. Fifth tail.';
  // 全文低于预算 → 原样返回（不引入空格虚胖）。
  assert.equal(slimDescription(four), four);
  // 压预算：第 1 句恒留，其余按分装预算。
  const tight = slimDescription(four, 30);
  assert.ok(tight.startsWith('First sentence.'), '第 1 句恒留');
  assert.ok(tight.length <= 30 + 15, '装入预算（允许最后一句整句略超出的空隙由实现决定，这里放宽到一句长）');
  assert.equal(slimDescription(undefined), '');
  assert.equal(slimDescription(null), '');
  assert.equal(slimDescription(''), '');
  // 纪律句加权：never 句优先于普通叙述句。
  const mixed = 'This tool paints pixels. You must close the file first. Colors look nice.';
  const picked = slimDescription(mixed, 60);
  assert.ok(picked.includes('must close the file'), 'must 纪律句应保留');
  assert.ok(!picked.includes('Colors look nice'), '弱叙述句被裁');
  // 中文纪律句。
  const zh = '这个工具用来整理目录。禁止删除系统文件。界面很美观。';
  const zhPicked = slimDescription(zh, 20);
  assert.ok(zhPicked.includes('禁止删除系统文件'), '中文禁止句应保留');
});

test('精简模式：预算可调且夹紧，update 落盘、snapshot 回传，schemaOf 投影按状态生效', async () => {
  isolateHome();
  const { gate, scopedTools, globalTools } = await createHarness(MODULE_URL);
  const definition = AGENT_DEFS.get('read');
  try {
    // 默认关：投影原样。
    assert.equal(gate.snapshot().slim, false);
    assert.equal(gate.snapshot().budget, 320);
    assert.equal(scopedTools.schemaOf(definition).description, definition.description);

    // 预算夹紧：越界回落边界值。
    assert.equal(gate.update({ budget: 1 }).budget, 80);
    assert.equal(gate.update({ budget: 99999 }).budget, 4000);
    assert.equal(gate.update({ budget: 150 }).budget, 150);

    const slimOn = gate.update({ slim: true });
    assert.equal(slimOn.slim, true);
    // 同一 class 原型：globalTools / scopedTools 共享包装，都生效。
    const projected = scopedTools.schemaOf(definition);
    assert.notEqual(projected.description, definition.description);
    assert.ok(projected.description.length < definition.description.length);
    assert.ok(projected.description.includes('Never read files above'), 'never 纪律句按权重保留');
    assert.ok(!projected.description.includes('Use offset/limit'), '无权重叙述句被裁');
    // 投影是新对象，存储里的 definition 原封不动。
    assert.equal(definition.description.includes('workspace root'), true);
    assert.deepEqual(Object.keys(projected).sort(), ['description', 'name', 'parameters'].sort());

    // 豁免：read 恢复完整，其余仍精简。
    const withExempt = gate.update({ exemptToggle: { name: 'read', exempt: true } });
    assert.deepEqual(withExempt.exempt, ['read']);
    assert.equal(scopedTools.schemaOf(definition).description, definition.description);
    const other = scopedTools.schemaOf(AGENT_DEFS.get('memory_note'));
    assert.notEqual(other.description, AGENT_DEFS.get('memory_note').description);

    // 豁免可撤销。
    gate.update({ exemptToggle: { name: 'read', exempt: false } });
    assert.notEqual(scopedTools.schemaOf(definition).description, definition.description);

    // snapshot 每工具带 slimTokens 与 exempt。
    const snap = gate.snapshot();
    const row = snap.groups.flatMap((g) => g.tools).find((t) => t.name === 'read');
    assert.equal(typeof row.slimTokens, 'number');
    assert.equal(row.exempt, false);

    // 关掉精简：全体恢复原样；豁免名单与预算保留。
    const slimOff = gate.update({ slim: false });
    assert.equal(slimOff.slim, false);
    assert.equal(scopedTools.schemaOf(definition).description, definition.description);
    assert.equal(slimOff.budget, 150);
    assert.deepEqual(globalTools === scopedTools, false);
  } finally {
    gate.dispose();
  }
});

test('preview：按需返回裁剪明细（kept 标记 + slim 文本），未知工具 found:false', async () => {
  isolateHome();
  const { gate } = await createHarness(MODULE_URL);
  try {
    gate.update({ slim: true, budget: 150 });
    const probe = gate.preview('read');
    assert.equal(probe.ok, true);
    assert.equal(probe.found, true);
    assert.equal(probe.budget, 150);
    assert.equal(probe.exempt, false, '精简开启且未豁免 → 生效中');
    assert.ok(Array.isArray(probe.parts) && probe.parts.length > 1, '原文切成多句');
    assert.equal(probe.parts[0].kept, true, '第 1 句恒留');
    assert.ok(probe.parts.some((p) => p.kept && p.text.includes('Never')), '纪律句标 kept');
    assert.ok(probe.parts.some((p) => !p.kept), '有被裁的句子才有对照意义');
    assert.ok(probe.slim.includes('Never'), 'slim 文本含纪律句');
    assert.ok(probe.slim.length < probe.original.length, 'slim 短于原文');

    // 豁免后：exempt=true，parts 仍是全 kept 之外的明细无关紧要，slim 应为原文。
    gate.update({ exemptToggle: { name: 'read', exempt: true } });
    const exempted = gate.preview('read');
    assert.equal(exempted.exempt, true);
    assert.equal(exempted.slim, AGENT_DEFS.get('read').description);

    // 精简关：同样视为未生效。
    gate.update({ slim: false, exemptToggle: { name: 'read', exempt: false } });
    assert.equal(gate.preview('read').exempt, true);

    // 未知工具。
    const missing = gate.preview('no_such_tool');
    assert.equal(missing.found, false);
  } finally {
    gate.dispose();
  }
});

test('dispose 后投影回到透传（精简不再生效）', async () => {
  isolateHome();
  const { gate, scopedTools } = await createHarness(MODULE_URL);
  const definition = AGENT_DEFS.get('read');
  gate.update({ slim: true, budget: 150 });
  assert.notEqual(scopedTools.schemaOf(definition).description, definition.description);
  gate.dispose();
  assert.equal(scopedTools.schemaOf(definition).description, definition.description);
});

// ── 回归：已停用的工具必须留在名单里，否则设置页连恢复入口都没有 ────────────

test('隐藏 agent 层工具：「未识别来源」分组不消失，置灰态与节省统计都在', async () => {
  isolateHome();
  const { gate } = await createScopedHarness(MODULE_URL);
  try {
    const before = gate.snapshot();
    assert.ok(before.groups.some((g) => g.reason === 'none' && g.tools.some((t) => t.name === 'mystery_tool')));

    const after = gate.update({ enabled: true, deny: ['mystery_tool'] });
    const unknown = after.groups.find((g) => g.reason === 'none');
    assert.ok(unknown, '「未识别来源」分组不得整体消失');
    const row = unknown.tools.find((t) => t.name === 'mystery_tool');
    assert.ok(row, '被隐藏的工具行仍在，用户才有恢复入口');
    assert.equal(row.denied, true, '界面据此把整行置灰');
    assert.ok(row.tokens > 0, '体积信息由定义缓存保留');
    assert.equal(row.summary, 'Agent-plane only, source unknown.', '描述也由缓存保留');
    assert.equal(after.totals.count, 2, '总数不受隐藏影响');
    assert.equal(after.totals.deniedCount, 1, '节省统计计入已隐藏工具');
    assert.ok(after.totals.deniedTokens > 0);
    assert.deepEqual(after.deny, ['mystery_tool']);

    // 全局层工具与 agent 层工具同时隐藏：两条采集路径都要能列出来。
    const both = gate.update({ deny: ['read', 'mystery_tool'] });
    assert.equal(both.totals.deniedCount, 2);
    assert.ok(both.groups.flatMap((g) => g.tools).some((t) => t.name === 'read' && t.denied === true));

    // 恢复：撤掉 deny 后重新可见，状态翻回激活。
    const restored = gate.update({ deny: [] });
    const restoredRow = restored.groups.flatMap((g) => g.tools).find((t) => t.name === 'mystery_tool');
    assert.equal(restoredRow.denied, false);
    assert.equal(restored.totals.deniedCount, 0);
  } finally {
    gate.dispose();
  }
});

test('名单里当前未注册的工具仍列出（可恢复、可清理），且不下发给 restrict', async () => {
  isolateHome();
  const { gate, tools } = await createScopedHarness(MODULE_URL);
  try {
    const snap = gate.update({ enabled: true, deny: ['ghost_agent_tool'] });
    const row = snap.groups.flatMap((g) => g.tools).find((t) => t.name === 'ghost_agent_tool');
    assert.ok(row, '当前不可见、但已写进名单的条目不得消失');
    assert.equal(row.denied, true, '界面据此置灰');
    assert.equal(row.tokens, 0, '体积未知就不编造');
    assert.equal(snap.totals.deniedCount, 1);
    assert.equal(tools.deny.size, 0, '未知名字不能下发给 restrict（否则会抛错）');

    // 用户仍能从界面取消勾选把它从名单里清掉。
    const cleared = gate.update({ deny: [] });
    assert.equal(cleared.groups.flatMap((g) => g.tools).some((t) => t.name === 'ghost_agent_tool'), false);
    assert.equal(cleared.totals.deniedCount, 0);
  } finally {
    gate.dispose();
  }
});

test('已停用工具的 preview 仍能查到定义（不报 found:false）', async () => {
  isolateHome();
  const { gate } = await createScopedHarness(MODULE_URL);
  try {
    gate.update({ enabled: true, slim: true, deny: ['mystery_tool'] });
    const probe = gate.preview('mystery_tool');
    assert.equal(probe.ok, true);
    assert.equal(probe.found, true);
    assert.equal(probe.original, 'Agent-plane only, source unknown.');
    assert.equal(gate.preview('no_such_tool').found, false, '真·未知工具仍报未找到');
  } finally {
    gate.dispose();
  }
});
