import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

/** One PostgreSQL identity expression, shared by the loader and CMS reads. */
export const PUBLISHED_SNAPSHOT_DIGEST_SQL = "encode(sha256(convert_to(published_snapshot::text, 'UTF8')), 'hex')";
export const RELEASE_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
export const RELEASE_STAMP_RE = /^\d{1,16}-\d{1,10}-\d{4,10}$/;

export interface ReleaseManifestV1 {
  schema: 1;
  stamp: string;
  posts: Array<{
    translationKey: string;
    locale: 'de' | 'en';
    slug: string;
    digest: string;
    gallery: Array<{ src: string; alt: string; caption: string | null }>;
  }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

/** Strict wire shape: corrupt records never become positive publication evidence. */
export function isReleaseManifest(value: unknown, stamp: string): value is ReleaseManifestV1 {
  if (!RELEASE_STAMP_RE.test(stamp) || !record(value) || !keys(value, ['schema', 'stamp', 'posts']) ||
      value.schema !== 1 || value.stamp !== stamp || !Array.isArray(value.posts)) return false;
  const seen = new Set<string>();
  for (const post of value.posts) {
    if (!record(post) || !keys(post, ['translationKey', 'locale', 'slug', 'digest', 'gallery']) ||
        typeof post.translationKey !== 'string' || !post.translationKey ||
        (post.locale !== 'de' && post.locale !== 'en') || typeof post.slug !== 'string' || !post.slug ||
        typeof post.digest !== 'string' || !/^[a-f0-9]{64}$/.test(post.digest) || !Array.isArray(post.gallery)) return false;
    const identity = JSON.stringify([post.translationKey, post.locale]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    for (const photo of post.gallery) {
      if (!record(photo) || !keys(photo, ['src', 'alt', 'caption']) || typeof photo.src !== 'string' ||
          typeof photo.alt !== 'string' || (photo.caption !== null && typeof photo.caption !== 'string')) return false;
    }
  }
  return true;
}

/** Bound the bytes actually read, including a file growing after stat. */
export async function readReleaseManifest(path: string, stamp: string): Promise<ReleaseManifestV1> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > RELEASE_MANIFEST_MAX_BYTES) throw new Error('Invalid release manifest');
    const bytes = Buffer.alloc(Math.min(stat.size + 1, RELEASE_MANIFEST_MAX_BYTES + 1));
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > stat.size || length > RELEASE_MANIFEST_MAX_BYTES) throw new Error('Invalid release manifest');
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!isReleaseManifest(value, stamp)) throw new Error('Invalid release manifest');
    return value;
  } finally { await file.close(); }
}

/** Optional loader output must never make an otherwise successful render fail. */
export async function writeReleaseManifest(
  posts: ReleaseManifestV1['posts'],
  path = process.env.SITE_RELEASE_MANIFEST,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  if (!path) return;
  const temporary = `${path}.partial`;
  try {
    const stamp = basename(path).replace(/\.manifest\.json$/, '');
    const manifest: ReleaseManifestV1 = { schema: 1, stamp, posts };
    if (!isReleaseManifest(manifest, stamp)) throw new Error('Invalid release manifest');
    const json = JSON.stringify(manifest);
    if (Buffer.byteLength(json) > RELEASE_MANIFEST_MAX_BYTES) throw new Error('Invalid release manifest');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, json);
    await rename(temporary, path);
  } catch {
    // A previous loader invocation must not leave apparently valid stale output.
    await rm(path, { force: true }).catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    try { warn('Release publication manifest unavailable; rendered site is unchanged.'); } catch { /* optional diagnostic */ }
  }
}
