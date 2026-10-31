# dsh-injection-tune

DSH 宿主插件，用于压低每个请求步的注入体积。四个功能各自独立开关，默认全部关闭——插件加载后行为与未安装时完全一致（fail-safe）。

## 背景

DSH 的 agent 每一步都会重新组装请求：runtime-context 快照、技能目录、项目指令、工具 schema 全量重发。长会话里这些固定开销占每步输入的一半以上，而其中大部分内容在步与步之间并没有变化。本插件挂在 `agent/pre-step` 瀑布里，对四类注入分别做削减。

## 功能

### AI-1 · runtime-context 去重（`dedupeRuntimeContext`）

runtime-context 快照每步都会整体重发，内部大量块与上一步相同。开启后按块与上一轮快照比对，只保留变化的块，其余折叠为一行统计（`folded N block(s), M chars`）。

### AI-2 · 技能目录增量注入（`incrementalSkillCatalog`）

`dsh-tool-skill` 会在目录内容变化后重发整份技能目录。开启后首次仍发全量，之后每步只列新增和描述有变化的条目，末尾补一行「其余 N 项未变」；有删除时报条数。实现上只替换目录消息的文本、不动 `source`，否则上游的 digest 判断会失效并退回全量重发。

`skillCatalogKeepDescription`（默认开）控制目录条目是否保留 description；关闭后只发名称，进一步压缩。

### AI-3 · 项目指令延迟注入（`deferredAgentInstructions`）

项目/全局指令原本挂在会话最前面，每步都占一段前缀。开启后延迟到首次出现相关信号时才注入。该功能由 `dsh-agent-instructions` 侧配合完成。

### AI-4 · 工具可见性门 + 精简模式（Web 面板）

设置页 AI-4 面板，含两部分：

**可见性门**：按注册来源（插件名）分框列出全部工具，每条带功能简述与体积估算。取消勾选即把该工具加入 deny 名单（走 `tools.restrict`），下一步生效。支持按名称/激活情况排序、正倒序、分框折叠、批量操作。隐藏的工具整行置灰，所有交互框禁用。

**精简模式**：开启后工具 description 只保留前 3 句（parameters 一律不动），每条工具可单独勾「豁免」保留完整说明。豁免框仅在精简模式开启且工具未隐藏时可交互；token 徽标按当前生效形态实时计算。

实现方式：包装 `tools.schemaOf` 原型（system-prompt 组装 schema 的必经通道），只修改每步现算的投影副本，存储中的原始定义不改——开关与豁免即时生效，卸载即回透传。隐藏语义上与旧版 deny 名单兼容，名单跨重启持久化在 `~/.dsh/injection-tune/`。

工具的注册来源按三层归因：调用栈捕获（跨重启落盘复用）→ fiber 名 → 内置表/名称前缀。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `dedupeRuntimeContext` | `false` | AI-1 runtime-context 去重 |
| `incrementalSkillCatalog` | `false` | AI-2 技能目录增量注入 |
| `deferredAgentInstructions` | `false` | AI-3 项目指令延迟注入 |
| `skillCatalogKeepDescription` | `true` | AI-2 目录条目保留 description |

所有配置均为 volatile（改后即时生效，不需重启）。AI-4 的开关与名单在面板里操作，不占配置键。

## 安装

```bash
dsh plugin --profile web install github:JiewiW/dsh-injection-tune#main
```

## 测试

```bash
node --test
```

## 版本

- **v0.2.3** — AI-4 精简模式（description 前 3 句 + 逐条豁免）
- v0.2.2 — 工具说明完整展示并自动换行（去掉 58 字符截断）
- v0.2.1 — 勾选语义反转为「勾选=激活」；分框排序/折叠；面板样式改版
- v0.2.0 — AI-4 工具可见性门（按来源分框 + 逐条停用）
- v0.1.0 — AI-1 / AI-2 / AI-3
