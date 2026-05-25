import type { ContextPackage, ContextRecommendation, ResolvedContextBlock, ResolvedContextSource } from '../src/types/platform-extensions'
import { estimateTokens } from './context-metadata-engine'

function sourceFor(pkgId: string, explicitPackageIds: string[], recommendations: ContextRecommendation[]): ResolvedContextSource {
  if (explicitPackageIds.includes(pkgId)) return 'explicit'
  if (recommendations.some(r => r.packageId === pkgId)) return 'auto'
  return 'rule'
}

function recommendationFor(pkgId: string, recommendations: ContextRecommendation[]): ContextRecommendation | undefined {
  return recommendations.find(r => r.packageId === pkgId)
}

function relevantChunks(pkg: ContextPackage, query: string, maxChunks: number): string {
  const tokens = query.toLowerCase().split(/[^a-z0-9_./-]+/).filter(t => t.length >= 2)
  const chunks = (pkg.chunks ?? [])
    .map(chunk => ({
      chunk,
      score: tokens.reduce((sum, token) => sum + (chunk.content.toLowerCase().includes(token) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks)
  return chunks.length ? chunks.map(c => c.chunk.content).join('\n\n---\n\n') : pkg.content.slice(0, 4000)
}

export function compressContextBlocks(input: {
  packages: ContextPackage[]
  query: string
  explicitPackageIds: string[]
  tokenBudget: number
  recommendations: ContextRecommendation[]
}): ResolvedContextBlock[] {
  const seenIds = new Set<string>()
  const seenHashes = new Set<string>()
  const ordered = input.packages.filter(pkg => {
    if (seenIds.has(pkg.id)) return false
    seenIds.add(pkg.id)
    const hash = pkg.metadata?.contentHash
    if (hash && seenHashes.has(hash)) return false
    if (hash) seenHashes.add(hash)
    return true
  })

  const totalTokens = ordered.reduce((sum, pkg) => sum + (pkg.metadata?.tokenEstimate ?? estimateTokens(pkg.content)), 0)
  let remaining = input.tokenBudget
  const blocks: ResolvedContextBlock[] = []

  for (const pkg of ordered) {
    const source = sourceFor(pkg.id, input.explicitPackageIds, input.recommendations)
    const rec = recommendationFor(pkg.id, input.recommendations)
    const fullTokens = pkg.metadata?.tokenEstimate ?? estimateTokens(pkg.content)
    let content = pkg.content
    let compression: ResolvedContextBlock['compression'] = 'none'

    if (totalTokens > input.tokenBudget) {
      if (source === 'explicit' && remaining > Math.min(fullTokens, input.tokenBudget * 0.45)) {
        content = fullTokens > remaining ? relevantChunks(pkg, input.query, 3) : pkg.content
        compression = content === pkg.content ? 'none' : 'extractive'
      } else if (source === 'rule') {
        content = pkg.compressed?.medium ?? relevantChunks(pkg, input.query, 2)
        compression = 'extractive'
      } else {
        content = pkg.compressed?.brief ?? relevantChunks(pkg, input.query, 1)
        compression = 'summary'
      }
    } else if (source === 'auto') {
      content = pkg.compressed?.medium ?? pkg.metadata?.summary ?? pkg.content
      compression = content === pkg.content ? 'none' : 'summary'
    }

    let tokenEstimate = estimateTokens(content)
    if (tokenEstimate > remaining && source !== 'explicit') {
      content = pkg.compressed?.brief ?? content.slice(0, Math.max(600, remaining * 4))
      compression = 'summary'
      tokenEstimate = estimateTokens(content)
    }
    if (remaining <= 0 && source === 'auto') continue
    remaining -= tokenEstimate

    blocks.push({
      id: `${pkg.id}:${source}`,
      packageId: pkg.id,
      title: pkg.name,
      source,
      content,
      summary: pkg.metadata?.shortSummary ?? pkg.metadata?.summary,
      tags: [...(pkg.tags ?? []), ...(pkg.metadata?.autoTags ?? [])],
      compression,
      score: rec?.score,
      tokenEstimate,
      contentHash: pkg.metadata?.contentHash,
    })
  }
  return blocks
}
