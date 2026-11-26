/**
 * lib/inject-order.js —— A 层「声明式注入源可视化管理」。
 *
 * 只处理具名注入项（systemPrompt.section()/context() 注册的项，带稳定 name）。
 * 事件驱动的条件注入（soft-cut 锚点、tool-args-error 恢复等）不在此覆盖范围内。
 *
 * 能力：排序 / 展开查看全文 / 编辑覆盖文本 / 恢复默认 / 隐藏（完全不注入）。
 *
 * 上游契约（0.2.0-rc.2 源码实测，勿跨版本复用）：
 *   · dsh-system-prompt/lib/index.js assemble()：
 *     L334 sections.sort(comparePromptSections)、L348 contexts.sort(order)
 *     全部发生在 waterfall **之前**；L356 waterfall 返回值即权威结果，
 *     L357-361 唯一后置处理是 complete section / runtime 抑制，不重排。
 *     下游 renderPrompt/renderContextSections 按数组顺序 map/filter/join，不再 sort。
 *     ⇒ 在 system-prompt/assemble hook 里写 assembly.sections/contexts 的新数组
 *       即可改变最终提示词顺序与条目集合，无需改每项的 order 字段。
 *   · assemble() 进入 waterfall 时 entry.text 已解析为字符串（函数已调用过），
 *     所以 hook 里捕获/覆写文本都是字符串操作。
 *   · assemble(context = {}) 是公开方法，可直接调用触发一次真实装配；
 *     用它做「实时检测」探针，不必另开会话（会走完整 waterfall，刷新快照）。
 *
 * 状态落盘在 ~/.dsh/injection-tune/inject-order.json（与 tool-gate 同目录）：
 *   table       name → 目标序号（用户拖拽结果）
 *   overrides   name → 用户编辑后的文本（覆盖注册原文）
 *   hidden      name → true（该条完全不注入）
 *   originals   name → 最近一次捕获到的注册原文（用于「恢复默认」，跨捕获保留）
 *   sections / contexts  最近一次装配的具名项清单（供设置页展示）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_FILE = path.join(os.homedir(), '.dsh', 'injection-tune', 'inject-order.json');
const SUMMARY_LIMIT = 160;

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'function') {
    try { return textOf(value({})); } catch { return ''; }
  }
  return '';
}

function summarize(text) {
  return text.slice(0, SUMMARY_LIMIT);
}

/** 捕获全部具名项的注册原文；原文只在首次或变化时更新，避免覆写值被当成原文。 */
function captureAll(entries, originals) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry, index) => {
    const name = typeof entry?.name === 'string' ? entry.name : '';
    if (!name) return null;
    const text = textOf(entry?.text);
    // 只有非空文本才更新原文：refresh() 无 context 时函数型 text 会返回空，
    // 若用它覆盖历史捕获到的真实内容会导致「展开是空文本」。
    if (text && (!Object.prototype.hasOwnProperty.call(originals, name) || !originals[name])) {
      originals[name] = text;
    }
    // 本次为空但已存过真实原文时，回退展示历史原文。
    const displayText = text || (Object.prototype.hasOwnProperty.call(originals, name) ? originals[name] : '');
    return {
      name,
      order: index,
      text: displayText,
      summary: summarize(displayText),
    };
  }).filter(Boolean);
}

/** 稳定重排：表内项按目标序号，表外项保持原相对次序且排在其后。 */
function reorderEntries(entries, table) {
  if (!Array.isArray(entries) || !table || typeof table !== 'object') return entries;
  const ranked = entries.map((entry, index) => {
    const name = typeof entry?.name === 'string' ? entry.name : '';
    const target = Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
    const rank = typeof target === 'number' && Number.isFinite(target)
      ? target
      : Number.MAX_SAFE_INTEGER - entries.length + index;
    return { entry, index, rank };
  });
  ranked.sort((a, b) => (a.rank - b.rank) || (a.index - b.index));
  return ranked.map((item) => item.entry);
}

/** 构造设置页展示项：当前文本（含覆盖）、注册原文、隐藏/覆盖标记。 */
function displayItems(captured, state) {
  return captured.map((item) => {
    const overridden = Object.prototype.hasOwnProperty.call(state.overrides, item.name);
    const text = overridden ? state.overrides[item.name] : item.text;
    return {
      name: item.name,
      order: item.order,
      text,
      originalText: Object.prototype.hasOwnProperty.call(state.originals, item.name)
        ? state.originals[item.name]
        : item.text,
      summary: summarize(text),
      overridden,
      hidden: state.hidden[item.name] === true,
    };
  });
}

/**
 * 创建注入源管理实例。
 *
 * @param {object} scope 含 systemPrompt / webServer 的 ctx.inject scope。
 * @param {object} logger ctx.logger（可选）。
 * @returns {{reorder, snapshot, refresh, update, dispose}}
 */
export function createInjectOrder(scope, logger) {
  const state = readState();
  if (!state.table || typeof state.table !== 'object') state.table = {};
  if (!state.overrides || typeof state.overrides !== 'object') state.overrides = {};
  if (!state.hidden || typeof state.hidden !== 'object') state.hidden = {};
  if (!state.originals || typeof state.originals !== 'object') state.originals = {};
  if (!Array.isArray(state.sections)) state.sections = [];
  if (!Array.isArray(state.contexts)) state.contexts = [];
  state.capturedAt = typeof state.capturedAt === 'number' ? state.capturedAt : 0;

  let disposed = false;
  /** 最近一次 hook 捕获的原始清单（未过滤、未覆盖），用于构造展示快照。 */
  let capturedSections = [];
  let capturedContexts = [];

  function warn(message, error) {
    try { logger?.warn?.('dsh-injection-tune inject-order: ' + message, error); } catch { /* 忽略 */ }
  }

  /**
   * 在 assemble hook 内调用，顺序至关重要：
   *   1. 捕获原始文本（此时尚无覆盖，取到的是注册原文）
   *   2. 应用用户覆盖文本到 entry.text
   *   3. 过滤掉隐藏项（完全不注入）
   *   4. 按排序表重排，写回 assembly
   *   5. 用捕获的原始清单 + 状态构造展示快照
   */
  function reorder(assembly) {
    if (disposed || !assembly || typeof assembly !== 'object') return;
    try {
      capturedSections = captureAll(assembly.sections, state.originals);
      capturedContexts = captureAll(assembly.contexts, state.originals);

      const applyEdits = (entries) => {
        if (!Array.isArray(entries)) return entries;
        let changed = false;
        const next = [];
        for (const entry of entries) {
          const name = typeof entry?.name === 'string' ? entry.name : '';
          if (name && state.hidden[name] === true) { changed = true; continue; }
          if (name && Object.prototype.hasOwnProperty.call(state.overrides, name)) {
            next.push({ ...entry, text: state.overrides[name] });
            changed = true;
          } else {
            next.push(entry);
          }
        }
        return changed ? next : entries;
      };

      let sections = applyEdits(assembly.sections);
      let contexts = applyEdits(assembly.contexts);

      if (Object.keys(state.table).length > 0) {
        sections = reorderEntries(sections, state.table);
        contexts = reorderEntries(contexts, state.table);
      }
      if (sections !== assembly.sections) assembly.sections = sections;
      if (contexts !== assembly.contexts) assembly.contexts = contexts;

      if (capturedSections.length > 0 || capturedContexts.length > 0) {
        state.sections = displayItems(capturedSections, state);
        state.contexts = displayItems(capturedContexts, state);
        state.capturedAt = Date.now();
      }
    } catch (error) {
      warn('reorder failed, skipped', error);
    }
  }

  function snapshot() {
    return {
      ok: true,
      table: { ...state.table },
      sections: state.sections.slice(),
      contexts: state.contexts.slice(),
      capturedAt: state.capturedAt,
    };
  }

  /** 实时检测：直接调一次真实 assemble，刷新具名项快照。 */
  async function refresh() {
    if (disposed) return { ok: false, error: 'disposed' };
    const systemPrompt = scope.systemPrompt;
    if (!systemPrompt || typeof systemPrompt.assemble !== 'function') {
      return { ok: false, error: 'systemPrompt service unavailable' };
    }
    try {
      await systemPrompt.assemble();
      return snapshot();
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 保存设置。body 可含：
   *   table       name → rank
   *   overrides   name → 编辑后的文本
   *   hidden      name → bool
   *   reset       name[]，恢复这些项的默认文本并重新激活
   *   resetAll    true，清空全部自定义（排序/覆盖/隐藏）
   */
  function update(body) {
    if (disposed) return { ok: false, error: 'disposed' };
    if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
    try {
      if (body.resetAll === true) {
        state.table = {};
        state.overrides = {};
        state.hidden = {};
      }
      if (Array.isArray(body.reset)) {
        for (const name of body.reset) {
          if (typeof name !== 'string') continue;
          delete state.overrides[name];
          delete state.hidden[name];
          delete state.table[name];
        }
      }
      if (body.table && typeof body.table === 'object' && !Array.isArray(body.table)) {
        const clean = {};
        for (const [name, rank] of Object.entries(body.table)) {
          if (typeof name === 'string' && name.length > 0
            && typeof rank === 'number' && Number.isFinite(rank)) clean[name] = rank;
        }
        state.table = clean;
      }
      if (body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)) {
        for (const [name, text] of Object.entries(body.overrides)) {
          if (typeof name !== 'string' || !name) continue;
          if (typeof text === 'string') state.overrides[name] = text;
          else delete state.overrides[name];
        }
      }
      if (body.hidden && typeof body.hidden === 'object' && !Array.isArray(body.hidden)) {
        for (const [name, value] of Object.entries(body.hidden)) {
          if (typeof name !== 'string' || !name) continue;
          if (value === true) state.hidden[name] = true;
          else delete state.hidden[name];
        }
      }
      writeState(state);
      // 立即用当前状态刷新展示快照（不必等下一轮真实注入）。
      state.sections = displayItems(capturedSections, state);
      state.contexts = displayItems(capturedContexts, state);
      return snapshot();
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  function dispose() {
    disposed = true;
    try { writeState(state); } catch { /* 忽略 */ }
  }

  return { reorder, snapshot, refresh, update, dispose };
}
