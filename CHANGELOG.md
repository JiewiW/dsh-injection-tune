# 变更记录

本文件记录 dsh-injection-tune 的版本变更。历史版本（0.6.0 及以前）的详细说明见仓库提交记录与 [Releases](https://github.com/JiewiW/dsh-injection-tune/releases)。

## 0.6.1

### 修复

- **工具注入名单卡片头徽标恒显示「隐藏 0」**：设置页「工具注入名单」卡片收起或展开时，右上角状态徽标始终显示 `隐藏 0`，与实际勾选状态不符，让人误以为名单没有生效。
  - 原因是前后端字段名错配：`lib/tool-gate.js` 的 `snapshot()` 只返回 `totals.deniedCount`，而 `lib/client.js` 的 `reportStats()` 读的是 `totals.hiddenCount`（该字段只存在于技能门后端）。读取结果为 `undefined`，被 `|| 0` 兜底成 0。
  - 同一面板正文里的「已隐藏 N 个」读的是 `deniedCount`，一直是对的，因此现象表现为「正文说隐藏了很多、徽标却是 0」。
  - 技能注入名单不受影响，因为 `lib/skill-gate.js` 的 `totals` 同时提供了 `hiddenCount` 与 `deniedCount`。

### 改动

- `lib/client.js` 的 `reportStats()` 改为 `deniedCount ?? hiddenCount ?? 0`：优先读工具门的真实字段名，同时保留技能门的旧字段名作兜底，任一存在即可，避免今后字段改名时徽标再次静默归零。

### 测试

- 新增回归用例（`test/client-panel.test.mjs`）：构造与 `tool-gate.js` 真实快照同形的响应（有 `deniedCount`、无 `hiddenCount`），走完整 `fetch` → `onStats` 链路，断言徽标拿到 41 而非 0。该用例在修复前会失败。
- 全量 `node --test`：62/62 通过。

## 0.6.0

- 技能隐藏改为每条技能独立选档，交互从勾选框改为四选一下拉菜单；配置由 v1 自动迁移到 v2。

## 0.5.0

- 技能隐藏拆成 `hide` / `name` / `headline` 三档（全局统一档位）。

## 0.4.3

- 修复工具注入名单里已停用条目消失的问题。

## 0.4.2

- 新增模型切换提示拦截开关（默认关闭）。
