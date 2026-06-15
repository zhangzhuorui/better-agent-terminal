import { useMemo, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContextInjectionPlan, ContextPackage, ContextRecommendation } from '../types/platform-extensions'

interface ContextDockProps {
  anchorRef: RefObject<HTMLDivElement | null>
  packages: ContextPackage[]
  attachedPackageIds: string[]
  recommendations: ContextRecommendation[]
  lastPlan: ContextInjectionPlan | null
  tokenBudget: number
  isStreaming: boolean
  pickerOpen: boolean
  pickMode: boolean
  searchOpen: boolean
  onOpenPicker: () => void
  onRefresh: () => void
  onTogglePickMode: () => void
  onToggleSearch: () => void
  onAddRecommendation: (id: string) => void
  onRemovePackage: (id: string) => void
}

function formatTokens(tokens?: number): string {
  if (!tokens) return '0'
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`
  return String(tokens)
}

export function ContextDock({
  anchorRef,
  packages,
  attachedPackageIds,
  recommendations,
  lastPlan,
  tokenBudget,
  isStreaming,
  pickerOpen,
  pickMode,
  searchOpen,
  onOpenPicker,
  onRefresh,
  onTogglePickMode,
  onToggleSearch,
  onAddRecommendation,
  onRemovePackage,
}: Readonly<ContextDockProps>) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const attachedPackages = useMemo(() => {
    const byId = new Map(packages.map(pkg => [pkg.id, pkg]))
    return attachedPackageIds.map(id => ({ id, pkg: byId.get(id) }))
  }, [attachedPackageIds, packages])

  const attachableRecommendations = recommendations.filter(rec => rec.source !== 'local-file')
  const planTokens = lastPlan?.estimatedTokens ?? attachedPackages.reduce((sum, item) => sum + (item.pkg?.metadata?.tokenEstimate ?? 0), 0)
  const budget = lastPlan?.tokenBudget ?? tokenBudget
  const budgetPercent = budget > 0 ? Math.min(100, Math.round((planTokens / budget) * 100)) : 0
  const hasContextActivity = attachedPackageIds.length > 0 || attachableRecommendations.length > 0 || Boolean(lastPlan)
  const summaryText = hasContextActivity
    ? t('claude.contextDockSummary', {
      attached: attachedPackageIds.length,
      recommended: attachableRecommendations.length,
      tokens: formatTokens(planTokens),
    })
    : t('claude.contextNoAttachedCompact')

  return (
    <div className={`claude-context-dock${expanded ? ' expanded' : ''}`} ref={anchorRef}>
      <div className="claude-context-dock-main">
        <button
          type="button"
          className="claude-context-dock-summary"
          onClick={() => setExpanded(x => !x)}
          aria-expanded={expanded}
          title={t('claude.contextPackagesHint')}
        >
          <span className="claude-context-dock-icon" aria-hidden="true">CTX</span>
          <span className="claude-context-dock-title">{t('claude.contextDockTitle')}</span>
          <span className="claude-context-dock-meta">{summaryText}</span>
          <span className="claude-context-dock-chevron">{expanded ? '▾' : '▸'}</span>
        </button>

        <div className="claude-context-dock-actions">
          <button
            type="button"
            className={`claude-context-dock-action${pickerOpen ? ' active' : ''}`}
            onClick={onOpenPicker}
          >
            {t('claude.contextPackagesBrowse')}
          </button>
          <button
            type="button"
            className={`claude-context-dock-action${pickMode ? ' active' : ''}`}
            title={pickMode ? t('claude.contextPickModeActive') : t('claude.contextPickMode')}
            aria-pressed={pickMode}
            onClick={onTogglePickMode}
          >
            {pickMode ? t('claude.contextPickModeActive') : t('claude.contextPickMode')}
          </button>
          <button
            type="button"
            className={`claude-context-dock-action${searchOpen ? ' active' : ''}`}
            title={t('contentSearch.placeholder')}
            aria-pressed={searchOpen}
            onClick={onToggleSearch}
          >
            {t('contentSearch.messages')}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="claude-context-dock-panel">
          <div className="claude-context-dock-section">
            <div className="claude-context-dock-section-head">
              <span>{t('claude.contextPackages')}</span>
              <button type="button" className="claude-context-dock-link" onClick={onRefresh}>
                {t('claude.contextPackagesRefresh')}
              </button>
            </div>
            <div className="claude-context-dock-chips">
              {attachedPackages.length === 0 ? (
                <span className="claude-context-dock-empty">{t('claude.contextPackagesNoneAttached')}</span>
              ) : (
                attachedPackages.map(({ id, pkg }) => (
                  <span
                    key={id}
                    className={`claude-context-dock-chip${pkg ? '' : ' missing'}`}
                    title={pkg?.metadata?.shortSummary || pkg?.description || pkg?.name || id}
                  >
                    <span className="claude-context-dock-chip-name">{pkg?.name ?? `${id.slice(0, 8)}…`}</span>
                    {pkg?.metadata?.tokenEstimate && (
                      <span className="claude-context-dock-chip-tokens">{formatTokens(pkg.metadata.tokenEstimate)}</span>
                    )}
                    <button
                      type="button"
                      className="claude-context-dock-chip-remove"
                      aria-label={t('common.close')}
                      onClick={() => onRemovePackage(id)}
                    >
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>
          </div>

          <div className="claude-context-dock-grid">
            <div className="claude-context-dock-section">
              <div className="claude-context-dock-section-head">
                <span>{t('claude.contextRecommendations')}</span>
                <span className="claude-context-dock-count">{attachableRecommendations.length}</span>
              </div>
              <div className="claude-context-dock-recs">
                {attachableRecommendations.length === 0 || isStreaming ? (
                  <span className="claude-context-dock-empty">{t('claude.contextNoRecommendations')}</span>
                ) : (
                  attachableRecommendations.slice(0, 4).map(rec => (
                    <button
                      key={rec.packageId}
                      type="button"
                      className="claude-context-dock-rec"
                      title={`${rec.reasons.join(', ')} · ${rec.tokenEstimate ?? 0} tokens`}
                      onClick={() => onAddRecommendation(rec.packageId)}
                    >
                      <span className="claude-context-dock-rec-main">
                        <span className="claude-context-dock-rec-name">{rec.name}</span>
                        <span className="claude-context-dock-rec-reason">{rec.reasons[0]}</span>
                      </span>
                      <span className="claude-context-dock-rec-score">{Math.round(rec.score * 100)}%</span>
                      <span className="claude-context-dock-rec-add">{t('claude.contextRecommendationAdd')}</span>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="claude-context-dock-section">
              <div className="claude-context-dock-section-head">
                <span>{t('claude.contextDockPlan')}</span>
                <span className="claude-context-dock-count">{lastPlan?.mode ?? 'recommend'}</span>
              </div>
              <div className="claude-context-dock-budget">
                <div className="claude-context-dock-budget-row">
                  <span>{t('claude.contextDockBudget')}</span>
                  <span>{formatTokens(planTokens)} / {formatTokens(budget)}</span>
                </div>
                <div className="claude-context-dock-budget-track">
                  <span style={{ width: `${budgetPercent}%` }} />
                </div>
                <div className="claude-context-dock-plan-stats">
                  <span>{t('claude.contextManual')}: {lastPlan?.explicitPackageIds.length ?? attachedPackageIds.length}</span>
                  <span>{t('claude.contextRule')}: {lastPlan?.rulePackageIds.length ?? 0}</span>
                  <span>{t('claude.contextAuto')}: {lastPlan?.recommendedPackageIds.length ?? 0}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
