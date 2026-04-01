import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import fr from './locales/fr.json';
import en from './locales/en.json';

export const SUPPORTED_LANGUAGES = [
  { code: 'fr', label: 'Fran\u00e7ais', flagUrl: 'https://flagcdn.com/w40/fr.png' },
  { code: 'en', label: 'English', flagUrl: 'https://flagcdn.com/w40/gb.png' },
  { code: 'es', label: 'Espa\u00f1ol', flagUrl: 'https://flagcdn.com/w40/es.png' },
  { code: 'de', label: 'Deutsch', flagUrl: 'https://flagcdn.com/w40/de.png' },
  { code: 'it', label: 'Italiano', flagUrl: 'https://flagcdn.com/w40/it.png' },
  { code: 'pt', label: 'Portugu\u00eas', flagUrl: 'https://flagcdn.com/w40/pt.png' },
  { code: 'nl', label: 'Nederlands', flagUrl: 'https://flagcdn.com/w40/nl.png' },
  { code: 'ru', label: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439', flagUrl: 'https://flagcdn.com/w40/ru.png' },
  { code: 'ja', label: '\u65e5\u672c\u8a9e', flagUrl: 'https://flagcdn.com/w40/jp.png' },
  { code: 'ko', label: '\ud55c\uad6d\uc5b4', flagUrl: 'https://flagcdn.com/w40/kr.png' },
  { code: 'zh', label: '\u4e2d\u6587', flagUrl: 'https://flagcdn.com/w40/cn.png' },
  { code: 'ar', label: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629', flagUrl: 'https://flagcdn.com/w40/sa.png' },
  { code: 'tr', label: 'T\u00fcrk\u00e7e', flagUrl: 'https://flagcdn.com/w40/tr.png' },
  { code: 'pl', label: 'Polski', flagUrl: 'https://flagcdn.com/w40/pl.png' },
] as const;

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number]['code'];

// Languages that actually have translation files loaded
const LOADED_LANG_CODES = new Set(['fr', 'en']);
export const AVAILABLE_LANGUAGES = SUPPORTED_LANGUAGES.filter(l => LOADED_LANG_CODES.has(l.code));

const ALL_LANG_CODES = SUPPORTED_LANGUAGES.map(l => l.code) as unknown as string[];

// Map i18n language codes to TMDB API language codes
const TMDB_LANGUAGE_MAP: Record<string, string> = {
  fr: 'fr-FR',
  en: 'en-US',
  es: 'es-ES',
  de: 'de-DE',
  it: 'it-IT',
  pt: 'pt-PT',
  nl: 'nl-NL',
  ru: 'ru-RU',
  ja: 'ja-JP',
  ko: 'ko-KR',
  zh: 'zh-CN',
  ar: 'ar-SA',
  tr: 'tr-TR',
  pl: 'pl-PL',
};

/** Returns the current TMDB language code (e.g. 'fr-FR') based on the active i18n language */
export const getTmdbLanguage = (): string => {
  return TMDB_LANGUAGE_MAP[i18n.language] || 'fr-FR';
};

// Retrieve stored language from localStorage (set by user in settings or loaded from server)
const getStoredLanguage = (): string | null => {
  try {
    return localStorage.getItem('user_language');
  } catch {
    return null;
  }
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      fr: { translation: fr },
      en: { translation: en },
    },
    lng: getStoredLanguage() || undefined, // Use stored language if available
    fallbackLng: 'en',
    supportedLngs: ALL_LANG_CODES,
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'user_language',
      caches: ['localStorage'],
    },
  });

// Helper to change language and persist locally
export const changeLanguage = async (lang: SupportedLanguage): Promise<void> => {
  await i18n.changeLanguage(lang);
  try {
    localStorage.setItem('user_language', lang);
  } catch {
    // Ignore storage errors
  }
};

/** Maps country codes to the most commonly spoken language supported by the app */
const COUNTRY_TO_LANG: Record<string, string> = {
  FR: 'fr', BE: 'fr', CH: 'fr', LU: 'fr', MC: 'fr', // French
  GB: 'en', US: 'en', CA: 'en', AU: 'en', NZ: 'en', IE: 'en', // English
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es', VE: 'es', // Spanish
  DE: 'de', AT: 'de', // German
  IT: 'it', // Italian
  PT: 'pt', BR: 'pt', // Portuguese
  NL: 'nl', // Dutch
  RU: 'ru', BY: 'ru', KZ: 'ru', // Russian
  JP: 'ja', // Japanese
  KR: 'ko', // Korean
  CN: 'zh', TW: 'zh', HK: 'zh', SG: 'zh', // Chinese
  SA: 'ar', AE: 'ar', EG: 'ar', MA: 'ar', DZ: 'ar', TN: 'ar', IQ: 'ar', JO: 'ar', LB: 'ar', LY: 'ar', // Arabic
  TR: 'tr', // Turkish
  PL: 'pl', // Polish
};

/**
 * Detects the best language for a first-time visitor.
 * Priority: 1) browser language if supported  2) IP geolocation  3) English fallback.
 * Only runs when no language has been stored yet (i.e., first visit).
 */
export const detectInitialLanguage = async (): Promise<void> => {
  if (localStorage.getItem('user_language')) return; // Already set by user or previous session

  // 1. Try browser language
  const rawBrowserLang = navigator.language || navigator.languages?.[0] || '';
  const browserLang = rawBrowserLang.split('-')[0].toLowerCase();
  if (browserLang && ALL_LANG_CODES.includes(browserLang)) {
    await i18n.changeLanguage(browserLang);
    localStorage.setItem('user_language', browserLang);
    return;
  }

  // 2. Try IP geolocation (free service, no key required)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('https://ipapi.co/json/', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      const countryLang = COUNTRY_TO_LANG[data.country_code as string];
      if (countryLang && ALL_LANG_CODES.includes(countryLang)) {
        await i18n.changeLanguage(countryLang);
        localStorage.setItem('user_language', countryLang);
        return;
      }
    }
  } catch {
    // IP detection failed -- fall through to English
  }

  // 3. Fallback to English
  await i18n.changeLanguage('en');
  localStorage.setItem('user_language', 'en');
};

export default i18n;
