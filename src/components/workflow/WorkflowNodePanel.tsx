import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkflowNode, WorkflowEdge } from '../../types/platform-extensions'
import { AGENT_PRESETS } from '../../types/agent-presets'

interface WorkflowNodePanelProps {
  node: WorkflowNode | null
  edge: WorkflowEdge | null
  onUpdateNode: (nodeId: string, updates: Partial<WorkflowNode>) => void
  onUpdateEdge: (edgeId: string, updates: Partial<WorkflowEdge>) => void
  onDeleteNode: (nodeId: string) => void
  onDeleteEdge: (edgeId: string) => void
}

export function WorkflowNodePanel({ node, edge, onUpdateNode, onUpdateEdge, onDeleteNode, onDeleteEdge }: WorkflowNodePanelProps) {
  const { t } = useTranslation()
  const [form, setForm] = useState<Partial<WorkflowNode>>({})
  const [edgeForm, setEdgeForm] = useState<Partial<WorkflowEdge>>({})

  useEffect(() => {
    if (node) setForm({ ...node })
    else setForm({})
  }, [node?.id])

  useEffect(() => {
    if (edge) setEdgeForm({ ...edge })
    else setEdgeForm({})
  }, [edge?.id])

  if (!node && !edge) {
    return (
      <div className="workflow-node-panel" style={{ width: 280, borderLeft: '1px solid var(--border-color)', padding: 16 }}>
        <p className="platform-muted">{t('platform.workflow.selectNodeOrEdge')}</p>
      </div>
    )
  }

  if (edge) {
    const edgeId = edge.id || `${edge.from}-${edge.to}`
    return (
      <div className="workflow-node-panel" style={{ width: 280, borderLeft: '1px solid var(--border-color)', padding: 16, overflow: 'auto' }}>
        <h4 className="platform-subhead">{t('platform.workflow.edge')}</h4>
        <label>
          {t('platform.workflow.edgeLabel')}
          <input
            value={edgeForm.label || ''}
            onChange={e => {
              setEdgeForm(f => ({ ...f, label: e.target.value }))
              onUpdateEdge(edgeId, { label: e.target.value })
            }}
          />
        </label>
        <label>
          {t('platform.workflow.conditionValue')}
          <input
            value={edgeForm.conditionValue || ''}
            onChange={e => {
              setEdgeForm(f => ({ ...f, conditionValue: e.target.value }))
              onUpdateEdge(edgeId, { conditionValue: e.target.value })
            }}
            placeholder="e.g. true, success"
          />
        </label>
        <button className="settings-danger-btn" onClick={() => onDeleteEdge(edgeId)}>
          {t('common.delete')}
        </button>
      </div>
    )
  }

  if (!node) return null

  const update = (updates: Partial<WorkflowNode>) => {
    setForm(f => ({ ...f, ...updates }))
    onUpdateNode(node.id, updates)
  }

  return (
    <div className="workflow-node-panel" style={{ width: 280, borderLeft: '1px solid var(--border-color)', padding: 16, overflow: 'auto' }}>
      <h4 className="platform-subhead">{t(`platform.workflow.nodeType${node.type.charAt(0).toUpperCase() + node.type.slice(1)}`)} Node</h4>

      <label>
        ID
        <input value={node.id} disabled />
      </label>

      <label>
        {t('platform.workflow.edgeLabel')}
        <input
          value={form.label || ''}
          onChange={e => update({ label: e.target.value })}
        />
      </label>

      {(node.type === 'agent' || node.type === 'send' || node.type === 'terminal') && (
        <>
          <label>
            {t('platform.workflow.terminalId')}
            <input
              value={form.terminalId || ''}
              onChange={e => update({ terminalId: e.target.value })}
            />
          </label>
        </>
      )}

      {(node.type === 'agent' || node.type === 'send') && (
        <>
          <label>
            {t('platform.workflow.prompt')}
            <textarea
              rows={4}
              value={form.prompt || ''}
              onChange={e => update({ prompt: e.target.value })}
            />
          </label>
          <label>
            {t('platform.workflow.agentPreset')}
            <select
              value={form.agentPreset || 'inherit'}
              onChange={e => update({ agentPreset: e.target.value })}
            >
              <option value="inherit">{t('platform.workflow.agentPresetInherit')}</option>
              {AGENT_PRESETS.filter(p => p.id !== 'none').map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label>
            {t('platform.workflow.modelOverride')}
            <input
              value={form.model || ''}
              onChange={e => update({ model: e.target.value })}
              placeholder="e.g. claude-opus-4-6"
            />
          </label>
          <label className="platform-check-inline">
            <input
              type="checkbox"
              checked={form.waitForComplete ?? true}
              onChange={e => update({ waitForComplete: e.target.checked })}
            />
            {t('platform.workflow.waitForComplete')}
          </label>
        </>
      )}

      {node.type === 'terminal' && (
        <label>
          {t('platform.workflow.command')}
          <input
            value={form.command || ''}
            onChange={e => update({ command: e.target.value })}
          />
        </label>
      )}

      {node.type === 'wait' && (
        <>
          <label>
            {t('platform.workflow.durationMs')}
            <input
              type="number"
              value={form.durationMs || 5000}
              onChange={e => update({ durationMs: Number(e.target.value) })}
            />
          </label>
        </>
      )}

      {node.type === 'condition' && (
        <label>
          {t('platform.workflow.condition')}
          <input
            value={form.condition || ''}
            onChange={e => update({ condition: e.target.value })}
            placeholder='{{prev.status}} === "success"'
          />
        </label>
      )}

      {node.type === 'human' && (
        <>
          <label>
            {t('platform.workflow.confirmTitle')}
            <input
              value={form.confirmTitle || ''}
              onChange={e => update({ confirmTitle: e.target.value })}
            />
          </label>
          <label>
            {t('platform.workflow.confirmDescription')}
            <input
              value={form.confirmDescription || ''}
              onChange={e => update({ confirmDescription: e.target.value })}
            />
          </label>
        </>
      )}

      {node.type === 'parallel' && (
        <label>
          {t('platform.workflow.parallelNodeIds')}
          <input
            value={(form.parallelNodeIds || []).join(', ')}
            onChange={e => update({ parallelNodeIds: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
          />
        </label>
      )}

      {node.type === 'loop' && (
        <>
          <label>
            {t('platform.workflow.loopNodeId')}
            <input
              value={form.loopNodeId || ''}
              onChange={e => update({ loopNodeId: e.target.value })}
            />
          </label>
          <label>
            {t('platform.workflow.loopCount')}
            <input
              type="number"
              value={form.loopCount || 1}
              onChange={e => update({ loopCount: Number(e.target.value) })}
            />
          </label>
        </>
      )}

      <label>
        {t('platform.workflow.timeout')}
        <input
          type="number"
          value={form.timeoutMs || 600000}
          onChange={e => update({ timeoutMs: Number(e.target.value) })}
        />
      </label>

      <div style={{ marginTop: 12 }}>
        <button className="settings-danger-btn" onClick={() => onDeleteNode(node.id)}>
          {t('common.delete')}
        </button>
      </div>
    </div>
  )
}
