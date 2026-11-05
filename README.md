# dsh-injection-tune

DSH 宿主插件，用于压低每个请求步的注入体积。设置页分「自动精简」「注入名单」两类共 6 个模块，各自独立：自动精简里的三项外部注入拦截默认开启、新增的模型切换提示拦截默认关闭，其余改写默认关闭；两扇注入名单默认关闭（名单保留但不生效），因此加载后不会改变工具与技能的可用性。

## 背景

DSH 的 agent 每一步都会重新组装请求：runtime-context 快照、技能目录、项目指令、工具 schema 全量重发。长会话里这些固定开销占每步输入的一半以上，而其中大部分内容在步与步之间并没有变化。本插件挂在 `agent/pre-step` 瀑布里，对四类注入分别做削减。

## 设置页结构（v0.4.1 重整）

面板位于 设置 → 内置插件 → 注入调优。界面统一用功能名，不再暴露 AI-x 内部代号：历史上面板里「AI-4」同时指 ACP 拦截与工具门，出现顺序还是 4/5/6 → 1/2/3 → 4 → 7，两扇名单又默认整屏展开，页面又长又乱。

| 顺序 | 分类 | 模块 | 内部代号 |
|---|---|---|---|
| 1 | 自动精简 | 外部插件注入拦截（4 个独立开关） | AI-4 / AI-5 / AI-6 / 模型切换 |
| 2 | 自动精简 | 运行时上下文去重 | AI-1 |
| 3 | 自动精简 | 技能目录增量下发 | AI-2 |
| 4 | 自动精简 | 项目指令延迟注入 | AI-3 |
| 5 | 注入名单 | 工具注入名单 | 工具门（旧称 AI-4，与 ACP 拦截重号） |
| 6 | 注入名单 | 技能注入名单 | AI-7 |

- **总折叠开关**：顶部「全部展开 / 全部折叠」一键控制 6 张卡片，旁边显示「已展开 N/6」；每张卡片标题也可单独点击展开/收起。默认全部折叠，一屏只看到 6 行标题。
- **状态徽标**：折叠时也能看状态——自动精简显示「x/y 项启用」，两扇名单由门面板异步上报「N 项 · 隐藏 M」，未启用显示「名单未启用」，读取中/失败各有提示。
- **折叠不卸载**：卡片 body 用 `display:none` 收起而非条件渲染，两扇门的名单数据与分框折叠状态跨折叠保留；展开时不重发 GET，也不会丢掉刚勾的选项。
- 折叠状态存浏览器 `localStorage`（key `dsh-injection-tune:fold-v1`），不写进插件配置；无 localStorage 的环境（如 node 测试）安全退化为默认全折叠。
- 门面板独立渲染时仍带自己的标题框；挂进卡片时传 `embedded: true` 去掉重复标题，功能说明保留在卡片体内。

## 功能

### AI-1 · runtime-context 去重（`dedupeRuntimeContext`）

runtime-context 快照每步都会整体重发，内部大量块与上一步相同。开启后按块与上一轮快照比对，只保留变化的块，其余折叠为一行统计（`folded N block(s), M chars`）。

### AI-2 · 技能目录增量注入（`incrementalSkillCatalog`）

`dsh-tool-skill` 会在目录内容变化后重发整份技能目录。开启后首次仍发全量，之后每步只列新增和描述有变化的条目，末尾补一行「其余 N 项未变」；有删除时报条数。实现上只替换目录消息的文本、不动 `source`，否则上游的 digest 判断会失效并退回全量重发。

`skillCatalogKeepDescription`（默认开）控制目录条目是否保留 description；关闭后只发名称，进一步压缩。

### AI-3 · 项目指令延迟注入（`deferredAgentInstructions`）

项目/全局指令原本挂在会话最前面，每步都占一段前缀。开启后延迟到首次出现相关信号时才注入。该功能由 `dsh-agent-instructions` 侧配合完成。

### 模型切换提示拦截（`suppressModelSelectionNotice`）

会话中途换模型时，`@deepseek-ai/dsh-agent` 的 `installModelSelection` 会在 `agent/pre-step` 追加一条 `user` 消息 `[model changed: …]`（`source.kind === 'model-selection'`、`form === 'notice'`、`summary === '旧模型 → 新模型'`，见 `lib/types/model-selection.js:12-26`）。这条消息会落盘，并在之后每次请求里随历史重发。

勾选后：

- 该消息按 `source` 从 `decision.messages` 剔除（与 AI-6 同一挂点、同一判据）；
- 每个 Session 的 `deriveMessages()` 被包一层投影，连开启开关之前已落盘的历史提示也不再进入请求（`buildRequest` 与 `agent-loop-invariant` 都走这个方法，两者一致，不会触发请求-日志一致性告警）。

开关默认关闭、volatile（改动即时生效，无需重启）；会话日志不改写，轨迹里仍能看到此前落盘的记录。

### 工具注入名单：工具可见性门 + 精简模式

设置页「工具注入名单」面板，含两部分：

**可见性门**：按注册来源（插件名）分框列出全部工具，每条带功能简述与体积估算。取消勾选即把该工具加入 deny 名单（走 `tools.restrict`），下一步生效。支持按名称/激活情况排序、正倒序、分框折叠、批量操作。隐藏的工具整行置灰，所有交互框禁用。

**精简模式**：开启后工具 description 按**关键词加权**裁剪——硬纪律句（必须/禁止/拒绝）优先保留，其余装入字符预算（默认 320，可在面板调节；parameters 一律不动）。每条工具可单独勾「豁免」保留完整说明；豁免框仅在精简模式开启且工具未隐藏时可交互；token 徽标按当前生效形态实时计算。每个工具下方有两个按需展开的子栏：「精简预览」实时显示裁剪结果，「原文对照」用浅黄底标出被保留的句子在原文中的位置——两者都只在展开状态下才向服务端请求计算。

裁剪实现：包装 `tools.schemaOf` 原型（system-prompt 组装 schema 的必经通道），只修改每步现算的投影副本，存储中的原始定义不改——开关、豁免与预算调整即时生效，卸载即回透传。隐藏语义上与旧版 deny 名单兼容，全部状态（含预算）跨重启持久化在 `~/.dsh/injection-tune/`。

工具的注册来源按三层归因：调用栈捕获（跨重启落盘复用）→ fiber 名 → 内置表/名称前缀。

### 技能注入名单：技能可见性门

设置页「技能注入名单」面板，与工具门同骨架：按技能来源（`skills` 注册表 summary 的 `source`，如 `user-dsh` / `project-dsh` / `bundled`）分框列出全部技能，每条带说明、提供者与目录行体积估算。取消勾选即把该技能加入 deny 名单，下一步请求起该行不再出现在 `<available_skills>` 目录里。支持框内排序、正倒序、分框折叠、批量隐藏/恢复；隐藏的技能整行置灰。清单是「全局视图 + 各活动会话」的并集：只注册在会话预设层的技能（例如 `skill-filesystem` 的用户/项目技能）需要有活动会话才会列出，界面上如实标注了这个范围；deny 名单本身按名字生效，不受当前是否列出影响。

实现上包装 `SkillRegistry.prototype.snapshot` 的**投影**，只过滤带 `scope`（agent）的查询：

- `dsh-tool-skill` 的目录发布用 `skills.snapshot({cwd, signal, scope: agent})`，其 `digestCatalogEntries` 基于过滤后的条目计算，历史里落盘的也是过滤后的 `source.entries` —— 两边一致，只在名单变化时重发一次目录，不会每轮抖动。若只改消息文本而不改 entries，digest 会永远不等，等于每轮重发。
- `skill` 工具 execute 先用 `skills.list(lookup)`（同样带 agent scope）找名字，因此隐藏的技能无法通过工具加载，这是执行侧的天然兜底。
- 不带 scope 的全局视图不受影响：设置页与技能管理器仍看得到全部技能，隐藏项随时可恢复。
- 用户显式输入 `/技能名` 走 `skills.get()`，属于人直接点名，**故意不拦**；界面上明确标注这个边界。

存储中的技能定义一概不改，开关与名单改动下一轮即时生效，卸载即透传；状态（含开关）跨重启持久化在 `~/.dsh/injection-tune/skill-gate.json`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dedupeRuntimeContext` | `false` | AI-1 runtime-context 去重 |
| `incrementalSkillCatalog` | `false` | AI-2 技能目录增量注入 |
| `deferredAgentInstructions` | `false` | AI-3 项目指令延迟注入 |
| `skillCatalogKeepDescription` | `true` | AI-2 目录条目保留 description |
| `suppressModelSelectionNotice` | `false` | 拦截内核的模型切换提示 `[model changed: …]`；勾选后不进本轮请求，历史里的旧提示也不再随请求重发 |

所有配置均为 volatile（改后即时生效，不需重启）。AI-4 与 AI-7 的开关和名单在面板里操作，不占配置键：前者落 `~/.dsh/injection-tune/tool-gate.json`，后者落 `~/.dsh/injection-tune/skill-gate.json`，两扇门默认均关闭。

## 安装

```bash
dsh plugin --profile web install github:JiewiW/dsh-injection-tune#main
```

## 测试

```bash
node --test
```

## 版本

- **v0.4.2** — 新增「模型切换提示拦截」开关（默认关闭）：按 `source.kind === 'model-selection' && form === 'notice'` 在 `agent/pre-step` 剔除 `[model changed: …]`，并投影 `Session.deriveMessages()` 让已落盘的历史提示不再随请求重发
- **v0.4.1** — 设置页重整：6 个模块分「自动精简 / 注入名单」两类重排，标题改用功能名（消除 AI-4 重号），新增顶部总折叠开关、逐卡片折叠与 localStorage 记忆、折叠态状态徽标；折叠不卸载门面板
- **v0.4.0** — AI-7 技能可见性门：按来源分框逐条控制技能目录注入（投影式过滤 `skills.snapshot`、执行侧随 `skills.list` 兜底、独立设置路由与面板）；回流线上 AI-4 ACP stub 热修
- **v0.2.4** — 精简模式升级为关键词加权裁剪（硬纪律句优先、预算可调默认 320、双语词典），AI-4 新增预算输入框与逐工具「精简预览 / 原文对照」子栏（按需展开计算）
- v0.2.3 — AI-4 精简模式（description 前 3 句 + 逐条豁免）
- v0.2.2 — 工具说明完整展示并自动换行（去掉 58 字符截断）
- v0.2.1 — 勾选语义反转为「勾选=激活」；分框排序/折叠；面板样式改版
- v0.2.0 — AI-4 工具可见性门（按来源分框 + 逐条停用）
- v0.1.0 — AI-1 / AI-2 / AI-3
