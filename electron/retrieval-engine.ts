import { spawn } from 'child_process'
import * as path from 'path'
import { logger } from './logger'

export interface CodeSearchResult {
  filePath: string
  lineNumber: number
  column?: number
  lineText: string
  matchRange?: { start: number; end: number }
}

export interface CodeSearchOptions {
  query: string
  workspacePath?: string
  glob?: string
  caseSensitive?: boolean
  maxResults?: number
}

function findRipgrep(): string | null {
  // Try common locations
  const candidates = [
    'rg',
    '/usr/local/bin/rg',
    '/opt/homebrew/bin/rg',
    '/usr/bin/rg',
  ]
  // On Windows
  if (process.platform === 'win32') {
    candidates.push('rg.exe')
  }
  // Return first that exists (simplified; could use `which`)
  return candidates[0]
}

export async function searchCodeContent(options: CodeSearchOptions): Promise<CodeSearchResult[]> {
  const rg = findRipgrep()
  if (!rg) {
    logger.log('[retrieval-engine] ripgrep not found, falling back to basic search')
    return []
  }

  const args = [
    '--json',
    '--max-count', String(options.maxResults ?? 50),
    '--max-columns', '300',
    '-C', '2', // 2 lines of context
  ]

  if (!options.caseSensitive) args.push('-i')
  if (options.glob) {
    args.push('-g', options.glob)
  }
  args.push(options.query)

  if (options.workspacePath) {
    args.push(options.workspacePath)
  } else {
    args.push('.')
  }

  return new Promise((resolve) => {
    const results: CodeSearchResult[] = []
    const child = spawn(rg, args, {
      cwd: options.workspacePath || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })

    child.on('close', () => {
      for (const line of stdout.split('\n').filter(Boolean)) {
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'match') {
            const data = parsed.data
            for (const sub of data.submatches || []) {
              results.push({
                filePath: path.normalize(data.path.text),
                lineNumber: data.line_number,
                column: sub.start,
                lineText: data.lines.text.replace(/\n$/, ''),
                matchRange: { start: sub.start, end: sub.end },
              })
            }
          }
        } catch { /* skip non-JSON lines */ }
      }
      resolve(results.slice(0, options.maxResults ?? 50))
    })

    child.on('error', () => {
      resolve([])
    })

    // Timeout after 10s
    setTimeout(() => {
      try { child.kill() } catch { /* noop */ }
      resolve(results)
    }, 10000)
  })
}

export async function searchFilesByName(query: string, workspacePath?: string, maxResults = 50): Promise<string[]> {
  const rg = findRipgrep()
  if (!rg) return []

  const args = [
    '--files',
    '--max-count', String(maxResults),
  ]

  return new Promise((resolve) => {
    const child = spawn(rg, args, {
      cwd: workspacePath || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })

    child.on('close', () => {
      const q = query.toLowerCase()
      const files = stdout.split('\n')
        .filter(Boolean)
        .filter(f => f.toLowerCase().includes(q))
        .slice(0, maxResults)
      resolve(files)
    })

    child.on('error', () => resolve([]))
    setTimeout(() => { try { child.kill() } catch { } resolve([]) }, 10000)
  })
}

export function extractSymbolsFromLine(lineText: string, language?: string): { type: 'function' | 'class' | 'interface' | 'variable' | 'unknown'; name: string } | null {
  // Lightweight regex-based symbol extraction
  const patterns: { regex: RegExp; type: 'function' | 'class' | 'interface' | 'variable' }[] = [
    { regex: /(?:function|def|fn)\s+(\w+)/, type: 'function' },
    { regex: /(?:class|struct)\s+(\w+)/, type: 'class' },
    { regex: /interface\s+(\w+)/, type: 'interface' },
    { regex: /(?:const|let|var)\s+(\w+)\s*[=:]/, type: 'variable' },
    { regex: /(\w+)\s*[:\(].*=>?\s*\{/, type: 'function' }, // arrow functions / methods
  ]

  for (const p of patterns) {
    const m = lineText.match(p.regex)
    if (m) {
      return { type: p.type, name: m[1] }
    }
  }

  return null
}
