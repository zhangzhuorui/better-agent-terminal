/**
 * User Preference Learning — local, privacy-preserving context recommendation learning.
 * Tracks which packages users select for different intents/tech-stacks and boosts
 * those packages in future recommendations.
 */

import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { IntentResult, TaskIntent } from './intent-classifier'

const PREF_FILE = 'context-user-preferences.json'
const MAX_ENTRIES = 500

interface SelectionRecord {
  packageId: string
  intents: TaskIntent[]
  languages: string[]
  frameworks: string[]
  tools: string[]
  keywords: string[]
  timestamp: number
}

interface PreferenceFile {
  version: 1
  records: SelectionRecord[]
  negativeRecords: SelectionRecord[]
}

function prefPath(): string {
  return path.join(app.getPath('userData'), PREF_FILE)
}

async function readPrefs(): Promise<PreferenceFile> {
  try {
    const raw = await fs.readFile(prefPath(), 'utf-8')
    const parsed = JSON.parse(raw) as PreferenceFile
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) return { version: 1, records: [], negativeRecords: [] }
    return { negativeRecords: [], ...parsed, records: parsed.records }
  } catch {
    return { version: 1, records: [], negativeRecords: [] }
  }
}

async function writePrefs(data: PreferenceFile): Promise<void> {
  const p = prefPath()
  const tmp = `${p}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, p)
}

function similarityWeight(record: SelectionRecord, intent: IntentResult): number {
  let weight = 0
  // Intent match
  for (const i of intent.intents) {
    if (record.intents.includes(i)) weight += 1.5
  }
  // Language match
  for (const l of intent.techStack.languages) {
    if (record.languages.includes(l)) weight += 1.0
  }
  // Framework match
  for (const f of intent.techStack.frameworks) {
    if (record.frameworks.includes(f)) weight += 1.2
  }
  // Tool match
  for (const t of intent.techStack.tools) {
    if (record.tools.includes(t)) weight += 0.8
  }
  // Keyword overlap
  const kwSet = new Set(record.keywords)
  for (const k of intent.extractedKeywords) {
    if (kwSet.has(k)) weight += 0.5
  }
  return weight
}

function decayFactor(timestamp: number): number {
  const days = (Date.now() - timestamp) / 86400000
  // Half-life of 30 days
  return Math.exp(-days * 0.0231)
}

/** Record that a user selected/accepted a package for a given prompt intent. */
export async function recordUserSelection(packageId: string, intent: IntentResult): Promise<void> {
  const prefs = await readPrefs()
  prefs.records.push({
    packageId,
    intents: intent.intents,
    languages: intent.techStack.languages,
    frameworks: intent.techStack.frameworks,
    tools: intent.techStack.tools,
    keywords: intent.extractedKeywords,
    timestamp: Date.now(),
  })
  // Trim old records if over limit
  if (prefs.records.length > MAX_ENTRIES) {
    prefs.records.sort((a, b) => b.timestamp - a.timestamp)
    prefs.records = prefs.records.slice(0, MAX_ENTRIES)
  }
  await writePrefs(prefs)
  _cachedRecords = prefs.records
  _lastLoad = Date.now()
}

/** Get learned preference boost for a package based on current intent. */
export function getUserPreferences(packageId: string, intent: IntentResult): { boost: number; reason?: string } {
  // Synchronous path: read from in-memory cache if available;
  // since this is called inside a tight scoring loop, we use a lightweight
  // cached version refreshed on demand.
  const records = _cachedRecords.filter(r => r.packageId === packageId)
  const negativeRecords = _cachedNegativeRecords.filter(r => r.packageId === packageId)

  let totalWeight = 0
  for (const r of records) {
    totalWeight += similarityWeight(r, intent) * decayFactor(r.timestamp)
  }
  let negativeWeight = 0
  for (const r of negativeRecords) {
    negativeWeight += similarityWeight(r, intent) * decayFactor(r.timestamp)
  }

  // Normalize: max boost 0.18, require at least 2.0 weighted relevance
  const rawBoost = Math.min(0.18, totalWeight * 0.03)
  const penalty = Math.min(0.18, negativeWeight * 0.03)
  const boost = Math.max(0, rawBoost - penalty)
  if (boost <= 0.02) return { boost: 0 }
  return { boost, reason: 'previously selected' }
}

let _cachedRecords: SelectionRecord[] = []
let _cachedNegativeRecords: SelectionRecord[] = []
let _lastLoad = 0

async function refreshCache(): Promise<void> {
  const now = Date.now()
  if (now - _lastLoad < 30000) return // 30s freshness
  const prefs = await readPrefs()
  _cachedRecords = prefs.records
  _cachedNegativeRecords = prefs.negativeRecords
  _lastLoad = now
}

/** Should be called at module load and after recordUserSelection. */
export async function loadUserPreferences(): Promise<void> {
  await refreshCache()
}

/** Record that a user rejected/dismissed a package for a given prompt. */
export async function recordNegativeFeedback(packageId: string, prompt: string): Promise<void> {
  const intent = classifyIntent(prompt)
  const prefs = await readPrefs()
  prefs.negativeRecords.push({
    packageId,
    intents: intent.intents,
    languages: intent.techStack.languages,
    frameworks: intent.techStack.frameworks,
    tools: intent.techStack.tools,
    keywords: intent.extractedKeywords,
    timestamp: Date.now(),
  })
  if (prefs.negativeRecords.length > MAX_ENTRIES) {
    prefs.negativeRecords.sort((a, b) => b.timestamp - a.timestamp)
    prefs.negativeRecords = prefs.negativeRecords.slice(0, MAX_ENTRIES)
  }
  await writePrefs(prefs)
  _cachedNegativeRecords = prefs.negativeRecords
}

/** Exported for retrieval service to ensure cache freshness before scoring. */
export { refreshCache }

// Initial load
loadUserPreferences().catch(() => {})
