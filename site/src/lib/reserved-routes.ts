export type Namespace = 'root' | 'de' | 'en';
export interface Reservation { segment: string; owner: 'app' | 'site' | 'locale' | 'legacy'; pageKind?: 'about' }
interface Mode { primary: 'de' | 'en'; locales: readonly ('de' | 'en')[] }
const DEFAULT_MODE: Mode = { primary: 'de', locales: ['de', 'en'] };
export const APP_SEGMENTS = ['admin', 'map', 'ai-config', 'ai-providers', 'api', 'auth', 'backups', 'comments', 'export', 'gallery', 'geocode', 'gpx', 'health', 'import', 'language', 'login', 'logout', 'media', 'moderation', 'pages', 'posts', 'rebuild', 'settings', 'setup', 'upload', 'users'] as const;
const legacy = ['feed', 'category', 'comments'].map((segment): Reservation => ({ segment, owner: 'legacy' }));
const de: Reservation[] = ['karte', 'reiseziele'].map((segment) => ({ segment, owner: 'site' }));
de.push({ segment: 'uber-mich', owner: 'site', pageKind: 'about' });
const en: Reservation[] = ['map', 'destinations'].map((segment) => ({ segment, owner: 'site' }));
en.push({ segment: 'about-me', owner: 'site', pageKind: 'about' });
const enRoot = en.map((entry) => entry.segment === 'map' ? { ...entry, segment: 'travel-map' } : entry);
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
