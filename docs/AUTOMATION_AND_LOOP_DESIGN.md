# 平台自动化与 Claude Code `/loop` — 方案设计

## 1. 两者分别解决什么问题

| 维度 | 平台定时自动化（本应用） | Claude Code `/loop`（SDK / CLI 内置 Skill） |
|------|--------------------------|---------------------------------------------|
| **调度主体** | Electron 主进程，读本地时钟，按 `runAtLocal` + `weekdays` 触发 | 会话内由 Claude Code 解析命令后，通过内置调度（如 cron / Monitor 等机制）重复执行 |
| **进程前提** | 应用保持运行（与设计文档一致） | **同一 Agent 会话保持活跃**；会话结束或应用退出后循环停止 |
| **典型粒度** | 每天固定时刻跑一次（如凌晨 2:00 全量任务） | 会话内短间隔轮询（如每 5m 看部署、每 30m 跑子命令） |
| **单次触发成本** | 每次调度 ≈ 一次 `sendMessage` + 一轮（或多轮）Agent | 首次用户消息启动 loop 后，后续迭代由 Claude Code 在会话内驱动，**不经过**应用级 cron |
| **与上下文包** | 已在 `sendMessage` 中合并注入 | 同样走 `sendMessage`，注入规则不变；用户可见气泡仍带 `[附加上下文包: …]` 行 |

结论：**不是替代关系，而是互补**。平台自动化负责「到点把会话叫醒并投递一条消息」；`/loop` 负责「在这条消息启动后，在 **Claude Code 会话内部** 按间隔重复执行同一意图」。

---

## 2. 能否结合

**可以。** 结合方式是让定时任务在触发时发送的内容**就是**（或**以**）`/loop …` 开头的用户消息，与用户在输入框手动输入 `/loop 5m check deploy` 等价。

- **能力边界**：本应用不解析 `/loop` 语法，也不实现 cron；仅负责**字符串拼接**与 `sendMessage`。
- **版本要求**：`/loop` 为 Claude Code 2.1.71+ 的 bundled skill；旧版 CLI 可能表现为普通文本或报错，需在 UI 提示。
- **权限**：无人值守时仍依赖任务的 `permissionMode`（如 `bypassPermissions`）；`/loop` 每次迭代仍会走工具与权限策略。
- **限制（来自官方文档）**：单会话内 loop 数量有上限（文档称约 50）；最短间隔受 cron 粒度等约束；用户可在 UI 里发新消息或中断以停止 loop（与 CLI 行为一致）。

---

## 3. 推荐产品形态

### 3.1 投递模式（已实现方向）

在自动化任务上增加可选字段：

- `promptDelivery`: `'plain' | 'claude_loop'`（默认 `plain`，兼容旧数据）
- `loopInterval`: 可选，如 `5m`、`1h`、`30s`（与官方文档一致；秒级可能被规整到分钟）

**拼接规则**（与官方语法对齐）：

- `plain`：`prompt` 原样发送。
- `claude_loop`：
  - 若 `prompt` 已以 `/loop` 开头 → 原样发送（避免重复包装）。
  - 否则：`loopInterval` 与 `prompt` 组合为  
    - 二者都有 → `/loop {interval} {prompt}`  
    - 仅有 `prompt` → `/loop {prompt}`（由 Claude 自适配间隔）  
    - 仅有 `loopInterval` → `/loop {interval}`（维护型 / 默认 loop 行为）  
    - 皆无 → `/loop`

### 3.2 何时用哪种模式

- **只用 plain**：每天一次总结、单次 codegen 指令、与 `/loop` 无关的固定提示词。
- **plain + 平台 cron**：适合「跨天、到点一次」且不需要会话内高频轮询。
- **claude_loop**：适合「到点后开始在**当前项目会话里**持续检查直到你停止」类任务；平台 cron 只负责**第一次**投递。

### 3.3 与「官方 Scheduled tasks / `/schedule`」的关系

Claude Code 文档中还提到云/桌面计划任务与 `/schedule` 等；本应用**不内置**这些能力。若未来 SDK 暴露统一 API，可再评估是否由主进程代理；当前阶段以**文本级 `/loop`** 为稳定集成点。

---

## 4. 实现要点（代码层）

| 模块 | 职责 |
|------|------|
| `src/types/platform-extensions.ts` | `AutomationJob` 扩展 `promptDelivery?`、`loopInterval?` |
| `electron/automation-jobs.ts` | `buildAutomationPromptText(job)` 纯函数，单测友好 |
| `electron/automation-scheduler.ts` | `runJob` 使用 `buildAutomationPromptText` 再 `sendMessage` |
| `PlatformHubPanel.tsx` | 表单：投递模式、可选间隔、说明文案 |
| 国际化 | `en` / `zh-CN` / `zh-TW` 键名 |

**不改**：`ClaudeAgentManager.sendMessage`、上下文包格式化逻辑；loop 仍是一条普通用户消息进入 `query()`。

---

## 5. 风险与测试建议

1. **SDK 与 CLI 版本**：在目标环境用「运行一次」验证 `/loop` 是否出现在 `supportedCommands` 且实际可执行。
2. **长会话**：loop 运行期间 `isStreaming`、权限弹窗、子 Agent 等与手动使用一致；自动化任务仅触发首条消息。
3. **重复触发**：同一终端若已有 loop，下次平台 cron 再发一条 `/loop` 可能叠加行为——属产品层面约束，可在文档中建议「每终端单 loop 任务」或用户自行避免时间重叠。

---

## 6. 小结

- **平台自动化** = 应用级「闹钟 + `sendMessage`」。
- **`/loop`** = Claude Code 会话级「重复执行同一提示（或子 slash）」。
- **结合** = 定时任务选用 **Claude loop 投递模式**，把 `/loop [interval] [prompt]` 作为发送内容，其余管道（会话启动、上下文包、统计、远程代理）沿用现有实现。
