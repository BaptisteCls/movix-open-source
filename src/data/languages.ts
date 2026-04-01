export interface LanguageOption {
    value: string;
    label: string;
}

const LANGUAGE_CODES: string[] = [
    'af', 'sq', 'am', 'ar', 'hy', 'as', 'az', 'eu', 'be', 'bn',
    'bs', 'bg', 'my', 'ca', 'zh', 'cn', 'hr', 'cs', 'da', 'nl',
    'dz', 'en', 'et', 'fi', 'fr', 'gl', 'ka', 'de', 'el', 'gu',
    'he', 'hi', 'hu', 'is', 'id', 'it', 'ja', 'kn', 'kk', 'km',
    'ko', 'ku', 'ky', 'lo', 'lv', 'lt', 'lb', 'mk', 'ms', 'ml',
    'mt', 'mi', 'mr', 'mn', 'ne', 'no', 'fa', 'pl', 'pt', 'pa',
    'ro', 'ru', 'sr', 'si', 'sk', 'sl', 'es', 'sw', 'sv', 'ta',
    'te', 'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'cy', 'zu',
];

/**
 * Returns a localized list of language options sorted by label.
 * @param locale - BCP 47 locale tag (e.g. 'en', 'fr', 'de')
 */
export function getLanguages(locale: string): LanguageOption[] {
    let names: Intl.DisplayNames | undefined;
    try {
        names = new Intl.DisplayNames([locale, 'en'], { type: 'language' });
    } catch {
        names = new Intl.DisplayNames(['en'], { type: 'language' });
    }
    return LANGUAGE_CODES.map(code => ({
        value: code,
        label: names!.of(code) || code,
    })).sort((a, b) => a.label.localeCompare(b.label, locale));
}

/** @deprecated Use getLanguages(locale) for localized labels */
export const languages: LanguageOption[] = getLanguages('fr');


