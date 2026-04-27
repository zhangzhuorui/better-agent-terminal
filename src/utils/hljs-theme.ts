import hljsDarkUrl from 'highlight.js/styles/vs2015.css?url'
import hljsLightUrl from 'highlight.js/styles/github.css?url'

let appliedEffective: 'dark' | 'light' | null = null

/** Swap the global highlight.js stylesheet (PathLinker, FileTree markdown). */
export function syncHljsStylesheet(effective: 'dark' | 'light'): void {
  if (appliedEffective === effective) return
  appliedEffective = effective
  let link = document.getElementById('hljs-dynamic-theme') as HTMLLinkElement | null
  if (!link) {
    link = document.createElement('link')
    link.id = 'hljs-dynamic-theme'
    link.rel = 'stylesheet'
    document.head.appendChild(link)
  }
  link.href = effective === 'light' ? hljsLightUrl : hljsDarkUrl
}
