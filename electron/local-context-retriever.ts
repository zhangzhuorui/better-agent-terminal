import * as path from 'path'
import type { ContextRecommendation } from '../src/types/platform-extensions'
import { searchCodeContent, searchFilesByName } from './retrieval-engine'

function extractQueryTerms(prompt: string): string[] {
  const fileLike = prompt.match(/[\w@./-]+\.(?:ts|tsx|js|jsx|json|css|scss|md|py|rs|go|java|yml|yaml)/g) ?? []
  const identifiers = prompt.match(/\b[A-Za-z_$][\w$]{2,}\b/g) ?? []
  return [...new Set([...fileLike, ...identifiers])].slice(0, 6)
}

export async function recommendLocalContext(input: {
  prompt: string
  workspacePath?: string
  limit?: number
}): Promise<ContextRecommendation[]> {
  if (!input.workspacePath) return []
  const terms = extractQueryTerms(input.prompt)
  if (!terms.length) return []

  const results: ContextRecommendation[] = []
  for (const term of terms.slice(0, 3)) {
    const files = await searchFilesByName(term, input.workspacePath, 5)
    for (const file of files.slice(0, 3)) {
      results.push({
        packageId: `local-file:${file}`,
        name: path.basename(file),
        score: 0.62,
        reasons: ['file name match'],
        tokenEstimate: 120,
        summary: file,
        workspaceRoot: input.workspacePath,
        source: 'local-file',
      })
    }

    const matches = await searchCodeContent({ query: term, workspacePath: input.workspacePath, maxResults: 5 })
    for (const match of matches.slice(0, 3)) {
      results.push({
        packageId: `local-file:${match.filePath}:${match.lineNumber}`,
        name: `${path.basename(match.filePath)}:${match.lineNumber}`,
        score: 0.58,
        reasons: ['code content match'],
        tokenEstimate: Math.ceil(match.lineText.length / 4) + 30,
        summary: `${match.filePath}:${match.lineNumber} ${match.lineText.trim()}`,
        workspaceRoot: input.workspacePath,
        source: 'local-file',
      })
    }
  }

  const seen = new Set<string>()
  return results
    .filter(item => {
      if (seen.has(item.packageId)) return false
      seen.add(item.packageId)
      return true
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 5)
}
