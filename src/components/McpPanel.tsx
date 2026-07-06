import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpServerConfig } from '../types/platform-extensions'

type Transport = 'stdio' | 'sse' | 'websocket'

interface McpForm {
  name: string
  transport: Transport
  command: string
  args: string
  url: string
  env: string
  timeoutMs: string
  enabled: boolean
}

const emptyForm: McpForm = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  env: '',
  timeoutMs: '30000',
  enabled: true,
}

export function McpPanel() {
  const { t } = useTranslation()
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [editing, setEditing] = useState<McpServerConfig | null>(null)
  const [form, setForm] = useState<McpForm>(emptyForm)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.electronAPI.mcp.list().then((list: unknown) => {
      if (Array.isArray(list)) setServers(list as McpServerConfig[])
    }).catch(() => setServers([]))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const openEdit = (s: McpServerConfig) => {
    setEditing(s)
    setForm({
      name: s.name,
      transport: s.transport,
      command: s.command || '',
      args: (s.args || []).join('\n'),
      url: s.url || '',
      env: Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
      timeoutMs: String(s.timeoutMs || 30000),
      enabled: s.enabled,
    })
  }

  const handleSave = async () => {
    const env: Record<string, string> = {}
    for (const line of form.env.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    const payload = {
      name: form.name.trim(),
      transport: form.transport,
      enabled: form.enabled,
      command: form.transport === 'stdio' ? form.command.trim() : undefined,
      args: form.transport === 'stdio' ? form.args.split('\n').map(s => s.trim()).filter(Boolean) : undefined,
      url: form.transport !== 'stdio' ? form.url.trim() : undefined,
      env: Object.keys(env).length ? env : undefined,
      timeoutMs: Number(form.timeoutMs) || 30000,
    }
    if (!payload.name) {
      setMsg(t('platform.mcp.name') + ' required')
      return
    }
    if (editing) {
      const u = await window.electronAPI.mcp.update(editing.id, payload)
      if (u) {
        setServers(prev => prev.map(s => (s.id === editing.id ? (u as McpServerConfig) : s)))
        setEditing(null)
        setForm(emptyForm)
      }
    } else {
      const c = await window.electronAPI.mcp.create(payload as any)
      if (c) {
        setServers(prev => [c as McpServerConfig, ...prev])
        setForm(emptyForm)
      }
    }
    setMsg(null)
  }

  const handleDelete = async (id: string) => {
    if (!confirm(t('platform.mcp.deleteConfirm'))) return
    const ok = await window.electronAPI.mcp.delete(id)
    if (ok) setServers(prev => prev.filter(s => s.id !== id))
  }

  const runHealth = async (id: string) => {
    const r = await window.electronAPI.mcp.healthCheck(id)
    setServers(prev => prev.map(s => {
      if (s.id !== id) return s
      return { ...s, lastHealthCheck: { ok: r.ok, error: r.error, checkedAt: Date.now() } }
    }))
  }

  return (
    <div className="platform-section">
      <p className="platform-muted">{t('platform.mcp.hint')}</p>
      {msg && <div className="platform-banner">{msg}</div>}
      <div className="platform-form platform-card">
        <h3 className="platform-subhead">{editing ? t('platform.mcp.edit') : t('platform.mcp.newServer')}</h3>
        <label>
          {t('platform.mcp.name')}
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        </label>
        <label>
          {t('platform.mcp.transport')}
          <select value={form.transport} onChange={e => setForm(f => ({ ...f, transport: e.target.value as Transport }))}>
            <option value="stdio">{t('platform.mcp.stdio')}</option>
            <option value="sse">{t('platform.mcp.sse')}</option>
            <option value="websocket">{t('platform.mcp.websocket')}</option>
          </select>
        </label>
        {form.transport === 'stdio' ? (
          <>
            <label>
              {t('platform.mcp.command')}
              <input value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))} placeholder="npx" />
            </label>
            <label>
              {t('platform.mcp.args')}
              <textarea rows={3} value={form.args} onChange={e => setForm(f => ({ ...f, args: e.target.value }))} />
            </label>
          </>
        ) : (
          <label>
            {t('platform.mcp.url')}
            <input value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="http://localhost:3000/sse" />
          </label>
        )}
        <label>
          {t('platform.mcp.env')}
          <textarea rows={3} value={form.env} onChange={e => setForm(f => ({ ...f, env: e.target.value }))} />
        </label>
        <label>
          {t('platform.mcp.timeout')}
          <input value={form.timeoutMs} onChange={e => setForm(f => ({ ...f, timeoutMs: e.target.value }))} />
        </label>
        <label className="platform-check-inline">
          <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
          {t('platform.mcp.enabled')}
        </label>
        <div className="platform-form-actions">
          <button type="button" className="settings-save-btn" onClick={() => void handleSave()}>
            {t('platform.mcp.save')}
          </button>
          {editing && (
            <button type="button" className="settings-cancel-btn" onClick={() => { setEditing(null); setForm(emptyForm) }}>
              {t('common.cancel')}
            </button>
          )}
        </div>
      </div>

      <h3 className="platform-subhead">{t('platform.mcp.title')}</h3>
      {servers.length === 0 ? (
        <p className="platform-muted">{t('platform.mcp.noServers')}</p>
      ) : (
        <ul className="platform-job-list">
          {servers.map(s => (
            <li key={s.id} className="platform-job-item">
              <div>
                <strong>{s.name}</strong>
                <span className="platform-muted"> · {s.transport} · {s.enabled ? t('platform.mcp.enabled') : t('common.cancel')}</span>
                {s.id === 'builtin-context' && (
                  <div className="platform-muted platform-job-meta">
                    {t('platform.mcp.builtinTools')}: context_package_list, context_package_get, context_package_search, context_retrieval_plan, context_memory_search, context_compress
                  </div>
                )}
                {s.lastHealthCheck && (
                  <div className="platform-muted platform-job-meta">
                    {t('platform.mcp.lastChecked')}: {new Date(s.lastHealthCheck.checkedAt).toLocaleString()} — {s.lastHealthCheck.ok ? t('platform.mcp.healthOk') : `${t('platform.mcp.healthFail')}: ${s.lastHealthCheck.error}`}
                  </div>
                )}
              </div>
              <div className="platform-job-actions">
                <button type="button" className="settings-save-btn" onClick={() => void runHealth(s.id)}>
                  {t('platform.mcp.healthCheck')}
                </button>
                {s.id !== 'builtin-context' && (
                  <>
                    <button type="button" className="settings-cancel-btn" onClick={() => openEdit(s)}>
                      {t('platform.mcp.edit')}
                    </button>
                    <button type="button" className="settings-danger-btn" onClick={() => void handleDelete(s.id)}>
                      {t('common.delete')}
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
