import { readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { assertSafeKey } from './storage.js';
import type { PostPair } from './posts.js';
import type { PagePair } from './pages.js';

// The variant filename contract: `${key}-${width}.${format}` (see storage.ts /
// variants.ts). Everything under storageDir that matches this is a variant of
// some key; anything else is ignored by the media library.
// @ai-warning: if the filename convention ever changes (e.g. content hashes),
// this regex and deleteMedia's grouping must change with it.
export const VARIANT_FILE_RE = /-(\d+)\.(avif|webp)$/;

export interface MediaItem {
  key: string;
  /** All variant files for this key, storageDir-relative POSIX paths, sorted by width then format. */
  files: string[];
  /** Distinct variant widths, ascending. */
  widths: number[];
  /** Smallest webp variant (rel path) — the cheapest preview; null if no webp exists. */
  thumbFile: string | null;
  /** Intrinsic dimensions, probed from the largest webp; null when unreadable. */
  width: number | null;
  height: number | null;
}

interface VariantFile { rel: string; width: number; format: string }

/**
 * Walk storageDir and group variant files by their storage key
 * (relative path with the `-{width}.{fmt}` suffix stripped).
 */
export async function listMedia(storageDir: string): Promise<MediaItem[]> {
  const root = resolve(storageDir);
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; // nothing uploaded yet
    throw e;
  }
  const byKey = new Map<string, VariantFile[]>();
  for (const d of entries) {
    if (!d.isFile()) continue;
    const m = VARIANT_FILE_RE.exec(d.name);
    if (!m) continue;
    const rel = relative(root, join(d.parentPath, d.name)).split(sep).join('/');
    const key = rel.replace(VARIANT_FILE_RE, '');
    const list = byKey.get(key) ?? [];
    list.push({ rel, width: Number(m[1]), format: String(m[2]) });
    byKey.set(key, list);
  }

  const items: MediaItem[] = [];
  for (const [key, files] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    files.sort((a, b) => a.width - b.width || a.format.localeCompare(b.format));
    const webps = files.filter((f) => f.format === 'webp');
    const thumb = webps[0] ?? null;
    const largest = webps[webps.length - 1] ?? null;
    let width: number | null = null;
    let height: number | null = null;
    if (largest) {
      // Metadata-only probe (no decode). The largest variant is the intrinsic
      // size — variantWidths() never upscales.
      try {
        const meta = await sharp(join(root, largest.rel)).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
      } catch {
        // unreadable/corrupt file — dims stay unknown
      }
    }
    items.push({
      key,
      files: files.map((f) => f.rel),
      widths: [...new Set(files.map((f) => f.width))].sort((a, b) => a - b),
      thumbFile: thumb?.rel ?? null,
      width,
      height,
    });
  }
  return items;
}

export interface UsageRef { kind: 'post' | 'page'; key: string; title: string }

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `text` references `src` as a whole URL: the occurrence may carry a
 * `-{width}.{avif|webp}` variant suffix (a hand-written direct variant link)
 * but must not be followed by another key character — so `…/hero` does not
 * match inside `…/hero2` or `…/hero-2`.
 */
function textReferences(src: string, text: string): boolean {
  const re = new RegExp(`${escapeRegExp(src)}(?:-\\d+\\.(?:avif|webp))?(?![a-z0-9/_-])`);
  return re.test(text);
}

interface UsageLocale {
  heroImage?: { src: string };
  images?: Record<string, unknown>;
  bodyMarkdown: string;
}

function localeUses(src: string, l: UsageLocale): boolean {
  if (l.heroImage && l.heroImage.src === src) return true;
  if (l.images && Object.hasOwn(l.images, src)) return true;
  return textReferences(src, l.bodyMarkdown);
}

/** Which posts/pages reference the image `src` (hero, images map, or body markdown). */
export function imageUsage(src: string, posts: PostPair[], pages: PagePair[]): UsageRef[] {
  const refs: UsageRef[] = [];
  for (const p of posts) {
    if (localeUses(src, p.de) || localeUses(src, p.en)) {
      refs.push({ kind: 'post', key: p.translationKey, title: p.de.title || p.en.title || p.translationKey });
    }
  }
  for (const pg of pages) {
    if (localeUses(src, pg.de) || localeUses(src, pg.en)) {
      refs.push({ kind: 'page', key: pg.key, title: pg.de.title || pg.en.title || pg.key });
    }
  }
  return refs;
}

/**
 * Unlink every variant file belonging to `key` (exact match after stripping
 * the variant suffix — sibling keys sharing a prefix are untouched).
 * Returns the number of files removed; 0 when the key has none.
 */
export async function deleteMedia(storageDir: string, key: string): Promise<number> {
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
    if (VARIANT_FILE_RE.test(d.name) && d.name.replace(VARIANT_FILE_RE, '') === base) {
      await unlink(join(dir, d.name));
      removed++;
    }
  }
  return removed;
}
