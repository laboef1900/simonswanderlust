import type { Locale } from '../i18n/ui';

const intlLocale: Record<Locale, string> = { de: 'de-DE', en: 'en-US' };

/** "OCT 2024" / "OKT 2024" — the small-caps label used on cards and heroes. */
export function dateLabel(date: Date, locale: Locale): string {
  return date
    .toLocaleDateString(intlLocale[locale], { month: 'short', year: 'numeric' })
    .replace(/\./g, '')
    .toUpperCase();
}

/** "44.4268° N · 26.1025° E" — expedition-log coordinate line. */
export function coordsLabel(coords: { lat: number; lng: number }): string {
  const lat = `${Math.abs(coords.lat).toFixed(4)}° ${coords.lat >= 0 ? 'N' : 'S'}`;
  const lng = `${Math.abs(coords.lng).toFixed(4)}° ${coords.lng >= 0 ? 'E' : 'W'}`;
  return `${lat} · ${lng}`;
}

/** "N°07" — journal entry label. */
export function entryLabel(n: number): string {
  return `N°${String(n).padStart(2, '0')}`;
}
