/**
 * Syncs persisted `AppSettings.theme` to the document for CSS `[data-theme="…"]` and native form controls.
 */
export function applyAppTheme(theme: 'dark' | 'light'): void {
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
}
