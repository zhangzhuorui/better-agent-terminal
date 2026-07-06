import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import QRCode from 'qrcode'
import type { AppSettings, ShellType, FontType, ColorPresetId, StatuslineItemConfig, LanguageCode, UiThemePreference } from '../types'
import { FONT_OPTIONS, COLOR_PRESETS, SHELL_OPTIONS, STATUSLINE_ITEMS } from '../types'
import { settingsStore, parseStatuslineTemplate, exportStatuslineTemplate } from '../stores/settings-store'
import { EnvVarEditor } from './EnvVarEditor'
import { AGENT_PRESETS, AgentPresetId } from '../types/agent-presets'

interface SettingsPanelProps {
  onClose: () => void
}

// Check if a font is available using CSS Font Loading API
const checkFontAvailable = (fontFamily: string): boolean => {
  // Extract the primary font name (first in the list)
  const fontName = fontFamily.split(',')[0].trim().replace(/['"]/g, '')
  if (fontName === 'monospace') return true

  try {
    return document.fonts.check(`12px "${fontName}"`)
  } catch {
    return false
  }
}

interface RemoteServerStatus {
  running: boolean
  port: number | null
  clients: { label: string; connectedAt: number }[]
}

// ── Copilot Device Flow Button ───────────────────────────────────────
function CopilotDeviceFlowButton({ hasToken, onTokenAcquired }: {
  hasToken: boolean
  onTokenAcquired: (token: string) => Promise<void>
}) {
  const [state, setState] = useState<'idle' | 'starting' | 'awaiting' | 'success' | 'error'>('idle')
  const [userCode, setUserCode] = useState('')
  const [verificationUri, setVerificationUri] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  const handleStart = useCallback(async () => {
    setState('starting')
    setErrorMsg('')
    try {
      const start = await window.electronAPI.copilotAuth.start()
      if (!start) {
        setErrorMsg('Failed to start device flow')
        setState('error')
        return
      }
      setUserCode(start.userCode)
      setVerificationUri(start.verificationUri)
      setState('awaiting')

      const result = await window.electronAPI.copilotAuth.poll(
        start.deviceCode,
        start.interval,
        start.expiresIn,
      )
      if (result.ok && result.accessToken) {
        await onTokenAcquired(result.accessToken)
        setState('success')
      } else {
        setErrorMsg(result.error || 'Authorization failed')
        setState('error')
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }, [onTokenAcquired])

  if (state === 'awaiting') {
    return (
      <div style={{ padding: 10, background: 'var(--bg-tertiary)', borderRadius: 6, fontSize: 12 }}>
        <div style={{ marginBottom: 6 }}>
          <strong>1.</strong> Open <a href={verificationUri} onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(verificationUri) }} style={{ color: 'var(--accent-color)' }}>{verificationUri}</a>
        </div>
        <div style={{ marginBottom: 6 }}>
          <strong>2.</strong> Enter code: <code style={{ fontSize: 14, padding: '2px 8px', background: 'var(--bg-primary)', borderRadius: 4, letterSpacing: 2 }}>{userCode}</code>
        </div>
        <div style={{ marginTop: 8, color: 'var(--text-secondary)' }}>Waiting for authorization...</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button
        className="profile-action-btn primary"
        onClick={handleStart}
        disabled={state === 'starting'}
      >
        {state === 'starting' ? 'Starting…' : hasToken ? 'Re-authenticate with GitHub' : 'Sign in with GitHub'}
      </button>
      {hasToken && state === 'idle' && (
        <span style={{ fontSize: 12, color: 'var(--success-color, #3fb950)' }}>✓ Authenticated</span>
      )}
      {state === 'success' && (
        <span style={{ fontSize: 12, color: 'var(--success-color, #3fb950)' }}>✓ Sign-in complete</span>
      )}
      {state === 'error' && (
        <span style={{ fontSize: 12, color: 'var(--danger-color)' }}>{errorMsg}</span>
      )}
    </div>
  )
}

interface RemoteClientStatus {
  connected: boolean
  info: { host: string; port: number } | null
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<AppSettings>(settingsStore.getSettings())
  const [availableFonts, setAvailableFonts] = useState<Set<FontType>>(new Set())

  // Remote server state
  const [serverStatus, setServerStatus] = useState<RemoteServerStatus>({ running: false, port: null, clients: [] })
  const [serverPort, setServerPort] = useState('9876')
  const [serverToken, setServerToken] = useState<string | null>(null)
  const [clientStatus, setClientStatus] = useState<RemoteClientStatus>({ connected: false, info: null })

  // QR code state
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrInfo, setQrInfo] = useState<{ url: string; mode: string } | null>(null)
  const [qrLoading, setQrLoading] = useState(false)
  const [qrError, setQrError] = useState<string | null>(null)
  const [qrAddresses, setQrAddresses] = useState<{ ip: string; mode: string; label: string }[]>([])
  const [qrToken, setQrToken] = useState<string | null>(null)
  const [qrPort, setQrPort] = useState<number>(9876)

  // Statusline config state
  const [slItems, setSlItems] = useState<StatuslineItemConfig[]>(settingsStore.getStatuslineItems())
  const [slDragId, setSlDragId] = useState<string | null>(null)
  const [slDropId, setSlDropId] = useState<string | null>(null)
  const [slDropPos, setSlDropPos] = useState<'before' | 'after'>('before')
  const [slImporting, setSlImporting] = useState(false)
  const [slImportText, setSlImportText] = useState('')

  // Settings tabs
  const [activeTab, setActiveTab] = useState<'general' | 'agents' | 'context'>('general')
  const [contextCacheStats, setContextCacheStats] = useState<{ hit: number; miss: number; size: number; lastClearedAt: number } | null>(null)
  const [maintenanceResult, setMaintenanceResult] = useState<{ archived: number; merged: number; deleted: number; memoryPruned: number } | null>(null)
  const [maintenanceRunning, setMaintenanceRunning] = useState(false)

  // Agent local config detection
  const [agentChecks, setAgentChecks] = useState<Record<string, { installed: boolean; envReady: boolean; missingEnvVars: string[]; version?: string }>>({})
  const [detectedKeys, setDetectedKeys] = useState<{ key: string; source: string; envVar: string }[]>([])
  const [validatingKey, setValidatingKey] = useState<string | null>(null)
  const [validationResult, setValidationResult] = useState<{ presetId: string; ok: boolean; message: string } | null>(null)

  const runAgentDetection = useCallback(async () => {
    try {
      const result = await window.electronAPI.agent.checkLocalConfigs()
      setAgentChecks(result.configs)
      setDetectedKeys(result.detectedKeys)
      // Auto-disable agents that are not locally installed (only for local-cli mode)
      for (const preset of AGENT_PRESETS.filter(p => p.id !== 'none')) {
        const check = result.configs[preset.id]
        const config = settingsStore.getAgentConfig(preset.id)
        if (check && !check.installed && config.mode === 'local-cli' && config.enabled) {
          settingsStore.setAgentConfig(preset.id, { enabled: false })
        }
      }
    } catch {
      // ignore
    }
  }, [])

  // Get current platform for filtering shell options
  const platform = window.electronAPI?.platform || 'darwin'
  const platformShellOptions = SHELL_OPTIONS.filter(opt => opt.platforms.includes(platform))

  useEffect(() => {
    return settingsStore.subscribe(() => {
      setSettings(settingsStore.getSettings())
    })
  }, [])

  // Check font availability on mount
  useEffect(() => {
    const checkFonts = async () => {
      // Wait for fonts to be loaded
      await document.fonts.ready

      const available = new Set<FontType>()
      for (const font of FONT_OPTIONS) {
        if (font.id === 'system' || font.id === 'custom' || checkFontAvailable(font.fontFamily)) {
          available.add(font.id)
        }
      }
      setAvailableFonts(available)
    }
    checkFonts()
  }, [])

  useEffect(() => {
    window.electronAPI.contextRetrieval.cacheStats().then(setContextCacheStats).catch(() => {})
  }, [])

  // Detect local agent installations on mount
  useEffect(() => {
    runAgentDetection()
  }, [runAgentDetection])

  const handleShellChange = (shell: ShellType) => {
    settingsStore.setShell(shell)
  }

  const handleCustomPathChange = (path: string) => {
    settingsStore.setCustomShellPath(path)
  }

  const handleFontSizeChange = (size: number) => {
    settingsStore.setFontSize(size)
  }

  const handleFontFamilyChange = (fontFamily: FontType) => {
    settingsStore.setFontFamily(fontFamily)
  }

  const handleCustomFontFamilyChange = (customFontFamily: string) => {
    settingsStore.setCustomFontFamily(customFontFamily)
  }

  const handleUiThemeChange = (theme: UiThemePreference) => {
    settingsStore.setTheme(theme)
  }

  const handleColorPresetChange = (colorPreset: ColorPresetId) => {
    settingsStore.setColorPreset(colorPreset)
  }

  const handleCustomBackgroundColorChange = (color: string) => {
    settingsStore.setCustomBackgroundColor(color)
  }

  const handleCustomForegroundColorChange = (color: string) => {
    settingsStore.setCustomForegroundColor(color)
  }

  const handleCustomCursorColorChange = (color: string) => {
    settingsStore.setCustomCursorColor(color)
  }

  // Load remote status on mount and poll
  useEffect(() => {
    const refresh = async () => {
      const ss = await window.electronAPI.remote.serverStatus()
      setServerStatus(ss)
      const cs = await window.electronAPI.remote.clientStatus()
      setClientStatus(cs)
    }
    refresh()
    const interval = setInterval(refresh, 3000)
    return () => clearInterval(interval)
  }, [])

  const handleStartServer = async () => {
    const result = await window.electronAPI.remote.startServer(parseInt(serverPort) || 9876)
    if ('error' in result) {
      alert(t('settings.failedToStartServer', { error: result.error }))
    } else {
      setServerToken(result.token)
      setServerPort(String(result.port))
    }
    const ss = await window.electronAPI.remote.serverStatus()
    setServerStatus(ss)
  }

  const handleStopServer = async () => {
    await window.electronAPI.remote.stopServer()
    setServerToken(null)
    const ss = await window.electronAPI.remote.serverStatus()
    setServerStatus(ss)
  }

  const generateQrForIp = useCallback(async (ip: string, mode: string, token: string, port: number) => {
    const url = `ws://${ip}:${port}`
    const payload = JSON.stringify({ url, token, mode })
    const dataUrl = await QRCode.toDataURL(payload, { width: 256, margin: 2 })
    setQrDataUrl(dataUrl)
    setQrInfo({ url, mode })
  }, [])

  const handleGenerateQR = useCallback(async () => {
    setQrLoading(true)
    setQrError(null)
    try {
      const result = await window.electronAPI.tunnel.getConnection()
      if ('error' in result) {
        setQrError(result.error)
        return
      }
      setQrAddresses(result.addresses)
      setQrToken(result.token)
      const port = parseInt(result.url.split(':').pop() || '9876')
      setQrPort(port)
      await generateQrForIp(result.addresses[0].ip, result.addresses[0].mode, result.token, port)
      // Refresh server status since we may have started it
      const ss = await window.electronAPI.remote.serverStatus()
      setServerStatus(ss)
      if (result.token) setServerToken(result.token)
    } catch (err) {
      setQrError(err instanceof Error ? err.message : String(err))
    } finally {
      setQrLoading(false)
    }
  }, [generateQrForIp])

  const terminalColors = settingsStore.getTerminalColors()

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('settings.title')}</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-tabs">
          <button
            type="button"
            className={activeTab === 'general' ? 'active' : ''}
            onClick={() => setActiveTab('general')}
          >
            {t('settings.tabGeneral')}
          </button>
          <button
            type="button"
            className={activeTab === 'agents' ? 'active' : ''}
            onClick={() => setActiveTab('agents')}
          >
            {t('settings.tabAgents')}
          </button>
          <button
            type="button"
            className={activeTab === 'context' ? 'active' : ''}
            onClick={() => setActiveTab('context')}
          >
            {t('settings.tabContext')}
          </button>
        </div>

        <div className="settings-content">
          {activeTab === 'general' && (
            <>
          <div className="settings-section">
            <h3>{t('settings.language')}</h3>
            <div className="settings-group">
              <label>{t('settings.language')}</label>
              <select
                value={settings.language || 'en'}
                onChange={e => {
                  const value = e.target.value as LanguageCode
                  settingsStore.setLanguage(value)
                  i18next.changeLanguage(value)
                }}
              >
                <option value="en">English</option>
                <option value="zh-CN">简体中文（中国）</option>
                <option value="zh-TW">繁體中文（台灣）</option>
              </select>
            </div>
          </div>

          <div className="settings-section">
            <h3>{t('settings.shell')}</h3>
            <div className="settings-group">
              <label>{t('settings.defaultShell')}</label>
              <select
                value={settings.shell}
                onChange={e => handleShellChange(e.target.value as ShellType)}
              >
                {platformShellOptions.map(opt => (
                  <option key={opt.id} value={opt.id}>{opt.name}</option>
                ))}
              </select>
            </div>

            {settings.shell === 'custom' && (
              <div className="settings-group">
                <label>{t('settings.customShellPath')}</label>
                <input
                  type="text"
                  value={settings.customShellPath}
                  onChange={e => handleCustomPathChange(e.target.value)}
                  placeholder={platform === 'win32' ? 'C:\\path\\to\\shell.exe' : '/path/to/shell'}
                />
              </div>
            )}

            <div className="settings-group">
              <label>{t('settings.defaultTerminalCount', { count: settings.defaultTerminalCount || 1 })}</label>
              <input
                type="range"
                min="1"
                max="5"
                value={settings.defaultTerminalCount || 1}
                onChange={e => settingsStore.setDefaultTerminalCount(Number(e.target.value))}
              />
            </div>

            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.createDefaultAgentTerminal === true}
                  onChange={e => settingsStore.setCreateDefaultAgentTerminal(e.target.checked)}
                />
                {t('settings.createAgentTerminalByDefault')}
              </label>
              <p className="settings-hint">{t('settings.createAgentTerminalHint')}</p>
            </div>

            {settings.createDefaultAgentTerminal && (
              <>
                <div className="settings-group">
                  <label>{t('settings.defaultAgent')}</label>
                  <select
                    value={settings.defaultAgent || 'claude-code'}
                    onChange={e => settingsStore.setDefaultAgent(e.target.value as AgentPresetId)}
                  >
                    {AGENT_PRESETS.filter(p => p.id !== 'none').map(preset => (
                      <option key={preset.id} value={preset.id}>
                        {preset.icon} {preset.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={settings.agentAutoCommand === true}
                      onChange={e => settingsStore.setAgentAutoCommand(e.target.checked)}
                    />
                    {t('settings.autoRunAgentCommand')}
                  </label>
                  <p className="settings-hint">{t('settings.autoRunAgentCommandHint')}</p>
                </div>
              </>
            )}

            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.allowBypassPermissions === true}
                  onChange={e => settingsStore.setAllowBypassPermissions(e.target.checked)}
                />
                {t('settings.allowBypassPermissions')}
              </label>
              <p className="settings-hint">{t('settings.allowBypassPermissionsHint')}</p>
            </div>
          </div>

          <div className="settings-section">
            <h3>{t('settings.notifications')}</h3>
            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.showDockBadge !== false}
                  onChange={e => settingsStore.setShowDockBadge(e.target.checked)}
                />
                {t('settings.showDockBadge')}
              </label>
              <p className="settings-hint">{t('settings.showDockBadgeHint')}</p>
            </div>
            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.notifyOnComplete !== false}
                  onChange={e => settingsStore.setNotifyOnComplete(e.target.checked)}
                />
                {t('settings.notifyOnComplete')}
              </label>
              <p className="settings-hint">{t('settings.notifyOnCompleteHint')}</p>
            </div>
            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.notifySound !== false}
                  onChange={e => settingsStore.setNotifySound(e.target.checked)}
                />
                {t('settings.notifySound')}
              </label>
            </div>
            <div className="settings-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={settings.notifyOnlyBackground !== false}
                  onChange={e => settingsStore.setNotifyOnlyBackground(e.target.checked)}
                />
                {t('settings.notifyOnlyBackground')}
              </label>
              <p className="settings-hint">{t('settings.notifyOnlyBackgroundHint')}</p>
            </div>
          </div>

          <div className="settings-section">
            <h3>{t('settings.appearance')}</h3>
            <div className="settings-group">
              <label>{t('settings.uiTheme')}</label>
              <select
                value={settings.theme}
                onChange={e => handleUiThemeChange(e.target.value as UiThemePreference)}
              >
                <option value="dark">{t('settings.uiThemeDark')}</option>
                <option value="light">{t('settings.uiThemeLight')}</option>
                <option value="system">{t('settings.uiThemeSystem')}</option>
              </select>
              <p className="settings-hint">{t('settings.uiThemeHint')}</p>
            </div>
            <div className="settings-group">
              <label>{t('settings.fontSize', { size: settings.fontSize })}</label>
              <input
                type="range"
                min="10"
                max="24"
                value={settings.fontSize}
                onChange={e => handleFontSizeChange(Number(e.target.value))}
              />
            </div>

            <div className="settings-group">
              <label>{t('settings.fontFamily')}</label>
              <select
                value={settings.fontFamily}
                onChange={e => handleFontFamilyChange(e.target.value as FontType)}
              >
                {FONT_OPTIONS.map(font => (
                  <option key={font.id} value={font.id} disabled={!availableFonts.has(font.id) && font.id !== 'custom'}>
                    {font.name} {availableFonts.has(font.id) ? '✓' : t('settings.fontNotInstalled')}
                  </option>
                ))}
              </select>
            </div>

            {settings.fontFamily === 'custom' && (
              <div className="settings-group">
                <label>{t('settings.customFontName')}</label>
                <input
                  type="text"
                  value={settings.customFontFamily}
                  onChange={e => handleCustomFontFamilyChange(e.target.value)}
                  placeholder={t('settings.customFontPlaceholder')}
                />
              </div>
            )}

            <div className="settings-group">
              <label>{t('settings.colorTheme')}</label>
              <select
                value={settings.colorPreset}
                onChange={e => handleColorPresetChange(e.target.value as ColorPresetId)}
              >
                {COLOR_PRESETS.map(preset => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </div>

            {settings.colorPreset === 'custom' && (
              <>
                <div className="settings-group color-picker-group">
                  <label>{t('settings.backgroundColor')}</label>
                  <div className="color-input-wrapper">
                    <input
                      type="color"
                      value={settings.customBackgroundColor}
                      onChange={e => handleCustomBackgroundColorChange(e.target.value)}
                    />
                    <input
                      type="text"
                      value={settings.customBackgroundColor}
                      onChange={e => handleCustomBackgroundColorChange(e.target.value)}
                      placeholder="#1f1d1a"
                    />
                  </div>
                </div>

                <div className="settings-group color-picker-group">
                  <label>{t('settings.textColor')}</label>
                  <div className="color-input-wrapper">
                    <input
                      type="color"
                      value={settings.customForegroundColor}
                      onChange={e => handleCustomForegroundColorChange(e.target.value)}
                    />
                    <input
                      type="text"
                      value={settings.customForegroundColor}
                      onChange={e => handleCustomForegroundColorChange(e.target.value)}
                      placeholder="#dfdbc3"
                    />
                  </div>
                </div>

                <div className="settings-group color-picker-group">
                  <label>{t('settings.cursorColor')}</label>
                  <div className="color-input-wrapper">
                    <input
                      type="color"
                      value={settings.customCursorColor}
                      onChange={e => handleCustomCursorColorChange(e.target.value)}
                    />
                    <input
                      type="text"
                      value={settings.customCursorColor}
                      onChange={e => handleCustomCursorColorChange(e.target.value)}
                      placeholder="#dfdbc3"
                    />
                  </div>
                </div>
              </>
            )}

            <div className="settings-group font-preview">
              <label>{t('common.preview')}</label>
              <div
                className="font-preview-box"
                style={{
                  fontFamily: settingsStore.getFontFamilyString(),
                  fontSize: settings.fontSize,
                  backgroundColor: terminalColors.background,
                  color: terminalColors.foreground
                }}
              >
                $ echo "Hello World" 你好世界 0123456789
              </div>
            </div>
          </div>

          {/* Statusline Configuration */}
          <div className="settings-section">
            <h3>{t('settings.statusline')}</h3>
            <p className="settings-hint" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              {t('settings.statuslineHint')}
            </p>
            <div className="statusline-config-list">
              {slItems.map(item => {
                const def = STATUSLINE_ITEMS.find(d => d.id === item.id)
                if (!def) return null
                return (
                  <div key={item.id}
                    className={`statusline-config-item${slDragId === item.id ? ' dragging' : ''}${slDropId === item.id ? ` drop-${slDropPos}` : ''}`}
                    draggable
                    onDragStart={() => setSlDragId(item.id)}
                    onDragEnd={() => { setSlDragId(null); setSlDropId(null) }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      const rect = e.currentTarget.getBoundingClientRect()
                      setSlDropPos(e.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
                      setSlDropId(item.id)
                    }}
                    onDragLeave={() => setSlDropId(null)}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (!slDragId || slDragId === item.id) return
                      const items = [...slItems]
                      const dragIdx = items.findIndex(i => i.id === slDragId)
                      const targetIdx = items.findIndex(i => i.id === item.id)
                      if (dragIdx === -1 || targetIdx === -1) return
                      const [dragged] = items.splice(dragIdx, 1)
                      const insertIdx = slDropPos === 'after' ? targetIdx + (dragIdx < targetIdx ? 0 : 1) : targetIdx + (dragIdx < targetIdx ? -1 : 0)
                      items.splice(Math.max(0, insertIdx), 0, dragged)
                      setSlItems(items)
                      settingsStore.setStatuslineItems(items)
                      setSlDragId(null); setSlDropId(null)
                    }}
                    title={def.description}
                  >
                    <span className="statusline-config-drag">&#x2630;</span>
                    <span className="statusline-config-label">{def.label}</span>
                    <span className="statusline-config-align">
                      {(['left', 'center', 'right'] as const).map(a => (
                        <button key={a}
                          className={`statusline-align-btn${(item.align || 'left') === a ? ' active' : ''}`}
                          onClick={() => {
                            const updated = slItems.map(i => i.id === item.id ? { ...i, align: a } : i)
                            setSlItems(updated); settingsStore.setStatuslineItems(updated)
                          }}
                          title={a}
                        >{a === 'left' ? 'L' : a === 'center' ? 'C' : 'R'}</button>
                      ))}
                    </span>
                    <button
                      className={`statusline-sep-btn${item.separatorAfter ? ' active' : ''}`}
                      onClick={() => {
                        const updated = slItems.map(i => i.id === item.id ? { ...i, separatorAfter: !i.separatorAfter } : i)
                        setSlItems(updated); settingsStore.setStatuslineItems(updated)
                      }}
                      title={t('settings.statuslineToggleSeparator')}
                    >&gt;</button>
                    <span className="statusline-color-swatches">
                      {['', '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#d19a66', '#abb2bf'].map(c => (
                        <button
                          key={c || 'default'}
                          className={`statusline-color-swatch${(item.color || '') === c ? ' active' : ''}`}
                          style={{ background: c || 'var(--text-secondary)' }}
                          onClick={() => {
                            const updated = slItems.map(i => i.id === item.id ? { ...i, color: c || undefined } : i)
                            setSlItems(updated); settingsStore.setStatuslineItems(updated)
                          }}
                          title={c || 'Default'}
                        />
                      ))}
                      <input
                        type="color"
                        className="statusline-color-custom"
                        value={item.color || '#999999'}
                        onChange={e => {
                          const updated = slItems.map(i => i.id === item.id ? { ...i, color: e.target.value } : i)
                          setSlItems(updated); settingsStore.setStatuslineItems(updated)
                        }}
                        title={t('settings.statuslineCustomColor')}
                      />
                    </span>
                    <label className="statusline-config-toggle">
                      <input type="checkbox" checked={item.visible} onChange={() => {
                        const updated = slItems.map(i => i.id === item.id ? { ...i, visible: !i.visible } : i)
                        setSlItems(updated); settingsStore.setStatuslineItems(updated)
                      }} />
                    </label>
                  </div>
                )
              })}
            </div>
            <div className="statusline-template-bar" style={{ marginTop: '8px', display: 'flex', gap: '4px', alignItems: 'center' }}>
              {slImporting ? (
                <>
                  <input
                    value={slImportText}
                    onChange={e => setSlImportText(e.target.value)}
                    placeholder="sessionId,tokens > cost | prompts"
                    onKeyDown={e => {
                      if (e.key === 'Enter' && slImportText.trim()) {
                        const parsed = parseStatuslineTemplate(slImportText.trim())
                        setSlItems(parsed); settingsStore.setStatuslineItems(parsed)
                        setSlImporting(false); setSlImportText('')
                      }
                    }}
                    autoFocus
                    style={{ flex: 1, fontSize: '11px', padding: '3px 6px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '3px', color: 'var(--text-primary)' }}
                  />
                  <button className="statusline-template-btn" onClick={() => {
                    if (!slImportText.trim()) return
                    const parsed = parseStatuslineTemplate(slImportText.trim())
                    setSlItems(parsed); settingsStore.setStatuslineItems(parsed)
                    setSlImporting(false); setSlImportText('')
                  }}>{t('common.apply')}</button>
                  <button className="statusline-template-btn" onClick={() => { setSlImporting(false); setSlImportText('') }}>{t('common.cancel')}</button>
                </>
              ) : (
                <>
                  <input
                    readOnly
                    value={exportStatuslineTemplate(slItems)}
                    style={{ flex: 1, fontSize: '11px', padding: '3px 6px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '3px', color: 'var(--text-secondary)' }}
                    title={t('settings.statuslineCurrentTemplate')}
                  />
                  <button className="statusline-template-btn" onClick={() => navigator.clipboard.writeText(exportStatuslineTemplate(slItems))}>{t('common.copy')}</button>
                  <button className="statusline-template-btn" onClick={() => setSlImporting(true)}>{t('common.import')}</button>
                  <button className="statusline-template-btn" onClick={() => {
                    settingsStore.setStatuslineItems(undefined as unknown as StatuslineItemConfig[])
                    setSlItems(settingsStore.getStatuslineItems())
                  }}>{t('common.reset')}</button>
                </>
              )}
            </div>
          </div>

            </>
          )}

          {activeTab === 'context' && (
            <div className="settings-section">
              <h3>{t('settings.contextModule')}</h3>
              <div className="settings-group">
                <label>{t('settings.contextAutoMode')}</label>
                <select
                  value={settings.contextModule.autoRetrievalMode}
                  onChange={e => settingsStore.setContextModuleSettings({ autoRetrievalMode: e.target.value as 'off' | 'recommend' | 'inject' })}
                >
                  <option value="off">{t('settings.contextModeOff')}</option>
                  <option value="recommend">{t('settings.contextModeRecommend')}</option>
                  <option value="inject">{t('settings.contextModeInject')}</option>
                </select>
              </div>
              <div className="settings-group">
                <label>{t('settings.contextMaxPackages', { count: settings.contextModule.autoInjectMaxPackages })}</label>
                <input type="range" min="1" max="8" value={settings.contextModule.autoInjectMaxPackages} onChange={e => settingsStore.setContextModuleSettings({ autoInjectMaxPackages: Number(e.target.value) })} />
              </div>
              <div className="settings-group">
                <label>{t('settings.contextMinScore', { score: settings.contextModule.autoInjectMinScore.toFixed(2) })}</label>
                <input type="range" min="0.1" max="0.95" step="0.01" value={settings.contextModule.autoInjectMinScore} onChange={e => settingsStore.setContextModuleSettings({ autoInjectMinScore: Number(e.target.value) })} />
              </div>
              <div className="settings-group">
                <label>{t('settings.contextTokenBudget')}</label>
                <input type="number" min="1000" step="1000" value={settings.contextModule.contextTokenBudget} onChange={e => settingsStore.setContextModuleSettings({ contextTokenBudget: Number(e.target.value) || 12000 })} />
              </div>
              {[
                ['compressionEnabled', 'settings.contextCompression'],
                ['structuredCompressionEnabled', 'settings.contextStructuredCompression'],
                ['retrieveIdCompressionEnabled', 'settings.contextRetrieveIdCompression'],
                ['summarizeOnSave', 'settings.contextSummarizeOnSave'],
                ['cacheEnabled', 'settings.contextCacheEnabled'],
                ['includeLocalFiles', 'settings.contextIncludeLocalFiles'],
                ['contextManagerAgentEnabled', 'settings.contextManagerAgent'],
                ['autoMemoryEnabled', 'settings.contextAutoMemory'],
              ].map(([key, label]) => (
                <div key={key} className="settings-group checkbox-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(settings.contextModule[key as keyof typeof settings.contextModule])}
                      onChange={e => settingsStore.setContextModuleSettings({ [key]: e.target.checked } as any)}
                    />
                    {t(label)}
                  </label>
                </div>
              ))}
              {settings.contextModule.contextManagerAgentEnabled && (
                <div className="settings-group">
                  <label>{t('settings.contextManagerAgentModel')}</label>
                  <input
                    type="text"
                    value={settings.contextModule.contextManagerAgentModel || ''}
                    placeholder="claude-sonnet-4-6"
                    onChange={e => settingsStore.setContextModuleSettings({ contextManagerAgentModel: e.target.value })}
                  />
                </div>
              )}
              <div className="settings-group">
                <label>{t('settings.contextMemoryDecayDays', { days: settings.contextModule.memoryDecayDays })}</label>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={settings.contextModule.memoryDecayDays}
                  onChange={e => settingsStore.setContextModuleSettings({ memoryDecayDays: Number(e.target.value) || 30 })}
                />
              </div>
              <div className="settings-group">
                <label>{t('settings.contextCacheStats')}</label>
                <p className="settings-hint">
                  {contextCacheStats ? `hit=${contextCacheStats.hit}, miss=${contextCacheStats.miss}, size=${contextCacheStats.size}` : '-'}
                </p>
                <button
                  type="button"
                  className="settings-save-btn"
                  onClick={() => window.electronAPI.contextRetrieval.clearCache().then(() => window.electronAPI.contextRetrieval.cacheStats()).then(setContextCacheStats)}
                >
                  {t('settings.contextClearCache')}
                </button>
              </div>
              <div className="settings-group">
                <label>{t('settings.contextMaintenance')}</label>
                <p className="settings-hint">
                  {maintenanceResult
                    ? t('settings.contextMaintenanceResult', {
                        archived: maintenanceResult.archived,
                        merged: maintenanceResult.merged,
                        deleted: maintenanceResult.deleted,
                        memoryPruned: maintenanceResult.memoryPruned,
                      })
                    : t('settings.contextMaintenanceHint')}
                </p>
                <button
                  type="button"
                  className="settings-save-btn"
                  disabled={maintenanceRunning}
                  onClick={() => {
                    setMaintenanceRunning(true)
                    window.electronAPI.contextMaintenance
                      .run({ staleDays: settings.contextModule.memoryDecayDays * 3 })
                      .then((report) => {
                        setMaintenanceResult({
                          archived: report.archivedPackages.length,
                          merged: report.mergedPackages.length,
                          deleted: report.deletedPackages.length,
                          memoryPruned: report.prunedMemoryEntries,
                        })
                      })
                      .catch(() => setMaintenanceResult(null))
                      .finally(() => setMaintenanceRunning(false))
                  }}
                >
                  {maintenanceRunning ? t('settings.contextMaintenanceRunning') : t('settings.contextMaintenanceRun')}
                </button>
              </div>
            </div>
          )}

          {activeTab === 'agents' && (
            <div className="settings-section">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>{t('settings.agentConfig')}</h3>
                <button
                  className="settings-save-btn"
                  onClick={runAgentDetection}
                  style={{ padding: '4px 10px', fontSize: 12 }}
                >
                  {t('settings.agentRefreshDetection')}
                </button>
              </div>

              {/* Detected API keys from shell configs */}
              {detectedKeys.length > 0 && (
                <div className="agent-config-alert agent-config-alert--info" style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('settings.detectedApiKeys')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {detectedKeys.map((dk, idx) => {
                      const preset = AGENT_PRESETS.find(p => p.apiKeyEnvVar === dk.envVar)
                      if (!preset) return null
                      const config = settingsStore.getAgentConfig(preset.id)
                      return (
                        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                          <span style={{ color: 'var(--text-secondary)' }}>
                            {dk.envVar} ({dk.source}):
                          </span>
                          <code style={{ fontSize: 11 }}>{dk.key.slice(0, 8)}••••{dk.key.slice(-4)}</code>
                          {!config.apiKey && (
                            <button
                              className="agent-config-mode-btn"
                              style={{ padding: '1px 6px', fontSize: 11 }}
                              onClick={async () => {
                                const encrypted = await window.electronAPI.secret.encrypt(dk.key)
                                settingsStore.setAgentConfig(preset.id, { apiKey: encrypted, mode: 'builtin' })
                              }}
                            >
                              {t('settings.useDetectedKey', { agent: preset.name })}
                            </button>
                          )}
                          {config.apiKey && (
                            <span style={{ color: 'var(--success-color)', fontSize: 11 }}>✓ {t('settings.keyAlreadySet')}</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {AGENT_PRESETS.filter(p => p.id !== 'none').map(preset => {
                const config = settingsStore.getAgentConfig(preset.id)
                const check = agentChecks[preset.id]
                const isInstalled = check?.installed ?? true
                const isEnvReady = check?.envReady ?? true
                const isBuiltin = config.mode === 'builtin'
                return (
                  <div
                    key={preset.id}
                    className={`agent-config-card${!isInstalled && !isBuiltin ? ' agent-config-card--disabled' : ''}`}
                  >
                    {/* Header */}
                    <div className="agent-config-header">
                      <div className="agent-config-title">
                        <span className="agent-config-icon" style={{ color: preset.color }}>{preset.icon}</span>
                        <strong>{preset.name}</strong>
                        <span className="agent-config-badge">
                          {isBuiltin ? 'Built-in' : preset.type === 'sdk' ? 'SDK' : 'CLI'}
                        </span>
                        {check?.version && (
                          <span className="agent-config-version" style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 4 }}>
                            {check.version}
                          </span>
                        )}
                      </div>
                      <label className="agent-config-toggle">
                        <input
                          type="checkbox"
                          checked={config.enabled}
                          disabled={!isInstalled && !isBuiltin}
                          onChange={e => settingsStore.setAgentConfig(preset.id, { enabled: e.target.checked })}
                        />
                        <span>{t('settings.agentEnabled')}</span>
                      </label>
                    </div>

                    {/* Mode switcher (for non-SDK agents) */}
                    {preset.type !== 'sdk' && (
                      <div className="agent-config-mode-bar">
                        <button
                          className={`agent-config-mode-btn${isBuiltin ? ' active' : ''}`}
                          onClick={() => settingsStore.setAgentConfig(preset.id, { mode: 'builtin' })}
                        >
                          {t('settings.agentModeBuiltin')}
                        </button>
                        <button
                          className={`agent-config-mode-btn${!isBuiltin ? ' active' : ''}`}
                          onClick={() => settingsStore.setAgentConfig(preset.id, { mode: 'local-cli' })}
                        >
                          {t('settings.agentModeLocalCli')}
                        </button>
                      </div>
                    )}

                    {/* Status alerts */}
                    {!isInstalled && !isBuiltin && (
                      <div className="agent-config-alert agent-config-alert--danger">
                        <div>{t('settings.agentNotInstalled', { command: preset.command })}</div>
                        {preset.docsUrl && (
                          <a
                            href={preset.docsUrl}
                            onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(e.currentTarget.href) }}
                          >
                            {t('settings.agentDocs')} ↗
                          </a>
                        )}
                      </div>
                    )}
                    {isInstalled && !isEnvReady && !isBuiltin && check?.missingEnvVars && (
                      <div className="agent-config-alert agent-config-alert--warning">
                        {t('settings.agentMissingEnv', { vars: check.missingEnvVars.join(', ') })}
                      </div>
                    )}
                    {isBuiltin && !config.apiKey && (preset.apiKeyEnvVar || preset.id === 'copilot-cli') && (
                      <div className="agent-config-alert agent-config-alert--warning">
                        {t('settings.agentMissingApiKey')}
                      </div>
                    )}

                    {/* Fields */}
                    <div className="agent-config-fields">
                      {isBuiltin ? (
                        <>
                          {/* Copilot: Device Flow button */}
                          {preset.id === 'copilot-cli' && (
                            <div className="settings-group">
                              <label>{t('settings.copilotAuth')}</label>
                              <CopilotDeviceFlowButton
                                hasToken={!!config.apiKey}
                                onTokenAcquired={async (token) => {
                                  const encrypted = await window.electronAPI.secret.encrypt(token)
                                  settingsStore.setAgentConfig(preset.id, { apiKey: encrypted })
                                }}
                              />
                              <p className="agent-config-desc">{t('settings.copilotAuthHint')}</p>
                            </div>
                          )}
                          {/* Built-in mode: API Key (hidden for copilot, replaced by device flow) */}
                          {preset.id !== 'copilot-cli' && (
                          <div className="settings-group">
                            <label>{t('settings.agentApiKey')}</label>
                            <div className="agent-config-apikey-row">
                              <input
                                type="password"
                                value={config.apiKey ? '••••••••' : ''}
                                onChange={async e => {
                                  const val = e.target.value
                                  if (val && val !== '••••••••') {
                                    const encrypted = await window.electronAPI.secret.encrypt(val)
                                    settingsStore.setAgentConfig(preset.id, { apiKey: encrypted })
                                  }
                                }}
                                placeholder={preset.apiKeyEnvVar || 'API Key'}
                              />
                              {config.apiKey && (
                                <button
                                  className="agent-config-clear-btn"
                                  onClick={() => settingsStore.setAgentConfig(preset.id, { apiKey: '' })}
                                  title={t('settings.agentClearApiKey')}
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                              {config.apiKey && (
                                <button
                                  className="agent-config-mode-btn"
                                  style={{ padding: '2px 8px', fontSize: 11 }}
                                  disabled={validatingKey === preset.id}
                                  onClick={async () => {
                                    setValidatingKey(preset.id)
                                    setValidationResult(null)
                                    try {
                                      const decrypted = await window.electronAPI.secret.decrypt(config.apiKey!)
                                      const res = await window.electronAPI.agent.validateApiKey(preset.id, decrypted, config.builtinBaseUrl)
                                      setValidationResult({
                                        presetId: preset.id,
                                        ok: res.ok,
                                        message: res.ok
                                          ? (res.model ? `Connected (${res.model})` : 'Connected')
                                          : (res.error || 'Failed'),
                                      })
                                    } catch (err: unknown) {
                                      setValidationResult({
                                        presetId: preset.id,
                                        ok: false,
                                        message: err instanceof Error ? err.message : String(err),
                                      })
                                    } finally {
                                      setValidatingKey(null)
                                    }
                                  }}
                                >
                                  {validatingKey === preset.id ? 'Testing…' : t('settings.testConnection')}
                                </button>
                              )}
                              {validationResult?.presetId === preset.id && (
                                <span
                                  style={{
                                    fontSize: 12,
                                    color: validationResult.ok ? 'var(--success-color)' : 'var(--danger-color)',
                                  }}
                                >
                                  {validationResult.ok ? '✓' : '✗'} {validationResult.message}
                                </span>
                              )}
                            </div>
                            <p className="agent-config-desc">{t('settings.agentApiKeyHint', { envVar: preset.apiKeyEnvVar || 'API_KEY' })}</p>
                          </div>
                          )}
                          {/* Built-in mode: Base URL (optional) */}
                          <div className="settings-group">
                            <label>{t('settings.agentBaseUrl')}</label>
                            <input
                              type="text"
                              value={config.builtinBaseUrl || ''}
                              onChange={e => settingsStore.setAgentConfig(preset.id, { builtinBaseUrl: e.target.value || undefined })}
                              placeholder={t('settings.agentBaseUrlPlaceholder')}
                            />
                            <p className="agent-config-desc">{t('settings.agentBaseUrlHint')}</p>
                          </div>
                        </>
                      ) : (
                        <>
                          {/* Local CLI mode: Command */}
                          <div className="settings-group">
                            <label>{t('settings.agentCommand')}</label>
                            <input
                              type="text"
                              value={config.command || ''}
                              onChange={e => settingsStore.setAgentConfig(preset.id, { command: e.target.value || undefined })}
                              placeholder={preset.command}
                              disabled={!isInstalled}
                            />
                            <p className="agent-config-desc">{t('settings.agentCommandDesc')}</p>
                          </div>

                          {preset.supportsArgs && (
                            <div className="settings-group">
                              <label>{t('settings.agentArgs')}</label>
                              <textarea
                                rows={2}
                                value={(config.args || []).join('\n')}
                                onChange={e => {
                                  const args = e.target.value.split('\n').map(s => s.trim()).filter(Boolean)
                                  settingsStore.setAgentConfig(preset.id, { args: args.length > 0 ? args : undefined })
                                }}
                                placeholder="--flag\n--option value"
                                disabled={!isInstalled}
                              />
                              <p className="agent-config-desc">{t('settings.agentArgsDesc')}</p>
                            </div>
                          )}

                          <div className="settings-group">
                            <label>{t('settings.agentEnvVars')}</label>
                            <textarea
                              rows={2}
                              value={Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')}
                              onChange={e => {
                                const env: Record<string, string> = {}
                                e.target.value.split('\n').forEach(line => {
                                  const idx = line.indexOf('=')
                                  if (idx > 0) {
                                    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
                                  }
                                })
                                settingsStore.setAgentConfig(preset.id, { env: Object.keys(env).length > 0 ? env : undefined })
                              }}
                              placeholder={preset.apiKeyEnvVar ? `${preset.apiKeyEnvVar}=your_key_here` : 'KEY=VALUE'}
                              disabled={!isInstalled}
                            />
                            <p className="agent-config-desc">{t('settings.agentEnvVarsDesc')}</p>
                          </div>

                          <label className="agent-config-toggle agent-config-toggle--inline">
                            <input
                              type="checkbox"
                              checked={config.autoStart}
                              disabled={!isInstalled}
                              onChange={e => settingsStore.setAgentConfig(preset.id, { autoStart: e.target.checked })}
                            />
                            <span>{t('settings.agentAutoStart')}</span>
                          </label>
                        </>
                      )}

                      {preset.docsUrl && (
                        <div style={{ marginTop: 4 }}>
                          <a
                            href={preset.docsUrl}
                            className="agent-config-docs-link"
                            onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(e.currentTarget.href) }}
                          >
                            {t('settings.agentDocs')} ↗
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {activeTab === 'general' && (
            <>
          <div className="settings-section">
            <h3>{t('settings.environmentVariables')}</h3>
            <p className="settings-hint" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              {t('settings.globalEnvVarsHint')}
            </p>
            <EnvVarEditor
              envVars={settings.globalEnvVars || []}
              onAdd={(envVar) => settingsStore.addGlobalEnvVar(envVar)}
              onRemove={(key) => settingsStore.removeGlobalEnvVar(key)}
              onUpdate={(key, updates) => settingsStore.updateGlobalEnvVar(key, updates)}
            />
          </div>
          <div className="settings-section">
            <h3>{t('settings.remoteAccess')}</h3>
            <p className="settings-hint" style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              {t('settings.remoteAccessHint')}{' '}
              <a href="https://github.com/tony1223/better-agent-terminal#remote-access--mobile-connect"
                style={{ color: '#58a6ff' }}
                onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(e.currentTarget.href) || window.open(e.currentTarget.href) }}>
                {t('settings.remoteAccessReadme')}
              </a>。
            </p>

            {serverStatus.running ? (
              <>
                <div className="settings-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#3fb950', fontSize: 12 }}>{t('settings.serverRunningOnPort', { port: serverStatus.port })}</span>
                  <button className="profile-action-btn danger" onClick={handleStopServer} style={{ marginLeft: 'auto' }}>
                    {t('settings.stopServer')}
                  </button>
                </div>
                {serverToken && (
                  <div className="settings-group">
                    <label>{t('settings.connectionToken')}</label>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="text"
                        readOnly
                        value={serverToken}
                        style={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }}
                        onClick={e => (e.target as HTMLInputElement).select()}
                      />
                      <button
                        className="profile-action-btn"
                        onClick={() => navigator.clipboard.writeText(serverToken)}
                        title="Copy token"
                      >
                        {t('common.copy')}
                      </button>
                    </div>
                  </div>
                )}
                {serverStatus.clients.length > 0 && (
                  <div className="settings-group">
                    <label>{t('settings.connectedClients', { count: serverStatus.clients.length })}</label>
                    {serverStatus.clients.map((c, i) => (
                      <div key={i} style={{ fontSize: 12, color: '#aaa', padding: '2px 0' }}>
                        {c.label} — {t('settings.connectedAt', { time: new Date(c.connectedAt).toLocaleTimeString() })}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="settings-group">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="number"
                    value={serverPort}
                    onChange={e => setServerPort(e.target.value)}
                    placeholder={t('settings.port')}
                    style={{ width: 80 }}
                  />
                  <button className="profile-action-btn primary" onClick={handleStartServer}>
                    {t('settings.startServer')}
                  </button>
                </div>
                <p style={{ fontSize: 11, color: '#d29922', marginTop: 6, lineHeight: 1.4 }}>
                  {t('settings.serverWarning')}
                </p>
              </div>
            )}

            {clientStatus.connected && clientStatus.info && (
              <div className="settings-group" style={{ marginTop: 8 }}>
                <span style={{ color: '#58a6ff', fontSize: 12 }}>
                  {t('settings.connectedToRemote', { host: clientStatus.info.host, port: clientStatus.info.port })}
                </span>
              </div>
            )}

            <div className="settings-group" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <label>{t('settings.mobileConnect')} <span style={{ fontSize: 10, color: '#d29922', fontWeight: 'normal' }}>{t('settings.mobileConnectExperimental')}</span></label>
              <p style={{ fontSize: 11, color: '#8b949e', marginTop: 2, marginBottom: 6, lineHeight: 1.4 }}>
                {t('settings.mobileConnectHint')}{' '}
                <a href="https://tailscale.com/" style={{ color: '#58a6ff' }}
                  onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(e.currentTarget.href) || window.open(e.currentTarget.href) }}>
                  Tailscale
                </a>{' '}
                {t('settings.mobileConnectSeeReadme')}{' '}
                <a href="https://github.com/tony1223/better-agent-terminal#remote-access--mobile-connect"
                  style={{ color: '#58a6ff' }}
                  onClick={e => { e.preventDefault(); window.electronAPI?.shell?.openExternal?.(e.currentTarget.href) || window.open(e.currentTarget.href) }}>
                  {t('settings.remoteAccessReadme')}
                </a>。
              </p>
              {!qrDataUrl ? (
                <>
                  <button
                    className="profile-action-btn primary"
                    onClick={handleGenerateQR}
                    disabled={qrLoading}
                    style={{ marginTop: 4 }}
                  >
                    {qrLoading ? t('settings.generating') : t('settings.generateQrCode')}
                  </button>
                  <p style={{ fontSize: 11, color: '#d29922', marginTop: 6, lineHeight: 1.4 }}>
                    {t('settings.qrWarning')}
                  </p>
                  {qrError && (
                    <p style={{ fontSize: 11, color: '#f85149', marginTop: 4 }}>{qrError}</p>
                  )}
                </>
              ) : (
                <div style={{ textAlign: 'center', marginTop: 8 }}>
                  {qrAddresses.length > 1 && (
                    <select
                      style={{ width: '100%', marginBottom: 8, fontSize: 12, padding: '4px 6px' }}
                      value={qrInfo?.url?.split('//')[1]?.split(':')[0] || ''}
                      onChange={async (e) => {
                        const addr = qrAddresses.find(a => a.ip === e.target.value)
                        if (addr && qrToken) {
                          await generateQrForIp(addr.ip, addr.mode, qrToken, qrPort)
                        }
                      }}
                    >
                      {qrAddresses.map(addr => (
                        <option key={addr.ip} value={addr.ip}>{addr.label}</option>
                      ))}
                    </select>
                  )}
                  <img
                    src={qrDataUrl}
                    alt="QR Code"
                    style={{ width: 200, height: 200, imageRendering: 'pixelated', borderRadius: 4, background: '#fff', padding: 4 }}
                  />
                  <p style={{ fontSize: 11, color: '#8b949e', marginTop: 6, wordBreak: 'break-all', fontFamily: 'monospace' }}>
                    {qrInfo?.url}
                  </p>
                  <p style={{ fontSize: 11, color: qrInfo?.mode === 'tailscale' ? '#3fb950' : '#d29922', marginTop: 2 }}>
                    {qrInfo?.mode === 'tailscale' ? t('settings.viaTailscale') : t('settings.lanOnly')}
                  </p>
                  <button
                    className="profile-action-btn"
                    onClick={() => { setQrDataUrl(null); setQrInfo(null); setQrAddresses([]) }}
                    style={{ marginTop: 8 }}
                  >
                    {t('common.close')}
                  </button>
                </div>
              )}
            </div>
          </div>
            </>
          )}
        </div>

        <div className="settings-footer">
          <p className="settings-note">{t('settings.footerNote')}</p>
        </div>
      </div>
    </div>
  )
}
