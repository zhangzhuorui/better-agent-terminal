import { syncHljsStylesheet } from './hljs-theme'
import type { UiThemePreference } from '../types'

/** Synced with settings `theme`; used before async settings load to reduce splash flash. */
export const UI_THEME_STORAGE_KEY = 'better-agent-ui-theme'

const listeners = new Set<(effective: 'dark' | 'light') => void>()

let lastPreference: UiThemePreference = readCachedUiThemePreference() ?? 'dark'

let systemMediaCleanup: (() => void) | null = null

export function readCachedUiThemePreference(): UiThemePreference | null {
  try {
    const v = localStorage.getItem(UI_THEME_STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* ignore */
  }
  return null
}

export function resolveEffectiveTheme(preference: UiThemePreference): 'dark' | 'light' {
  if (preference === 'light') return 'light'
  if (preference === 'dark') return 'dark'
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return 'dark'
}

/** Current effective theme (after resolving “system”). */
export function getEffectiveUiTheme(): 'dark' | 'light' {
  return resolveEffectiveTheme(lastPreference)
}

export function subscribeUiEffectiveTheme(cb: (effective: 'dark' | 'light') => void): () => void {
  listeners.add(cb)
  cb(getEffectiveUiTheme())
  return () => listeners.delete(cb)
}

function notifyEffectiveListeners(effective: 'dark' | 'light'): void {
  listeners.forEach(l => {
    try {
      l(effective)
    } catch {
      /* ignore */
    }
  })
}

function applyDomForEffective(effective: 'dark' | 'light'): void {
  const root = document.documentElement
  if (effective === 'light') {
    root.setAttribute('data-theme', 'light')
    root.style.colorScheme = 'light'
  } else {
    root.removeAttribute('data-theme')
    root.style.colorScheme = 'dark'
  }
}

function syncElectronChrome(effective: 'dark' | 'light'): void {
  const hex = effective === 'light' ? '#f5f5f5' : '#1a1a1a'
  const api = window.electronAPI?.app as { setChromeBackgroundColor?: (h: string) => Promise<void> } | undefined
  void api?.setChromeBackgroundColor?.(hex)
}

function setupSystemThemeListener(enable: boolean): void {
  systemMediaCleanup?.()
  systemMediaCleanup = null
  if (!enable || typeof window === 'undefined' || !window.matchMedia) return
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const handler = (): void => {
    if (lastPreference !== 'system') return
    const eff = resolveEffectiveTheme('system')
    applyDomForEffective(eff)
    syncHljsStylesheet(eff)
    syncElectronChrome(eff)
    notifyEffectiveListeners(eff)
  }
  mq.addEventListener('change', handler)
  systemMediaCleanup = () => mq.removeEventListener('change', handler)
}

/**
 * Apply stored preference: `dark` / `light` / `system` (follow OS).
 * Updates DOM, hljs stylesheet, Electron window chrome, and notifies subscribers.
 */
export function applyUiTheme(preference: UiThemePreference): void {
  lastPreference = preference
  try {
    localStorage.setItem(UI_THEME_STORAGE_KEY, preference)
  } catch {
    /* ignore */
  }
  const effective = resolveEffectiveTheme(preference)
  applyDomForEffective(effective)
  syncHljsStylesheet(effective)
  syncElectronChrome(effective)
  notifyEffectiveListeners(effective)
  setupSystemThemeListener(preference === 'system')
}
