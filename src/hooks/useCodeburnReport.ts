import { useState, useEffect, useCallback } from 'react'
import type { CodeburnReport, CodeburnError, CodeburnPeriod } from '../types/codeburn'

type ReportState =
  | { status: 'loading' }
  | { status: 'success'; data: CodeburnReport }
  | { status: 'error'; error: string; available: boolean }
  | { status: 'unavailable' }

export function useCodeburnReport(period: CodeburnPeriod = 'week') {
  const [state, setState] = useState<ReportState>({ status: 'loading' })

  const refresh = useCallback(async () => {
    setState({ status: 'loading' })

    try {
      const availability = await window.electronAPI.analytics.isCodeburnAvailable()
      if (!availability.available) {
        setState({ status: 'unavailable' })
        return
      }

      const result = await window.electronAPI.analytics.getCodeburnReport({ period })

      if (result && typeof result === 'object' && 'error' in result) {
        const err = result as CodeburnError
        setState({ status: 'error', error: err.error, available: err.available })
        return
      }

      setState({ status: 'success', data: result as CodeburnReport })
    } catch (e) {
      setState({ status: 'error', error: String(e), available: true })
    }
  }, [period])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { state, refresh }
}
