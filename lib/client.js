/**
 * lib/client.js —— dsh-injection-tune 的浏览器半边：
 * 在设置 → 内置插件 分区注册标签页，提供四个开关的自动表单。
 *
 * 模块格式遵循 cordis client bundle 契约：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports; } })
 *
 * 依赖（package.json dsh.client.inject 必须声明这些包）：
 *   @deepseek-ai/cordis                     — ctx / Service 基础
 *   @deepseek-ai/dsh-client-ui-settings     — ConfigForms 服务
 *   @deepseek-ai/dsh-client-locale          — ctx.locale
 *   @deepseek-ai/dsh-client-ui-primitives   — SettingsForm / SettingsValueField / settingsBooleanField
 */

window.__ModuleLoader__.load({
  id: 'dsh-injection-tune',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    // ── 本地化字典 ──────────────────────────────────────────────────────────
    var NS = 'dshInjectionTune';

    var zh = {
      tab: '注入调优',
      title: '注入调优',
      intro: '在每轮会话的 agent/pre-step 瀑布里，对三类注入消息做运行时改写，削减上下文冗余。三个功能独立开关，默认全部关闭。',
      sectionDedupe: 'AI-1 · runtime-context 内部去重',
      sectionDedupeHint: '同一条 runtime-context 快照消息内，把被更长段落完全覆盖的重复段落折叠成指针行。仅折叠 ≥ 400 字符的整块重复。',
      fieldDedupe: '启用 runtime-context 内部去重',
      sectionSkill: 'AI-2 · 技能目录增量注入',
      sectionSkillHint: '首次发完整目录，之后只列自上次以来新增/变更的条目，附「其余 N 项未变」提示。必须保留 source.entries 否则每轮重发完整目录。',
      fieldSkill: '启用技能目录增量注入',
      fieldSkillKeepDesc: '保留技能条目描述正文（关闭则只显示条目名称）',
      sectionInstr: 'AI-3 · 项目指令延迟注入',
      sectionInstrHint: 'agent-instructions 里只留前 2 节，其余折叠为显式指针，附源文件路径 + read 工具建议。',
      fieldInstr: '启用项目指令延迟注入',
      save: '保存',
      saving: '保存中…',
      saveFailed: '保存失败',
      readOnly: '该字段由继承层提供，只读。',
      unavailable: '暂不可用',
    };

    var en = {
      tab: 'Injection Tune',
      title: 'Injection Tune',
      intro: 'Runtime rewriting of three injected message streams in the agent/pre-step waterfall to cut context bloat. Each feature is an independent toggle; all are off by default.',
      sectionDedupe: 'AI-1 · runtime-context internal dedup',
      sectionDedupeHint: 'Collapse paragraphs fully repeated within one runtime-context snapshot message into pointer lines. Only folds repeats ≥ 400 chars.',
      fieldDedupe: 'Enable runtime-context internal dedup',
      sectionSkill: 'AI-2 · Incremental skill catalog',
      sectionSkillHint: 'First render sends the full catalog; subsequent renders only list entries added or changed since last time, with an "all other N entries unchanged" note.',
      fieldSkill: 'Enable incremental skill catalog',
      fieldSkillKeepDesc: 'Keep each skill entry description body (off = name-only)',
      sectionInstr: 'AI-3 · Deferred agent instructions',
      sectionInstrHint: 'Keep only the first 2 sections of agent-instructions inline; the rest collapse into pointer lines with source file path + read-tool suggestion.',
      fieldInstr: 'Enable deferred agent instructions',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'Save failed',
      readOnly: 'Inherited from an upstream layer; read only here.',
      unavailable: 'Unavailable',
    };

    // ── Config namespace ────────────────────────────────────────────────────
    // Host 端 dsh.settings.describe() 会把每个 fiber 的 entry.options.id 作为
    // "ns" 字段返回，这个值就是 bundle id，也就是 npm 包名。
    var PLUGIN_NS = 'dsh-injection-tune';

    // ── 简单内联样式（避免额外 css 依赖） ──────────────────────────────────
    var s = {
      section: { width: '100%', maxWidth: '760px', display: 'flex', flexDirection: 'column', gap: '14px' },
      intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px', lineHeight: '20px' },
      heading: { margin: 0, fontSize: '15px', fontWeight: 600 },
      block: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
      blockTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      blockHint: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' },
      btn: { border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', cursor: 'pointer', background: 'transparent', borderRadius: '6px', padding: '6px 14px', fontSize: '13px' },
      btnPrimary: { border: '1px solid var(--dsw-alias-state-business-primary)', background: 'var(--dsw-alias-state-business-primary)', color: '#fff', font: 'inherit', cursor: 'pointer', borderRadius: '6px', padding: '6px 14px', fontSize: '13px' },
      btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
      status: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      error: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
      unavailableBox: { padding: '20px', color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px', textAlign: 'center', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px' },
    };

    // ── 布尔字段构造器 ────────────────────────────────────────────────────
    // SettingsFormModel 只有 settingsNumberField / settingsTextField。
    // 布尔字段需要自己构造：输入值是 boolean（或 undefined），直接保存。
    // 用 primitive 的 FormFieldState 约定：text 表示编辑值，overridden 表示 user 层存在。
    function settingsBooleanField(fieldName) {
      return {
        name: fieldName,
        /** 把 entry 快照投影到字段 state。value 可以是 boolean 或 undefined（继承层）。 */
        project(value, over) {
          var boolValue = typeof value === 'boolean' ? value : false;
          return {
            text: boolValue,
            overridden: over === true,
            invalid: false,
          };
        },
        /** 返回 {op:'set', path:[name], value} 或 {op:'unset', path:[name]} 供 mutate 提交。 */
        // 这个函数的签名要和 primitives 的 field spec 对齐 — 看 agent-loop 范例里 settingsNumberField 怎么接的
      };
    }

    // 上面那个太底层了 — 用 primitives 内置工厂。它确实没有 settingsBooleanField，
    // 但 form.mutate 接受 {op:'set', path, value}，我们直接在按钮 onClick 里调 edit/save。
    // 让我改用更简单的方式：不用 SettingsFormModel 这个复杂层，
    // 直接用 ConfigFormController 的 getSnapshot() / subscribe() / mutate() 手写组件。

    // ── 组件：InjectionTuneTab ────────────────────────────────────────────
    function InjectionTuneTab({ t, scope }) {
      var snapshot = scope.getSnapshot();

      // 订阅变化
      var _, forceUpdate;
      var snapshotObj = snapshot;
      var subscribed = false;

      // 用 useState + useEffect 做订阅
      var stateHolder = { snapshot: snapshotObj };

      var updateHook = null; // react.useState 返回的 setter
      // 我们用自定义 hook
      // 但在工厂函数里没有 hooks 可用 — 这个组件是纯函数，靠外部订阅触发重渲染
      // 简单做法：用 useSyncExternalStore

      var snap = scope.getSnapshot();
      var formValue = snap.value ?? {};
      var baseValue = snap.base ?? {};
      var userValue = snap.user ?? {};

      // 布尔比较
      var dedupe = typeof formValue.dedupeRuntimeContext === 'boolean' ? formValue.dedupeRuntimeContext : false;
      var incSkill = typeof formValue.incrementalSkillCatalog === 'boolean' ? formValue.incrementalSkillCatalog : false;
      var keepDesc = typeof formValue.skillCatalogKeepDescription === 'boolean' ? formValue.skillCatalogKeepDescription : true;
      var deferInstr = typeof formValue.deferredAgentInstructions === 'boolean' ? formValue.deferredAgentInstructions : false;

      function toggle(path, current) {
        var next = !current;
        scope.mutate([{ op: 'set', path: path, value: next }], snap.revision);
      }

      function renderSwitch(label, hint, path, current, disabled) {
        var isUserOverride = userValue[path[path.length - 1]] !== undefined;
        return react.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '10px' } },
          react.createElement('label', {
            style: { cursor: disabled ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'flex-start', gap: '8px', flex: 1 },
          },
            react.createElement('input', {
              type: 'checkbox',
              checked: current,
              disabled: disabled,
              onChange: function () { if (!disabled) toggle(path, current); },
              style: { marginTop: '3px', cursor: disabled ? 'not-allowed' : 'pointer' },
            }),
            react.createElement('div', null,
              react.createElement('div', { style: { fontSize: '13px' } }, label,
                isUserOverride ? react.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', marginLeft: '6px' } }, '（已覆盖继承层）') : null,
              ),
              hint ? react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', marginTop: '2px' } }, hint) : null,
            )
          ),
        );
      }

      if (snap.status === 'unavailable') {
        return react.createElement('div', { style: s.section },
          react.createElement('div', { style: s.unavailableBox }, t('unavailable')),
        );
      }

      var subOptDisabled = !incSkill; // skillCatalogKeepDescription 只有 incrementalSkillCatalog 开启时才有意义

      return react.createElement('div', { style: s.section },
        react.createElement('p', { style: s.intro }, t('intro')),

        // AI-1
        react.createElement('div', { style: s.block },
          react.createElement('h4', { style: s.blockTitle }, t('sectionDedupe')),
          react.createElement('p', { style: s.blockHint }, t('sectionDedupeHint')),
          renderSwitch(t('fieldDedupe'), null, ['dedupeRuntimeContext'], dedupe, !snap.writable),
        ),

        // AI-2
        react.createElement('div', { style: s.block },
          react.createElement('h4', { style: s.blockTitle }, t('sectionSkill')),
          react.createElement('p', { style: s.blockHint }, t('sectionSkillHint')),
          renderSwitch(t('fieldSkill'), null, ['incrementalSkillCatalog'], incSkill, !snap.writable),
          renderSwitch(t('fieldSkillKeepDesc'), null, ['skillCatalogKeepDescription'], keepDesc, subOptDisabled || !snap.writable),
        ),

        // AI-3
        react.createElement('div', { style: s.block },
          react.createElement('h4', { style: s.blockTitle }, t('sectionInstr')),
          react.createElement('p', { style: s.blockHint }, t('sectionInstrHint')),
          renderSwitch(t('fieldInstr'), null, ['deferredAgentInstructions'], deferInstr, !snap.writable),
        ),
      );
    }

    // ── apply（cordis client 入口） ────────────────────────────────────────
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, 'dsh-injection-tune: locale');

      // 等 Host 端服务真的注册了这个 namespace 再挂载
      ctx.effect(
        function () {
          return ctx.configForms.whileServed(
            [PLUGIN_NS],
            function () {
              var scope = ctx.configForms.get(PLUGIN_NS);

              // 用 useState 包一层让组件有订阅能力
              // 但 InjectionsTuneTab 是纯函数组件，需要在它外面做订阅
              var InjectionTuneTabWithHooks = function () {
                var snapshot = react.useSyncExternalStore(
                  function (cb) { return scope.subscribe(cb); },
                  function () { return scope.getSnapshot(); },
                  function () { return scope.getSnapshot(); },
                );
                return InjectionTuneTab({ t: t, scope: scope });
              };

              var dispose = ctx.slots.inject(
                'settings.plugins.tab',
                function () {
                  return ctx.slots.register({
                    name: 'settings.plugins.tab',
                    id: 'injection-tune',
                    order: 50,
                    label: function () { return t('tab'); },
                    locale: NS,
                  }, InjectionTuneTabWithHooks);
                },
              );
              return dispose;
            },
          );
        },
        'dsh-injection-tune: settings tab',
      );
    }

    exports.NS = NS;
    exports.PLUGIN_NS = PLUGIN_NS;
    exports.apply = apply;
    exports.inject = ['slots', 'locale', 'configForms'];

    return module.exports;
  },
});
