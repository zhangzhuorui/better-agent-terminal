/**
 * Agent Config Detector — cross-platform local CLI detection and built-in API validation.
 *
 * Responsibilities:
 *   1. Detect whether agent CLIs are installed (claude, codex, gemini, gh).
 *   2. Scan shell config files for API keys so users don't have to re-enter them.
 *   3. Validate built-in mode API keys by making a lightweight HTTP call.
 */

import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { logger } from './logger'
import type { AgentPresetId } from '../src/types/agent-presets'

// ─── CLI Detection ────────────────────────────────────────────────────────

export function commandExists(cmd: string): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [cmd], { stdio: 'ignore', timeout: 3000 })
    } else {
      execFileSync('which', [cmd], { stdio: 'ignore', timeout: 3000 })
    }
    return true
  } catch {
    return false
  }
}

export interface AgentLocalCheck {
  installed: boolean
  envReady: boolean
  missingEnvVars: string[]
  version?: string
}

export interface DetectedApiKey {
  key: string
  source: string // e.g., '~/.zshrc'
  envVar: string
}

export interface AgentDetectionResult {
  configs: Record<string, AgentLocalCheck>
  detectedKeys: DetectedApiKey[]
  scannedAt: number
}

let _cachedResult: AgentDetectionResult | null = null

function getAgentVersion(cmd: string): string | undefined {
  try {
    const raw = execFileSync(cmd, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim()
    return raw.split('\n')[0] || raw
  } catch {
    return undefined
  }
}

export function detectLocalAgentConfigs(): AgentDetectionResult {
  const configs: Record<string, AgentLocalCheck> = {}

  // codex-cli
  const codexInstalled = commandExists('codex')
  const openaiKey = !!process.env.OPENAI_API_KEY
  configs['codex-cli'] = {
    installed: codexInstalled,
    envReady: openaiKey,
    missingEnvVars: openaiKey ? [] : ['OPENAI_API_KEY'],
    version: codexInstalled ? getAgentVersion('codex') : undefined,
  }

  // gemini-cli
  const geminiInstalled = commandExists('gemini')
  const googleKey = !!process.env.GOOGLE_API_KEY
  configs['gemini-cli'] = {
    installed: geminiInstalled,
    envReady: googleKey,
    missingEnvVars: googleKey ? [] : ['GOOGLE_API_KEY'],
    version: geminiInstalled ? getAgentVersion('gemini') : undefined,
  }

  // copilot-cli (gh CLI + copilot extension)
  const ghInstalled = commandExists('gh')
  configs['copilot-cli'] = {
    installed: ghInstalled,
    envReady: true,
    missingEnvVars: [],
    version: ghInstalled ? getAgentVersion('gh') : undefined,
  }

  // claude-code
  const claudeInstalled = commandExists('claude')
  configs['claude-code'] = {
    installed: claudeInstalled,
    envReady: true,
    missingEnvVars: [],
    version: claudeInstalled ? getAgentVersion('claude') : undefined,
  }

  const detectedKeys = scanShellConfigsForApiKeys()

  const result: AgentDetectionResult = {
    configs,
    detectedKeys,
    scannedAt: Date.now(),
  }
  _cachedResult = result
  return result
}

export function getCachedDetectionResult(): AgentDetectionResult | null {
  return _cachedResult
}

// ─── Shell Config Scanning ────────────────────────────────────────────────

const SHELL_CONFIG_FILES = ['.zshrc', '.bashrc', '.bash_profile', '.profile', '.zshenv']
const API_KEY_PATTERNS: Record<string, RegExp[]> = {
  OPENAI_API_KEY: [/export\s+OPENAI_API_KEY=["']?([A-Za-z0-9_\-]{20,})["']?/],
  GOOGLE_API_KEY: [/export\s+GOOGLE_API_KEY=["']?([A-Za-z0-9_\-]{20,})["']?/],
  ANTHROPIC_API_KEY: [/export\s+ANTHROPIC_API_KEY=["']?([A-Za-z0-9_\-]{20,})["']?/],
  GITHUB_TOKEN: [/export\s+GITHUB_TOKEN=["']?([A-Za-z0-9_\-]{20,})["']?/],
}

function scanShellConfigsForApiKeys(): DetectedApiKey[] {
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) return []

  const results: DetectedApiKey[] = []
  const seen = new Set<string>()

  for (const fileName of SHELL_CONFIG_FILES) {
    const filePath = path.join(home, fileName)
    try {
      const content = fsSync.readFileSync(filePath, 'utf8')
      for (const [envVar, patterns] of Object.entries(API_KEY_PATTERNS)) {
        for (const regex of patterns) {
          const match = regex.exec(content)
          if (match && match[1]) {
            const key = match[1]
            if (seen.has(key)) continue
            seen.add(key)
            results.push({ key, source: `~/${fileName}`, envVar })
          }
        }
      }
    } catch {
      // File doesn't exist or not readable — ignore
    }
  }

  // Also check project .env files in common locations
  const envPaths = [
    path.join(home, '.env'),
    path.join(process.cwd(), '.env'),
  ]
  for (const envPath of envPaths) {
    try {
      const content = fsSync.readFileSync(envPath, 'utf8')
      for (const [envVar, patterns] of Object.entries(API_KEY_PATTERNS)) {
        for (const regex of patterns) {
          const match = regex.exec(content)
          if (match && match[1]) {
            const key = match[1]
            if (seen.has(key)) continue
            seen.add(key)
            results.push({ key, source: path.basename(envPath) === '.env' ? '.env' : envPath, envVar })
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  return results
}

// Need fsSync import at top but we used it above; fix by importing here for the function
import * as fsSync from 'fs'

// ─── Built-in API Key Validation ──────────────────────────────────────────

export interface ApiKeyValidationResult {
  ok: boolean
  error?: string
  model?: string
}

export async function validateBuiltinApiKey(
  presetId: AgentPresetId,
  apiKey: string,
  baseUrl?: string
): Promise<ApiKeyValidationResult> {
  if (!apiKey) return { ok: false, error: 'API key is empty' }

  try {
    switch (presetId) {
      case 'codex-cli': {
        const url = baseUrl?.trim() || 'https://api.openai.com/v1/models'
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
        }
        const data = (await res.json()) as { data?: { id: string }[] }
        const model = data.data?.[0]?.id
        return { ok: true, model }
      }
      case 'gemini-cli': {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=1`
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
        }
        const data = (await res.json()) as { models?: { name: string }[] }
        const model = data.models?.[0]?.name?.replace('models/', '')
        return { ok: true, model }
      }
      case 'copilot-cli': {
        // Validate Copilot token by calling the models endpoint
        const res = await fetch('https://api.githubcopilot.com/models', {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Editor-Version': 'vscode/1.85.0',
          },
          signal: AbortSignal.timeout(10000),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
        }
        const data = (await res.json()) as { data?: { id: string }[] }
        const model = data.data?.[0]?.id
        return { ok: true, model }
      }
      case 'claude-code':
        return { ok: true } // Claude Code built-in uses SDK session, no simple HTTP validation
      default:
        return { ok: false, error: 'Unknown preset' }
    }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
