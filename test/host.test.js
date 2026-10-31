/**
 * test/host.test.js —— 三个 feature 与 host 改写的单元测试（node:test）。
 *
 * 覆盖：
 *   1. AI-1 同消息内长块重复折叠 / 短块不动 / 无重复不动；
 *   2. AI-2 首次不压缩、变更集才压缩、keepDescription=false 只留名字；
 *   3. AI-3 保留前 N 节、折叠其余节、路径与节标题进指针；
 *   4. host.apply 对三类消息只改 content[0].text、保留 source；
 *   5. host.apply 全 off 时仍注册 listener（支持设置页热启），但不改写消息。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { dedupeWithinMessage } from '../lib/features/dedupe-runtime-context.js';
import { toIncrementalCatalog } from '../lib/features/incremental-skill-catalog.js';
import { deferSections } from '../lib/features/deferred-agent-instructions.js';
import * as host from '../lib/host.js';
import { resolveConfig } from '../lib/config.js';

/** 造一条单 text block 的 user 消息。 */
function message(text, source) {
  return { id: `m-${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source };
}

/**
 * 造一个最小 Cordis ctx 替身。
 *
 * ctx.logger 是 LoggerService：可调用但调用只创建命名 logger facade 而不输出，
 * 真正落日志的是 ctx.logger.info / ctx.logger.warn，因此替身必须提供这两个方法。
 *
 * @returns {{ctx: object, listeners: object[], logs: string[]}} ctx 替身与其收集器。
 */
function fakeCtx() {
  const listeners = [];
  const logs = [];
  const ctx = {
    logger: {
      info: (...args) => logs.push(`info ${args.join(' ')}`),
      warn: (...args) => logs.push(`warn ${args.join(' ')}`),
      error: (...args) => logs.push(`error ${args.join(' ')}`),
      debug: (...args) => logs.push(`debug ${args.join(' ')}`),
    },
    on: (name, handler, options) => listeners.push({ name, handler, options }),
    // AI-4 的门走 ctx.inject；替身里三个服务都不存在，因此回调永不执行 =
    // 验证「拿不到 tools/agents/webServer 时插件仍能加载」这条降级边界。
    inject: () => () => {},
    get: () => undefined,
  };
  return { ctx, listeners, logs };
}

const LONG_A = 'A'.repeat(500);
const LONG_B = 'B'.repeat(500);

test('AI-1 folds duplicate long block, keeps first occurrence', () => {
  const text = `head\n\n${LONG_A}\n\nmid\n\n${LONG_A}\n\ntail`;
  const result = dedupeWithinMessage(text);
  assert.equal(result.foldedBlocks, 1);
  assert.equal(result.foldedChars, 500);
  assert.ok(result.text.includes(LONG_A));
  assert.ok(result.text.includes('不再重复'));
  assert.ok(!result.text.endsWith(`${LONG_A}\n\ntail`));
});

test('AI-1 leaves short repeats alone', () => {
  const short = 'x'.repeat(50);
  const text = `${short}\n\n${short}\n\n${short}`;
  const result = dedupeWithinMessage(text);
  assert.equal(result.foldedBlocks, 0);
  assert.equal(result.text, text);
});

test('AI-2 emits full catalog when no previous entries', () => {
  const full = '<system-reminder>\n<available_skills>\n- `a`: desc\n</available_skills>\n</system-reminder>';
  const entries = [{ name: 'a', description: 'desc' }];
  const result = toIncrementalCatalog(full, [], entries);
  assert.equal(result.savedChars, 0);
  assert.equal(result.text, full);
});

test('AI-2 emits only changed entries after first round', () => {
  const full = '<system-reminder>\n<available_skills>\n- `a`: desc\n- `b`: desc-b\n</available_skills>\n</system-reminder>';
  const previous = [{ name: 'a', description: 'desc' }, { name: 'b', description: 'desc-b' }];
  const current = [{ name: 'a', description: 'desc' }, { name: 'b', description: 'desc-b2' }];
  const result = toIncrementalCatalog(full, previous, current);
  assert.ok(result.text.includes('`b` (changed): desc-b2'));
  assert.ok(!result.text.includes('- `a`'));
  assert.ok(result.text.includes('All other 1 skill(s) are unchanged'));
  assert.ok(result.text.length < full.length + 600);
});

test('AI-2 keeps names only when keepDescription is false', () => {
  const full = '<system-reminder>\n<available_skills>\n- `a`: desc\n</available_skills>\n</system-reminder>';
  const previous = [{ name: 'a', description: 'old' }];
  const current = [{ name: 'a', description: 'desc' }];
  const result = toIncrementalCatalog(full, previous, current, { keepDescription: false });
  assert.ok(result.text.includes('- `a`'));
  assert.ok(!result.text.includes('desc'));
});

test('AI-3 keeps first sections and defers the rest', () => {
  const body = [
    'Intro paragraph.',
    '',
    '## One',
    'first body',
    '',
    '## Two',
    'second body',
    '',
    '## Three',
    `third ${LONG_B}`,
    '',
    '## Four',
    'fourth body',
  ].join('\n');
  const text = `<system-reminder>\nInstructions from: D:/x/AGENTS.md\n\n${body}\n</system-reminder>`;
  const result = deferSections(text, { keepSections: 2 });
  assert.equal(result.deferredSections, 2);
  assert.ok(result.savedChars > 0);
  assert.ok(result.text.includes('## One'));
  assert.ok(result.text.includes('## Two'));
  assert.ok(!result.text.includes('## Three'));
  assert.ok(result.text.includes('「Three」、「Four」'));
  assert.ok(result.text.includes('D:/x/AGENTS.md'));
});

test('AI-3 no-ops when section count is within budget', () => {
  const text = '<system-reminder>\n## One\nbody\n</system-reminder>';
  const result = deferSections(text, { keepSections: 2 });
  assert.equal(result.deferredSections, 0);
  assert.equal(result.text, text);
});

test('host rewrites runtime-context text but keeps source', () => {
  const { ctx, listeners, logs } = fakeCtx();
  const dispose = host.apply(ctx, resolveConfig({ dedupeRuntimeContext: true }));
  // 2 条：agent/pre-step（AI-1~AI-6）+ system-prompt/assemble（AI-4/5）
  assert.equal(listeners.length, 2);
  assert.equal(listeners[0].name, 'agent/pre-step');
  assert.equal(listeners[0].options.prepend, true);
  assert.equal(listeners[1].name, 'system-prompt/assemble');

  const source = { kind: 'runtime-context', form: 'snapshot', sections: [] };
  const text = `head\n\n${LONG_A}\n\nmid\n\n${LONG_A}\n\ntail`;
  const messages = [message(text, source)];
  const outcome = { kind: 'enter', messages };
  const rewritten = listeners[0].handler(outcome, async () => outcome);
  return rewritten.then((result) => {
    assert.equal(result.messages[0].content[0].text.includes('不再重复'), true);
    assert.deepEqual(result.messages[0].source, source);
    assert.ok(logs.some((line) => line.includes('AI-1 folded')));
    dispose();
  });
});

test('host registers the listener even when all features are off', () => {
  // 全关也注册：配置是 volatile 的，设置页热启后要立刻生效，
  // 提前 dispose 会让热启失效（见 host.js apply 的注释）。
  const { ctx, listeners } = fakeCtx();
  host.apply(ctx, resolveConfig({}));

  // 2 条：agent/pre-step（AI-1~AI-6）+ system-prompt/assemble（AI-4/5）
  assert.equal(listeners.length, 2);
  assert.equal(listeners[0].name, 'agent/pre-step');
  assert.equal(listeners[1].name, 'system-prompt/assemble');

  const source = { kind: 'runtime-context', form: 'snapshot', sections: [] };
  const text = `head\n\n${LONG_A}\n\nmid\n\n${LONG_A}\n\ntail`;
  const outcome = { kind: 'enter', messages: [message(text, source)] };
  return listeners[0].handler(outcome, async () => outcome).then((result) => {
    // 三个特性全关：原文一字不改。
    assert.equal(result.messages[0].content[0].text, text);
  });
});

test('host does not rewrite unrelated messages that share a null id', () => {
  const { ctx, listeners } = fakeCtx();
  host.apply(ctx, resolveConfig({ dedupeRuntimeContext: true }));

  const source = { kind: 'runtime-context', form: 'snapshot', sections: [] };
  const text = `head\n\n${LONG_A}\n\nmid\n\n${LONG_A}\n\ntail`;
  const target = { id: null, role: 'user', content: [{ type: 'text', text }], source };
  const other = { id: null, role: 'user', content: [{ type: 'text', text: 'keep me' }], source: { kind: 'other' } };
  const outcome = { kind: 'enter', messages: [target, other] };

  return listeners[0].handler(outcome, async () => outcome).then((result) => {
    assert.equal(result.messages[0].content[0].text.includes('不再重复'), true);
    assert.equal(result.messages[1].content[0].text, 'keep me');
  });
});

test('host keeps skill catalog state separate per agent', () => {
  const { ctx, listeners } = fakeCtx();
  host.apply(ctx, resolveConfig({ incrementalSkillCatalog: true }));

  const entries = [
    { name: 'a', description: 'desc' },
    { name: 'b', description: 'desc-b' },
  ];
  const full = '<system-reminder>\n<available_skills>\n- `a`: desc\n- `b`: desc-b\n</available_skills>\n</system-reminder>';

  const runFor = (agentId) => {
    const catalogSource = { kind: 'skill-catalog', form: 'catalog', entries };
    const message = { id: null, role: 'user', content: [{ type: 'text', text: full }], source: catalogSource };
    const outcome = { kind: 'enter', messages: [message] };
    return listeners[0].handler({ ...outcome, agent: { id: agentId } }, async () => outcome);
  };

  return runFor('agent-a')
    .then(() => runFor('agent-b'))
    .then((result) => {
      // agent-b 是首次见到目录：previous 为 null，必须拿到全量原文而非增量。
      assert.equal(result.messages[0].content[0].text, full);
    });
});
