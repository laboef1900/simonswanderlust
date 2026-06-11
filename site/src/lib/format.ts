import type { Locale } from '../i18n/ui';

const intlLocale: Record<Locale, string> = { de: 'de-DE', en: 'en-US' };

/** "OCT 2024" / "OKT 2024" — the small-caps label used on cards and heroes. */
export function dateLabel(date: Date, locale: Locale): string {
  return date
    .toLocaleDateString(intlLocale[locale], { month: 'short', year: 'numeric' })
    .replace('.', '')
    .toUpperCase();
}
