# 平台扩展功能 — 需求与设计说明

本文档描述在 **Better Agent Terminal** 中新增的三类能力：**上下文包**、**使用数据看板**、**定时自动化任务**。实现上遵循现有架构（Electron 主进程持久化、IPC / 远程代理、`ClaudeAgentManager` 与 SDK 对话循环）。

---

## 1. 背景与目标

| 能力 | 目标 |
|------|------|
| 上下文包 | 用户可创建可复用的文本上下文单元，统一命名与存储，并按对话（终端会话）附加，在每次发往 Claude 的请求中注入。 |
| 数据看板 | 在本地汇总与展示使用行为：用户发送次数、Agent 完成轮次、按日 Token 与费用增量等（不依赖外部遥测）。 |
| 自动化 | 在应用**保持运行**的前提下，按本地时间计划在指定 **Claude Agent 终端** 上自动发送提示词，适合夜间批处理等场景。 |

### 1.1 非目标（当前版本）

- 不修改 Claude Agent SDK 的 `systemPrompt` preset；上下文通过**用户消息前的结构化前缀**注入，以保证兼容性与可维护性。
- 自动化**不会在应用完全退出后执行**；需保持 Electron 进程运行（可配合 OS 登录启动或夜间不关机等使用方式）。
- 数据看板为**本机、当前配置目录**下的统计，不包含账号控制台官方账单对齐（可作趋势参考）。

---

## 2. 上下文包（Context Packages）

### 2.1 数据模型

- **存储位置**：`userData/context-packages.json`
- **字段**（每条记录）：
  - `id`：UUID
  - `name`：显示名（唯一性由 UI 提示，技术上允许重名）
  - `description`：可选摘要
  - `content`：正文（Markdown 纯文本）
  - `tags`：可选字符串数组，便于筛选
  - `createdAt` / `updatedAt`：毫秒时间戳

### 2.2 生命周期与 API

- CRUD 通过 IPC：`contextPackage:list | get | create | update | delete`
- 远程模式：通道加入 `PROXIED_CHANNELS`，与现有 snippet 一致由主机执行。

### 2.3 注入规则

- 每个 **终端（TerminalInstance）** 可持久化 `contextPackageIds: string[]`，表示「本对话默认附加的包」。
- 调用 `claude:send-message` 时增加可选参数 `options?: { contextPackageIds?: string[] }`：
  - 若传入 `contextPackageIds`，与终端默认值**合并去重**（调用方显式列表优先顺序：先包列表顺序，再终端默认）。
  - 主进程将多个包格式化为固定分隔的结构化块，再拼接用户原文，**仅对 SDK `query` 使用完整文本**；聊天时间线中的用户气泡仍以**用户原文**为主，并追加一行 `[附加上下文包: …]` 便于识别。

### 2.4 UI

- 在 **平台中心**（见第 4 节）提供包的列表、创建、编辑、删除。
- 在 **ClaudeAgentPanel** 输入区上方提供多选（checkbox）绑定当前终端的 `contextPackageIds`，变更后 `workspaceStore.save()`。

---

## 3. 使用数据看板（Analytics）

### 3.1 指标定义

- **userMessages**：用户成功提交到 `sendMessage` 的次数（不含自动化时可单独统计，见下）。
- **agentTurns**：每次 SDK `result` 事件计为一次 Agent 轮次结束。
- **inputTokens / outputTokens / costUsd**：按**会话维度**记录 SDK 上报的累计值，用相邻两次的差值计入「当日增量」，避免重复累计；**会话 reset** 时清除该会话的基线。
- **automationRuns / automationFailures**：自动化触发成功/失败次数。

### 3.2 存储

- **文件**：`userData/platform-analytics.json`
- **结构**：`version`、`totals`、`byDay`（`YYYY-MM-DD`）、`sessionBaselines`（`sessionId → { input, output, cost }`）。

### 3.3 采集点

- `ClaudeAgentManager.sendMessage`：在通过校验后调用 `recordUserMessage`（可选 `source: 'user' | 'automation'`）。
- `result` 分支：调用 `recordAgentTurn(sessionId, metadata)`。
- `resetSession`：清除该 `sessionId` 的 baseline。
- 自动化执行完毕：`recordAutomationRun(success, error?)`。

### 3.4 UI

- 平台中心「数据看板」页：展示总计、今日、最近 7 日按日表格；说明数据为本地估算。

---

## 4. 定时自动化（Automation Jobs）

### 4.1 数据模型

- **存储**：`userData/automation-jobs.json`（数组）
- **字段**：
  - `id`、`name`、`enabled`
  - `runAtLocal`：`HH:mm`（24 小时制，本地时区）
  - `weekdays`：可选，`0–6`（`Date.getDay()`，0=周日）；缺省或空数组表示**每天**
  - `terminalId`：目标 Claude Agent 终端 ID（`agentPreset === 'claude-code'`）
  - `prompt`：自动发送的文本
  - `contextPackageIds`：可选
  - `permissionMode`：可选，默认 `bypassPermissions`（无人值守时减少权限弹窗）
  - `lastRunAt`：配合调度器比对「同一本地分钟」避免 30s 轮询重复触发
  - `lastError`：可选

### 4.2 调度器

- 主进程每分钟 tick 一次，检查本地时间是否匹配 `runAtLocal` 的**小时与分钟**，且 `weekdays` 约束满足。
- 执行步骤：
  1. 读取 `workspaces.json`，解析终端；校验 `terminalId` 存在且为 `claude-code`，取得 `cwd` / `model`。
  2. 若 `ClaudeAgentManager` 中无该 session，则 `startSession(terminalId, { cwd, permissionMode, model })`。
  3. `sendMessage(terminalId, prompt, undefined, { contextPackageIds, source: 'automation' })`。
  4. 写回 job 的运行时间与错误信息。

### 4.3 限制与安全提示

- 自动执行会使用真实 Claude 额度与工具权限；默认 `bypassPermissions` 风险较高，UI 需文字提示，用户可改为较严模式（可能卡在权限 UI）。
- 若目标终端已删除或工作区未加载，任务标记失败并写入 `lastError`。

### 4.4 API

- IPC：`automation:list | saveAll | runNow(id)`（`runNow` 便于手动测试）

### 4.5 与 Claude Code `/loop` 的结合

- 定时任务可选将提示词以 **`/loop [interval] [prompt]`** 形式投递，由 Claude Code 内置 skill 在**会话内**重复执行；与本节「应用级 cron」互补。详见 `docs/AUTOMATION_AND_LOOP_DESIGN.md`。

---

## 5. UI 入口：平台中心（Platform Hub）

- 侧栏底部新增按钮，打开全屏遮罩面板（样式对齐 `SettingsPanel`）。
- Tab：**数据看板** | **上下文包** | **自动化**
- 国际化：`en.json` / `zh-TW.json` 增加对应文案键。

---

## 6. 兼容性与回归

- `claude:send-message` 第三参数仍为 `images`，第四参数为可选 `options`，旧调用不变。
- `workspace` 持久化终端时增加 `contextPackageIds` 字段；旧数据缺省为空数组。
- 新增 IPC 均已加入 `PROXIED_CHANNELS` / `preload`，远程客户端行为与本地一致（由主机执行）。

---

## 7. 文件清单（实现）

| 区域 | 文件 |
|------|------|
| 文档 | `docs/PLATFORM_FEATURES_DESIGN.md` |
| 类型 | `src/types/platform-extensions.ts`，`src/types/index.ts`（TerminalInstance） |
| 主进程 | `electron/context-package-store.ts`，`electron/analytics-store.ts`，`electron/automation-jobs.ts`，`electron/automation-scheduler.ts` |
| 集成 | `electron/claude-agent-manager.ts`，`electron/main.ts`，`electron/preload.ts`，`electron/remote/protocol.ts` |
| 渲染 | `src/components/PlatformHubPanel.tsx`，`src/components/Sidebar.tsx`，`src/App.tsx`，`src/components/ClaudeAgentPanel.tsx`，`src/stores/workspace-store.ts` |
| 样式 | `src/styles/platform-hub.css` |
| 文案 | `src/locales/en.json`，`src/locales/zh-TW.json` |
