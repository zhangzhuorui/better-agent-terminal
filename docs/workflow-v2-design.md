# Workflow Orchestration V2 设计方案

## 1. 需求概览

- **多 Agent 节点**：工作流中不同节点可指定不同 Agent（Claude Code / Codex / Gemini CLI / Copilot / Terminal）
- **可视化编排**：参考 Claude Code Agent View 的节点式 DAG 编辑器，支持拖拽、连线、配置
- **执行引擎升级**：真正的异步 DAG 调度器，支持等待 Agent 完成、条件分支、并行、循环、人工审批
- **实时状态**：执行过程中可视化展示每个节点的状态、输出、工具调用

---

## 2. 架构设计

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Renderer Process (React)                              │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐  │
│  │  WorkflowCanvas     │  │  WorkflowNodePanel  │  │  WorkflowExecMonitor│  │
│  │  (可视化画布)        │  │  (节点配置侧边栏)     │  │  (执行状态监控)      │  │
│  │  - ReactFlow-like   │  │  - Agent 选择        │  │  - 实时状态流        │  │
│  │  - 拖拽/连线/缩略图   │  │  - Prompt 编辑       │  │  - 节点高亮          │  │
│  └─────────────────────┘  └─────────────────────┘  └─────────────────────┘  │
│                              ↑ IPC (invoke + on)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                         Main Process (Electron)                               │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐  │
│  │  workflow-engine.ts │  │  workflow-executor.ts│  │  agent-dispatcher.ts│  │
│  │  (定义持久化 CRUD)   │  │  (DAG 异步调度器)     │  │  (Agent 路由分发)    │  │
│  └─────────────────────┘  └─────────────────────┘  └─────────────────────┘  │
│                              ↓                                                │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐  │
│  │  claude-agent-mgr   │  │  pty-manager        │  │  codex-bridge (future)│ │
│  │  (Claude SDK)       │  │  (Terminal)         │  │  (其他 Agent CLI)    │  │
│  └─────────────────────┘  └─────────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 类型定义扩展

### 3.1 节点类型扩展

```typescript
// src/types/platform-extensions.ts

export type WorkflowNodeType =
  | 'agent'        // 向指定 Agent 发送 prompt 并等待完成
  | 'terminal'     // 向普通 terminal 发送命令
  | 'wait'         // 等待时间或事件
  | 'condition'    // 条件分支
  | 'human'        // 人工审批
  | 'parallel'     // 并行网关（fork）
  | 'join'         // 汇聚网关（join）
  | 'loop'         // 循环
  | 'start'        // 开始节点（视觉标记）
  | 'end'          // 结束节点（视觉标记）
  | 'mcp'          // MCP 工具调用节点

export interface WorkflowNodePosition {
  x: number
  y: number
}

export type WorkflowAgentPreset = AgentPresetId | 'inherit'  // inherit = 使用 terminal 预设

export interface WorkflowNode {
  id: string
  type: WorkflowNodeType
  label?: string
  position: WorkflowNodePosition
  /** Agent 节点专用 */
  agentPreset?: WorkflowAgentPreset
  terminalId?: string
  prompt?: string
  contextPackageIds?: string[]
  permissionMode?: AutomationPermissionMode
  model?: string        // 覆盖默认模型
  effort?: string       // 覆盖 effort 设置
  waitForComplete?: boolean  // agent: 是否等待 Agent 执行完成（默认 true）
  timeoutMs?: number    // 节点超时（默认 10 分钟）
  /** Terminal 节点专用 */
  command?: string      // terminal: 发送的命令文本
  /** Wait 节点专用 */
  durationMs?: number
  waitForEvent?: 'agent_complete' | 'file_change' | 'user_input'
  /** Condition 节点专用 */
  condition?: string
  /** Human 节点专用 */
  confirmTitle?: string
  confirmDescription?: string
  /** Parallel 节点专用 */
  parallelNodeIds?: string[]
  /** Loop 节点专用 */
  loopNodeId?: string
  loopCount?: number
  loopUntil?: string
  /** MCP 节点专用 */
  mcpServerId?: string
  mcpToolName?: string
  mcpToolInput?: Record<string, unknown>
}

export interface WorkflowEdge {
  id: string
  from: string
  to: string
  label?: string
  /** 条件边：只有 condition 节点出边需要 */
  conditionValue?: string  // e.g. "true", "success", "approved"
}

export interface WorkflowDefinition {
  id: string
  name: string
  description?: string
  enabled: boolean
  trigger: WorkflowTrigger
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  viewport?: { x: number; y: number; zoom: number }  // 画布视口状态
  createdAt: number
  updatedAt: number
}
```

### 3.2 执行状态扩展

```typescript
export type WorkflowNodeExecutionStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'waiting_agent'   // 已发送，等待 Agent 完成
  | 'waiting_human'   // 等待人工审批
  | 'waiting_event'   // 等待事件
  | 'completed'
  | 'failed'
  | 'skipped'         // 条件分支未命中
  | 'timeout'
  | 'cancelled'

export interface WorkflowNodeState {
  status: WorkflowNodeExecutionStatus
  output?: string
  startedAt?: number
  endedAt?: number
  error?: string
  /** Agent 执行详情 */
  agentTurns?: number
  agentTokensIn?: number
  agentTokensOut?: number
  agentCostUsd?: number
  /** 工具调用追踪 */
  toolCalls?: WorkflowNodeToolCall[]
}

export interface WorkflowNodeToolCall {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  endedAt?: number
}

export interface WorkflowExecution {
  id: string
  workflowId: string
  status: WorkflowExecutionStatus
  nodeStates: Record<string, WorkflowNodeState>
  currentNodeIds: string[]  // 当前正在执行的节点（支持并行）
  startedAt: number
  endedAt?: number
  error?: string
}
```

---

## 4. 可视化编辑器设计（Agent View 风格）

### 4.1 画布布局

参考 Claude Code Agent View 和 n8n 的设计：

```
┌──────────────────────────────────────────────────────────────────────┐
│  ← Workflow Name              [Run] [Save] [Export]     [×]          │
├──────────────────────────────────────────────────────────────────────┤
│  ┌─────────┐                                                        │
│  │  Start  │──┐                                                     │
│  └─────────┘  │                                                     │
│               ▼                                                     │
│  ┌───────────────┐    ┌───────────────┐                            │
│  │  ✦ Review PR  │───→│  ⬡ Write Test │──┐                         │
│  │  (Claude)     │    │  (Codex)      │  │                         │
│  │  ● Running    │    │  ○ Pending    │  │                         │
│  └───────────────┘    └───────────────┘  │                         │
│                                           ▼                         │
│                              ┌───────────────────┐                 │
│                              │  ✦ Summarize      │                 │
│                              │  (Claude)         │                 │
│                              │  ○ Pending        │                 │
│                              └───────────────────┘                 │
│                                                                     │
│  ──────────────────── 迷你地图 / 缩放控制 ─────────────────────────  │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 节点视觉设计

每个节点是一个卡片，包含：

- **顶部色条**：根据 Agent 预设着色（Claude 橙色、Codex 绿色、Gemini 蓝色、Terminal 灰色）
- **图标 + 名称**：Agent 图标 + 节点标签
- **状态指示器**：
  - `○` pending / queued
  - `●` running（脉冲动画）
  - `◐` waiting_agent（等待中）
  - `✓` completed（绿色）
  - `✗` failed（红色）
  - `⊘` skipped（灰色）
- **底部元数据**：token 数、耗时、turn 数（仅 Agent 节点）

### 4.3 连线设计

- 实线箭头：正常执行流
- 虚线箭头：条件分支（带标签如 "success" / "failed"）
- 连线颜色随源节点状态变化：pending(gray) → running(blue) → completed(green) → failed(red)
- 执行时，连线有流动动画表示数据/控制流

### 4.4 交互设计

| 操作 | 行为 |
|------|------|
| 拖拽空白处 | 平移画布 |
| 滚轮 | 缩放画布 |
| 点击节点 | 选中，右侧打开配置面板 |
| 拖拽节点 | 移动节点位置 |
| 从节点锚点拖拽 | 创建连线 |
| 双击连线 | 编辑条件标签 |
| 右键节点 | 上下文菜单（删除、复制、执行到此） |
| Cmd/Ctrl + 滚轮 | 缩放 |
| 框选 | 多选节点 |

---

## 5. 执行引擎升级

### 5.1 DAG 调度器核心逻辑

```typescript
class WorkflowExecutorV2 {
  private workflow: WorkflowDefinition
  private execution: WorkflowExecution
  private runningNodes = new Set<string>()
  private completedNodes = new Set<string>()
  private abortControllers = new Map<string, AbortController>()

  /** 拓扑排序 + 动态调度 */
  async start(): Promise<WorkflowExecution> {
    this.execution.status = 'running'

    // 找到 start 节点或入度为 0 的节点
    const startNodes = this.getStartNodes()
    await this.scheduleNodes(startNodes)

    return this.execution
  }

  /** 当一个节点完成时，调度下游节点 */
  private async onNodeComplete(nodeId: string): Promise<void> {
    this.completedNodes.add(nodeId)
    this.runningNodes.delete(nodeId)

    const outgoing = this.workflow.edges.filter(e => e.from === nodeId)

    for (const edge of outgoing) {
      // 检查条件边
      if (edge.conditionValue) {
        const nodeOutput = this.execution.nodeStates[nodeId]?.output
        if (nodeOutput !== edge.conditionValue) {
          this.markNodeSkipped(edge.to)
          continue
        }
      }

      // 检查所有入边是否满足（汇聚节点）
      if (this.areAllPredecessorsCompleted(edge.to)) {
        await this.scheduleNode(edge.to)
      }
    }

    // 检查是否全部完成
    if (this.runningNodes.size === 0 && this.areAllNodesFinished()) {
      this.execution.status = 'completed'
      this.execution.endedAt = Date.now()
      await this.saveExecution()
    }
  }

  /** 调度单个节点 */
  private async scheduleNode(nodeId: string): Promise<void> {
    if (this.runningNodes.has(nodeId) || this.completedNodes.has(nodeId)) return

    const node = this.workflow.nodes.find(n => n.id === nodeId)
    if (!node) return

    this.runningNodes.add(nodeId)
    const abortCtrl = new AbortController()
    this.abortControllers.set(nodeId, abortCtrl)

    // 异步执行，不阻塞调度器
    this.executeNodeAsync(node, abortCtrl.signal)
  }

  /** 节点执行逻辑 */
  private async executeNodeAsync(node: WorkflowNode, signal: AbortSignal): Promise<void> {
    const state = this.execution.nodeStates[node.id]
    state.status = 'running'
    state.startedAt = Date.now()
    this.broadcastNodeUpdate(node.id)

    try {
      switch (node.type) {
        case 'agent':
          await this.executeAgentNode(node, signal)
          break
        case 'terminal':
          await this.executeTerminalNode(node, signal)
          break
        case 'condition':
          await this.executeConditionNode(node)
          break
        case 'human':
          await this.executeHumanNode(node, signal)
          break
        case 'parallel':
          await this.executeParallelNode(node, signal)
          break
        case 'join':
          await this.executeJoinNode(node)
          break
        case 'loop':
          await this.executeLoopNode(node, signal)
          break
        case 'mcp':
          await this.executeMcpNode(node, signal)
          break
        case 'wait':
          await this.executeWaitNode(node, signal)
          break
        case 'start':
        case 'end':
          state.output = node.type
          break
      }

      if (signal.aborted) {
        state.status = 'cancelled'
        return
      }

      state.status = 'completed'
      state.endedAt = Date.now()
      this.broadcastNodeUpdate(node.id)
      await this.onNodeComplete(node.id)
    } catch (err) {
      state.status = 'failed'
      state.error = err instanceof Error ? err.message : String(err)
      state.endedAt = Date.now()
      this.broadcastNodeUpdate(node.id)
      // 失败时：根据策略决定是否继续（默认中止）
      this.execution.status = 'failed'
      this.execution.error = state.error
      this.execution.endedAt = Date.now()
      await this.saveExecution()
    }
  }

  /** Agent 节点：向指定 terminal 发送 prompt，等待完成 */
  private async executeAgentNode(node: WorkflowNode, signal: AbortSignal): Promise<void> {
    const terminalId = node.terminalId
    const prompt = this.resolveTemplate(node.prompt || '')
    if (!terminalId || !prompt) return

    state.status = 'waiting_agent'
    this.broadcastNodeUpdate(node.id)

    // 通过 claude-agent-manager 发送并等待完成
    const result = await this.dispatchToAgent({
      terminalId,
      prompt,
      agentPreset: node.agentPreset,
      contextPackageIds: node.contextPackageIds,
      permissionMode: node.permissionMode,
      model: node.model,
      effort: node.effort,
      waitForComplete: node.waitForComplete ?? true,
      timeoutMs: node.timeoutMs || 600_000,
      signal,
      onProgress: (meta) => {
        // 实时更新 token、turn、tool call 状态
        state.agentTurns = meta.turns
        state.agentTokensIn = meta.inputTokens
        state.agentTokensOut = meta.outputTokens
        state.toolCalls = meta.toolCalls
        this.broadcastNodeUpdate(node.id)
      }
    })

    state.output = result.output
    state.agentCostUsd = result.costUsd
  }
}
```

### 5.2 Agent 分发器

```typescript
// electron/agent-dispatcher.ts
interface AgentDispatchOptions {
  terminalId: string
  prompt: string
  agentPreset?: WorkflowAgentPreset
  waitForComplete: boolean
  timeoutMs: number
  signal: AbortSignal
  onProgress: (meta: AgentProgressMeta) => void
}

interface AgentProgressMeta {
  turns: number
  inputTokens: number
  outputTokens: number
  toolCalls: WorkflowNodeToolCall[]
}

export async function dispatchToAgent(options: AgentDispatchOptions): Promise<AgentResult> {
  const { terminalId, prompt, agentPreset, waitForComplete, timeoutMs, signal, onProgress } = options

  // 1. 确保 terminal 使用的是正确的 agent preset
  const preset = agentPreset === 'inherit' ? undefined : agentPreset
  if (preset) {
    await ensureTerminalPreset(terminalId, preset)
  }

  // 2. 发送消息
  await sendMessageToTerminal(terminalId, prompt)

  if (!waitForComplete) {
    return { output: 'Message sent', costUsd: 0 }
  }

  // 3. 等待 Agent 完成（通过监听 claude-agent-manager 的 stream 事件）
  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    const checkInterval = setInterval(() => {
      if (signal.aborted) {
        clearInterval(checkInterval)
        reject(new Error('Cancelled'))
        return
      }

      if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkInterval)
        reject(new Error('Timeout'))
        return
      }

      const sessionState = getSessionState(terminalId)
      onProgress({
        turns: sessionState.turns,
        inputTokens: sessionState.inputTokens,
        outputTokens: sessionState.outputTokens,
        toolCalls: sessionState.activeTasks.map(t => ({
          id: t.toolUseId,
          name: t.name,
          status: t.status,
          startedAt: t.startedAt
        }))
      })

      // 检测 Agent 是否空闲（无 active tasks，最后消息是 assistant）
      if (sessionState.isIdle) {
        clearInterval(checkInterval)
        resolve({
          output: sessionState.lastAssistantMessage || '',
          costUsd: sessionState.totalCost
        })
      }
    }, 1000)
  })
}
```

---

## 6. 前端组件设计

### 6.1 组件拆分

```
src/components/workflow/
├── WorkflowCanvas.tsx          # 主画布容器（状态管理、快捷键）
├── WorkflowNode.tsx            # 节点渲染组件
├── WorkflowEdge.tsx            # 连线渲染组件
├── WorkflowMinimap.tsx         # 迷你地图
├── WorkflowToolbar.tsx         # 顶部工具栏
├── WorkflowNodePanel.tsx       # 右侧节点配置面板
├── WorkflowPalette.tsx         # 左侧节点面板（可拖拽添加）
├── WorkflowExecOverlay.tsx     # 执行时的状态覆盖层
└── hooks/
    ├── useWorkflowCanvas.ts    # 画布交互逻辑（拖拽、缩放、选择）
    ├── useWorkflowExecution.ts # 执行状态监听
    └── useNodeRegistry.ts      # 节点类型注册表
```

### 6.2 WorkflowCanvas 核心逻辑

不使用外部库（如 ReactFlow），自研轻量级画布：

```typescript
// 核心状态
interface CanvasState {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  viewport: { x: number; y: number; zoom: number }
  selectedNodeIds: string[]
  selectedEdgeId: string | null
  draggingNodeId: string | null
  connectingFrom: { nodeId: string; anchor: 'top' | 'right' | 'bottom' | 'left' } | null
  isPanning: boolean
}

// 坐标转换
function screenToCanvas(screenX: number, screenY: number, viewport: Viewport): Point {
  return {
    x: (screenX - viewport.x) / viewport.zoom,
    y: (screenY - viewport.y) / viewport.zoom
  }
}
```

### 6.3 节点渲染

```tsx
function WorkflowNode({ node, isSelected, isExecuting, state }: NodeProps) {
  const preset = getAgentPreset(node.agentPreset)
  const status = state?.status || 'pending'

  return (
    <g
      transform={`translate(${node.position.x}, ${node.position.y})`}
      className={`wf-node ${isSelected ? 'selected' : ''} ${status}`}
      onMouseDown={(e) => onNodeMouseDown(e, node.id)}
    >
      {/* 节点卡片 */}
      <rect className="wf-node-bg" width={200} height={80} rx={8} />
      {/* Agent 色条 */}
      <rect className="wf-node-accent" width={200} height={4} rx={8} fill={preset?.color} />
      {/* 图标 */}
      <text className="wf-node-icon" x={12} y={28}>{preset?.icon}</text>
      {/* 标签 */}
      <text className="wf-node-label" x={32} y={28}>{node.label || node.type}</text>
      {/* Agent 名称 */}
      <text className="wf-node-preset" x={12} y={50}>{preset?.name}</text>
      {/* 状态 */}
      <circle className={`wf-node-status ${status}`} cx={184} cy={16} r={6} />
      {/* 连接锚点 */}
      <circle className="wf-anchor" cx={100} cy={0} r={5} data-anchor="top" />
      <circle className="wf-anchor" cx={200} cy={40} r={5} data-anchor="right" />
      <circle className="wf-anchor" cx={100} cy={80} r={5} data-anchor="bottom" />
      <circle className="wf-anchor" cx={0} cy={40} r={5} data-anchor="left" />
    </g>
  )
}
```

---

## 7. IPC 接口扩展

### 7.1 Preload 新增

```typescript
workflow: {
  // ... existing methods
  /** 实时执行状态推送 */
  onExecutionUpdate: (callback: (executionId: string, nodeId: string, state: WorkflowNodeState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, executionId: string, nodeId: string, state: WorkflowNodeState) =>
      callback(executionId, nodeId, state)
    ipcRenderer.on('workflow:execution-update', handler)
    return () => ipcRenderer.removeListener('workflow:execution-update', handler)
  },
  /** 验证工作流 DAG 合法性 */
  validate: (workflowId: string) => ipcRenderer.invoke('workflow:validate', workflowId) as Promise<{ valid: boolean; errors: string[] }>,
  /** 单步调试：执行到指定节点 */
  debug: (workflowId: string, targetNodeId: string) => ipcRenderer.invoke('workflow:debug', workflowId, targetNodeId),
}
```

### 7.2 Main Process 新增

```typescript
// workflow-engine.ts 中新增事件发射
import { broadcastHub } from './remote/broadcast-hub'

function broadcastExecutionUpdate(executionId: string, nodeId: string, state: WorkflowNodeState) {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('workflow:execution-update', executionId, nodeId, state)
  }
  broadcastHub.broadcast('workflow:execution-update', executionId, nodeId, state)
}
```

---

## 8. 数据迁移

现有 `workflow-definitions.json` v1 → v2：

```typescript
function migrateWorkflowV1ToV2(wf: any): WorkflowDefinition {
  return {
    ...wf,
    nodes: wf.nodes.map((n: any, idx: number) => ({
      ...n,
      position: n.position || { x: 100 + idx * 250, y: 200 },
      // v1 'send' 节点 → v2 'agent' 节点（如果 terminalId 是 claude terminal）或 'terminal'
      type: n.type === 'send' ? 'agent' : n.type,
      agentPreset: n.type === 'send' ? 'inherit' : undefined,
      waitForComplete: true,
      timeoutMs: 600_000,
    })),
    edges: wf.edges.map((e: any, idx: number) => ({
      ...e,
      id: e.id || `edge-${idx}`,
    })),
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}
```

---

## 9. 实现步骤（可执行）

### Phase 1: 基础架构（1-2 天）
1. [ ] 扩展 `src/types/platform-extensions.ts` 类型定义
2. [ ] 创建 `electron/workflow-executor-v2.ts` 新执行引擎
3. [ ] 创建 `electron/agent-dispatcher.ts` Agent 分发器
4. [ ] 扩展 `electron/preload.ts` IPC 接口
5. [ ] 扩展 `electron/main.ts` IPC handler 注册

### Phase 2: 可视化画布（3-4 天）
6. [ ] 创建 `src/components/workflow/` 目录结构
7. [ ] 实现 `useWorkflowCanvas.ts` 画布核心逻辑
8. [ ] 实现 `WorkflowNode.tsx` 节点渲染
9. [ ] 实现 `WorkflowEdge.tsx` 连线渲染
10. [ ] 实现 `WorkflowCanvas.tsx` 主画布
11. [ ] 实现 `WorkflowToolbar.tsx` 工具栏

### Phase 3: 节点配置与交互（2-3 天）
12. [ ] 实现 `WorkflowPalette.tsx` 节点面板
13. [ ] 实现 `WorkflowNodePanel.tsx` 右侧配置面板
14. [ ] 实现节点选择 Agent preset、prompt 编辑
15. [ ] 实现拖拽添加节点、删除节点、复制节点
16. [ ] 实现连线创建和删除

### Phase 4: 执行与监控（2-3 天）
17. [ ] 集成新执行引擎到 IPC handler
18. [ ] 实现 `WorkflowExecOverlay.tsx` 执行状态覆盖
19. [ ] 实现实时状态推送和前端监听
20. [ ] 实现节点状态动画（running、waiting、completed、failed）
21. [ ] 实现执行历史查看

### Phase 5: 集成与优化（1-2 天）
22. [ ] 替换 `WorkflowPanel.tsx` 为新可视化编辑器
23. [ ] 数据迁移：v1 → v2
24. [ ] 国际化键值补充
25. [ ] 测试：创建、编辑、执行、调试工作流
26. [ ] 构建验证

---

## 10. 风险与回滚策略

| 风险 | 缓解措施 |
|------|----------|
| 新执行引擎有 bug | 保留 v1 执行引擎，通过 feature flag 切换 |
| 数据迁移失败 | 备份 `workflow-definitions.json` 到 `.v1-backup` |
| 画布性能差 | 使用 SVG `transform` 而非重排，节点数量 > 50 时开启虚拟化 |
| Agent 等待检测不准确 | 支持配置 "完成信号"（如特定输出文本匹配） |
| 向后兼容 | v1 工作流自动迁移，v2 新增字段均为可选 |

---

## 11. 后续扩展

- **子工作流**：节点类型 `subworkflow`，调用另一个工作流
- **事件触发**：Git webhook、文件监听、定时触发
- **变量系统**：全局变量、节点输出引用（`{{nodeId.output}}`）
- **模板市场**：预置工作流模板（Code Review、Bug Fix、Release）
- **执行回放**：保存完整执行轨迹，支持逐步回放
