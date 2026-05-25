# 多 Agent 深度集成方案设计

## 1. 调研结论

| Agent | SDK/CLI 现状 | 可集成方式 | 深度集成可行性 |
|-------|-------------|-----------|--------------|
| **Claude Code** | `@anthropic-ai/claude-agent-sdk` + `@anthropic-ai/claude-code` | 官方 SDK，流式消息、工具调用、权限控制 | 已深度集成 |
| **OpenAI Codex** | `@openai/codex` (npm CLI) | CLI 工具，终端中运行，有 `sdk/` 目录但无独立 SDK 包 | PTY + 输出解析，或调用内部 SDK |
| **Google Gemini** | `@google/genai` (API SDK) | 只有 API SDK，**无官方 Agent CLI** | 需自建 Agent 面板调用 API |
| **GitHub Copilot** | `gh copilot` (gh CLI 扩展) | 只有 `suggest`/`explain` 命令，**无 Agent CLI** | PTY 方式，功能有限 |

### 关键发现

- **Codex** 是 OpenAI 发布的终端编码 Agent（类似 Claude Code），通过 `npm install -g @openai/codex` 安装，运行 `codex` 启动。仓库中有 `sdk/` 目录，说明可能暴露内部 API。
- **Gemini** 和 **Copilot** 目前**没有独立的终端 Agent CLI**，无法像 Claude Code 那样深度集成。Gemini 只有 API SDK (`@google/genai`)，Copilot 只有简单的命令建议 CLI。

---

## 2. 总体架构设计

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Renderer Process (React)                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │ ClaudeAgentPanel│  │ CodexAgentPanel │  │ GenericAgentPanel│             │
│  │  (SDK 直连)      │  │  (PTY + 解析)    │  │  (PTY 终端)      │             │
│  │  • 流式消息      │  │  • 消息历史      │  │  • xterm.js     │             │
│  │  • 工具调用      │  │  • 发送/接收     │  │  • PromptBox    │             │
│  │  • 权限弹窗      │  │  • 状态检测      │  │  • 简单历史      │             │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘             │
│                              ↑ IPC                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                         Main Process (Electron)                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │claude-agent-mgr │  │ codex-agent-mgr │  │  pty-manager    │             │
│  │  (已有)          │  │  (新建)          │  │  (已有)          │             │
│  │  • SDK Session   │  │  • PTY 进程      │  │  • node-pty     │             │
│  │  • 流转发        │  │  • 输出解析      │  │  • 跨平台 Shell  │             │
│  │  • 状态跟踪      │  │  • 完成检测      │  │  • spawn/fork   │             │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘             │
│                              ↓                                                │
│  ┌─────────────────┐  ┌─────────────────┐                                   │
│  │ Claude SDK      │  │ @openai/codex   │  ┌─────────────────┐             │
│  │ @anthropic-ai/… │  │ CLI (PTY)       │  │ @google/genai   │  (future)   │
│  └─────────────────┘  └─────────────────┘  │ API SDK          │             │
│                                             └─────────────────┘             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 分层实现方案

### Tier 1: Codex（深度集成，最高优先级）

Codex 是 OpenAI 推出的对标 Claude Code 的终端 Agent，有最高的集成价值。

#### 3.1.1 启动方式

Codex CLI 的启动命令：
```bash
# 标准启动（交互式 TUI）
codex

# 可能支持的参数（需实际验证）
codex --help
codex --model gpt-4.1
codex --approval-mode auto
```

**集成策略**：通过 PTY 启动 `codex` 进程，但前端不使用原生 xterm.js，而是：
1. 启动时捕获初始输出
2. 用户发送消息时通过 PTY write 输入
3. 解析输出流，提取 Codex 的响应文本
4. 渲染为消息气泡（类似 ClaudeAgentPanel）

#### 3.1.2 输出解析策略

Codex CLI 的输出格式需要实际运行后才能确定。常见模式：

```
# 模式 A: 类似 Claude 的流式文本输出
> user message here

Codex: I'll help you with that...
[思考过程]
[工具调用: ls]
[工具结果]
Done!

> █

# 模式 B: Markdown/结构化输出
## Response
...

## Actions
- Read: file.txt
- Write: file.txt
```

**实现方式**：
- 创建 `electron/codex-agent-manager.ts`，管理 Codex PTY 进程
- 使用正则表达式/状态机解析输出流
- 维护消息历史（user / assistant / tool_call / tool_result）
- 检测 "prompt ready" 状态（看到 `>` 或类似提示符）

#### 3.1.3 核心文件

```
electron/
  ├── codex-agent-manager.ts      # Codex PTY 进程管理 + 输出解析
  ├── codex-output-parser.ts      # 输出流解析器（状态机）
  └── codex-command-bridge.ts     # 命令转换（将 UI 操作转为 CLI 输入）

src/components/
  ├── CodexAgentPanel.tsx         # Codex 专用 Agent 面板
  ├── codex/
  │   ├── CodexMessageList.tsx    # 消息列表渲染
  │   ├── CodexToolCall.tsx       # 工具调用渲染
  │   └── CodexStatusBar.tsx      # 状态栏（模型、token、耗时）
```

#### 3.1.4 IPC 接口

```typescript
// preload.ts 新增
codex: {
  startSession: (sessionId: string, options: { cwd: string; model?: string }) => Promise<boolean>
  stopSession: (sessionId: string) => Promise<void>
  sendMessage: (sessionId: string, prompt: string) => Promise<void>
  onMessage: (callback: (sessionId: string, message: CodexMessage) => void) => Unsubscribe
  onToolUse: (callback: (sessionId: string, toolCall: CodexToolCall) => void) => Unsubscribe
  onStatus: (callback: (sessionId: string, status: 'idle' | 'thinking' | 'acting') => void) => Unsubscribe
}
```

---

### Tier 2: Generic Agent（所有其他 Agent 的通用方案）

对于 Gemini CLI（如果存在社区版）、Copilot CLI、以及未来任何基于 CLI 的 Agent，提供一个统一的"增强终端"体验。

#### 3.2.1 当前状态

目前项目已有此模式的雏形：
- `MainPanel.tsx` 中 `!isClaudeCode` 的 Agent 走 `TerminalPanel` + `PromptBox`
- `WorkspaceView.tsx` 中通过 `pty.write(preset.command + '\r')` 自动启动 Agent

#### 3.2.2 增强方案

**将 PromptBox 升级为 GenericAgentPanel**：

```
┌─────────────────────────────────────┐
│  ✦ Agent Name                ⟳  ×  │  <- MainPanel Header
├─────────────────────────────────────┤
│                                     │
│  ┌─────────────────────────────┐   │
│  │ User: 请帮我 review 这段代码 │   │  <- 消息历史（新）
│  └─────────────────────────────┘   │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ Agent: [终端输出片段...]     │   │  <- 捕获的关键输出
│  └─────────────────────────────┘   │
│                                     │
│  [终端内容预览...]                  │  <- 可折叠的 xterm.js
│                                     │
├─────────────────────────────────────┤
│  [输入消息...]              [发送]  │  <- PromptBox
└─────────────────────────────────────┘
```

**核心改进**：
1. **消息历史记录**：对非 Claude Agent，在终端上方显示消息历史（用户发送的 prompt + Agent 的关键响应）
2. **智能滚动**：Agent 响应时自动滚动到底部，用户可手动滚动查看历史
3. **状态检测**：通过输出内容检测 Agent 是否正在思考/执行（关键字匹配："Thinking...", "Running...", "Done"）
4. **一键发送**：PromptBox 支持历史记录、快捷命令

#### 3.2.3 核心文件

```
src/components/
  ├── GenericAgentPanel.tsx       # 通用 Agent 面板（替代当前 TerminalPanel + PromptBox）
  ├── AgentMessageHistory.tsx     # 消息历史组件
  └── AgentStatusIndicator.tsx    # Agent 状态指示器（thinking/idle/error）
```

---

### Tier 3: Gemini API SDK（未来扩展）

如果用户希望直接调用 Gemini API（而非通过 CLI）：

```typescript
// electron/gemini-bridge.ts
import { GoogleGenAI } from "@google/genai";

export class GeminiBridge {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async sendMessage(prompt: string, options?: { model?: string }) {
    const response = await this.ai.models.generateContent({
      model: options?.model || "gemini-2.5-flash",
      contents: prompt,
    });
    return response.text;
  }
}
```

**注意**：这不是 Agent（不能执行文件操作、终端命令），只是 API 调用。可以作为单独的 "Gemini Chat" 终端类型，但不适用于工作流编排。

---

## 4. 界面中直接新建对应终端

### 4.1 当前流程

`ThumbnailBar` 的 `+` 菜单目前只有：
1. Terminal (⌘)
2. Claude Code (✦)

### 4.2 新增菜单项

```tsx
// ThumbnailBar.tsx 中的 + 菜单
<div className="thumbnail-add-menu">
  {/* 现有 */}
  <div onClick={onAddTerminal}>
    <span>⌘</span> Terminal
  </div>
  <div onClick={onAddClaudeAgent}>
    <span style={{ color: '#d97706' }}>✦</span> Claude Code
  </div>

  {/* 新增 */}
  <div onClick={onAddCodexAgent}>
    <span style={{ color: '#10a37f' }}>⬡</span> Codex
  </div>
  <div onClick={onAddGeminiAgent}>
    <span style={{ color: '#4285f4' }}>◇</span> Gemini CLI
  </div>
  <div onClick={onAddCopilotAgent}>
    <span style={{ color: '#6e40c9' }}>⬢</span> GitHub Copilot
  </div>
</div>
```

### 4.3 WorkspaceView 中的处理

```tsx
// WorkspaceView.tsx
const handleAddCodexAgent = useCallback(() => {
  const terminal = workspaceStore.addTerminal(workspace.id, 'codex-cli')
  const shell = await getShellFromSettings()
  const settings = settingsStore.getSettings()
  const customEnv = mergeEnvVars(settings.globalEnvVars, workspace.envVars)

  window.electronAPI.pty.create({
    id: terminal.id,
    cwd: workspace.folderPath,
    type: 'terminal',
    agentPreset: 'codex-cli',
    shell,
    customEnv
  })

  // 自动启动 codex 命令
  if (settings.agentAutoCommand) {
    setTimeout(() => {
      window.electronAPI.pty.write(terminal.id, 'codex\r')
    }, 500)
  }

  workspaceStore.setFocusedTerminal(terminal.id)
  workspaceStore.save()
}, [workspace.id, workspace.folderPath, workspace.envVars])
```

### 4.4 设置中增加 Agent 配置

```typescript
// src/types/index.ts
export interface AppSettings {
  // ... existing fields
  /** Per-agent configuration */
  agentConfigs?: Record<AgentPresetId, AgentConfig>
}

export interface AgentConfig {
  enabled: boolean
  command: string          // 启动命令，如 'codex', 'gemini', 'gh copilot'
  args?: string[]          // 额外参数
  env?: Record<string, string>  // 环境变量（如 OPENAI_API_KEY）
  autoStart: boolean       // 新建终端时自动启动
}
```

```tsx
// SettingsPanel.tsx 新增 Agent 配置标签页
<AgentSettingsTab>
  {AGENT_PRESETS.filter(p => p.id !== 'none').map(preset => (
    <AgentConfigCard key={preset.id} preset={preset}>
      <checkbox> Enable {preset.name}
      <input> Command: {preset.command}
      <input> Args (optional)
      <checkbox> Auto-start on new terminal
    </AgentConfigCard>
  ))}
</AgentSettingsTab>
```

---

## 5. MainPanel 路由逻辑升级

```tsx
// MainPanel.tsx
export const MainPanel = memo(function MainPanel({ terminal, ... }) {
  const isAgent = terminal.agentPreset && terminal.agentPreset !== 'none'
  const isClaudeCode = terminal.agentPreset === 'claude-code'
  const isCodex = terminal.agentPreset === 'codex-cli'
  // const isGemini = terminal.agentPreset === 'gemini-cli'
  // const isCopilot = terminal.agentPreset === 'copilot-cli'

  return (
    <div className="main-panel">
      <div className="main-panel-content">
        {isClaudeCode ? (
          <ClaudeAgentPanel ... />
        ) : isCodex ? (
          <CodexAgentPanel ... />  {/* 新增 */}
        ) : isAgent ? (
          <GenericAgentPanel ... />  {/* 增强现有的 TerminalPanel + PromptBox */}
        ) : (
          <TerminalPanel ... />
        )}
      </div>
    </div>
  )
})
```

---

## 6. 实现优先级建议

| 优先级 | 任务 | 工作量 | 价值 |
|--------|------|--------|------|
| P0 | 界面中新建 Codex/Gemini/Copilot 终端（ThumbnailBar 菜单 + WorkspaceView 处理） | 0.5 天 | 高（立即可用） |
| P0 | 设置中增加 Agent 配置（命令、参数、自动启动） | 0.5 天 | 高 |
| P1 | GenericAgentPanel（消息历史 + 增强 PromptBox） | 1-2 天 | 高（改善所有非 Claude Agent 体验） |
| P2 | CodexAgentPanel（深度集成，输出解析） | 3-5 天 | 高（Codex 是对标 Claude Code 的） |
| P3 | codex-agent-manager.ts（输出解析状态机） | 2-3 天 | 高（支撑 CodexAgentPanel） |
| P4 | Gemini API Bridge（@google/genai） | 1-2 天 | 中（非 Agent，只是 API 聊天） |

---

## 7. 风险与注意事项

1. **Codex 输出格式不稳定**：Codex CLI 的输出格式可能随版本变化，解析器需要可配置/可更新
2. **Gemini 无 Agent CLI**：无法像 Claude/Codex 那样执行文件操作，只能作为聊天工具
3. **Copilot 功能有限**：`gh copilot` 只有 suggest/explain，不支持多轮任务执行
4. **环境变量**：Codex 需要 `OPENAI_API_KEY`，Gemini 需要 `GOOGLE_API_KEY`，需在设置中管理
5. **向后兼容**：现有 `agent-presets.ts` 和 `WorkspaceView` 的 Agent 启动逻辑需要平滑过渡
