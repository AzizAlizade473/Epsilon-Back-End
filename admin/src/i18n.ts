import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import az from './locales/az.json';

const KEY = 'epsilon-admin-lang';
export const LANGS = ['en', 'az'] as const;

function stored(): string {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'az' ? 'az' : 'en';
  } catch {
    return 'en';
  }
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, az: { translation: az } },
  lng: stored(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});
document.documentElement.lang = i18n.language;

export function setLanguage(lng: (typeof LANGS)[number]) {
  document.documentElement.lang = lng;
  try {
    localStorage.setItem(KEY, lng);
  } catch {
    /* not persisted */
  }
  return i18n.changeLanguage(lng);
}

export default i18n;
