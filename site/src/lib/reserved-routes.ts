import { wordsFor } from './route-words.js';
export type Namespace = 'root' | 'de' | 'en';
export interface Reservation { segment: string; owner: 'app' | 'site' | 'locale' | 'legacy'; pageKind?: 'about' }
interface Mode { primary: 'de' | 'en'; locales: readonly ('de' | 'en')[] }
const DEFAULT_MODE: Mode = { primary: 'de', locales: ['de', 'en'] };
export const APP_SEGMENTS = ['admin', 'map', 'ai-config', 'ai-providers', 'api', 'auth', 'backups', 'comments', 'export', 'geocode', 'gpx', 'health', 'import', 'journey-admin', 'language', 'login', 'logout', 'media', 'moderation', 'onboarding', 'pages', 'posts', 'rebuild', 'settings', 'setup', 'upload', 'users'] as const;
const legacy = ['feed', 'category', 'comments'].map((segment): Reservation => ({ segment, owner: 'legacy' }));
function siteReservations(locale: 'de' | 'en', primary: 'de' | 'en'): Reservation[] {
  const words = wordsFor(locale, primary);
  return [
    { segment: words.map, owner: 'site' },
    { segment: words.regions, owner: 'site' },
    { segment: words.about, owner: 'site', pageKind: 'about' },
  ];
}
const de = siteReservations('de', 'de');
const en = siteReservations('en', 'de');
const enRoot = siteReservations('en', 'en');
export const RESERVED: Record<Namespace, readonly Reservation[]> = {
  root: [...APP_SEGMENTS.map((segment): Reservation => ({ segment, owner: 'app' })), ...de,
    { segment: '404', owner: 'site' }, { segment: 'de', owner: 'locale' }, { segment: 'en', owner: 'locale' }, ...legacy],
  de,
  en: [...en, ...legacy],
};
export function namespaceOf(locale: 'de' | 'en', mode: Mode): Namespace { return locale === mode.primary ? 'root' : locale; }
export function reservation(namespace: Namespace, slug: string, mode: Mode = DEFAULT_MODE): Reservation | null {
  if (namespace !== 'root') return RESERVED[namespace].find((entry) => entry.segment === slug) ?? null;
  const fixed = RESERVED.root.find((entry) => entry.owner !== 'site' && entry.segment === slug);
  if (fixed) return fixed;
  if (slug === '404') return { segment: slug, owner: 'site' };
  const words = mode.primary === 'de' ? de : enRoot;
  return words.find((entry) => entry.segment === slug) ?? null;
}
