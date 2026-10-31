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
  ['memory_note', { name: 'memory_note', description: 'Write a note into long-term memory. Notes persist across sessions. Keep each note short. Use tags to group related notes.', parameters: {} }],
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

test('slimDescription：多于 3 句截前 3 句，不足 3 句原样返回', async () => {
  const { slimDescription } = await import(MODULE_URL);
  const four = 'First sentence. Second one! Third? Fourth here. Fifth tail.';
  assert.equal(slimDescription(four), 'First sentence. Second one! Third?');
  const two = '只有一句。第二句也不少。';
  assert.equal(slimDescription(two), two);
  assert.equal(slimDescription(undefined), '');
  assert.equal(slimDescription(null), '');
  assert.equal(slimDescription(''), '');
  assert.equal(slimDescription(four, 2), 'First sentence. Second one!');
});

test('精简模式：update 落盘、snapshot 回传，schemaOf 投影按状态生效', async () => {
  isolateHome();
  const { gate, scopedTools, globalTools } = await createHarness(MODULE_URL);
  const definition = AGENT_DEFS.get('read');
  try {
    // 默认关：投影原样。
    assert.equal(gate.snapshot().slim, false);
    assert.equal(scopedTools.schemaOf(definition).description, definition.description);

    const slimOn = gate.update({ slim: true });
    assert.equal(slimOn.slim, true);
    // 同一 class 原型：globalTools / scopedTools 共享包装，都生效。
    const projected = scopedTools.schemaOf(definition);
    assert.notEqual(projected.description, definition.description);
    assert.ok(projected.description.length < definition.description.length);
    assert.ok(!projected.description.includes('Never read files above'), '只保留前 3 句');
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

    // 关掉精简：全体恢复原样；豁免名单保留（下次开启仍生效）。
    const slimOff = gate.update({ slim: false });
    assert.equal(slimOff.slim, false);
    assert.equal(scopedTools.schemaOf(definition).description, definition.description);
    assert.deepEqual(globalTools === scopedTools, false);
  } finally {
    gate.dispose();
  }
});

test('dispose 后投影回到透传（精简不再生效）', async () => {
  isolateHome();
  const { gate, scopedTools } = await createHarness(MODULE_URL);
  const definition = AGENT_DEFS.get('read');
  gate.update({ slim: true });
  assert.notEqual(scopedTools.schemaOf(definition).description, definition.description);
  gate.dispose();
  assert.equal(scopedTools.schemaOf(definition).description, definition.description);
});
