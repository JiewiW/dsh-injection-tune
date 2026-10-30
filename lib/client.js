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

      // AI-4 工具可见性门
      gateTitle: 'AI-4 · 工具可见性门',
      gateHint: '逐条停用工具：被停用的工具整份 schema 不进请求（每一轮都省，且不吃缓存）。按注册来源分框，默认全部勾选 = 全部激活，取消勾选即隐藏该工具；改动即时生效，新请求按新名单装配。',
      gateEnable: '启用工具可见性门',
      gateEnableHint: '关闭后名单保留但不生效',
      gateSummary: '共 {count} 个工具 · 已激活 {active} 个 · 已隐藏 {denied} 个 · 每请求约省 {saved} token（工具表合计 ≈{total}）',
      gateLoading: '正在读取工具表…',
      gateUnavailable: '读不到工具表：宿主未提供 tools 服务，或设置路由未注册。',
      gateRefresh: '刷新',
      gateEmpty: '当前没有任何可见工具。',
      gateSaving: '保存中…',
      gateAgents: '生效范围：{n} 个活动会话',
      gateGroupMeta: '{count} 个工具 · 激活 {active} · 隐藏 {denied} · ≈{tokens} token',
      gateGroupHide: '全部隐藏',
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

      // AI-4 tool visibility gate
      gateTitle: 'AI-4 · Tool visibility gate',
      gateHint: 'Disable tools one by one: a disabled tool drops its whole schema from the request (saved on every turn, and it is not covered by prompt caching). Grouped by the plugin that registered it. All tools start checked (= active); unchecking hides one. Changes apply immediately.',
      gateEnable: 'Enable the tool visibility gate',
      gateEnableHint: 'List is kept but inactive while off',
      gateSummary: '{count} tools · {active} active · {denied} hidden · ≈{saved} tokens saved per request (tool table ≈{total})',
      gateLoading: 'Reading the tool table…',
      gateUnavailable: 'Tool table unavailable: the host exposes no tools service, or the settings route is not registered.',
      gateRefresh: 'Refresh',
      gateEmpty: 'No visible tools.',
      gateSaving: 'Saving…',
      gateAgents: 'Applies to: {n} live session(s)',
      gateGroupMeta: '{count} tools · {active} active · {denied} hidden · ≈{tokens} tokens',
      gateGroupHide: 'Hide all',
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
      collapseBtn: { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', font: 'inherit', fontSize: '11px', lineHeight: '16px', padding: '0 2px', width: '16px', textAlign: 'center' },
      groupTitle: { fontSize: '15px', fontWeight: 700, fontFamily: '"Microsoft YaHei", "微软雅黑", "PingFang SC", sans-serif', color: 'var(--dsw-alias-label-primary)' },
      groupMeta: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
      linkBtn: { marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--dsw-alias-state-business-primary)', cursor: 'pointer', font: 'inherit', fontSize: '11px', padding: 0 },
      toolRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '4px 0' },
      toolRowHidden: { opacity: 0.55 },
      hiddenTag: { fontSize: '10px', lineHeight: '14px', padding: '0 4px', borderRadius: '3px', border: '1px solid var(--dsw-alias-state-warn-primary)', color: 'var(--dsw-alias-state-warn-primary)', marginLeft: '6px' },
      toolName: { fontSize: '13px', fontFamily: 'monospace', color: 'var(--dsw-alias-label-primary)' },
      toolFunc: { fontSize: '10px', lineHeight: '15px', fontFamily: 'monospace', color: 'var(--dsw-alias-label-tertiary)', marginTop: '1px' },
      toolTok: { marginLeft: 'auto', fontSize: '11px', fontFamily: 'monospace', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      badge: { fontSize: '10px', lineHeight: '14px', padding: '0 4px', borderRadius: '3px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', marginLeft: '6px' },
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
              setData(json);
              setError('');
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

      function renderTool(tool) {
        var hidden = tool.denied === true;
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
          ),
          h('span', { style: s.toolTok }, '≈' + tool.tokens + ' tok'),
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
