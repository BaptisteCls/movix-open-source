export interface CountryOption {
    value: string;
    label: string;
}

const COUNTRY_CODES: string[] = [
    'US', 'FR', 'GB', 'JP', 'KR', 'ES', 'DE', 'IT', 'CN', 'IN',
    'CA', 'AU', 'BR', 'RU', 'SE', 'NO', 'DK', 'NL', 'MX', 'PL',
    'TR', 'TH', 'ID', 'PH', 'VN', 'AR', 'CO', 'ZA', 'EG', 'NG',
    'BE', 'CH', 'AT', 'IE', 'NZ', 'HK', 'TW', 'SA', 'AE', 'IL',
    'PT', 'FI', 'GR', 'CZ', 'HU', 'RO', 'UA',
];

/**
 * Returns a localized list of country options sorted by label.
 * @param locale - BCP 47 locale tag (e.g. 'en', 'fr', 'de')
 */
export function getCountries(locale: string): CountryOption[] {
    let names: Intl.DisplayNames | undefined;
    try {
        names = new Intl.DisplayNames([locale, 'en'], { type: 'region' });
    } catch {
        names = new Intl.DisplayNames(['en'], { type: 'region' });
    }
    return COUNTRY_CODES.map(code => ({
        value: code,
        label: names!.of(code) || code,
    })).sort((a, b) => a.label.localeCompare(b.label, locale));
}

/** @deprecated Use getCountries(locale) for localized labels */
export const countries: CountryOption[] = getCountries('fr');

