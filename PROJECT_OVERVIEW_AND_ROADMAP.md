# Better Agent Terminal — 项目全景分析与未来规划

> 文档版本：2026-04-20 | 基于代码版本 v2.0.9

---

## 一、项目简介

### 1.1 定位

**Better Agent Terminal（BAT）** 是一款跨平台的终端聚合器，核心定位是「开发者的工作区指挥中心」。它将多项目终端管理、AI Agent 对话、文件浏览、Git 可视化、代码片段管理、远程访问等功能整合在单个 Electron 应用中，让开发者在一个窗口内完成从代码编辑到 AI 协作的完整工作流。

### 1.2 核心价值主张

| 维度 | 价值 |
|------|------|
| **空间聚合** | 一个窗口管理 N 个项目，每个项目含多个 Terminal + 1 个内置 Claude Code Agent |
| **人机协作** | Agent 不是外部工具，而是「工作区的一部分」——与终端同层级、可切换焦点 |
| **上下文工程** | 通过「上下文包」机制，将可复用的知识片段系统化注入 Agent 对话 |
| **数据自有** | 使用统计、行为记录全部本地存储，不依赖云端遥测 |
| **远程可控** | 内置 WebSocket 服务器，支持跨设备远程操作（含移动端扫码连接） |

### 1.3 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 框架 | Electron 28 + React 18 + TypeScript 5.3 | 主进程 Node.js，渲染进程 React |
| 构建 | Vite 5 + electron-builder | 支持 Windows/macOS/Linux 三端打包 |
| 终端 | xterm.js 5.5 + node-pty | 完整 Unicode/CJK 支持，多窗口广播 |
| AI SDK | @anthropic-ai/claude-agent-sdk 0.2.62 | 原生集成 Claude Code，非 CLI 包装 |
| 存储 | 本地 JSON + better-sqlite3 | 配置/分析用 JSON，会话/片段用 SQLite |
| 远程 | ws (WebSocket) + qrcode | 主机-客户端模式，支持 Tailscale 穿透 |
| 渲染 | marked + highlight.js + mermaid | Markdown 预览、语法高亮、图表渲染 |
| i18n | i18next + react-i18next | 英/简中/繁中三语 |

### 1.4 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Electron Main Process                         │
│  ┌─────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │ PtyManager  │  │ClaudeAgentManager│  │    ProfileManager       │ │
│  │ (node-pty)  │  │  (SDK 会话)       │  │  (配置快照)              │ │
│  └─────────────┘  └─────────────────┘  └─────────────────────────┘ │
│  ┌─────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │ snippet-db  │  │  RemoteServer   │  │ AutomationScheduler     │ │
│  │ (SQLite)    │  │  (WebSocket)    │  │  (定时任务)              │ │
│  └─────────────┘  └─────────────────┘  └─────────────────────────┘ │
│  ┌─────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │AnalyticsStore│  │ContextPkgStore  │  │   Logger (disk)         │ │
│  │ (JSON)      │  │  (JSON)         │  │                         │ │
│  └─────────────┘  └─────────────────┘  └─────────────────────────┘ │
│                           ↑ IPC ↓                                   │
├─────────────────────────────────────────────────────────────────────┤
│                      Preload (contextBridge)                         │
│                 exposes window.electronAPI                           │
├─────────────────────────────────────────────────────────────────────┤
│                       Renderer (React 18)                            │
│  ┌─────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │   App.tsx   │──│  Sidebar.tsx    │──│  WorkspaceView.tsx      │ │
│  │  (根布局)   │  │ (工作区列表)     │  │   (工作区容器)           │ │
│  └─────────────┘  └─────────────────┘  └─────────────────────────┘ │
│  ┌─────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │ClaudeAgentPanel│ │ TerminalPanel  │  │   PlatformHubPanel      │ │
│  │ (Agent 对话) │  │  (xterm.js)    │  │ (看板/上下文/自动化)      │ │
│  └─────────────┘  └─────────────────┘  └─────────────────────────┘ │
│  ┌─────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │ GitPanel.tsx│  │ SettingsPanel.tsx│ │   FileTree.tsx          │ │
│  │ (Git 视图)  │  │   (设置)         │  │   (文件浏览)            │ │
│  └─────────────┘  └─────────────────┘  └─────────────────────────┘ │
│         Stores: workspace-store.ts  |  settings-store.ts           │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、现有功能矩阵

### 2.1 已完成功能（v2.0.9）

| 模块 | 功能点 | 完成度 |
|------|--------|--------|
| **工作区管理** | 多工作区、拖拽排序、分组过滤、颜色标记、分离窗口 | 100% |
| | 环境变量（全局 + 工作区级）、配置文件（本地/远程） | 100% |
| **终端** | xterm.js 终端、Google Meet 式布局（70/30）、缩略图栏 | 100% |
| | Agent 预设（Claude/Gemini/Codex/Copilot/纯终端）、自动启动命令 | 100% |
| **Claude Agent** | SDK 原生集成、消息流式输出、工具权限拦截、子 Agent 追踪 | 100% |
| | 会话恢复/分支/暂停/唤醒、模型切换、1M 上下文、图片附件 | 100% |
| | 智能路径识别（点击预览）、文件搜索（Ctrl+P）、Mermaid 图表 | 100% |
| | Slash 命令（/resume、/model）、Prompt 历史、Plan 模式 | 100% |
| **上下文包** | 创建/编辑/删除/搜索、按工作区或全局绑定、标签分类 | 100% |
| | 按终端附加注入、消息级手动选择注入、树形浏览 | 100% |
| **数据看板** | 本地使用统计（7 日）、用户消息数、Agent 轮次、Token/费用增量 | 80% |
| **自动化** | 定时任务（HH:mm + 星期）、目标终端选择、权限模式配置 | 80% |
| | `plain` / `claude_loop` 双投递模式、手动触发、错误追踪 | 100% |
| **远程访问** | WebSocket 服务器、QR 码连接、Tailscale IP 优选、BAT-to-BAT 配置 | 100% |
| **状态栏** | 13 项可配置指标、拖拽排序、自定义颜色、三区域对齐、模板导入导出 | 100% |
| **代码片段** | SQLite 存储、CRUD、搜索、分类、收藏、双击粘贴/复制/编辑 | 100% |
| **Git 集成** | Commit 日志、Diff 查看、状态检测、GitHub 链接跳转 | 100% |
| **文件浏览** | 树形导航、文件搜索、文本/图片预览、Markdown 渲染 | 100% |
| **国际化** | 英/简中/繁中完整覆盖 | 100% |
| **主题** | UI 主题（Dark/Light/System）、终端配色（7 套预设 + 自定义）、字体 | 100% |

### 2.2 当前局限

| 领域 | 现状不足 |
|------|----------|
| 上下文管理 | 包需要手动创建和选择，无智能推荐或自动发现 |
| 数据看板 | 仅有基础汇总，无趋势分析、无异常检测、无模型维度拆分 |
| 自动化 | 单一「到点发消息」模式，无多步骤编排、无依赖关系、无条件分支 |
| 模型追踪 | 仅记录会话级元数据，无单次请求级别的完整链路追踪 |
| 行为审计 | 无高危操作识别、无系统命令分类统计、无安全告警 |
| 检索能力 | 无跨工作区代码检索、无 RAG 式语义搜索 |

---

## 三、规划与路线图

### 3.1 阶段划分

```
Phase 1: 夯实基础（当前 → 2 个月内）
    ├─ 上下文智能：自动注入、推荐、检索
    └─ 数据看板增强：趋势图、模型拆分、异常标记

Phase 2: 编排与追踪（2 → 4 个月）
    ├─ 自动化任务编排：多步骤工作流、条件分支、人工确认节点
    └─ 模型链路轨迹追踪：请求级追踪、父子调用链可视化

Phase 3: 安全与治理（4 → 6 个月）
    ├─ 模型行为统计：高危操作检测、系统命令分类、安全评分
    └─ 合规审计：操作日志、回溯回放、策略约束
```

---

## 四、预期功能详细设计

### 4.1 上下文管理（Context Management）

#### 当前状态
已完成「上下文包」基础能力：用户可以手动创建文本片段、按工作区绑定、在发送消息时注入。但包的创建、选择、维护完全依赖用户主动操作。

#### 目标设计
**从「手动管理」进化到「智能上下文工程」。**

| 子功能 | 设计要点 |
|--------|----------|
| **对话萃取** | Agent 对话中自动识别高价值片段（如被采纳的方案、关键决策点），提示用户「是否保存为上下文包？」 |
| **项目感知** | 根据工作区目录结构（README、docs/、.cursorrules 等）自动建议创建上下文包 |
| **版本追踪** | 上下文包支持版本历史，编辑时保留旧版本，支持对比和回滚 |
| **跨项目复用** | 增强「全局包」的推荐逻辑：根据当前项目技术栈（从 package.json、Cargo.toml 等推断）推荐相关的全局包 |

**技术方案：**
- 在 `ClaudeAgentManager` 的 `result` 事件中增加「高价值检测」逻辑：当 Agent 输出包含「已修改文件列表」、「方案总结」、「架构决策」等模式时，向渲染进程发送 `contextPackage:suggest` 事件
- 渲染进程弹出非侵入式 Toast 提示，用户一键保存
- 新增 `ContextPackageVersion` 类型，`ContextPackage` 增加 `versions` 数组

---

### 4.2 自动注入（Auto Injection）

#### 当前状态
上下文包需要用户在每个终端手动勾选 `contextPackageIds`，或在发送单条消息时手动选择。无「根据场景自动附加」的能力。

#### 目标设计
**「规则引擎 + 智能匹配」双轨自动注入。**

| 子功能 | 设计要点 |
|--------|----------|
| **规则引擎** | 用户可配置注入规则：「当工作区路径匹配 `*/api/*` 时，自动附加『API 规范包』」 |
| **文件触发** | 当 Agent 提及特定文件/目录时，自动检索并注入相关的上下文包 |
| **时间触发** | 晨会模式（9:00 自动附加「昨日进展包」）、Code Review 模式（提交前自动附加「检查清单包」） |
| **智能衰减** | 长期未引用的上下文包自动降低优先级，避免上下文窗口膨胀 |

**数据模型扩展：**
```typescript
interface InjectionRule {
  id: string;
  name: string;
  enabled: boolean;
  // 触发条件（OR 关系）
  conditions: {
    workspacePathPattern?: string;     // 路径正则
    agentPreset?: AgentPresetId;       // 特定 Agent 类型
    timeRange?: { start: string; end: string; weekdays: number[] };
    messageKeyword?: string;           // 用户消息含关键词
  }[];
  action: {
    contextPackageIds: string[];
    injectPosition: 'prepend' | 'append';  // 注入位置
    deduplicate: boolean;                  // 是否去重
  };
}
```

**技术方案：**
- 新建 `electron/injection-engine.ts`，在 `sendMessage` 前评估所有匹配规则，合并 `contextPackageIds`
- UI 在 `PlatformHubPanel` 新增「注入规则」子 Tab
- 规则匹配结果在 PromptBox 上方以「本次自动附加：X 个包」提示，用户可点击展开/取消

---

### 4.3 推荐（Recommendation）

#### 当前状态
无推荐系统。用户需要主动搜索和发现上下文包、代码片段、历史 Prompt。

#### 目标设计
**「右时右地」的主动推荐。**

| 推荐场景 | 触发时机 | 推荐内容 |
|----------|----------|----------|
| **上下文包推荐** | 打开工作区时 | 根据项目技术栈推荐相关全局包 |
| **Prompt 推荐** | 输入框聚焦时 | 根据当前 Git 分支、最近修改文件推荐常用 Prompt |
| **片段推荐** | 终端输入时 | 根据当前目录/命令历史推荐匹配的代码片段 |
| **Agent 模式推荐** | 检测到特定文件变更时 | 「检测到 schema 变更，是否让 Agent 生成迁移脚本？」 |

**技术方案：**
- 推荐引擎 `electron/recommendation-engine.ts`，基于轻量规则 + 简单统计（无 ML 依赖）
- 推荐源：工作区文件元数据（tech stack）、Git 状态、最近使用的包/片段/Prompt、时间模式
- UI 在 `ClaudeAgentPanel` 的 PromptBox 上方增加「推荐栏」，可折叠
- 在 `Sidebar` 的工作区项上增加「✨ 推荐」徽章，提示有可用的上下文包未附加

---

### 4.4 自动检索（Auto Retrieval）

#### 当前状态
文件搜索（Ctrl+P）仅支持文件名模糊匹配。无跨文件内容检索、无语义检索、无自动根据对话内容检索相关代码的功能。

#### 目标设计
**「对话即检索」——Agent 对话过程中自动发现相关代码。**

| 子功能 | 设计要点 |
|--------|----------|
| **本地代码检索** | 跨工作区的 `ripgrep` 级内容搜索，支持正则和文件类型过滤 |
| **对话感知检索** | Agent 提及函数名/类名/文件名时，自动在后台检索相关定义和引用，以「相关代码」卡片呈现 |
| **检索即上下文** | 用户可将检索结果一键转为临时上下文包，注入当前对话 |
| **符号索引** | 对常见语言（JS/TS/Python/Go/Rust）建立轻量级符号索引（基于 tree-sitter 或正则），支持「跳转到定义」 |

**技术方案：**
- 主进程集成 `ripgrep`（通过 `rg` 二进制或 `@vscode/ripgrep`）
- 新增 IPC：`search:content(query, glob, workspaceId?)`
- 在 `ClaudeAgentPanel` 中，当 Agent 输出包含疑似代码引用时，触发后台检索，结果以折叠卡片形式插入消息下方
- 符号索引使用定期扫描（工作区首次加载时 + 文件变更时增量更新），存储在 SQLite `symbols` 表中

---

### 4.5 自动化任务编排执行（Automation Task Orchestration）

#### 当前状态
已实现「定时触发 + 单条消息发送」的基础自动化。每条任务是独立的、无状态的、无依赖的。

#### 目标设计
**从「定时闹钟」升级为「工作流编排引擎」。**

| 子功能 | 设计要点 |
|--------|----------|
| **工作流定义** | 支持多步骤节点：发送消息 → 等待完成 → 条件判断 → 分支执行 → 人工确认 |
| **节点类型** | `send`（发消息）、`wait`（等待时间/事件）、`condition`（条件分支）、`human`（人工确认）、`parallel`（并行执行）、`loop`（循环） |
| **上下文传递** | 上游节点的 Agent 输出可作为下游节点的 Prompt 模板变量（如 `{{prev.output}}`） |
| **触发器扩展** | 除时间触发外，支持：Git 提交触发、文件变更触发（watch）、Webhook 触发、手动触发 |
| **执行可视化** | 看板中显示工作流执行状态：等待中/运行中/已完成/失败，支持查看每步输出 |
| **失败处理** | 重试策略（次数/间隔）、失败通知、自动回滚（如 Agent 修改了文件后失败，自动 git checkout） |

**数据模型扩展：**
```typescript
interface WorkflowDefinition {
  id: string;
  name: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

type WorkflowNode =
  | { id: string; type: 'send'; terminalId: string; prompt: string; contextPackageIds?: string[]; permissionMode?: AutomationPermissionMode }
  | { id: string; type: 'wait'; durationMs?: number; waitForEvent?: 'agent_complete' | 'file_change' }
  | { id: string; type: 'condition'; expression: string }  // 简易表达式引擎
  | { id: string; type: 'human'; title: string; description: string; timeoutMs?: number }
  | { id: string; type: 'parallel'; nodeIds: string[] }
  | { id: string; type: 'loop'; count: number | 'until_condition'; nodeId: string };

interface WorkflowExecution {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  nodeStates: Record<string, { status: string; output?: string; startedAt?: number; endedAt?: number }>;
  startedAt: number;
  endedAt?: number;
}
```

**技术方案：**
- 新建 `electron/workflow-engine.ts`，负责工作流的解析、执行、状态机管理
- 基于现有 `automation-scheduler.ts` 扩展，scheduler 只负责「触发」，workflow-engine 负责「编排」
- 当前 `AutomationJob` 兼容为「单节点工作流」的特例
- UI 在 `PlatformHubPanel` 的 Automation Tab 中，从「列表视图」升级为「列表 + 画布视图」（画布可二期再做，一期先用列表/树形展示节点）

---

### 4.6 数据看板（Data Dashboard）

#### 当前状态
已实现基础 7 日统计：用户消息数、Agent 轮次、Token 输入/输出、费用、自动化运行/失败次数。展示形式为总计卡片 + 按日表格。

#### 目标设计
**从「统计汇总」升级为「运营级洞察」。**

| 子功能 | 设计要点 |
|--------|----------|
| **趋势图表** | 折线图展示 30 日/90 日趋势；对比本周 vs 上周 |
| **模型维度拆分** | 按模型（Sonnet/Opus/Haiku 等）拆分 Token 使用量和费用占比 |
| **工作区维度** | 按工作区拆分使用热力图，识别「最活跃项目」 |
| **时段分析** | 24 小时使用热力图，识别个人高效时段 |
| **异常标记** | 单日费用突增 > 200% 时自动标记（红色预警）；自动化失败率 > 20% 时提示 |
| **导出报告** | 支持导出 CSV/JSON，便于用户自行分析或报销 |
| **目标与预算** | 设置月度预算上限，接近时通知；设置「每日消息目标」等游戏化元素 |

**技术方案：**
- `analytics-store.ts` 扩展：保留 365 天数据（当前 120 天），增加 `model` 维度到每条记录
- 引入轻量图表库（如 `chart.js` 或纯 CSS/SVG 自绘）
- `PlatformHubPanel` Dashboard Tab 从当前「卡片+表格」重构为多视图：Overview / Trends / Models / Workspaces / Budget

---

### 4.7 模型链路轨迹追踪（Model Chain Tracing）

#### 当前状态
已具备基础「子 Agent 追踪」：在 `session.activeTasks` 中记录 Agent/Task 工具的创建和完成状态，UI 中显示任务列表和消息数。但无请求级别的详细追踪，无父子调用链的可视化。

#### 目标设计
**「可观测性」级别的 Agent 执行追踪。**

| 子功能 | 设计要点 |
|--------|----------|
| **请求级追踪** | 每次 `sendMessage` → SDK `query` → 模型响应 → 工具调用 → 工具结果的完整链路记录 |
| **时序瀑布图** | 类似 Chrome DevTools Network 的瀑布图：展示每轮 Agent 思考、工具执行、等待时间的耗时分布 |
| **父子调用链** | Agent 工具启动子 Agent 时，形成树形调用链，支持展开/折叠 |
| **Token 流转** | 每轮输入 Token（系统提示 + 历史 + 上下文包 + 用户消息）的详细构成 |
| **追踪持久化** | 追踪数据写入 SQLite `traces` 表，支持按会话/日期检索和回放 |
| **追踪导出** | 导出为 JSON（兼容 OpenTelemetry 格式），可接入外部 APM 工具 |

**数据模型：**
```typescript
interface AgentTrace {
  id: string;
  sessionId: string;
  terminalId: string;
  rootTraceId: string;       // 根追踪 ID（支持分布式追踪概念）
  parentTraceId?: string;    // 父 Agent 的 trace ID
  type: 'turn' | 'tool_call' | 'tool_result' | 'thinking' | 'subagent';
  name: string;              // 如 "bash", "Read", "Agent"
  status: 'started' | 'completed' | 'error';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}
```

**技术方案：**
- 在 `ClaudeAgentManager` 中埋点：SDK 事件（`thinking`, `tool_use`, `tool_result`, `text`, `result`）全部转为 `AgentTrace` 写入
- 新建 `electron/trace-store.ts`，SQLite 表结构优化索引（sessionId, timestamp）
- UI 在 `ClaudeAgentPanel` 中新增「追踪」视图（与 Messages 视图并列），展示瀑布图和调用树
- 瀑布图用纯 CSS Flex 实现，无需引入重型图表库

---

### 4.8 模型行为统计（高危、系统操作等）

#### 当前状态
无专门的行为审计和统计。工具权限系统已拦截所有工具调用，但无历史审计、无风险分级、无统计报表。

#### 目标设计
**「Agent 安全运营中心」。**

| 子功能 | 设计要点 |
|--------|----------|
| **操作分类** | 自动分类 Agent 执行的操作：文件读写、代码执行（bash）、网络请求、Git 操作、数据库操作 |
| **风险评级** | 每条操作自动标注风险等级：`low`（读文件）、`medium`（写文件）、`high`（执行命令含 rm/curl/sudo）、`critical`（修改系统配置、暴露 secrets） |
| **高危检测规则** | 内置规则：含 `rm -rf`/`sudo`/`chmod 777` 的命令、访问 `.env`/`.ssh` 等敏感文件、向外部 URL 发送数据、修改 `~/.bashrc` 等 |
| **行为统计看板** | 按日/周/月统计：各类操作数量、高危操作占比、被拦截次数、自动通过次数 |
| **安全评分** | 为每个工作区/会话计算「安全评分」：基于高危操作比例、权限模式严格程度 |
| **实时告警** | 高危操作发生时，系统托盘通知 + 声音提示；支持配置「任何 high+ 操作必须人工确认」 |
| **审计日志** | 不可篡改的本地审计日志（只追加），记录：谁（哪个终端）、何时、做了什么、结果如何、是否人工批准 |

**数据模型：**
```typescript
interface AgentAction {
  id: string;
  traceId: string;
  sessionId: string;
  timestamp: number;
  category: 'file_read' | 'file_write' | 'bash' | 'git' | 'network' | 'db' | 'other';
  toolName: string;
  description: string;       // 人类可读描述
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskReasons: string[];     // 触发风险评级的原因
  autoApproved: boolean;     // 是否自动通过（未经人工确认）
  approvedBy?: 'user' | 'plan_mode' | 'bypass';
  payload?: Record<string, unknown>;  // 脱敏后的参数摘要
}

interface SecurityReport {
  period: { start: number; end: number };
  totalActions: number;
  byCategory: Record<string, number>;
  byRiskLevel: Record<string, number>;
  highRiskActions: AgentAction[];
  autoApprovalRate: number;
  securityScore: number;  // 0-100
}
```

**技术方案：**
- 在 `ClaudeAgentManager` 的权限处理点（`resolvePermission`）和操作执行后，调用 `electron/audit-engine.ts` 记录 `AgentAction`
- 风险检测规则引擎：基于关键词匹配 + 路径模式 + 命令解析（轻量级，无 AST 解析）
- 审计日志使用追加写 JSON Lines 文件（`audit.log`），每日轮转，避免 SQLite 写入瓶颈
- UI：
  - `PlatformHubPanel` 新增「安全」Tab：统计图表、最近高危操作列表、安全评分
  - `ClaudeAgentPanel` 中每条 Agent 消息旁显示「操作摘要」徽章（如「3 次文件写入 · 1 次高危」），点击展开详情
  - Settings 中新增「安全策略」设置：自定义高危规则、告警开关、自动拦截阈值

---

## 五、技术架构演进建议

### 5.1 新增核心模块

```
electron/
  ├─ injection-engine.ts      # 上下文自动注入规则引擎
  ├─ recommendation-engine.ts # 推荐引擎（规则 + 统计驱动）
  ├─ retrieval-engine.ts      # 代码检索与符号索引
  ├─ workflow-engine.ts       # 工作流编排执行引擎
  ├─ trace-store.ts           # 链路追踪持久化
  ├─ audit-engine.ts          # 行为审计与风险检测
  └─ symbol-indexer.ts        # 轻量级符号索引（基于 tree-sitter 或正则）

src/components/
  ├─ TraceViewer.tsx          # 链路追踪瀑布图/调用树
  ├─ SecurityDashboard.tsx    # 安全看板
  ├─ WorkflowEditor.tsx       # 工作流编辑器（列表/画布视图）
  ├─ CodeRetrievalPanel.tsx   # 代码检索结果面板
  └─ RecommendationBar.tsx    # 推荐栏（PromptBox 上方）
```

### 5.2 存储扩展

| 数据 | 当前存储 | 扩展方案 |
|------|----------|----------|
| 上下文包版本 | JSON | 版本信息嵌入 `context-packages.json`，无需拆分 |
| 注入规则 | 无 | 新增 `injection-rules.json` |
| 工作流定义 | 无 | 新增 `workflows.json` |
| 工作流执行记录 | 无 | SQLite `workflow_executions` 表 |
| 链路追踪 | 无 | SQLite `traces` 表（按日分表或索引优化） |
| 审计日志 | 无 | JSON Lines `audit.log`（每日轮转） |
| 符号索引 | 无 | SQLite `symbols` 表（项目级，可重建） |
| 分析数据 | JSON（120天）| 扩展为 365 天，增加 model 维度 |

### 5.3 依赖引入评估

| 依赖 | 用途 | 评估 |
|------|------|------|
| `chart.js` + `chartjs-adapter-date-fns` | 数据看板图表 | 推荐。轻量、无 React 绑定依赖、可 Tree-shake |
| `@vscode/ripgrep` | 内容检索后端 | 推荐。跨平台 rg 二进制管理 |
| `tree-sitter` + language bindings | 符号索引 | 可选。若包体积过大，可用语言特定正则替代一期 |
| `jsonata` 或自研 | 工作流条件表达式 | 自研轻量表达式引擎更安全，避免引入全功能脚本引擎 |

---

## 六、实施优先级建议

### P0（立即启动）
1. **自动注入规则引擎** — 与现有上下文包系统无缝衔接，ROI 最高
2. **数据看板增强** — 在现有 `analytics-store` 基础上扩展，用户感知明显
3. **模型链路追踪** — 与现有 `activeTasks` 衔接，为后续安全审计打基础

### P1（2 个月内）
4. **自动检索（本地代码搜索）** — 显著提升 Agent 效率，技术方案成熟
5. **上下文推荐** — 基于已有统计的轻量规则推荐，提升上下文包使用率
6. **高危行为检测** — 在权限拦截点埋点即可实现，安全价值高

### P2（4 个月内）
7. **工作流编排引擎** — 架构变化较大，需要充分设计
8. **安全看板与审计日志** — 依赖 P0 的链路追踪和 P1 的高危检测

### P3（6 个月内）
9. **符号索引与跳转到定义** — 工程量大，可用性提升边际递减
10. **工作流可视化画布** — 体验优化，非功能必需

---

## 七、与现有系统的兼容性

所有新功能遵循以下原则：

1. **向后兼容**：现有 `context-packages.json`、`automation-jobs.json`、`platform-analytics.json` 的旧数据格式无损迁移
2. **IPC 扩展**：新通道遵循现有命名规范，远程代理（`PROXIED_CHANNELS`）同步支持
3. **可选启用**：所有新功能默认关闭或有温和默认值，老用户无感知升级
4. **无回归**：修改 `ClaudeAgentManager.sendMessage` 等核心路径时，保留原有参数签名，新能力通过可选参数或前置/后置钩子注入
