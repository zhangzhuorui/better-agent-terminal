import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import zhTW from './locales/zh-TW.json'
import zhCN from './locales/zh-CN.json'

/** Browser default before settings.json is applied */
export function detectBrowserLanguage(): 'en' | 'zh-TW' | 'zh-CN' {
  if (typeof navigator === 'undefined') return 'en'
  const n = navigator.language.toLowerCase()
  if (n === 'zh-tw' || n === 'zh-hk' || n === 'zh-mo') return 'zh-TW'
  if (n.startsWith('zh')) return 'zh-CN'
  return 'en'
}

i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-TW': { translation: zhTW },
    'zh-CN': { translation: zhCN },
  },
  lng: detectBrowserLanguage(),
  fallbackLng: ['en', 'zh-CN'],
  interpolation: {
    escapeValue: false, // React already escapes
  },
})

export default i18next
