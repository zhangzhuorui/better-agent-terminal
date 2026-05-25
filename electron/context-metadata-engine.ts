import { createHash } from 'crypto'
import type { ContextPackageChunk, ContextPackageMetadata } from '../src/types/platform-extensions'

export interface GeneratedContextMetadata {
  metadata: ContextPackageMetadata
  chunks: ContextPackageChunk[]
  compressed: {
    brief?: string
    medium?: string
    detailed?: string
    updatedAt: number
  }
}

const METADATA_VERSION = 1
const MAX_CHUNK_TOKENS = 1800
const TECH_TERMS = [
  'react', 'electron', 'typescript', 'javascript', 'node', 'vite', 'zustand', 'redux',
  'workflow', 'automation', 'settings', 'terminal', 'claude', 'agent', 'ipc', 'preload',
  'debug', 'error', 'test', 'build', 'css', 'html', 'json', 'markdown', 'python', 'rust',
  'go', 'java', 'swift', 'kotlin', 'docker', 'github', 'git', 'api', 'mcp', 'analytics',
]

const TAG_RULES: Array<[string, RegExp]> = [
  ['debug', /\b(debug|bug|error|exception|stack trace|crash|fail(ed|ure)?)\b/i],
  ['test', /\b(test|spec|vitest|jest|playwright|assert|coverage)\b/i],
  ['workflow', /\b(workflow|automation|trigger|scheduler|node|edge)\b/i],
  ['settings', /\b(settings|preference|config|configuration|option)\b/i],
  ['react', /\b(react|component|hook|jsx|tsx|useState|useEffect)\b/i],
  ['electron', /\b(electron|ipcMain|ipcRenderer|preload|BrowserWindow|main process)\b/i],
  ['typescript', /\b(typescript|interface|type|tsx|tsconfig)\b/i],
  ['api', /\b(api|endpoint|request|response|http|websocket)\b/i],
  ['context', /\b(context package|context|retrieval|injection|prompt)\b/i],
]

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function uniq(values: string[], limit = 30): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = value.trim().toLowerCase()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
    if (result.length >= limit) break
  }
  return result
}

function extractHeadings(content: string): string[] {
  return Array.from(content.matchAll(/^#{1,4}\s+(.+)$/gm)).map(m => m[1].trim()).filter(Boolean)
}

function extractRelatedFiles(content: string): string[] {
  const matches = content.match(/[\w@./-]+\.(?:ts|tsx|js|jsx|json|css|scss|md|py|rs|go|java|yml|yaml|toml|sh)/g) ?? []
  return uniq(matches, 40)
}

function extractCodeIdentifiers(content: string): string[] {
  const identifiers: string[] = []
  const patterns = [
    /\b(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*=>/g,
    /\b([A-Za-z_$][\w$]*)\(/g,
  ]
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) identifiers.push(match[1])
  }
  return identifiers
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9_]+|_/)
    .map(s => s.toLowerCase())
    .filter(s => s.length >= 3)
}

function detectLanguage(content: string, files: string[]): string | undefined {
  const extCounts = new Map<string, number>()
  for (const file of files) {
    const ext = file.split('.').pop()?.toLowerCase()
    if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1)
  }
  const ext = [...extCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (ext === 'ts' || ext === 'tsx') return 'typescript'
  if (ext === 'js' || ext === 'jsx') return 'javascript'
  if (ext === 'py') return 'python'
  if (ext === 'rs') return 'rust'
  if (ext === 'go') return 'go'
  if (ext === 'java') return 'java'
  if (/\binterface\s+\w+|:\s*(string|number|boolean)\b|import type\b/.test(content)) return 'typescript'
  if (/\bfunction\s+\w+|const\s+\w+\s*=|require\(/.test(content)) return 'javascript'
  return undefined
}

function detectFramework(content: string): string | undefined {
  const lower = content.toLowerCase()
  if (lower.includes('electron') || lower.includes('ipcmain') || lower.includes('ipcrenderer')) return 'electron'
  if (lower.includes('react') || lower.includes('usestate') || lower.includes('useeffect') || lower.includes('tsx')) return 'react'
  if (lower.includes('vite')) return 'vite'
  if (lower.includes('next.js') || lower.includes('nextjs')) return 'nextjs'
  return undefined
}

function buildSummary(input: { name: string; description?: string; content: string; headings: string[] }): { summary: string; shortSummary: string } {
  const lines = input.content.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const bullets = lines.filter(l => /^[-*]\s+|^\d+\.\s+/.test(l)).slice(0, 5)
  const firstParagraph = lines.find(l => !l.startsWith('#') && l.length > 30) ?? lines[0] ?? ''
  const parts = [
    input.description,
    input.headings.length ? `Headings: ${input.headings.slice(0, 6).join('; ')}` : undefined,
    firstParagraph,
    bullets.length ? bullets.join(' ') : undefined,
  ].filter(Boolean) as string[]
  const summary = trimText(parts.join('\n'), 900)
  const shortSummary = trimText(input.description || input.headings[0] || firstParagraph || input.name, 180)
  return { summary, shortSummary }
}

function trimText(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trim()}…`
}

function makeCompressed(summary: string, content: string): GeneratedContextMetadata['compressed'] {
  return {
    brief: trimText(summary || content, 350),
    medium: trimText(summary ? `${summary}\n\n${content}` : content, 1600),
    detailed: trimText(content, 4200),
    updatedAt: Date.now(),
  }
}

function splitIntoChunks(packageId: string, content: string): ContextPackageChunk[] {
  const chunks: ContextPackageChunk[] = []
  const sections = content.split(/(?=^#{1,3}\s+)/gm).filter(s => s.trim())
  let offset = 0
  const sourceParts = sections.length > 1 ? sections : content.split(/\n\s*\n/).filter(s => s.trim())
  let buffer = ''
  let bufferStart = 0

  const pushBuffer = () => {
    const trimmed = buffer.trim()
    if (!trimmed) return
    const startOffset = bufferStart
    const endOffset = startOffset + buffer.length
    chunks.push({
      id: `${packageId}:chunk:${chunks.length + 1}`,
      packageId,
      content: trimmed,
      summary: trimText(trimmed, 220),
      keywords: extractKeywords(trimmed, []),
      tokenEstimate: estimateTokens(trimmed),
      startOffset,
      endOffset,
      hash: hash(trimmed),
    })
    buffer = ''
  }

  for (const part of sourceParts) {
    const partIndex = content.indexOf(part, offset)
    const start = partIndex >= 0 ? partIndex : offset
    if (!buffer) bufferStart = start
    if (estimateTokens(buffer + '\n\n' + part) > MAX_CHUNK_TOKENS && buffer) pushBuffer()
    if (!buffer) bufferStart = start
    buffer += (buffer ? '\n\n' : '') + part
    offset = start + part.length
    if (estimateTokens(buffer) > MAX_CHUNK_TOKENS) pushBuffer()
  }
  pushBuffer()
  return chunks
}

function extractKeywords(content: string, userTags: string[]): string[] {
  const lower = content.toLowerCase()
  const terms = TECH_TERMS.filter(term => lower.includes(term))
  const identifiers = extractCodeIdentifiers(content).flatMap(splitIdentifier)
  const headings = extractHeadings(content).flatMap(splitIdentifier)
  return uniq([...userTags, ...terms, ...headings, ...identifiers], 40)
}

export function generateContextMetadata(input: {
  id?: string
  name: string
  description?: string
  content: string
  userTags?: string[]
  workspaceRoot?: string
}): GeneratedContextMetadata {
  const headings = extractHeadings(input.content)
  const relatedFiles = extractRelatedFiles(input.content)
  const keywords = extractKeywords(`${input.name}\n${input.description ?? ''}\n${input.content}`, input.userTags ?? [])
  const tags = TAG_RULES.filter(([, pattern]) => pattern.test(`${input.name}\n${input.description ?? ''}\n${input.content}`)).map(([tag]) => tag)
  const language = detectLanguage(input.content, relatedFiles)
  const framework = detectFramework(input.content)
  const { summary, shortSummary } = buildSummary({
    name: input.name,
    description: input.description,
    content: input.content,
    headings,
  })
  const metadata: ContextPackageMetadata = {
    summary,
    shortSummary,
    autoTags: uniq([...tags, language, framework].filter(Boolean) as string[], 16),
    keywords,
    language,
    framework,
    relatedFiles,
    contentHash: hash(input.content),
    tokenEstimate: estimateTokens(input.content),
    metadataVersion: METADATA_VERSION,
    generatedAt: Date.now(),
  }
  return {
    metadata,
    chunks: splitIntoChunks(input.id ?? 'pending', input.content),
    compressed: makeCompressed(summary, input.content),
  }
}
