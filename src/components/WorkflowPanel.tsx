import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { v4 as uuidv4 } from 'uuid'
import type { WorkflowDefinition, WorkflowExecution, WorkflowNode, WorkflowEdge, WorkflowNodeType } from '../types/platform-extensions'

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
  const [wfForm, setWfForm] = useState({ name: '', description: '', enabled: true })
  const [nodes, setNodes] = useState<WorkflowNode[]>([])
  const [edges, setEdges] = useState<WorkflowEdge[]>([])
  const [nodeForm, setNodeForm] = useState<NodeForm>(emptyNode)
  const [edgeFrom, setEdgeFrom] = useState('')
  const [edgeTo, setEdgeTo] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [viewExecId, setViewExecId] = useState<string | null>(null)

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

  const openEdit = (w: WorkflowDefinition) => {
    setEditing(w)
    setWfForm({ name: w.name, description: w.description || '', enabled: w.enabled })
    setNodes(w.nodes.slice())
    setEdges(w.edges.slice())
    setNodeForm(emptyNode)
  }

  const handleSaveWorkflow = async () => {
    if (!wfForm.name.trim()) return
    if (editing) {
      const u = await window.electronAPI.workflow.update(editing.id, {
        name: wfForm.name.trim(),
        description: wfForm.description || undefined,
        enabled: wfForm.enabled,
        nodes,
        edges,
      })
      if (u) {
        setWorkflows(prev => prev.map(w => (w.id === editing.id ? (u as WorkflowDefinition) : w)))
        setEditing(null)
        setWfForm({ name: '', description: '', enabled: true })
        setNodes([])
        setEdges([])
      }
    } else {
      const c = await window.electronAPI.workflow.create({
        name: wfForm.name.trim(),
        description: wfForm.description || undefined,
        enabled: wfForm.enabled,
        trigger: { type: 'manual' },
        nodes,
        edges,
      })
      if (c) {
        setWorkflows(prev => [c as WorkflowDefinition, ...prev])
        setWfForm({ name: '', description: '', enabled: true })
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
    const r = await window.electronAPI.workflow.execute(id)
    if (r.ok) {
      setMsg(`${t('platform.workflow.execute')} OK — ${r.executionId}`)
      refreshExecs(id)
    } else {
      setMsg(r.error || t('platform.workflow.failed'))
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

        <div className="platform-form" style={{ marginTop: 12 }}>
          <h4 className="platform-subhead">{t('platform.workflow.nodes')}</h4>
          <label>
            Type
            <select value={nodeForm.type} onChange={e => setNodeForm(f => ({ ...f, type: e.target.value as WorkflowNodeType }))}>
              <option value="send">{t('platform.workflow.nodeTypeSend')}</option>
              <option value="wait">{t('platform.workflow.nodeTypeWait')}</option>
              <option value="condition">{t('platform.workflow.nodeTypeCondition')}</option>
              <option value="human">{t('platform.workflow.nodeTypeHuman')}</option>
              <option value="parallel">{t('platform.workflow.nodeTypeParallel')}</option>
              <option value="loop">{t('platform.workflow.nodeTypeLoop')}</option>
            </select>
          </label>
          <label>
            ID (optional)
            <input value={nodeForm.id} onChange={e => setNodeForm(f => ({ ...f, id: e.target.value }))} placeholder={uuidv4().slice(0, 8)} />
          </label>
          <label>
            Label
            <input value={nodeForm.label} onChange={e => setNodeForm(f => ({ ...f, label: e.target.value }))} />
          </label>
          {nodeForm.type === 'send' && (
            <>
              <label>
                {t('platform.workflow.terminal')}
                <input value={nodeForm.terminalId} onChange={e => setNodeForm(f => ({ ...f, terminalId: e.target.value }))} />
              </label>
              <label>
                {t('platform.workflow.prompt')}
                <textarea rows={3} value={nodeForm.prompt} onChange={e => setNodeForm(f => ({ ...f, prompt: e.target.value }))} />
              </label>
            </>
          )}
          {nodeForm.type === 'wait' && (
            <label>
              {t('platform.workflow.durationMs')}
              <input value={nodeForm.durationMs} onChange={e => setNodeForm(f => ({ ...f, durationMs: e.target.value }))} />
            </label>
          )}
          {nodeForm.type === 'condition' && (
            <label>
              {t('platform.workflow.condition')}
              <input value={nodeForm.condition} onChange={e => setNodeForm(f => ({ ...f, condition: e.target.value }))} placeholder='{{prev.status}} === "success"' />
            </label>
          )}
          {nodeForm.type === 'human' && (
            <label>
              Timeout (ms)
              <input value={nodeForm.timeoutMs} onChange={e => setNodeForm(f => ({ ...f, timeoutMs: e.target.value }))} />
            </label>
          )}
          {nodeForm.type === 'parallel' && (
            <label>
              Child node IDs (comma-separated)
              <input value={nodeForm.parallelNodeIds} onChange={e => setNodeForm(f => ({ ...f, parallelNodeIds: e.target.value }))} />
            </label>
          )}
          {nodeForm.type === 'loop' && (
            <>
              <label>
                Loop node ID
                <input value={nodeForm.loopNodeId} onChange={e => setNodeForm(f => ({ ...f, loopNodeId: e.target.value }))} />
              </label>
              <label>
                Loop count
                <input value={nodeForm.loopCount} onChange={e => setNodeForm(f => ({ ...f, loopCount: e.target.value }))} />
              </label>
            </>
          )}
          <button type="button" className="settings-save-btn" onClick={addNode}>
            {nodeForm.id && nodes.some(n => n.id === nodeForm.id) ? 'Update node' : 'Add node'}
          </button>
        </div>

        {nodes.length > 0 && (
          <div className="platform-form" style={{ marginTop: 12 }}>
            <h4 className="platform-subhead">{t('platform.workflow.edges')}</h4>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select value={edgeFrom} onChange={e => setEdgeFrom(e.target.value)}>
                <option value="">From…</option>
                {nodes.map(n => <option key={n.id} value={n.id}>{n.label || n.id}</option>)}
              </select>
              <span>→</span>
              <select value={edgeTo} onChange={e => setEdgeTo(e.target.value)}>
                <option value="">To…</option>
                {nodes.map(n => <option key={n.id} value={n.id}>{n.label || n.id}</option>)}
              </select>
              <button type="button" className="settings-save-btn" onClick={addEdge}>Add edge</button>
            </div>
          </div>
        )}

        <div className="platform-form-actions">
          <button type="button" className="settings-save-btn" onClick={() => void handleSaveWorkflow()}>
            {t('common.save')}
          </button>
          {editing && (
            <button type="button" className="settings-cancel-btn" onClick={() => { setEditing(null); setWfForm({ name: '', description: '', enabled: true }); setNodes([]); setEdges([]) }}>
              {t('common.cancel')}
            </button>
          )}
        </div>
      </div>

      <h3 className="platform-subhead">{t('platform.workflow.title')}</h3>
      {workflows.length === 0 ? (
        <p className="platform-muted">{t('platform.workflow.noWorkflows')}</p>
      ) : (
        <ul className="platform-job-list">
          {workflows.map(w => (
            <li key={w.id} className="platform-job-item">
              <div>
                <strong>{w.name}</strong>
                <span className="platform-muted"> · {w.enabled ? t('platform.workflow.enabled') : t('common.cancel')} · {w.nodes.length} nodes</span>
              </div>
              <div className="platform-job-actions">
                <button type="button" className="settings-save-btn" onClick={() => { refreshExecs(w.id); void runWorkflow(w.id) }}>
                  {t('platform.workflow.execute')}
                </button>
                <button type="button" className="settings-cancel-btn" onClick={() => openEdit(w)}>
                  {t('common.edit')}
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
