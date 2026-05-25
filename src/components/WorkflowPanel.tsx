import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { v4 as uuidv4 } from 'uuid'
import type { WorkflowDefinition, WorkflowExecution, WorkflowNode, WorkflowEdge, WorkflowNodeType, WorkflowTrigger } from '../types/platform-extensions'
import { WorkflowCanvas } from './workflow/WorkflowCanvas'
import { WorkflowToolbar } from './workflow/WorkflowToolbar'
import { WorkflowNodePanel } from './workflow/WorkflowNodePanel'

type NodeForm = {
  id: string
  type: WorkflowNodeType
  label: string
  terminalId: string
  prompt: string
  durationMs: string
  condition: string
  timeoutMs: string
  parallelNodeIds: string
  loopNodeId: string
  loopCount: string
}

const emptyNode: NodeForm = {
  id: '',
  type: 'send',
  label: '',
  terminalId: '',
  prompt: '',
  durationMs: '5000',
  condition: '',
  timeoutMs: '30000',
  parallelNodeIds: '',
  loopNodeId: '',
  loopCount: '1',
}

export function WorkflowPanel() {
  const { t } = useTranslation()
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [executions, setExecutions] = useState<WorkflowExecution[]>([])
  const [editing, setEditing] = useState<WorkflowDefinition | null>(null)
  const defaultTrigger: WorkflowTrigger = { type: 'manual' }
  const [wfForm, setWfForm] = useState<{ name: string; description: string; enabled: boolean; trigger: WorkflowTrigger }>({ name: '', description: '', enabled: true, trigger: defaultTrigger })
  const [nodes, setNodes] = useState<WorkflowNode[]>([])
  const [edges, setEdges] = useState<WorkflowEdge[]>([])
  const [nodeForm, setNodeForm] = useState<NodeForm>(emptyNode)
  const [edgeFrom, setEdgeFrom] = useState('')
  const [edgeTo, setEdgeTo] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [viewExecId, setViewExecId] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [activeExecution, setActiveExecution] = useState<WorkflowExecution | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [humanConfirm, setHumanConfirm] = useState<{ executionId: string; nodeId: string; title: string; description: string } | null>(null)

  const refresh = useCallback(() => {
    window.electronAPI.workflow.list().then((list: unknown) => {
      if (Array.isArray(list)) setWorkflows(list as WorkflowDefinition[])
    }).catch(() => setWorkflows([]))
  }, [])

  const refreshExecs = useCallback((workflowId?: string) => {
    window.electronAPI.workflow.executions(workflowId, 20).then((list: unknown) => {
      if (Array.isArray(list)) setExecutions(list as WorkflowExecution[])
    }).catch(() => setExecutions([]))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Subscribe to real-time execution updates
  useEffect(() => {
    const unsubscribe = window.electronAPI.workflow.onExecutionUpdate((executionId, nodeId, state) => {
      setActiveExecution(prev => {
        if (!prev || prev.id !== executionId) return prev
        const next = { ...prev, nodeStates: { ...prev.nodeStates } }
        if (nodeId === '__execution__') {
          // Execution-level update
          next.status = (state as any).status ?? next.status
          next.currentNodeIds = (state as any).currentNodeIds ?? next.currentNodeIds
          next.error = (state as any).error ?? next.error
          next.endedAt = (state as any).endedAt ?? next.endedAt
        } else {
          next.nodeStates[nodeId] = state as any
        }
        return next
      })
      // When execution finishes, refresh history and clear active state
      if (nodeId === '__execution__') {
        const status = (state as any).status
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          setIsRunning(false)
          if (activeExecution) refreshExecs(activeExecution.workflowId)
        }
      }
    })
    return unsubscribe
  }, [refreshExecs])

  // Subscribe to human confirmation requests
  useEffect(() => {
    const unsubscribe = window.electronAPI.workflow.onHumanConfirmRequest((executionId, nodeId, meta) => {
      setHumanConfirm({ executionId, nodeId, title: meta.title, description: meta.description })
    })
    return unsubscribe
  }, [])

  const openEdit = (w: WorkflowDefinition) => {
    setEditing(w)
    setWfForm({ name: w.name, description: w.description || '', enabled: w.enabled, trigger: w.trigger || { type: 'manual' } })
    setNodes(w.nodes.map((n, i) => ({
      ...n,
      position: n.position || { x: 100 + i * 220, y: 200 + (i % 3) * 120 },
    })))
    setEdges(w.edges.map((e, i) => ({
      ...e,
      id: e.id || `edge-${i}-${Date.now()}`,
    })))
    setSelectedNodeId(null)
    setSelectedEdgeId(null)
    setNodeForm(emptyNode)
  }

  const handleSaveWorkflow = async () => {
    if (!wfForm.name.trim()) return
    if (editing) {
      const u = await window.electronAPI.workflow.update(editing.id, {
        name: wfForm.name.trim(),
        description: wfForm.description || undefined,
        enabled: wfForm.enabled,
        trigger: wfForm.trigger,
        nodes,
        edges,
      })
      if (u) {
        setWorkflows(prev => prev.map(w => (w.id === editing.id ? (u as WorkflowDefinition) : w)))
        setEditing(null)
        setWfForm({ name: '', description: '', enabled: true, trigger: defaultTrigger })
        setNodes([])
        setEdges([])
      }
    } else {
      const c = await window.electronAPI.workflow.create({
        name: wfForm.name.trim(),
        description: wfForm.description || undefined,
        enabled: wfForm.enabled,
        trigger: wfForm.trigger,
        nodes,
        edges,
      })
      if (c) {
        setWorkflows(prev => [c as WorkflowDefinition, ...prev])
        setWfForm({ name: '', description: '', enabled: true, trigger: defaultTrigger })
        setNodes([])
        setEdges([])
      }
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm(t('platform.workflow.deleteConfirm'))) return
    const ok = await window.electronAPI.workflow.delete(id)
    if (ok) setWorkflows(prev => prev.filter(w => w.id !== id))
  }

  const addNode = () => {
    const id = nodeForm.id.trim() || uuidv4()
    const node: WorkflowNode = {
      id,
      type: nodeForm.type,
      label: nodeForm.label.trim() || undefined,
      ...(nodeForm.type === 'send' ? { terminalId: nodeForm.terminalId.trim(), prompt: nodeForm.prompt.trim() } : {}),
      ...(nodeForm.type === 'wait' ? { durationMs: Number(nodeForm.durationMs) || 5000 } : {}),
      ...(nodeForm.type === 'condition' ? { condition: nodeForm.condition.trim() } : {}),
      ...(nodeForm.type === 'human' ? { timeoutMs: Number(nodeForm.timeoutMs) || 30000 } : {}),
      ...(nodeForm.type === 'parallel' ? { parallelNodeIds: nodeForm.parallelNodeIds.split(',').map(s => s.trim()).filter(Boolean) } : {}),
      ...(nodeForm.type === 'loop' ? { loopNodeId: nodeForm.loopNodeId.trim(), loopCount: Number(nodeForm.loopCount) || 1 } : {}),
    }
    setNodes(prev => {
      const idx = prev.findIndex(n => n.id === id)
      if (idx >= 0) {
        const next = prev.slice()
        next[idx] = node
        return next
      }
      return [...prev, node]
    })
    setNodeForm(emptyNode)
  }

  const removeNode = (id: string) => {
    setNodes(prev => prev.filter(n => n.id !== id))
    setEdges(prev => prev.filter(e => e.from !== id && e.to !== id))
  }

  const addEdge = () => {
    if (!edgeFrom || !edgeTo || edgeFrom === edgeTo) return
    setEdges(prev => [...prev, { from: edgeFrom, to: edgeTo }])
    setEdgeFrom('')
    setEdgeTo('')
  }

  const removeEdge = (from: string, to: string) => {
    setEdges(prev => prev.filter(e => !(e.from === from && e.to === to)))
  }

  const runWorkflow = async (id: string) => {
    setMsg(null)
    setIsRunning(true)
    const r = await window.electronAPI.workflow.execute(id)
    if (r.ok) {
      setMsg(`${t('platform.workflow.execute')} OK — ${r.executionId}`)
      // Initialize active execution skeleton
      setActiveExecution({
        id: r.executionId,
        workflowId: id,
        status: 'running',
        nodeStates: {},
        startedAt: Date.now(),
      })
      refreshExecs(id)
    } else {
      setMsg(r.error || t('platform.workflow.failed'))
      setIsRunning(false)
    }
  }

  const loadNodeIntoForm = (n: WorkflowNode) => {
    setNodeForm({
      id: n.id,
      type: n.type,
      label: n.label || '',
      terminalId: n.terminalId || '',
      prompt: n.prompt || '',
      durationMs: String(n.durationMs || 5000),
      condition: n.condition || '',
      timeoutMs: String(n.timeoutMs || 30000),
      parallelNodeIds: (n.parallelNodeIds || []).join(', '),
      loopNodeId: n.loopNodeId || '',
      loopCount: String(n.loopCount || 1),
    })
  }

  const selectedExec = executions.find(e => e.id === viewExecId)

  return (
    <div className="platform-section">
      <p className="platform-muted">{t('platform.workflow.hint')}</p>
      {msg && <div className="platform-banner">{msg}</div>}
      {humanConfirm && (
        <div className="platform-banner" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--warning-color)' }}>
          <strong>{humanConfirm.title}</strong>
          <p>{humanConfirm.description}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="settings-save-btn"
              onClick={() => {
                window.electronAPI.workflow.resolveHumanConfirm(humanConfirm.executionId, humanConfirm.nodeId, true)
                setHumanConfirm(null)
              }}
            >
              {t('platform.workflow.approve')}
            </button>
            <button
              className="settings-danger-btn"
              onClick={() => {
                window.electronAPI.workflow.resolveHumanConfirm(humanConfirm.executionId, humanConfirm.nodeId, false)
                setHumanConfirm(null)
              }}
            >
              {t('platform.workflow.reject')}
            </button>
          </div>
        </div>
      )}
      <div className="platform-form platform-card">
        <h3 className="platform-subhead">{editing ? t('platform.workflow.edit') : t('platform.workflow.newWorkflow')}</h3>
        <label>
          {t('platform.workflow.name')}
          <input value={wfForm.name} onChange={e => setWfForm(f => ({ ...f, name: e.target.value }))} />
        </label>
        <label>
          {t('platform.workflow.description')}
          <input value={wfForm.description} onChange={e => setWfForm(f => ({ ...f, description: e.target.value }))} />
        </label>
        <label className="platform-check-inline">
          <input type="checkbox" checked={wfForm.enabled} onChange={e => setWfForm(f => ({ ...f, enabled: e.target.checked }))} />
          {t('platform.workflow.enabled')}
        </label>

        {/* Trigger Configuration */}
        <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--border-color)', borderRadius: 4 }}>
          <strong>{t('platform.workflow.triggerTitle')}</strong>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
            <label>
              {t('platform.workflow.triggerType')}
              <select
                value={wfForm.trigger.type}
                onChange={e => {
                  const type = e.target.value as WorkflowTrigger['type']
                  setWfForm(f => ({ ...f, trigger: { type } }))
                }}
              >
                <option value="manual">{t('platform.workflow.triggerManual')}</option>
                <option value="schedule">{t('platform.workflow.triggerSchedule')}</option>
                <option value="webhook">{t('platform.workflow.triggerWebhook')}</option>
              </select>
            </label>
            {wfForm.trigger.type === 'schedule' && (
              <>
                <label>
                  {t('platform.workflow.scheduleLabel')}
                  <input
                    placeholder="0 9 * * 1-5  or  09:00"
                    value={wfForm.trigger.schedule || ''}
                    onChange={e => setWfForm(f => ({ ...f, trigger: { ...f.trigger, schedule: e.target.value } }))}
                  />
                </label>
                <label>
                  {t('platform.workflow.weekdaysLabel')}
                  <input
                    placeholder="1,2,3,4,5"
                    value={(wfForm.trigger.weekdays || []).join(',')}
                    onChange={e => {
                      const weekdays = e.target.value.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n) && n >= 0 && n <= 6)
                      setWfForm(f => ({ ...f, trigger: { ...f.trigger, weekdays } }))
                    }}
                  />
                </label>
              </>
            )}
            {wfForm.trigger.type === 'webhook' && (
              <>
                <label>
                  {t('platform.workflow.webhookSecret')}
                  <input
                    type="password"
                    placeholder="optional secret"
                    value={wfForm.trigger.webhookSecret || ''}
                    onChange={e => setWfForm(f => ({ ...f, trigger: { ...f.trigger, webhookSecret: e.target.value } }))}
                  />
                </label>
                {editing && (
                  <div className="platform-muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {t('platform.workflow.webhookUrl')}: <code>http://localhost:9877/webhook/{editing.id}</code>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Visual Canvas Editor */}
        <div style={{ display: 'flex', height: 'min(68vh, 720px)', marginTop: 12, border: '1px solid var(--border-color)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <WorkflowToolbar
              onAddNode={(type) => {
                const newNode: WorkflowNode = {
                  id: uuidv4(),
                  type,
                  position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
                }
                setNodes(prev => [...prev, newNode])
              }}
              onRun={() => void handleSaveWorkflow().then(() => {
                if (editing) void runWorkflow(editing.id)
              })}
              onSave={() => void handleSaveWorkflow()}
              onValidate={async () => {
                const id = editing?.id
                if (!id) { setMsg(t('platform.workflow.saveFirst')); return }
                const r = await window.electronAPI.workflow.validate(id)
                setMsg(r.valid ? t('platform.workflow.valid') : `${t('platform.workflow.invalid')}: ${r.errors.join(', ')}`)
              }}
              isRunning={isRunning}
            />
            <div style={{ flex: 1, position: 'relative' }}>
              <WorkflowCanvas
                key={editing?.id || 'new'}
                workflow={{
                  id: editing?.id || 'new',
                  name: wfForm.name,
                  description: wfForm.description,
                  enabled: wfForm.enabled,
                  trigger: wfForm.trigger,
                  nodes,
                  edges,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                }}
                execution={activeExecution && activeExecution.workflowId === editing?.id ? activeExecution : null}
                onChange={updates => {
                  if (updates.nodes) setNodes(updates.nodes)
                  if (updates.edges) setEdges(updates.edges)
                }}
                onNodeSelect={setSelectedNodeId}
                onEdgeSelect={setSelectedEdgeId}
              />
            </div>
          </div>
          <WorkflowNodePanel
            node={selectedNodeId ? nodes.find(n => n.id === selectedNodeId) || null : null}
            edge={selectedEdgeId ? edges.find(e => (e.id || `${e.from}-${e.to}`) === selectedEdgeId) || null : null}
            onUpdateNode={(nodeId, updates) => {
              setNodes(prev => prev.map(n => n.id === nodeId ? { ...n, ...updates } : n))
            }}
            onUpdateEdge={(edgeId, updates) => {
              setEdges(prev => prev.map(e => (e.id || `${e.from}-${e.to}`) === edgeId ? { ...e, ...updates } : e))
            }}
            onDeleteNode={(nodeId) => {
              setNodes(prev => prev.filter(n => n.id !== nodeId))
              setEdges(prev => prev.filter(e => e.from !== nodeId && e.to !== nodeId))
              setSelectedNodeId(null)
            }}
            onDeleteEdge={(edgeId) => {
              setEdges(prev => prev.filter(e => (e.id || `${e.from}-${e.to}`) !== edgeId))
              setSelectedEdgeId(null)
            }}
          />
        </div>

        <div className="platform-form-actions">
          <button type="button" className="settings-save-btn" onClick={() => void handleSaveWorkflow()}>
            {t('common.save')}
          </button>
          {editing && (
            <button type="button" className="settings-cancel-btn" onClick={() => { setEditing(null); setWfForm({ name: '', description: '', enabled: true, trigger: defaultTrigger }); setNodes([]); setEdges([]); setSelectedNodeId(null); setSelectedEdgeId(null) }}>
              {t('common.cancel')}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <h3 className="platform-subhead" style={{ margin: 0 }}>{t('platform.workflow.title')}</h3>
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
          <select
            className="settings-cancel-btn"
            style={{ padding: '4px 8px' }}
            onChange={async e => {
              const templateId = e.target.value
              if (!templateId) return
              e.target.value = ''
              const templates = await window.electronAPI.workflow.templates()
              const tmpl = templates.find((t: any) => t.id === templateId)
              if (!tmpl) return
              const c = await window.electronAPI.workflow.create(tmpl.workflow)
              if (c) {
                setWorkflows(prev => [c as WorkflowDefinition, ...prev])
                openEdit(c as WorkflowDefinition)
                setMsg(`${t('platform.workflow.createdFromTemplate')}: ${tmpl.name}`)
              }
            }}
          >
            <option value="">{t('platform.workflow.fromTemplate') || 'From Template...'}</option>
            <option value="code-review">Code Review</option>
            <option value="auto-test">Auto Test & Fix</option>
            <option value="release">Release Flow</option>
          </select>
          <button
            type="button"
            className="settings-cancel-btn"
            onClick={async () => {
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = '.json'
              input.onchange = async () => {
                const file = input.files?.[0]
                if (!file) return
                const text = await file.text()
                const r = await window.electronAPI.workflow.import(text)
                if (r.ok && r.workflow) {
                  setWorkflows(prev => [r.workflow as WorkflowDefinition, ...prev])
                  setMsg(t('platform.workflow.importSuccess'))
                } else {
                  setMsg(`${t('platform.workflow.importFailed')}: ${r.error}`)
                }
              }
              input.click()
            }}
          >
            {t('platform.workflow.import') || 'Import'}
          </button>
        </div>
      </div>
      {workflows.length === 0 ? (
        <p className="platform-muted">{t('platform.workflow.noWorkflows')}</p>
      ) : (
        <ul className="platform-job-list">
          {workflows.map(w => (
            <li key={w.id} className="platform-job-item">
              <div>
                <strong>{w.name}</strong>
                <span className="platform-muted"> · {w.enabled ? t('platform.workflow.enabled') : t('common.cancel')} · {w.nodes.length} nodes · trigger: {w.trigger?.type || 'manual'}</span>
              </div>
              <div className="platform-job-actions">
                <button type="button" className="settings-save-btn" onClick={() => { refreshExecs(w.id); void runWorkflow(w.id) }}>
                  {t('platform.workflow.execute')}
                </button>
                <button type="button" className="settings-cancel-btn" onClick={() => openEdit(w)}>
                  {t('common.edit')}
                </button>
                <button
                  type="button"
                  className="settings-cancel-btn"
                  onClick={async () => {
                    const r = await window.electronAPI.workflow.export(w.id)
                    if (r.ok && r.json) {
                      const blob = new Blob([r.json], { type: 'application/json' })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = `${w.name.replace(/\s+/g, '_')}.json`
                      a.click()
                      URL.revokeObjectURL(url)
                    } else {
                      setMsg(r.error || t('platform.workflow.exportFailed'))
                    }
                  }}
                >
                  {t('platform.workflow.export') || 'Export'}
                </button>
                <button type="button" className="settings-danger-btn" onClick={() => void handleDelete(w.id)}>
                  {t('common.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {executions.length > 0 && (
        <>
          <h3 className="platform-subhead">{t('platform.workflow.executions')}</h3>
          <ul className="platform-job-list">
            {executions.map(ex => (
              <li key={ex.id} className="platform-job-item" style={{ cursor: 'pointer' }} onClick={() => setViewExecId(ex.id === viewExecId ? null : ex.id)}>
                <div>
                  <strong>{ex.status}</strong>
                  <span className="platform-muted"> · {new Date(ex.startedAt).toLocaleString()}</span>
                  {ex.error && <div className="platform-job-error">{ex.error}</div>}
                  {viewExecId === ex.id && ex.nodeStates && (
                    <div className="platform-muted platform-job-meta">
                      {Object.entries(ex.nodeStates).map(([nid, st]) => (
                        <div key={nid}>{nid}: {st.status}{st.error ? ` — ${st.error}` : ''}</div>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
