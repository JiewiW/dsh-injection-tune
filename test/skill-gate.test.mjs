/**
 * test/skill-gate.test.mjs —— 技能可见性门（AI-7）的单元测试。
 *
 * 覆盖：
 *   1. 技能清单按 source 分框、描述清洗、目录行体积估算；
 *   2. 门关闭时完全透传（fail-safe 默认值）；
 *   3. 开启后只过滤带 agent scope 的 snapshot / list（目录注入 + skill 工具），
 *      全局视图不受影响——这是「设置页仍能恢复隐藏项」的前提；
 *   4. toggle 单条、名单去重、状态落盘跨实例复用；
 *   5. dispose 后回到透传；
 *   6. 宿主没有 skills 服务时返回只读空壳，不抛错；
 *   7. 目录行 500 字符截断与上游 catalogDescription 同口径。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** 每个用例一个独立 HOME，避免用例之间共享 sidecar 状态。 */
function isolateHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-gate-'));
  process.env.USERPROFILE = dir;
  process.env.HOME = dir;
  return dir;
}

/** skills 服务替身：与 dsh-skill/lib/index.js 同形（list 内部走 snapshot）。 */
class FakeSkills {
  constructor(skills) {
    this.skills = skills;
    this.snapshotCalls = [];
  }
  async snapshot(options = {}) {
    this.snapshotCalls.push(options);
    return { skills: this.skills.slice(), complete: true };
  }
  async list(options = {}) {
    return (await this.snapshot(options)).skills;
  }
}

const SKILLS = [
  {
    name: 'matlab-code-writing',
    description: 'Write MATLAB code.  遵守命名规范，禁止魔法数字。',
    source: 'user-dsh',
    provider: 'filesystem',
    invocation: { modelInvocable: true, userInvocable: true },
  },
  {
    name: 'dsh-plugin-dev-hardrules',
    description: 'Hard rules for DSH plugin development.',
    source: 'project-dsh',
    provider: 'filesystem',
    invocation: { modelInvocable: true, userInvocable: true },
  },
  {
    name: 'bundled-helper',
    description: 'Bundled helper.',
    source: 'bundled',
    provider: 'bundled',
    invocation: { modelInvocable: false, userInvocable: true },
  },
  {
    name: 'mystery-skill',
    description: 'A skill with no source field.',
    provider: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
  },
];

/** 搭一个最小宿主：ctx.skills / ctx.agents / ctx.logger。 */
async function createHarness(moduleUrl) {
  const { createSkillGate } = await import(moduleUrl);
  const skillsService = new FakeSkills(SKILLS);
  const agents = [{ id: 'a1', session: { header: { cwd: 'D:/work' } } }];
  const scope = {
    skills: skillsService,
    agents: { list: () => agents },
    logger: { info() {}, warn() {} },
    on: () => () => {},
  };
  return { gate: createSkillGate(scope, scope.logger), skillsService, createSkillGate, scope };
}

const MODULE_URL = new URL('../lib/skill-gate.js', import.meta.url).href;
const GLOBAL_LOOKUP = {};
const AGENT_LOOKUP = { cwd: 'D:/work', scope: { id: 'a1' } };

test('按 source 分框、描述清洗、体积与调用策略如实下发', async () => {
  isolateHome();
  const { gate } = await createHarness(MODULE_URL);
  try {
    const snapshot = await gate.snapshot();
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.totals.count, 4);
    assert.equal(snapshot.agents, 1);
    const reasons = Object.fromEntries(snapshot.groups.map((g) => [g.label, g.reason]));
    assert.equal(reasons['user-dsh'], 'registry');
    assert.equal(reasons['project-dsh'], 'registry');
    assert.equal(reasons['bundled'], 'registry');
    assert.equal(reasons['未识别来源'], 'none');

    const skills = snapshot.groups.flatMap((g) => g.skills);
    const matlab = skills.find((item) => item.name === 'matlab-code-writing');
    assert.equal(matlab.summary, 'Write MATLAB code. 遵守命名规范，禁止魔法数字。');
    assert.equal(matlab.provider, 'filesystem');
    assert.ok(matlab.chars > matlab.name.length, '目录行体积应包含描述正文');
    assert.equal(matlab.tokens, Math.ceil(matlab.chars / 4) + 4);
    assert.equal(skills.find((item) => item.name === 'bundled-helper').modelInvocable, false);
    assert.equal(snapshot.totals.deniedCount, 0);
  } finally {
    gate.dispose();
  }
});

test('门关闭时完全透传（默认 fail-safe）', async () => {
  isolateHome();
  const { gate, skillsService } = await createHarness(MODULE_URL);
  try {
    assert.equal((await gate.snapshot()).enabled, false);
    const agentView = await skillsService.snapshot(AGENT_LOOKUP);
    assert.equal(agentView.skills.length, 4);
    assert.equal((await skillsService.list(AGENT_LOOKUP)).length, 4);
  } finally {
    gate.dispose();
  }
});

test('开启后只过滤带 scope 的查询：目录与 skill 工具被挡，全局视图不受影响', async () => {
  isolateHome();
  const { gate, skillsService } = await createHarness(MODULE_URL);
  try {
    await gate.update({ enabled: true, rules: { 'bundled-helper': 'hide', 'mystery-skill': 'hide' } });

    const agentView = await skillsService.snapshot(AGENT_LOOKUP);
    assert.deepEqual(agentView.skills.map((skill) => skill.name), ['matlab-code-writing', 'dsh-plugin-dev-hardrules']);
    assert.equal(agentView.complete, true, 'observation 的其它字段必须保留');
    assert.deepEqual((await skillsService.list(AGENT_LOOKUP)).map((skill) => skill.name),
      ['matlab-code-writing', 'dsh-plugin-dev-hardrules'], 'skill 工具走 list()，同样被挡');

    const globalView = await skillsService.snapshot(GLOBAL_LOOKUP);
    assert.equal(globalView.skills.length, 4, '设置页/技能管理器的全局视图必须看得到全部');

    // 设置页快照仍列出全部技能（含被隐藏的两条），否则无法恢复。
    const snapshot = await gate.snapshot();
    assert.equal(snapshot.totals.count, 4);
    assert.equal(snapshot.totals.hiddenCount, 2);
    assert.ok(snapshot.totals.hiddenTokens > 0);
    assert.equal(snapshot.groups.flatMap((g) => g.skills).find((item) => item.name === 'bundled-helper').hidden, true);

    // 关闭后规则保留但不再生效。
    await gate.update({ enabled: false });
    assert.equal((await skillsService.snapshot(AGENT_LOOKUP)).skills.length, 4);
    assert.equal(Object.keys((await gate.snapshot()).rules).length, 2);
  } finally {
    gate.dispose();
  }
});

test('setMode 单条改档位、clear 清空、落盘跨实例复用', async () => {
  isolateHome();
  const { gate, createSkillGate, scope } = await createHarness(MODULE_URL);
  try {
    const once = await gate.update({ setMode: { name: 'mystery-skill', mode: 'name' } });
    assert.deepEqual(once.rules, { 'mystery-skill': 'name' });
    // 非法档位不写入；同名再设一次是覆盖而非追加。
    const bogus = await gate.update({ setMode: { name: 'mystery-skill', mode: 'bogus' } });
    assert.deepEqual(bogus.rules, { 'mystery-skill': 'name' });
    const twice = await gate.update({ setMode: { name: 'mystery-skill', mode: 'headline' } });
    assert.deepEqual(twice.rules, { 'mystery-skill': 'headline' });
    // 两条技能各自持有不同档位，互不影响。
    const multi = await gate.update({ setMode: { name: 'bundled-helper', mode: 'hide' } });
    assert.deepEqual(multi.rules, { 'mystery-skill': 'headline', 'bundled-helper': 'hide' });
    await gate.update({ enabled: true });

    // 模拟进程重启：新实例从 sidecar 读回规则与开关。
    const reloaded = createSkillGate(scope, scope.logger);
    const state = await reloaded.snapshot();
    assert.equal(state.enabled, true);
    assert.deepEqual(state.rules, { 'mystery-skill': 'headline', 'bundled-helper': 'hide' });
    // mode:null 恢复激活 = 从规则表删除该条。
    const restored = await reloaded.update({ setMode: { name: 'mystery-skill', mode: null } });
    assert.deepEqual(restored.rules, { 'bundled-helper': 'hide' });
    const cleared = await reloaded.update({ clear: true });
    assert.deepEqual(cleared.rules, {});
    reloaded.dispose();
  } finally {
    gate.dispose();
  }
});

test('dispose 后投影回到透传', async () => {
  isolateHome();
  const { gate, skillsService } = await createHarness(MODULE_URL);
  await gate.update({ enabled: true, rules: { 'bundled-helper': 'hide' } });
  assert.equal((await skillsService.list(AGENT_LOOKUP)).length, 3);
  gate.dispose();
  assert.equal((await skillsService.list(AGENT_LOOKUP)).length, 4);
});

test('宿主没有 skills 服务时返回只读空壳', async () => {
  isolateHome();
  const { createSkillGate } = await import(MODULE_URL);
  const scope = { agents: { list: () => [] }, logger: { info() {}, warn() {} }, on: () => () => {} };
  const gate = createSkillGate(scope, scope.logger);
  const snapshot = await gate.snapshot();
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.groups.length, 0);
  assert.equal((await gate.update({ enabled: true })).ok, false);
  gate.dispose();
});

test('catalogLineChars 与上游 catalogDescription 同口径（空白归一 + 500 截断）', async () => {
  const { catalogLineChars } = await import(MODULE_URL);
  const short = { name: 'short', description: '  a   b  ' };
  assert.equal(catalogLineChars(short), '- `short`: a b'.length + 1);
  const long = { name: 'long', description: 'x'.repeat(900) };
  const expectedBody = `${'x'.repeat(497)}...`;
  assert.equal(catalogLineChars(long), `- \`long\`: ${expectedBody}`.length + 1);
});

// ── 三档隐藏模式（hide / name / headline） ────────────────────────────────

test('projectSkill 三档投影：hide 整条移除、name 清空描述、headline 截断', async () => {
  const { projectSkill } = await import(MODULE_URL);
  const skill = { name: 'demo', description: '  a   b  ', invocation: { modelInvocable: true } };

  assert.equal(projectSkill(skill, 'hide', 60), null);

  const named = projectSkill(skill, 'name', 60);
  assert.equal(named.description, '');
  assert.equal(named.name, 'demo');
  // 其余字段必须原样保留，skill 工具后续还要靠 name/invocation 加载正文。
  assert.deepEqual(named.invocation, { modelInvocable: true });

  const headed = projectSkill({ name: 'long', description: 'x'.repeat(200) }, 'headline', 60);
  assert.equal(headed.description.length, 60);
  assert.equal(headed.description, `${'x'.repeat(57)}...`);
});

test('normalizeState 白名单化 rules、钳制 headlineChars、迁移旧版 deny+mode', async () => {
  const { normalizeState, DEFAULT_STATE } = await import(MODULE_URL);
  // 旧版（version 1）配置自动迁移：deny + 全局 mode → 每条技能各一条规则。
  assert.deepEqual(normalizeState({ deny: ['a', 'b'], mode: 'name' }).rules, { a: 'name', b: 'name' });
  assert.deepEqual(normalizeState({ deny: ['a'] }).rules, { a: 'hide' }, '旧配置缺 mode → 按旧版出厂默认 hide');
  assert.deepEqual(normalizeState({}).rules, {});
  assert.equal(normalizeState({}).version, 2);
  // 新格式：非法档位被丢弃，非字符串键/空名被丢弃。
  assert.deepEqual(normalizeState({ rules: { a: 'hide', b: 'bogus', c: 'headline' } }).rules, { a: 'hide', c: 'headline' });
  assert.deepEqual(normalizeState({ rules: { '': 'hide' } }).rules, {});
  // 新旧并存时以 rules 为准，deny 只补 rules 里没有的。
  assert.deepEqual(normalizeState({ rules: { a: 'name' }, deny: ['a', 'b'], mode: 'hide' }).rules, { a: 'name', b: 'hide' });
  // headlineChars 钳制。
  assert.equal(normalizeState({ headlineChars: 9999 }).headlineChars, 500);
  assert.equal(normalizeState({ headlineChars: 1 }).headlineChars, 10);
  assert.equal(normalizeState({ headlineChars: 'abc' }).headlineChars, 60);
  assert.deepEqual(DEFAULT_STATE.rules, {}); // 出厂无规则 = 全部激活
});

test('name 档：被隐藏技能仍在 list/snapshot 里，但描述为空（模型能发现、能加载）', async () => {
  isolateHome();
  const { gate, skillsService } = await createHarness(MODULE_URL);
  await gate.update({ enabled: true, rules: { 'matlab-code-writing': 'name' } });

  const viaList = await skillsService.list(AGENT_LOOKUP);
  const hit = viaList.find((s) => s.name === 'matlab-code-writing');
  assert.ok(hit, 'name 档必须保留条目，否则 skill 工具报 unknown');
  assert.equal(hit.description, '');
  assert.equal(viaList.length, SKILLS.length); // 条数不变
  gate.dispose();
});

test('headline 档：保留名字与前 N 字，条数不变', async () => {
  isolateHome();
  const { gate, skillsService } = await createHarness(MODULE_URL);
  await gate.update({ enabled: true, rules: { 'matlab-code-writing': 'headline' }, headlineChars: 20 });

  const viaList = await skillsService.list(AGENT_LOOKUP);
  const hit = viaList.find((s) => s.name === 'matlab-code-writing');
  assert.ok(hit);
  assert.equal(hit.description.length, 20);
  assert.ok(hit.description.endsWith('...'));
  gate.dispose();
});

test('hide 档维持原行为：整条移除', async () => {
  isolateHome();
  const { gate, skillsService } = await createHarness(MODULE_URL);
  await gate.update({ enabled: true, rules: { 'matlab-code-writing': 'hide' } });

  const viaList = await skillsService.list(AGENT_LOOKUP);
  assert.equal(viaList.find((s) => s.name === 'matlab-code-writing'), undefined);
  assert.equal(viaList.length, SKILLS.length - 1);
  gate.dispose();
});

test('逐技能独立：同一轮里三条技能各走不同档位，互不干扰', async () => {
  isolateHome();
  const { gate, skillsService } = await createHarness(MODULE_URL);
  // 四条技能：一条激活、一条 hide、一条 name、一条 headline。
  await gate.update({
    enabled: true,
    rules: { 'bundled-helper': 'hide', 'matlab-code-writing': 'name', 'mystery-skill': 'headline' },
    headlineChars: 20,
  });

  const viaList = await skillsService.list(AGENT_LOOKUP);
  // hide 的那条消失，其余三条仍在。
  assert.equal(viaList.find((s) => s.name === 'bundled-helper'), undefined);
  assert.equal(viaList.length, SKILLS.length - 1);

  const named = viaList.find((s) => s.name === 'matlab-code-writing');
  assert.ok(named);
  assert.equal(named.description, '', 'name 档描述必须为空');

  const headed = viaList.find((s) => s.name === 'mystery-skill');
  assert.ok(headed);
  assert.equal(headed.description.length, 20, 'headline 档按同一 headlineChars 截断');
  assert.ok(headed.description.endsWith('...'));

  // 激活的那条描述原样不动。
  const active = viaList.find((s) => s.name === 'dsh-plugin-dev-hardrules');
  assert.ok(active);
  assert.ok(active.description.length > 20, '未设置规则的技能必须原样下发');
  gate.dispose();
});

test('三档下全局视图都不受影响（设置页仍能恢复）', async () => {
  for (const mode of ['hide', 'name', 'headline']) {
    isolateHome();
    const { gate, skillsService } = await createHarness(MODULE_URL);
    await gate.update({ enabled: true, rules: { 'matlab-code-writing': mode } });
    const globalView = await skillsService.snapshot(GLOBAL_LOOKUP);
    assert.equal(globalView.skills.length, SKILLS.length, `${mode}: 全局视图必须完整`);
    assert.ok(globalView.skills.some((s) => s.name === 'matlab-code-writing'));
    gate.dispose();
  }
});

test('投影必须稳定：同一规则表连续调用产出相同描述（防 digest 抖动重发）', async () => {
  isolateHome();
  const { gate, skillsService } = await createHarness(MODULE_URL);
  await gate.update({ enabled: true, rules: { 'matlab-code-writing': 'headline' }, headlineChars: 20 });

  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const list = await skillsService.list(AGENT_LOOKUP);
    runs.push(JSON.stringify(list.map((s) => [s.name, s.description])));
  }
  assert.equal(runs[0], runs[1]);
  assert.equal(runs[1], runs[2]);
  gate.dispose();
});

test('snapshot 统计按各技能档位算实际占用：hide 省满、name/headline 只省描述', async () => {
  isolateHome();
  const { gate } = await createHarness(MODULE_URL);

  const hideView = await gate.update({ enabled: true, rules: { 'matlab-code-writing': 'hide' } });
  assert.equal(hideView.totals.keptTokens, 0, 'hide 档隐藏项不再占任何体积');
  assert.ok(hideView.totals.savedTokens > 0);
  assert.equal(hideView.totals.hiddenCount, 1);

  const nameView = await gate.update({ rules: { 'matlab-code-writing': 'name' } });
  assert.ok(nameView.totals.keptTokens > 0, 'name 档仍占「名字」那一行的体积');
  assert.ok(nameView.totals.savedTokens < hideView.totals.savedTokens);
  assert.equal(nameView.totals.hiddenCount, 1);

  const headView = await gate.update({ rules: { 'matlab-code-writing': 'headline' }, headlineChars: 20 });
  assert.ok(headView.totals.keptTokens > nameView.totals.keptTokens, 'headline 比 name 多占摘要部分');
  assert.equal(headView.rules['matlab-code-writing'], 'headline');

  // 逐技能统计：hide + headline 两条各按自己档位计入 keptTokens。
  const mixed = await gate.update({
    rules: { 'matlab-code-writing': 'hide', 'bundled-helper': 'headline' },
    headlineChars: 20,
  });
  assert.equal(mixed.totals.hiddenCount, 2);
  assert.ok(mixed.totals.keptTokens > 0, 'headline 那条仍占体积，所以总计 > 0');
  gate.dispose();
});

test('规则表与 headlineChars 跨实例落盘复用', async () => {
  isolateHome();
  const { gate } = await createHarness(MODULE_URL);
  await gate.update({
    enabled: true,
    rules: { 'matlab-code-writing': 'headline', 'bundled-helper': 'hide' },
    headlineChars: 42,
  });
  gate.dispose();

  const { gate: reopened } = await createHarness(MODULE_URL);
  const view = await reopened.snapshot();
  assert.deepEqual(view.rules, { 'matlab-code-writing': 'headline', 'bundled-helper': 'hide' });
  assert.equal(view.headlineChars, 42);
  reopened.dispose();
});

test('旧版配置（deny + 全局 mode）自动迁移为逐技能规则，行为与升级前一致', async () => {
  isolateHome();
  // 手写一份 version 1 的 sidecar，模拟从旧版配置升级。
  const file = path.join(process.env.HOME, '.dsh', 'injection-tune', 'skill-gate.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    enabled: true,
    deny: ['matlab-code-writing', 'bundled-helper'],
    mode: 'name',
    headlineChars: 60,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }, null, 2));

  const { gate, skillsService } = await createHarness(MODULE_URL);
  const view = await gate.snapshot();
  assert.deepEqual(view.rules, { 'matlab-code-writing': 'name', 'bundled-helper': 'name' },
    '旧版全局 mode 必须展开到每条技能上');

  // 行为验证：两条都按 name 档投影（条目保留、描述清空）。
  const viaList = await skillsService.list(AGENT_LOOKUP);
  for (const name of ['matlab-code-writing', 'bundled-helper']) {
    const hit = viaList.find((s) => s.name === name);
    assert.ok(hit, name + ': name 档必须保留条目');
    assert.equal(hit.description, '');
  }
  assert.equal(viaList.length, SKILLS.length);
  gate.dispose();
});
