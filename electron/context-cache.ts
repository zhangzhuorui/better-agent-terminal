import { createHash } from 'crypto'

interface CacheEntry<T> {
  value: T
  expiresAt: number
  createdAt: number
}

const MAX_ENTRIES = 200
const DEFAULT_TTL_MS = 5 * 60 * 1000
const caches = new Map<string, CacheEntry<unknown>>()
let hits = 0
let misses = 0
let lastClearedAt = Date.now()

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export function makeStableCacheKey(...parts: unknown[]): string {
  return createHash('sha256').update(stableStringify(parts)).digest('hex')
}

export function getCache<T>(key: string): T | undefined {
  const entry = caches.get(key)
  if (!entry || entry.expiresAt < Date.now()) {
    if (entry) caches.delete(key)
    misses += 1
    return undefined
  }
  hits += 1
  caches.delete(key)
  caches.set(key, entry)
  return entry.value as T
}

export function setCache<T>(key: string, value: T, ttlMs = DEFAULT_TTL_MS): void {
  caches.set(key, { value, expiresAt: Date.now() + ttlMs, createdAt: Date.now() })
  while (caches.size > MAX_ENTRIES) {
    const first = caches.keys().next().value
    if (!first) break
    caches.delete(first)
  }
}

export function deleteCacheByPrefix(prefix: string): void {
  for (const key of caches.keys()) {
    if (key.startsWith(prefix)) caches.delete(key)
  }
}

export function getContextCacheStats(): { hit: number; miss: number; size: number; lastClearedAt: number } {
  return { hit: hits, miss: misses, size: caches.size, lastClearedAt }
}

export function clearContextCaches(): void {
  caches.clear()
  hits = 0
  misses = 0
  lastClearedAt = Date.now()
}
