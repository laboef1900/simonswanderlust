import type { RemoteHeroImage } from './images.js';
import { MAX_GALLERY_TEXT } from '../../../uploader/public/gallery-photo-line.js';

export interface JourneySnapshotLocale {
  slug: string;
  title: string;
  intro: string;
  heroImage: RemoteHeroImage;
}
export interface JourneySnapshot {
  version: 1;
  members: string[];
  locales: Partial<Record<'de' | 'en', JourneySnapshotLocale>>;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
const finitePositive = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

/** Pure shared boundary: origin adaptation is allowed, variant URLs are never bases. */
export function isCanonicalJourneyHero(value: unknown): value is RemoteHeroImage {
  if (!object(value) || !keys(value, ['src', 'width', 'height', 'alt', 'format', 'focus'])
    || typeof value.src !== 'string' || typeof value.alt !== 'string' || value.alt.length > MAX_GALLERY_TEXT || value.alt.includes('\0')
    || !finitePositive(value.width) || !finitePositive(value.height)
    || (value.format !== undefined && value.format !== 'jpeg')) return false;
  try {
    const url = new URL(value.src);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.href !== value.src || !/^\/[a-z0-9][a-z0-9/_-]*$/.test(url.pathname)
      || url.pathname.includes('//') || url.pathname.endsWith('/')) return false;
  } catch { return false; }
  if (value.focus !== undefined) {
    const focus = value.focus;
    if (!object(focus) || !keys(focus, ['x', 'y']) || !['x', 'y'].every((key) =>
      typeof focus[key] === 'number' && Number.isFinite(focus[key]) && focus[key] >= 0 && focus[key] <= 100)) return false;
  }
  return true;
}

/** Validates retained snapshots as well as live ones; deletion may leave zero members. */
export function parseJourneySnapshot(value: unknown): JourneySnapshot {
  const invalid = (): never => { throw new Error('Invalid journey snapshot.'); };
  if (!object(value) || !keys(value, ['version', 'members', 'locales']) || value.version !== 1
    || !Array.isArray(value.members) || value.members.length > 50
    || value.members.some((key) => typeof key !== 'string' || !key || key.includes('\0'))
    || new Set(value.members).size !== value.members.length
    || !object(value.locales) || !keys(value.locales, ['de', 'en']) || Object.keys(value.locales).length === 0) return invalid();
  for (const locale of Object.values(value.locales)) {
    if (!object(locale) || !keys(locale, ['slug', 'title', 'intro', 'heroImage'])
      || typeof locale.slug !== 'string' || locale.slug.length > 100 || !/^[a-z0-9][a-z0-9-]*$/.test(locale.slug)
      || typeof locale.title !== 'string' || !locale.title.trim() || locale.title.length > 200 || /\p{C}/u.test(locale.title)
      || typeof locale.intro !== 'string' || !locale.intro.trim() || locale.intro.length > 2000 || locale.intro.includes('\0')
      || !isCanonicalJourneyHero(locale.heroImage) || !locale.heroImage.alt) return invalid();
  }
  return value as unknown as JourneySnapshot;
}
