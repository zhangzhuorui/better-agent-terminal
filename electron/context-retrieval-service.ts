import type { AgentPresetId } from '../src/types/agent-presets'
import type { ContextInjectionPlan, ContextRecommendation, ContextRetrievalOptions } from '../src/types/platform-extensions'
import type { ContextModuleSettings } from '../src/types'
import { getCache, makeStableCacheKey, setCache } from './context-cache'
import { getOrBuildContextPackageIndex } from './context-package-index'
import { recommendLocalContext } from './local-context-retriever'
import { classifyIntent, scoreByIntent } from './intent-classifier'
import { getUserPreferences, refreshCache } from './user-preference-learn'

function normalizeQuery(text: string): string[] {
  const tokens = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_./-]+|_/)
    .map(t => t.trim())
    .filter(t => t.length >= 2)
  return [...new Set(tokens)]
}

function workspaceMatches(pkgWorkspace: string | undefined, workspacePath: string | undefined): 'same' | 'global' | 'other' {
  if (!pkgWorkspace) return 'global'
  if (!workspacePath) return 'other'
  return pkgWorkspace === workspacePath || workspacePath.startsWith(pkgWorkspace) || pkgWorkspace.startsWith(workspacePath) ? 'same' : 'other'
}

function countMatches(tokens: string[], text: string): number {
  const lower = text.toLowerCase()
  return tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0)
}

export async function recommendContextPackages(options: ContextRetrievalOptions): Promise<{ recommendations: ContextRecommendation[]; cacheHit: boolean }> {
  const prompt = options.prompt.trim()
  if (!prompt) return { recommendations: [], cacheHit: false }
  const cacheKey = `recommend:${makeStableCacheKey(options)}`
  const cached = getCache<ContextRecommendation[]>(cacheKey)
  if (cached) return { recommendations: cached, cacheHit: true }

  const tokens = normalizeQuery(prompt)
  const intent = classifyIntent(prompt)
  await refreshCache()
  const excluded = new Set(options.excludePackageIds ?? [])
  const index = await getOrBuildContextPackageIndex()
  const packageRecommendations = index
    .filter(entry => !excluded.has(entry.packageId))
    .map(entry => {
      const name = entry.searchableText.split('\n')[0] || entry.packageId
      const metadata = entry.metadata
      const userText = `${metadata?.summary ?? ''}\n${metadata?.shortSummary ?? ''}`
      let score = 0
      const reasons: string[] = []
      const nameMatches = countMatches(tokens, name)
      if (nameMatches) {
        score += Math.min(0.35, nameMatches * 0.12)
        reasons.push('name match')
      }
      const tagText = `${metadata?.autoTags?.join(' ') ?? ''} ${metadata?.keywords?.join(' ') ?? ''}`
      const tagMatches = countMatches(tokens, tagText)
      if (tagMatches) {
        score += Math.min(0.28, tagMatches * 0.07)
        reasons.push('tag/keyword match')
      }
      const summaryMatches = countMatches(tokens, userText)
      if (summaryMatches) {
        score += Math.min(0.22, summaryMatches * 0.06)
        reasons.push('summary match')
      }
      let contentScore = 0
      for (const token of tokens) contentScore += Math.min(4, entry.termFreq[token] ?? 0)
      if (contentScore) {
        score += Math.min(0.3, contentScore * 0.025)
        reasons.push('content match')
      }
      const workspace = workspaceMatches(entry.workspaceRoot, options.workspacePath)
      if (workspace === 'same') {
        score += 0.14
        reasons.push('current workspace')
      } else if (workspace === 'global') {
        score += 0.04
        reasons.push('global package')
      } else {
        score -= 0.08
      }
      const ageDays = Math.max(0, (Date.now() - entry.updatedAt) / 86400000)
      score += Math.max(0, 0.04 - ageDays * 0.002)
      const intentBoost = scoreByIntent(intent, metadata)
      if (intentBoost.boost > 0) {
        score += intentBoost.boost
        reasons.push(...intentBoost.reasons)
      }
      const pref = getUserPreferences(entry.packageId, intent)
      if (pref.boost > 0) {
        score += pref.boost
        if (pref.reason) reasons.push(pref.reason)
      }
      return {
        packageId: entry.packageId,
        name,
        score: Math.max(0, Math.min(1, Number(score.toFixed(3)))),
        reasons: reasons.length ? reasons : ['weak semantic match'],
        tokenEstimate: entry.tokens,
        summary: metadata?.shortSummary ?? metadata?.summary,
        tags: [...(metadata?.autoTags ?? []), ...(metadata?.keywords?.slice(0, 4) ?? [])],
        workspaceRoot: entry.workspaceRoot,
        source: 'context-package' as const,
      }
    })
    .filter(rec => rec.score >= (options.minScore ?? 0.12))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 8)

  const localRecommendations = options.includeLocalFiles
    ? await recommendLocalContext({ prompt, workspacePath: options.workspacePath, limit: 5 })
    : []
  const recommendations = [...packageRecommendations, ...localRecommendations]
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 8)

  setCache(cacheKey, recommendations)
  return { recommendations, cacheHit: false }
}

export async function buildContextInjectionPlan(input: {
  prompt: string
  workspacePath?: string
  agentPreset?: AgentPresetId
  explicitPackageIds: string[]
  rulePackageIds?: string[]
  settings: ContextModuleSettings
}): Promise<ContextInjectionPlan> {
  const mode = input.settings.autoRetrievalMode
  const rulePackageIds = [...new Set(input.rulePackageIds ?? [])]
  const explicitPackageIds = [...new Set(input.explicitPackageIds)]
  const cacheKey = `plan:${makeStableCacheKey({ ...input, explicitPackageIds, rulePackageIds })}`
  const cached = input.settings.cacheEnabled ? getCache<ContextInjectionPlan>(cacheKey) : undefined
  if (cached) return { ...cached, cacheHit: true }

  const { recommendations, cacheHit } = await recommendContextPackages({
    prompt: input.prompt,
    workspacePath: input.workspacePath,
    agentPreset: input.agentPreset,
    excludePackageIds: [...explicitPackageIds, ...rulePackageIds],
    limit: input.settings.autoInjectMaxPackages,
    minScore: mode === 'inject' ? input.settings.autoInjectMinScore : 0.12,
    includeLocalFiles: input.settings.includeLocalFiles,
  })
  const recommendedPackageIds = mode === 'inject'
    ? recommendations.filter(r => r.source !== 'local-file' && r.score >= input.settings.autoInjectMinScore).slice(0, input.settings.autoInjectMaxPackages).map(r => r.packageId)
    : []
  const finalPackageIds = mode === 'off'
    ? [...new Set([...explicitPackageIds, ...rulePackageIds])]
    : [...new Set([...explicitPackageIds, ...rulePackageIds, ...recommendedPackageIds])]
  const estimatedTokens = recommendations
    .filter(r => finalPackageIds.includes(r.packageId))
    .reduce((sum, r) => sum + (r.tokenEstimate ?? 0), 0)
  const plan: ContextInjectionPlan = {
    mode,
    explicitPackageIds,
    rulePackageIds,
    recommendedPackageIds,
    finalPackageIds,
    recommendations,
    tokenBudget: input.settings.contextTokenBudget,
    estimatedTokens,
    cacheHit,
    compressed: false,
  }
  if (input.settings.cacheEnabled) setCache(cacheKey, plan)
  return plan
}
