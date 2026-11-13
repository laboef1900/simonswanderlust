import { lstat, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { assertSafeKey } from './storage.js';
import type { PostUsageRow } from './posts.js';
import type { PagePair } from './pages.js';
import { assertWorkWritable, type WorkCancellationOptions } from './work-cancellation.js';
import type { StoredJourney } from './journeys.js';
import type { ImageFormat } from './variants.js';

// The variant filename contract: `${key}-${width}.${format}` (see storage.ts /
// variants.ts). Everything under storageDir that matches this is a variant of
// some key; anything else is ignored by the media library.
// @ai-warning: keys carry a content/profile-hash suffix, but that is part of
// the key, not the variant suffix — this regex still only strips the trailing
// `-{width}.{avif|webp|jpeg}`, so a hashed key groups correctly.
export const VARIANT_FILE_RE = /-(\d+)\.(avif|webp|jpeg)$/;

// The untouched-original sibling written next to the variants (`${key}-orig.<ext>`,
// issue #21). It is a private DR asset, not a gallery item, but deleteMedia must
// remove it alongside the variants so deleting an image doesn't orphan its
// full-resolution original on disk.
export const ORIGINAL_FILE_RE = /-orig\.[a-z0-9]+$/i;

export interface UsageRef {
  kind: 'post' | 'page' | 'journey';
  key: string;
  title: string;
  /**
   * `published`: the version the blog serves references the image — a post's
   * `published_snapshot`, or a page (pages have no snapshot; the working copy
   * is what gets built). `working`: the editable copy references it. A post
   * that is `published` but not `working` has had the photo swapped out in a
   * draft save and needs a republish (or unpublish) before the photo can go.
   */
  published: boolean;
  working: boolean;
}

const KEY_CHAR_RE = /[a-z0-9/_-]/;
const VARIANT_SUFFIX_RE = /^-(\d+)\.(?:avif|webp|jpeg)/;
const SAFE_CANDIDATE_URL_RE = /^[a-z]+:\/\/[^/]+\/([a-z0-9/_-]+)$/;

/**
 * True when `text` references `src` as a whole URL: the occurrence may carry a
 * `-{width}.{avif|webp|jpeg}` variant suffix (a hand-written direct variant
 * link) but must not be followed by another key character — so `…/hero` does
 * not match inside `…/hero2` or `…/hero-2`.
 */
function textReferences(src: string, text: string): boolean {
  if (!src || !text) return false;
  let pos = 0;
  while ((pos = text.indexOf(src, pos)) !== -1) {
    let end = pos + src.length;
    const rest = text.slice(end);
    const variant = VARIANT_SUFFIX_RE.exec(rest);
    if (variant) end += variant[0].length;
    if (end >= text.length || !KEY_CHAR_RE.test(text[end]!)) return true;
    pos += 1;
  }
  return false;
}

interface UsageLocale {
  heroImage?: { src: string };
  titleImage?: { src: string };
  images?: Record<string, unknown>;
  bodyMarkdown: string;
}

function localeUses(src: string, l: UsageLocale): boolean {
  // Match both header images, map keys and body using the same variant-tolerant,
  // boundary-safe matcher, including hand-pasted direct variant URLs.
  if (l.heroImage && textReferences(src, l.heroImage.src)) return true;
  if (l.titleImage && textReferences(src, l.titleImage.src)) return true;
  if (l.images && Object.keys(l.images).some((k) => textReferences(src, k))) return true;
  return textReferences(src, l.bodyMarkdown);
}

function groupPostRows(posts: PostUsageRow[]): Map<string, PostUsageRow[]> {
  const byKey = new Map<string, PostUsageRow[]>();
  for (const r of posts) {
    const rows = byKey.get(r.translationKey) ?? [];
    rows.push(r);
    byKey.set(r.translationKey, rows);
  }
  return byKey;
}

function postUsageFromGroups(src: string, byKey: Map<string, PostUsageRow[]>): UsageRef[] {
  const refs: UsageRef[] = [];
  for (const [key, rows] of byKey) {
    const using = rows.filter((r) => localeUses(src, r));
    if (using.length > 0) {
      refs.push({
        kind: 'post', key, title: rows.map((r) => r.title).find((t) => t) || key,
        published: using.some((r) => r.source === 'published'),
        working: using.some((r) => r.source === 'working'),
      });
    }
  }
  return refs;
}

/**
 * Which posts/pages reference the image `src` (hero, images map, or body
 * markdown). Posts arrive as flat per-locale rows (PostStore.usageRows) so a
 * stranded single-locale row — invisible to PostStore.get() — still guards
 * its images against deletion, and a published post's snapshot rows guard
 * what the live site still renders after a draft swapped the photo out (#115).
 */
export function imageUsage(src: string, posts: PostUsageRow[], pages: PagePair[], journeys: StoredJourney[] = []): UsageRef[] {
  const refs = postUsageFromGroups(src, groupPostRows(posts));
  for (const pg of pages) {
    if (localeUses(src, pg.de) || localeUses(src, pg.en)) {
      refs.push({ kind: 'page', key: pg.key, title: pg.de.title || pg.en.title || pg.key, published: true, working: true });
    }
  }
  for (const journey of journeys) {
    const working = [journey.de, journey.en].some(locale => locale.heroImage?.src === src);
    const retained = Object.values(journey.publishedSnapshot?.locales ?? {}).some(locale => locale.heroImage.src === src);
    if (working || retained) refs.push({
      kind: 'journey', key: journey.id, title: journey.de.title || journey.en.title || journey.id,
      working, published: retained && journey.status === 'published',
    });
  }
  return refs;
}

/**
 * Single-pass batch lookup for `GET /media`: indexes candidate keys across
 * posts, pages and journeys once instead of scanning the full corpus per item.
 */
export function imageUsageBatch(
  srcs: readonly string[],
  posts: PostUsageRow[],
  pages: PagePair[],
  journeys: StoredJourney[] = [],
): Map<string, UsageRef[]> {
  const result = new Map<string, UsageRef[]>();
  if (srcs.length === 0) return result;
  const byPostKey = groupPostRows(posts);
  const wanted = new Set<string>();
  const fallback: string[] = [];
  for (const src of srcs) {
    const m = SAFE_CANDIDATE_URL_RE.exec(src);
    if (m) wanted.add(m[1]!);
    else fallback.push(src);
  }
  const candidatePosts = new Map<string, Set<string>>();
  const candidatePages = new Map<string, Set<PagePair>>();
  const journeyRefs = new Map<string, UsageRef[]>();
  const scanRe = /\/([a-z0-9/_-]+?)(?:-\d+\.(?:avif|webp|jpeg))?(?![a-z0-9/_-])/g;
  const collect = (text: string, onHit: (key: string) => void) => {
    if (!text) return;
    scanRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = scanRe.exec(text)) !== null) {
      const key = m[1]!;
      if (wanted.has(key)) onHit(key);
    }
  };
  const collectLocale = (l: UsageLocale, onHit: (key: string) => void) => {
    if (l.heroImage?.src) collect(l.heroImage.src, onHit);
    if (l.titleImage?.src) collect(l.titleImage.src, onHit);
    if (l.images) for (const k of Object.keys(l.images)) collect(k, onHit);
    collect(l.bodyMarkdown, onHit);
  };
  if (wanted.size > 0) {
    for (const r of posts) {
      collectLocale(r, (key) => {
        let set = candidatePosts.get(key);
        if (!set) { set = new Set(); candidatePosts.set(key, set); }
        set.add(r.translationKey);
      });
    }
    for (const pg of pages) {
      const hit = (key: string) => {
        let set = candidatePages.get(key);
        if (!set) { set = new Set(); candidatePages.set(key, set); }
        set.add(pg);
      };
      collectLocale(pg.de, hit);
      collectLocale(pg.en, hit);
    }
  }
  for (const journey of journeys) {
    const ref: UsageRef = {
      kind: 'journey', key: journey.id, title: journey.de.title || journey.en.title || journey.id,
      working: false, published: false,
    };
    const seen = new Map<string, { working: boolean; published: boolean }>();
    for (const locale of [journey.de, journey.en]) {
      const s = locale.heroImage?.src;
      if (s) seen.set(s, { ...(seen.get(s) ?? { working: false, published: false }), working: true });
    }
    const pub = journey.status === 'published';
    for (const locale of Object.values(journey.publishedSnapshot?.locales ?? {})) {
      const s = locale.heroImage.src;
      seen.set(s, { ...(seen.get(s) ?? { working: false, published: false }), published: pub });
    }
    for (const [s, flags] of seen) {
      const list = journeyRefs.get(s) ?? [];
      list.push({ ...ref, ...flags });
      journeyRefs.set(s, list);
    }
  }
  for (const src of srcs) {
    const m = SAFE_CANDIDATE_URL_RE.exec(src);
    if (!m) {
      result.set(src, imageUsage(src, posts, pages, journeys));
      continue;
    }
    const key = m[1]!;
    const refs: UsageRef[] = [];
    const postKeys = candidatePosts.get(key);
    if (postKeys) {
      for (const tk of postKeys) {
        const rows = byPostKey.get(tk)!;
        const using = rows.filter((r) => localeUses(src, r));
        if (using.length > 0) {
          refs.push({
            kind: 'post', key: tk, title: rows.map((r) => r.title).find((t) => t) || tk,
            published: using.some((r) => r.source === 'published'),
            working: using.some((r) => r.source === 'working'),
          });
        }
      }
    }
    const pageMatches = candidatePages.get(key);
    if (pageMatches) {
      for (const pg of pageMatches) {
        if (localeUses(src, pg.de) || localeUses(src, pg.en)) {
          refs.push({ kind: 'page', key: pg.key, title: pg.de.title || pg.en.title || pg.key, published: true, working: true });
        }
      }
    }
    const jRefs = journeyRefs.get(src);
    if (jRefs) refs.push(...jRefs);
    result.set(src, refs);
  }
  return result;
}

/**
 * Unlink every variant file belonging to `key` (exact match after stripping
 * the variant suffix — sibling keys sharing a prefix are untouched).
 * Returns the number of files removed; 0 when the key has none.
 */
export async function deleteMedia(storageDir: string, key: string, opts: WorkCancellationOptions = {}): Promise<number> {
  assertWorkWritable(opts);
  assertSafeKey(key); // path-traversal guard — same chokepoint as every write
  const root = resolve(storageDir);
  const dir = join(root, dirname(key));
  const base = basename(key);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  let removed = 0;
  for (const d of entries) {
    if (!d.isFile()) continue;
    // A file belongs to `key` when stripping its variant suffix — or its
    // `-orig.<ext>` suffix — yields exactly `base` (sibling keys sharing a
    // prefix, e.g. `hero` vs `hero-b`, are untouched).
    const isVariant = VARIANT_FILE_RE.test(d.name) && d.name.replace(VARIANT_FILE_RE, '') === base;
    const isOriginal = ORIGINAL_FILE_RE.test(d.name) && d.name.replace(ORIGINAL_FILE_RE, '') === base;
    if (isVariant || isOriginal) {
      assertWorkWritable(opts);
      await unlink(join(dir, d.name));
      removed++;
    }
  }
  return removed;
}

/** One variant file of a photo as it exists on disk (#570, the Versions list). */
export interface VariantFile {
  format: ImageFormat;
  /** From the filename — the variant contract. */
  width: number;
  /** From the file header; null when the file cannot be read as an image. */
  height: number | null;
  /** lstat size. */
  bytes: number;
}

/** A variant file plus its public URL, `${item.src}-${width}.${format}`. */
export interface MediaVersion extends VariantFile {
  src: string;
}

/**
 * What `GET /media/items/*?versions=1` adds as `versions`. `available` with no
 * items means the key has no variant files; `processing` rows are not read
 * (their set is in flux); `unavailable` is an unsafe stored key or a storage
 * error other than ENOENT.
 */
export type MediaVersions =
  | { availability: 'available'; items: MediaVersion[] }
  | { availability: 'processing' }
  | { availability: 'unavailable' };

/** The order versions of one width are listed in. */
const VARIANT_FORMAT_ORDER: readonly ImageFormat[] = ['avif', 'webp', 'jpeg'];

/** A variant's pixel height from its header; null when sharp cannot read it. */
async function headerHeight(file: string): Promise<number | null> {
  try {
    const { height } = await sharp(file).metadata(); // header only, no pixel decode
    return typeof height === 'number' && Number.isInteger(height) && height > 0 ? height : null;
  } catch {
    return null;
  }
}

/**
 * The variant files that exist for `key`, sorted by width and then AVIF, WebP,
 * JPEG. The DISK is the authoritative source (media-store.ts), so legacy,
 * partial and JPEG-only sets list exactly what is there.
 *
 * @ai-warning `key` comes from a database row here, and a row can be
 * hand-edited or restored from a dump: `assertSafeKey` is re-asserted BEFORE
 * any path is built, like `deleteMedia`, and its exact-base match keeps `hero`
 * from listing `hero-b`. Regular files only — `Dirent.isFile()` and then
 * `lstat().isFile()` — so a symlink is never followed and its target's size or
 * dimensions are never reported. The private original (`-orig.*`) cannot match
 * `VARIANT_FILE_RE` and is never listed.
 *
 * A missing directory (ENOENT) is an empty list. Every other error is THROWN:
 * the caller reports it as unavailable and must not log it with the path.
 */
export async function listVariantFiles(storageDir: string, key: string): Promise<VariantFile[]> {
  assertSafeKey(key);
  const dir = join(resolve(storageDir), dirname(key));
  const base = basename(key);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const candidates: { format: ImageFormat; width: number; file: string }[] = [];
  for (const d of entries) {
    if (!d.isFile()) continue;
    const match = VARIANT_FILE_RE.exec(d.name);
    if (!match || d.name.replace(VARIANT_FILE_RE, '') !== base) continue;
    const format = VARIANT_FORMAT_ORDER.find((f) => f === match[2]);
    const width = Number(match[1]);
    // The public URL is rebuilt from the parsed width (`${src}-${width}.${format}`),
    // so a name that does not round-trip (`hero-0640.webp`, a width past the safe
    // integers) is not a variant the site can address and is left out.
    if (!format || String(width) !== match[1]) continue;
    candidates.push({ format, width, file: join(dir, d.name) });
  }
  const probed = await Promise.all(candidates.map(async ({ format, width, file }): Promise<VariantFile | null> => {
    let stat;
    try {
      stat = await lstat(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // deleted since the listing
      throw e;
    }
    if (!stat.isFile()) return null;
    return { format, width, height: await headerHeight(file), bytes: stat.size };
  }));
  const files = probed.filter((f): f is VariantFile => f !== null);
  return files.sort((a, b) =>
    a.width - b.width || VARIANT_FORMAT_ORDER.indexOf(a.format) - VARIANT_FORMAT_ORDER.indexOf(b.format));
}
