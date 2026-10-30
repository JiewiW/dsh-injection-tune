/**
 * test/tool-gate.test.mjs —— 工具可见性门的单元测试（node:test + ESM）。
 *
 * 为什么单独一个 .mjs：`test/host.test.js` 是 CJS 的 `require(...)`，而本包已转 ESM
 * （type: module），那个文件在 Node 22 下会直接报错。这里不再往坏掉的壳里加用例，
 * 用 `.mjs` + `npm run test:gate` 单独跑。
 *
 * 覆盖：
 *   1. 工具清单按注册来源分框（对照表 / 前缀 / 未识别）；
 *   2. 描述 → 一行功能摘要（去 Markdown、截断）；
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
}

const AGENT_DEFS = new Map([
  ['read', { name: 'read', description: 'Read a UTF-8 text file. Use offset/limit to page.', parameters: { type: 'object' } }],
  ['browser_open', { name: 'browser_open', description: '打开一个浏览器标签页并导航到指定 URL。', parameters: {} }],
  ['memory_note', { name: 'memory_note', description: 'Write a note into long-term memory.', parameters: {} }],
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

test('按注册来源分框、描述转一行摘要', async () => {
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
    assert.equal(tools.find((t) => t.name === 'read').summary, 'Read a UTF-8 text file.');
    assert.equal(tools.find((t) => t.name === 'read').critical, true);
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
