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
      intro: '在 systemPrompt 组装阶段和每轮 agent/pre-step 瀑布里，对三类外部插件的注入做运行时拦截/改写，削减上下文冗余。六个功能独立开关，默认全部开启。',
      sectionSup: 'AI-4/5 · 系统级注入拦截',
      sectionSupHint: '这三项在 system-prompt/assemble 阶段就拦截——在初始系统提示词组装时就干掉对应 section/context，不会出现在后续消息流里。',
      fieldSupACP: '拦截 billion-context 等外部压缩插件的 ACP 规范 section',
      fieldSupACPHint: 'billion-context 安装后会把一整套 ACP 压缩规范塞进初始系统提示词（约 10KB），与其他压缩方案重复。开启后直接过滤掉。',
      fieldSupAutoMem: '拦截 auto-memory 的 runtime-context 动态快照',
      fieldSupAutoMemHint: 'auto-memory 每轮把 <memory_system> 块追加到历史尾部，约 1-2KB/轮。开启后只去掉这条注入消息，auto-memory 其他功能（写盘、tool、配置）不受影响。',
      fieldSupSessionKit: '拦截 session-kit 的任务看板自动注入',
      fieldSupSessionKitHint: 'session-kit 每轮扫描未完任务追加提醒（约 200 字符）。开启后不再自动注入，但 task_list / task_inject 工具照常可用。',
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

      // AI-4 工具可见性门
      gateTitle: 'AI-4 · 工具可见性门',
      gateHint: '逐条停用工具：被停用的工具整份 schema 不进请求（每一轮都省，且不吃缓存）。按注册来源分框，默认全部勾选 = 全部激活，取消勾选即隐藏该工具；改动即时生效，新请求按新名单装配。',
      gateEnable: '启用工具可见性门',
      gateEnableHint: '关闭后名单保留但不生效',
      gateSlim: '精简模式',
      gateSlimHint: '说明按关键词加权裁剪：硬纪律句（必须/禁止/拒绝）优先保留，其余装入预算（parameters 不动）；勾选「豁免」的工具保持完整说明。只影响工具表体积，不影响工具可用性。',
      gateBudget: '精简预算',
      gateBudgetApply: '应用',
      gateBudgetInEffect: '当前预算 {budget} 字符（生效中）',
      gateBudgetPending: '当前预算 {budget} 字符（有未应用的修改：{draft}）',
      gateBudgetOff: '精简模式关闭时预算不生效',
      gateBudgetInvalid: '预算需为 80–4000 的整数',
      gatePrevSlim: '精简预览',
      gatePrevOrig: '原文对照',
      gatePrevLoading: '计算中…',
      gatePrevNotFound: '（读不到该工具的原始描述）',
      gatePrevIneffective: '（豁免中或精简未生效——完整说明原样下发）',
      gateExempt: '豁免',
      gateExemptTitle: '精简模式下保留该工具的完整说明（仅精简模式开启且工具未被隐藏时可勾选）',
      gateSummary: '共 {count} 个工具 · 已激活 {active} 个 · 已隐藏 {denied} 个 · 每请求约省 {saved} token（工具表合计 ≈{total}）',
      gateLoading: '正在读取工具表…',
      gateUnavailable: '读不到工具表：宿主未提供 tools 服务，或设置路由未注册。',
      gateRefresh: '刷新',
      gateEmpty: '当前没有任何可见工具。',
      gateSaving: '保存中…',
      gateAgents: '生效范围：{n} 个活动会话',
      gateGroupMeta: '{count} 个工具 · 激活 {active} · 隐藏 {denied} · ≈{tokens} token',
      gateGroupHide: '隐藏本栏所有工具注入',
      gateGroupRestore: '全部激活',
      gateSortLabel: '排序',
      gateSortName: '按名称',
      gateSortState: '按激活情况',
      gateSortAsc: '正序',
      gateSortDesc: '倒序',
      gateExpand: '展开',
      gateCollapse: '折叠',
      gateReason_capture: '来源：运行时捕获',
      gateReason_learned: '来源：历史记录',
      gateReason_table: '来源：内置对照表',
      gateReason_prefix: '来源：名称前缀',
      gateReason_none: '来源未识别',
      gateCritical: '核心',
      gateFuncPrefix: '功能：',
      gateNoSummary: '（该工具没有描述）',
      gateHiddenTag: '已隐藏',
    };

    var en = {
      tab: 'Injection Tune',
      title: 'Injection Tune',
      intro: 'Intercept and rewrite injected content from three external plugins, both at systemPrompt assembly time and in the per-turn agent/pre-step waterfall. Six independent toggles; all on by default.',
      sectionSup: 'AI-4/5 · System-level injection blockers',
      sectionSupHint: 'These three filters run at the system-prompt/assemble stage — they strip sections/contexts before any per-turn message is built.',
      fieldSupACP: 'Block billion-context ACP spec section',
      fieldSupACPHint: 'billion-context injects ~10KB of ACP compression rules into the system prompt. Enable to strip it (useful when another compression scheme is in play).',
      fieldSupAutoMem: 'Block auto-memory runtime-context snapshots',
      fieldSupAutoMemHint: 'auto-memory appends a ~1-2KB memory_system block to history on every turn. Enable to suppress just that injection — all other auto-memory functions (write-back, tools, config) remain intact.',
      fieldSupSessionKit: 'Block session-kit task-board auto-injection',
      fieldSupSessionKitHint: 'session-kit scans unfinished tasks and appends a ~200-char reminder each turn. Enable to suppress automatic injection; task_list / task_inject tools remain usable.',
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

      // AI-4 tool visibility gate
      gateTitle: 'AI-4 · Tool visibility gate',
      gateHint: 'Disable tools one by one: a disabled tool drops its whole schema from the request (saved on every turn, and it is not covered by prompt caching). Grouped by the plugin that registered it. All tools start checked (= active); unchecking hides one. Changes apply immediately.',
      gateEnable: 'Enable the tool visibility gate',
      gateEnableHint: 'List is kept but inactive while off',
      gateSlim: 'Slim mode',
      gateSlimHint: 'Descriptions are trimmed by keyword weighting: hard-discipline sentences (must/never/refused) are kept first, the rest fit into the budget (parameters untouched); tools checked "Exempt" keep their full description. Shrinks the tool table only, never availability.',
      gateBudget: 'Slim budget',
      gateBudgetApply: 'Apply',
      gateBudgetInEffect: 'Current budget {budget} chars (in effect)',
      gateBudgetPending: 'Current budget {budget} chars (unapplied change: {draft})',
      gateBudgetOff: 'Budget applies only while slim mode is on',
      gateBudgetInvalid: 'Budget must be an integer between 80 and 4000',
      gatePrevSlim: 'Slim preview',
      gatePrevOrig: 'Original',
      gatePrevLoading: 'Computing…',
      gatePrevNotFound: '(original description unavailable)',
      gatePrevIneffective: '(exempt or slim mode off — the full description is sent as-is)',
      gateExempt: 'Exempt',
      gateExemptTitle: 'Keep the full description for this tool while slim mode is on (clickable only when slim mode is on and the tool is not hidden)',
      gateSummary: '{count} tools · {active} active · {denied} hidden · ≈{saved} tokens saved per request (tool table ≈{total})',
      gateLoading: 'Reading the tool table…',
      gateUnavailable: 'Tool table unavailable: the host exposes no tools service, or the settings route is not registered.',
      gateRefresh: 'Refresh',
      gateEmpty: 'No visible tools.',
      gateSaving: 'Saving…',
      gateAgents: 'Applies to: {n} live session(s)',
      gateGroupMeta: '{count} tools · {active} active · {denied} hidden · ≈{tokens} tokens',
      gateGroupHide: 'Hide this group',
      gateGroupRestore: 'Activate all',
      gateSortLabel: 'Sort',
      gateSortName: 'By name',
      gateSortState: 'By state',
      gateSortAsc: 'Ascending',
      gateSortDesc: 'Descending',
      gateExpand: 'Expand',
      gateCollapse: 'Collapse',
      gateReason_capture: 'source: captured at runtime',
      gateReason_learned: 'source: learned',
      gateReason_table: 'source: built-in table',
      gateReason_prefix: 'source: name prefix',
      gateReason_none: 'source unknown',
      gateCritical: 'core',
      gateFuncPrefix: 'Role: ',
      gateNoSummary: '(no description)',
      gateHiddenTag: 'hidden',
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

      // ── AI-4 工具可见性门 ────────────────────────────────────────────────
      gateSummary: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      gateToolbar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      // 排序条：与刷新按钮同一行，靠右收起。
      sortBar: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexWrap: 'wrap' },
      sortLabel: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      segBtn: { border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: '11px', lineHeight: '16px', padding: '2px 8px', borderRadius: '5px', cursor: 'pointer' },
      segBtnOn: { border: '1px solid var(--dsw-alias-state-business-primary)', background: 'var(--dsw-alias-state-business-primary)', color: '#fff' },
      // 分框：加深底色 + 亮色边框，与页面底区分开。
      // 底色 = layer-2 再压一层 16% 黑色渐变：这样明暗两种主题下都是"更深"，
      // 不依赖 token 在某个主题里恰好比页面底色暗（token 缺失时也只剩这层淡灰，不会消失）。
      groupBox: {
        background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, transparent))',
        backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0.16), rgba(0, 0, 0, 0.16))',
        border: '1px solid var(--dsw-alias-state-business-primary)',
        borderRadius: '10px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      groupHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      collapseBtn: {
        // 圆角方形底：深色主题下透明按钮几乎看不见，加一层浅底 + 细边框定位点击区。
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '20px', height: '20px', flex: '0 0 auto',
        borderRadius: '5px',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer', font: 'inherit', fontSize: '11px', lineHeight: '1',
        padding: '0', textAlign: 'center',
      },
      groupTitle: { fontSize: '15px', fontWeight: 700, fontFamily: '"Microsoft YaHei", "微软雅黑", "PingFang SC", sans-serif', color: 'var(--dsw-alias-label-primary)' },
      groupMeta: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      linkBtn: { marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--dsw-alias-state-business-primary)', cursor: 'pointer', font: 'inherit', fontSize: '11px', padding: 0 },
      toolRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '4px 0' },
      toolRowHidden: { opacity: 0.55 },
      hiddenTag: { fontSize: '10px', lineHeight: '14px', padding: '0 4px', borderRadius: '3px', border: '1px solid var(--dsw-alias-state-warn-primary)', color: 'var(--dsw-alias-state-warn-primary)', marginLeft: '6px' },
      toolName: { fontSize: '13px', fontFamily: 'monospace', color: 'var(--dsw-alias-label-primary)' },
      // 功能说明：完整展示，超宽自动换行。nowrap/ellipsis 一律不加，
      // 长英文标识符用 break-word + anywhere 兜住，避免撑破分框。
      toolFunc: {
        fontSize: '10px',
        lineHeight: '15px',
        fontFamily: 'monospace',
        color: 'var(--dsw-alias-label-tertiary)',
        marginTop: '1px',
        whiteSpace: 'normal',
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
      },
      toolTok: { marginLeft: 'auto', fontSize: '11px', fontFamily: 'monospace', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      badge: { fontSize: '10px', lineHeight: '14px', padding: '0 4px', borderRadius: '3px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', marginLeft: '6px' },
      // 预览子栏：展开才渲染、按需请求。浅黄透明底标出「精简后仍保留」的句子。
      subToggle: {
        // 亮色圆角矩形：10px 小蓝字在深色底上太弱，加边框把点击区显出来。
        display: 'inline-flex', alignItems: 'center',
        border: '1px solid var(--dsw-alias-state-business-primary)',
        borderRadius: '4px',
        background: 'transparent',
        color: 'var(--dsw-alias-state-business-primary)',
        cursor: 'pointer', font: 'inherit', fontSize: '10px', lineHeight: '16px',
        padding: '0 6px', marginRight: '6px',
      },
      subToggleDisabled: { borderColor: 'var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', cursor: 'not-allowed', opacity: 0.5 },
      subBox: {
        fontSize: '10px', lineHeight: '15px', fontFamily: 'monospace', color: 'var(--dsw-alias-label-secondary)',
        marginTop: '4px', padding: '6px 8px', borderRadius: '4px',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)',
        whiteSpace: 'normal', wordBreak: 'break-word', overflowWrap: 'anywhere',
      },
      hlMark: { background: 'rgba(255, 213, 79, 0.30)', borderRadius: '2px' },
      subNote: { fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)', fontStyle: 'italic' },
      budgetInput: { width: '64px', fontSize: '12px', padding: '1px 4px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '3px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
      budgetBtn: { fontSize: '11px', padding: '1px 8px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '3px', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
      gateEmpty: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', padding: '8px 0' },
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
      var supACP = typeof formValue.suppressACPSection === 'boolean' ? formValue.suppressACPSection : true;
      var supAutoMem = typeof formValue.suppressAutoMemoryRuntimeContext === 'boolean' ? formValue.suppressAutoMemoryRuntimeContext : true;
      var supSessionKit = typeof formValue.suppressSessionKitTasks === 'boolean' ? formValue.suppressSessionKitTasks : true;

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

        // AI-4/5/6：系统级注入拦截（systemPrompt 阶段 + pre-step 阶段）
        react.createElement('div', { style: s.block },
          react.createElement('h4', { style: s.blockTitle }, t('sectionSup')),
          react.createElement('p', { style: s.blockHint }, t('sectionSupHint')),
          renderSwitch(t('fieldSupACP'), t('fieldSupACPHint'), ['suppressACPSection'], supACP, !snap.writable),
          renderSwitch(t('fieldSupAutoMem'), t('fieldSupAutoMemHint'), ['suppressAutoMemoryRuntimeContext'], supAutoMem, !snap.writable),
          renderSwitch(t('fieldSupSessionKit'), t('fieldSupSessionKitHint'), ['suppressSessionKitTasks'], supSessionKit, !snap.writable),
        ),

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

        // AI-4：工具可见性门（自带数据源，不依赖 configForms）
        react.createElement(ToolGateSection, { t: t, styles: s }),
      );
    }

    // ── 组件：ToolGateSection（AI-4 工具可见性门） ─────────────────────────
    // 与上面三个开关不同，这里的数据不进 configForms —— 它是"108 条工具各自一行"
    // 的结构化列表，走本插件自己的设置路由（GET 读、POST 写，写完整名单）。
    var GATE_API = '/plugins/injection-tune/tool-gate';

    function ToolGateSection(props) {
      var t = props.t;
      var s = props.styles;
      var h = react.createElement;

      var dataPair = react.useState(null);
      var data = dataPair[0];
      var setData = dataPair[1];
      var errorPair = react.useState('');
      var error = errorPair[0];
      var setError = errorPair[1];
      var busyPair = react.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var aliveRef = react.useRef(true);
      // 排序与折叠都是纯视图状态：不进名单、不落盘、不影响不同分框之间的内容。
      var sortPair = react.useState('name'); // 'name' | 'state'
      var sortKey = sortPair[0];
      var setSortKey = sortPair[1];
      var descPair = react.useState(false);
      var descending = descPair[0];
      var setDescending = descPair[1];
      var collapsedPair = react.useState({}); // { [groupKey]: true }
      var collapsed = collapsedPair[0];
      var setCollapsed = collapsedPair[1];

      function request(method, body) {
        var init = { method: method };
        if (body !== undefined) {
          init.headers = { 'Content-Type': 'application/json' };
          init.body = JSON.stringify(body);
        }
        setBusy(true);
        return fetch(GATE_API, init)
          .then(function (response) { return response.json(); })
          .then(function (json) {
            if (!aliveRef.current) return;
            if (json && json.ok === true) {
              var firstLoad = data === null;
              setData(json);
              setError('');
              if (firstLoad && typeof json.budget === 'number') setBudgetDraft(String(json.budget));
              // 预算 / 豁免 / 精简开关变化后，重算展开中的预览（收起的不算）。
              refreshExpandedPreviews(json);
            } else {
              setError((json && json.error) || t('saveFailed'));
            }
          })
          .catch(function (err) {
            if (aliveRef.current) setError(String((err && err.message) || err));
          })
          .then(function () { if (aliveRef.current) setBusy(false); });
      }

      react.useEffect(function () {
        aliveRef.current = true;
        request('GET');
        return function () { aliveRef.current = false; };
      }, []);

      /** 名单增删：单纯拼数组，隐藏 = 进 deny。 */
      function withHidden(denyList, names, hidden) {
        var next = denyList.slice();
        for (var i = 0; i < names.length; i += 1) {
          var index = next.indexOf(names[i]);
          if (hidden) {
            if (index < 0) next.push(names[i]);
          } else if (index >= 0) {
            next.splice(index, 1);
          }
        }
        return next;
      }

      function toggleTool(name, hidden) {
        if (!data) return;
        request('POST', { deny: withHidden(data.deny || [], [name], hidden) });
      }

      function toggleGroup(group, hidden) {
        if (!data) return;
        var names = group.tools.map(function (tool) { return tool.name; });
        request('POST', { deny: withHidden(data.deny || [], names, hidden) });
      }

      /** 豁免切换：精简模式下保留该工具的完整 description。 */
      function toggleExempt(name, exempt) {
        if (!data) return;
        request('POST', { exemptToggle: { name: name, exempt: exempt } });
      }

      // ── 预览子栏（按需现算：只在展开状态下才请求服务端） ────────────────
      var expandedPair = react.useState({}); // { [name]: { slim: bool, orig: bool } }
      var expanded = expandedPair[0];
      var setExpanded = expandedPair[1];
      var previewCachePair = react.useState({}); // { [name]: { key, resp } }
      var previewCache = previewCachePair[0];
      var setPreviewCache = previewCachePair[1];
      var budgetDraftPair = react.useState('');
      var budgetDraft = budgetDraftPair[0];
      var setBudgetDraft = budgetDraftPair[1];
      // 同步 ref：request() 的闭包里要读最新的展开/缓存状态做失效重算。
      var expandedRef = react.useRef({});
      var previewCacheRef = react.useRef({});
      react.useEffect(function () { expandedRef.current = expanded; }, [expanded]);
      react.useEffect(function () { previewCacheRef.current = previewCache; }, [previewCache]);

      /** 预览缓存键：预算 / 精简开关 / 豁免任一变化都要重算。 */
      function previewKeyOf(budgetValue, slimOn, exempt) {
        return [budgetValue, slimOn, exempt].join('|');
      }

      /** 展开/收起一个预览子栏；展开时若缓存缺失或已过期则按需请求。 */
      function togglePreview(name, which, tool) {
        var current = expanded[name] || {};
        var opening = current[which] !== true;
        setExpanded(function (prev) {
          var next = Object.assign({}, prev);
          next[name] = Object.assign({}, prev[name] || {});
          next[name][which] = !(prev[name] && prev[name][which] === true);
          return next;
        });
        if (opening && data) {
          var cached = previewCache[name];
          var wantedKey = previewKeyOf(data.budget, data.slim === true, tool.exempt === true);
          if (!cached || cached.loading || cached.fetchedKey !== wantedKey) {
            fetchPreviewWithKey(name, wantedKey);
          }
        }
      }

      function fetchPreviewWithKey(name, wantedKey) {
        setPreviewCache(function (prev) {
          var next = Object.assign({}, prev);
          next[name] = { loading: true, wantedKey: wantedKey };
          return next;
        });
        var init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preview: name }) };
        fetch(GATE_API, init)
          .then(function (response) { return response.json(); })
          .then(function (json) {
            if (!aliveRef.current) return;
            setPreviewCache(function (prev) {
              var next = Object.assign({}, prev);
              next[name] = { fetchedKey: wantedKey, resp: json };
              return next;
            });
          })
          .catch(function () {
            if (!aliveRef.current) return;
            setPreviewCache(function (prev) {
              var next = Object.assign({}, prev);
              next[name] = { fetchedKey: wantedKey, resp: { ok: false, error: 'fetch failed' } };
              return next;
            });
          });
      }

      /** 预算 / 豁免变化后重算所有已展开的预览（收起状态的不算，省资源）。 */
      function refreshExpandedPreviews(nextData) {
        var names = Object.keys(expandedRef.current || {});
        for (var i = 0; i < names.length; i += 1) {
          var name = names[i];
          var state = expandedRef.current[name] || {};
          if (state.slim !== true && state.orig !== true) continue;
          var tool = null;
          var groups = (nextData && nextData.groups) || [];
          for (var g = 0; g < groups.length; g += 1) {
            for (var ti = 0; ti < groups[g].tools.length; ti += 1) {
              if (groups[g].tools[ti].name === name) { tool = groups[g].tools[ti]; break; }
            }
            if (tool) break;
          }
          if (!tool) continue;
          var cached = previewCacheRef.current[name];
          var wantedKey = [
            nextData && nextData.budget,
            nextData && nextData.slim === true,
            tool.exempt === true,
          ].join('|');
          if (!cached || cached.loading || cached.fetchedKey !== wantedKey) fetchPreviewWithKey(name, wantedKey);
        }
      }

      /** 应用预算输入。 */
      function applyBudget() {
        if (!data) return;
        var parsed = Number(budgetDraft);
        if (!Number.isFinite(parsed) || String(Math.round(parsed)) !== String(budgetDraft).trim()) {
          setError(t('gateBudgetInvalid'));
          return;
        }
        request('POST', { budget: Math.round(parsed) });
      }

      function renderTool(tool) {
        var hidden = tool.denied === true;
        var slimOn = data !== null && data.slim === true;
        // 豁免框只有在「精简模式开着、工具未被隐藏」时才可交互；隐藏工具名下全部交互框置灰。
        var exemptInteractive = slimOn && !hidden && !busy;
        // token 徽标动态化：精简生效中的工具显示精简后体积，其余显示完整体积。
        var shownTokens = slimOn && tool.exempt !== true
          ? (tool.slimTokens !== undefined ? tool.slimTokens : tool.tokens)
          : tool.tokens;
        return h('div', { key: tool.name, style: hidden ? Object.assign({}, s.toolRow, s.toolRowHidden) : s.toolRow },
          h('input', {
            type: 'checkbox',
            // 勾选 = 激活。取消勾选才把它加进 deny 名单。
            checked: !hidden,
            disabled: busy,
            style: { marginTop: '3px', cursor: busy ? 'not-allowed' : 'pointer' },
            onChange: function (event) { toggleTool(tool.name, !event.target.checked); },
          }),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: s.toolName }, tool.name,
              tool.critical ? h('span', { style: s.badge }, t('gateCritical')) : null,
              hidden ? h('span', { style: s.hiddenTag }, t('gateHiddenTag')) : null,
            ),
            // 与 step-governor 的「源码键」同一种小字：10px、等宽、三级文字色。
            h('div', { style: s.toolFunc }, t('gateFuncPrefix') + (tool.summary || t('gateNoSummary'))),
            renderPreviews(tool),
          ),
          h('label', {
            title: t('gateExemptTitle'),
            style: {
              display: 'flex', alignItems: 'center', gap: '3px', fontSize: '10px', whiteSpace: 'nowrap',
              color: 'var(--dsw-alias-label-tertiary)',
              cursor: exemptInteractive ? 'pointer' : 'not-allowed',
              opacity: exemptInteractive ? 1 : 0.4,
            },
          },
            h('input', {
              type: 'checkbox',
              checked: tool.exempt === true,
              disabled: !exemptInteractive,
              onChange: function (event) { toggleExempt(tool.name, event.target.checked); },
            }),
            t('gateExempt'),
          ),
          h('span', { style: s.toolTok }, '≈' + shownTokens + ' tok'),
        );
      }

      /**
       * 工具行下方的两个预览子栏：精简预览 + 原文对照（保留句浅黄高亮）。
       *
       * 只在展开状态下才渲染内容并按需请求（要求 4：省资源）；精简未开启或
       * 工具被隐藏时开关置灰不可点，已展开的内容如实显示「未生效」。
       */
      function renderPreviews(tool) {
        var hidden = tool.denied === true;
        var slimOn = data !== null && data.slim === true;
        var interactive = slimOn && !hidden;
        var state = expanded[tool.name] || {};
        // 开关本身常驻渲染（否则折叠时连「展开」按钮都没有，永远点不开）；
        // 内容只在展开状态渲染并请求，收起时零开销。
        var cached = previewCache[tool.name];
        var resp = cached && !cached.loading ? cached.resp : null;
        var loading = !resp || cached.loading === true;

        function subToggle(which, labelKey) {
          var open = state[which] === true;
          return h('button', {
            key: which,
            type: 'button',
            style: interactive ? s.subToggle : Object.assign({}, s.subToggle, s.subToggleDisabled),
            disabled: !interactive,
            onClick: function () { if (interactive) togglePreview(tool.name, which, tool); },
          }, (open ? '▾ ' : '▸ ') + t(labelKey));
        }

        var slimText;
        if (loading) slimText = h('div', { style: s.subNote }, t('gatePrevLoading'));
        else if (!resp.ok || resp.found === false) slimText = h('div', { style: s.subNote }, resp.found === false ? t('gatePrevNotFound') : String(resp.error || 'error'));
        else if (resp.exempt === true) slimText = h('div', null, h('span', { style: s.subNote }, t('gatePrevIneffective')), resp.original);
        else slimText = resp.slim;

        function originalWithMarks() {
          if (!resp || !resp.ok || !Array.isArray(resp.parts)) {
            return resp && resp.original ? resp.original : t('gatePrevNotFound');
          }
          if (resp.exempt === true) return resp.original;
          var nodes = [];
          for (var i = 0; i < resp.parts.length; i += 1) {
            var part = resp.parts[i];
            nodes.push(part.kept
              ? h('span', { key: i, style: s.hlMark }, part.text)
              : part.text);
          }
          return nodes;
        }

        return h('div', { style: { marginTop: '2px' } },
          h('div', null, subToggle('slim', 'gatePrevSlim'), subToggle('orig', 'gatePrevOrig')),
          state.slim === true ? h('div', { style: s.subBox }, slimText) : null,
          state.orig === true ? h('div', { style: s.subBox }, originalWithMarks()) : null,
        );
      }

      /**
       * 对**单个分框内**的工具排序。
       *
       * 只在 group.tools 的副本上操作，排序永远不跨框 —— 不同来源的工具在
       * 「名称」「激活情况」两个维度上都可能与别的框交错，一旦跨框排序就会把
       * 归属关系打散。
       *
       * @param {object} group 一个来源分组。
       * @returns {Array<object>} 排好序的工具副本。
       */
      function sortedTools(group) {
        var list = group.tools.slice();
        list.sort(function (a, b) {
          var delta = 0;
          if (sortKey === 'state') {
            delta = (a.denied === true ? 1 : 0) - (b.denied === true ? 1 : 0);
          }
          if (delta === 0) {
            delta = a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
          }
          return descending ? -delta : delta;
        });
        return list;
      }

      function toggleCollapsed(key) {
        var next = Object.assign({}, collapsed);
        if (next[key]) delete next[key];
        else next[key] = true;
        setCollapsed(next);
      }

      function renderGroup(group) {
        var hiddenAll = group.deniedCount >= group.tools.length;
        var activeCount = group.tools.length - group.deniedCount;
        var foldKey = group.label;
        var isCollapsed = collapsed[foldKey] === true;
        var head = h('div', { key: 'head', style: s.groupHead },
          h('button', {
            type: 'button',
            title: isCollapsed ? t('gateExpand') : t('gateCollapse'),
            style: s.collapseBtn,
            onClick: function () { toggleCollapsed(foldKey); },
          }, isCollapsed ? '▸' : '▾'),
          h('span', { style: s.groupTitle, title: group.label }, group.label),
          h('span', { style: s.groupMeta },
            t('gateGroupMeta', { count: group.tools.length, active: activeCount, denied: group.deniedCount, tokens: group.tokens })
              + ' · ' + t('gateReason_' + group.reason),
          ),
          h('button', {
            type: 'button',
            style: Object.assign({}, s.linkBtn, busy ? s.btnDisabled : {}),
            disabled: busy,
            onClick: function () { toggleGroup(group, !hiddenAll); },
          }, hiddenAll ? t('gateGroupRestore') : t('gateGroupHide')),
        );
        var rows = isCollapsed ? [] : sortedTools(group).map(renderTool);
        return h('div', { key: group.label + ':' + group.tools.length, style: s.groupBox },
          [head].concat(rows),
        );
      }

      var body;
      if (data === null) {
        body = h('div', { style: s.gateEmpty }, error || (busy ? t('gateLoading') : t('gateUnavailable')));
      } else {
        body = [
          h('label', { key: 'master', style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: busy ? 'not-allowed' : 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: data.enabled === true,
              disabled: busy,
              onChange: function () { request('POST', { enabled: data.enabled !== true }); },
            }),
            h('span', { style: { fontSize: '13px' } }, t('gateEnable')),
            data.enabled === true
              ? null
              : h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } }, t('gateEnableHint')),
          ),
          h('label', { key: 'slim', style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', cursor: busy ? 'not-allowed' : 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: data.slim === true,
              disabled: busy,
              onChange: function () { request('POST', { slim: data.slim !== true }); },
            }),
            h('span', { style: { fontSize: '13px' } }, t('gateSlim')),
          ),
          data.slim === true
            ? h('p', { key: 'slimHint', style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', margin: '2px 0 0 26px' } }, t('gateSlimHint'))
            : null,
          // 预算行常显：精简关闭时置灰不可编辑，避免「找不到这个设置」。
          h('div', { key: 'budget', style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0 0 26px', opacity: data.slim === true ? 1 : 0.45 } },
            h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, t('gateBudget')),
            h('input', {
              type: 'number', min: 80, max: 4000, step: 10,
              value: budgetDraft,
              disabled: busy || data.slim !== true,
              style: s.budgetInput,
              onChange: function (event) { setBudgetDraft(event.target.value); },
            }),
            h('button', {
              type: 'button',
              style: Object.assign({}, s.budgetBtn, (busy || data.slim !== true) ? { cursor: 'not-allowed' } : {}),
              disabled: busy || data.slim !== true || String(data.budget) === String(budgetDraft).trim(),
              onClick: applyBudget,
            }, t('gateBudgetApply')),
            h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } },
              data.slim !== true
                ? t('gateBudgetOff')
                : (String(data.budget) === String(budgetDraft).trim()
                  ? t('gateBudgetInEffect', { budget: data.budget })
                  : t('gateBudgetPending', { budget: data.budget, draft: budgetDraft })),
            ),
          ),
          h('p', { key: 'summary', style: s.gateSummary }, t('gateSummary', {
            count: data.totals.count,
            active: data.totals.count - data.totals.deniedCount,
            denied: data.totals.deniedCount,
            saved: data.totals.deniedTokens,
            total: data.totals.tokens,
          })),
          error ? h('p', { key: 'err', style: s.error }, error) : null,
          h('div', { key: 'toolbar', style: s.gateToolbar },
            h('button', {
              key: 'refresh',
              type: 'button',
              style: Object.assign({}, s.btn, busy ? s.btnDisabled : {}),
              disabled: busy,
              onClick: function () { request('GET'); },
            }, t('gateRefresh')),
            busy ? h('span', { key: 'busy', style: s.status }, t('gateSaving')) : null,
            h('span', { key: 'agents', style: s.status }, t('gateAgents', { n: data.agents })),
            // 排序：只影响每个分框内部的顺序，不改变分组归属。
            h('div', { key: 'sort', style: s.sortBar },
              h('span', { style: s.sortLabel }, t('gateSortLabel')),
              h('button', {
                type: 'button',
                style: Object.assign({}, s.segBtn, sortKey === 'name' ? s.segBtnOn : {}),
                onClick: function () { setSortKey('name'); },
              }, t('gateSortName')),
              h('button', {
                type: 'button',
                style: Object.assign({}, s.segBtn, sortKey === 'state' ? s.segBtnOn : {}),
                onClick: function () { setSortKey('state'); },
              }, t('gateSortState')),
              h('button', {
                type: 'button',
                style: s.segBtn,
                onClick: function () { setDescending(!descending); },
              }, descending ? t('gateSortDesc') : t('gateSortAsc')),
            ),
          ),
          data.groups.length === 0 ? h('div', { key: 'none', style: s.gateEmpty }, t('gateEmpty')) : null,
        ].concat(data.groups.map(renderGroup));
      }

      return h('div', { style: s.block },
        h('h4', { style: s.blockTitle }, t('gateTitle')),
        h('p', { style: s.blockHint }, t('gateHint')),
        body,
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
    // 供测试渲染（client bundle 里多一个导出无副作用，不影响 settings 挂载）。
    exports.ToolGateSection = ToolGateSection;
    exports.inject = ['slots', 'locale', 'configForms'];

    return module.exports;
  },
});
