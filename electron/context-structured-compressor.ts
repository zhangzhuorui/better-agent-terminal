import type { ContextContentType, StructuredCompressionVariant } from '../src/types/platform-extensions'
import * as ts from 'typescript'
import { estimateTokens } from './context-metadata-engine'
import { logger } from './logger'

const JSON_SAMPLE_LIMIT = 10
const RETRIEVE_ID_MIN_LENGTH = 12
const MAX_RETRIEVE_IDS = 200

export function detectContentType(content: string): ContextContentType {
  const trimmed = content.trim()
  if (!trimmed) return 'text'
  if (looksLikeJson(trimmed)) return 'json'
  if (looksLikeMarkdown(trimmed)) return 'markdown'
  if (looksLikeCode(trimmed)) return 'code'
  return 'text'
}

function looksLikeJson(text: string): boolean {
  const first = text[0]
  if (first !== '{' && first !== '[') return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function looksLikeMarkdown(text: string): boolean {
  return /^#{1,6}\s/m.test(text) || /```/m.test(text) || /^\s*[-*]\s/m.test(text)
}

function looksLikeCode(text: string): boolean {
  // Common code signatures: function declarations, imports, type annotations, semicolons, braces
  return /\b(function|const|let|var|class|interface|type|enum|import|export|async|await)\b/.test(text)
    && /[{};]/.test(text)
}

export function buildRetrieveIdMap(content: string): Record<string, string> {
  const map: Record<string, string> = {}
  let id = 0
  const add = (text: string) => {
    if (text.length < RETRIEVE_ID_MIN_LENGTH) return
    if (Object.values(map).includes(text)) return
    if (id >= MAX_RETRIEVE_IDS) return
    id += 1
    map[`@r${id}@`] = text
  }

  // Long identifiers
  const identifierMatches = content.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{11,}\b/g)
  for (const m of identifierMatches) add(m[0])

  // File paths
  const pathMatches = content.matchAll(/[\w/.-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|c|cpp|h|yaml|yml|css)/g)
  for (const m of pathMatches) add(m[0])

  // Repeated long string literals (basic)
  const stringMatches = content.matchAll(/['"`]([^'"`]{20,})['"`]/g)
  const counts = new Map<string, number>()
  for (const m of stringMatches) {
    const s = m[1]
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  for (const [s, c] of counts.entries()) {
    if (c >= 2) add(s)
  }

  return map
}

export function compressWithRetrieveIds(content: string, map: Record<string, string>): string {
  let out = content
  // Sort keys by length descending to avoid partial replacements
  const entries = Object.entries(map).sort((a, b) => b[1].length - a[1].length)
  for (const [id, text] of entries) {
    out = out.split(text).join(id)
  }
  return out
}

export function decompressRetrieveIds(content: string, map: Record<string, string>): string {
  let out = content
  // Sort IDs by length descending so @r10@ is expanded before @r1@
  const entries = Object.entries(map).sort((a, b) => b[0].length - a[0].length)
  for (const [id, text] of entries) {
    out = out.split(id).join(text)
  }
  return out
}

export function compressJson(content: string, _budget?: number): StructuredCompressionVariant {
  const originalTokens = estimateTokens(content)
  try {
    const obj = JSON.parse(content)
    const idMap = new Map<string, string>()
    let nextId = 0

    function assignIds(value: unknown): unknown {
      if (typeof value === 'string' && value.length >= 20) {
        if (!idMap.has(value)) {
          nextId += 1
          idMap.set(value, `@r${nextId}@`)
        }
        return idMap.get(value)
      }
      if (Array.isArray(value)) {
        if (value.length > JSON_SAMPLE_LIMIT * 2) {
          const head = value.slice(0, JSON_SAMPLE_LIMIT).map(assignIds)
          const tail = value.slice(-JSON_SAMPLE_LIMIT).map(assignIds)
          return [...head, `/* ... ${value.length - JSON_SAMPLE_LIMIT * 2} items omitted ... */`, ...tail]
        }
        return value.map(assignIds)
      }
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out[k] = assignIds(v)
        }
        return out
      }
      return value
    }

    const compressed = assignIds(obj)
    const body = JSON.stringify(compressed, null, 1)
    const retrieveIdMap: Record<string, string> = {}
    for (const [text, id] of idMap.entries()) retrieveIdMap[id] = text

    return {
      mode: 'json',
      summary: `JSON with ${Object.keys(obj).length} top-level keys`,
      body,
      tokenEstimate: estimateTokens(body),
      originalTokens,
      retrieveIdMap,
    }
  } catch (error) {
    logger.error('[structured-compressor] JSON compression failed:', error instanceof Error ? error.message : String(error))
    return makeFallback('json', content, originalTokens)
  }
}

export function compressTypeScript(
  content: string,
  queryTerms: string[] = [],
  _budget?: number
): StructuredCompressionVariant {
  const originalTokens = estimateTokens(content)
  try {
    const source = ts.createSourceFile('tmp.ts', content, ts.ScriptTarget.Latest, true)
    const querySet = new Set(queryTerms.map(t => t.toLowerCase()))
    const replacements: { start: number; end: number; text: string }[] = []

    function isInsideReplacement(node: ts.Node): boolean {
      const start = node.getStart(source)
      const end = node.getEnd()
      return replacements.some(r => r.start <= start && r.end >= end)
    }

    function isExported(node: ts.Node): boolean {
      if (!('modifiers' in node) || !Array.isArray(node.modifiers)) return false
      return node.modifiers.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword)
    }

    function getName(node: ts.Node): string | undefined {
      if (ts.isFunctionDeclaration(node) && node.name) return node.name.text
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text
      if (ts.isArrowFunction(node)) return undefined
      if (ts.isClassDeclaration(node) && node.name) return node.name.text
      if (ts.isInterfaceDeclaration(node) && node.name) return node.name.text
      if (ts.isTypeAliasDeclaration(node) && node.name) return node.name.text
      return undefined
    }

    function shouldKeepBody(node: ts.Node, name?: string): boolean {
      if (name && querySet.has(name.toLowerCase())) return true
      if (isExported(node)) return true
      return false
    }

    function visit(node: ts.Node) {
      if (isInsideReplacement(node)) return
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)
      ) {
        const name = getName(node)
        if (!shouldKeepBody(node, name)) {
          const start = node.getStart(source)
          const end = node.getEnd()
          const params = node.parameters.map(p => p.getText(source)).join(', ')
          const asyncText = node.modifiers?.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''
          const returnType = node.type ? `: ${node.type.getText(source)}` : ''
          const replacementName = name ? `${asyncText}function ${name}` : `${asyncText}function`
          replacements.push({
            start,
            end,
            text: `${replacementName}(${params})${returnType} { /* body omitted: ~${Math.max(1, Math.round((end - start) / 4))} tokens */ }`,
          })
          return
        }
      }
      ts.forEachChild(node, visit)
    }

    visit(source)

    if (replacements.length === 0) {
      return makeFallback('code', content, originalTokens)
    }

    // Apply replacements from end to start
    replacements.sort((a, b) => b.start - a.start)
    let body = content
    for (const r of replacements) {
      body = body.slice(0, r.start) + r.text + body.slice(r.end)
    }

    return {
      mode: 'code',
      summary: `Code with ${replacements.length} function bodies elided`,
      body,
      tokenEstimate: estimateTokens(body),
      originalTokens,
      queryTerms,
    }
  } catch (error) {
    logger.error('[structured-compressor] TypeScript compression failed:', error instanceof Error ? error.message : String(error))
    return makeFallback('code', content, originalTokens)
  }
}

export function compressMarkdown(content: string, queryTerms: string[] = [], _budget?: number): StructuredCompressionVariant {
  const originalTokens = estimateTokens(content)
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  const querySet = new Set(queryTerms.map(t => t.toLowerCase()))

  let inCodeBlock = false
  let currentParagraph: string[] = []
  const flushParagraph = () => {
    if (currentParagraph.length === 0) return
    const para = currentParagraph.join(' ')
    const sentences = para.match(/[^.!?]+[.!?]+/g) ?? [para]
    const ranked = sentences
      .map(s => ({
        text: s.trim(),
        score: querySet.size ? [...querySet].reduce((sum, t) => sum + (s.toLowerCase().includes(t) ? 1 : 0), 0) : 0,
      }))
      .sort((a, b) => b.score - a.score)
    const kept = ranked.slice(0, 2).map(r => r.text)
    out.push(kept.join(' ') + (ranked.length > 2 ? ' [...]' : ''))
    currentParagraph = []
  }

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushParagraph()
      inCodeBlock = !inCodeBlock
      out.push(line)
      continue
    }
    if (inCodeBlock) {
      out.push(line)
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      flushParagraph()
      out.push(line)
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      continue
    }
    currentParagraph.push(line)
  }
  flushParagraph()

  const body = out.join('\n')
  return {
    mode: 'markdown',
    summary: `Markdown with headings and code blocks preserved`,
    body,
    tokenEstimate: estimateTokens(body),
    originalTokens,
    queryTerms,
  }
}

function makeFallback(mode: ContextContentType, content: string, originalTokens: number): StructuredCompressionVariant {
  return {
    mode,
    summary: 'Structured compression unavailable; using original content',
    body: content,
    tokenEstimate: originalTokens,
    originalTokens,
  }
}

export interface StructuredCompressOptions {
  contentType?: ContextContentType
  queryTerms?: string[]
  budget?: number
  retrieveIdEnabled?: boolean
}

export function compressStructured(
  content: string,
  options: StructuredCompressOptions = {}
): StructuredCompressionVariant {
  const contentType = options.contentType ?? detectContentType(content)
  let variant: StructuredCompressionVariant

  switch (contentType) {
    case 'json':
      variant = compressJson(content, options.budget)
      break
    case 'code':
      variant = compressTypeScript(content, options.queryTerms, options.budget)
      break
    case 'markdown':
      variant = compressMarkdown(content, options.queryTerms, options.budget)
      break
    default:
      variant = makeFallback('text', content, estimateTokens(content))
  }

  if (options.retrieveIdEnabled && variant.mode !== 'json') {
    const map = buildRetrieveIdMap(variant.body)
    if (Object.keys(map).length > 0) {
      const compressedBody = compressWithRetrieveIds(variant.body, map)
      variant = {
        ...variant,
        body: compressedBody,
        tokenEstimate: estimateTokens(compressedBody),
        retrieveIdMap: { ...(variant.retrieveIdMap ?? {}), ...map },
      }
    }
  }

  return variant
}
