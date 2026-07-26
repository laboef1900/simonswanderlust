import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProcessResult, Variant } from './pipeline.js';

export interface StorageOptions {
  storageDir: string;
  baseUrl: string;
}

export interface StoredImage {
  src: string;
  width: number;
  height: number;
  files: string[];
  snippet: string;
}

// Central chokepoint for every write path (direct /upload AND the WordPress
// re-host path, which bypasses the route-level KEY_RE check). A key is a
// relative slug-segment path; reject anything that could escape storageDir.
// @ai-warning: do not loosen this to allow '.' — it is what blocks `../` traversal.
const SAFE_KEY_RE = /^[a-z0-9][a-z0-9/_-]*$/;

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY_RE.test(key) || key.includes('..') || key.includes('//')) {
    throw new Error(`unsafe storage key "${key}" (lowercase a-z, 0-9, / _ - only; no traversal)`);
  }
}

// The original's extension comes from sharp's format detection ([a-z0-9]+ in
// practice), but validate at the write boundary anyway — it becomes part of a
// filesystem path.
const SAFE_EXT_RE = /^[a-z0-9]+$/;

// Matches the untouched-original filename written by storeVariants
// (`<key>-orig.<ext>`). Variant suffixes are numeric widths (`-640.avif`), so
// this can only match an original, never a variant. Used to keep originals off
// the public image mount: they live in storageDir so the incremental backup tar
// still captures them, but a full-resolution original is a private DR asset,
// not something the site ever links to.
const ORIGINAL_FILE_RE = /-orig\.[a-z0-9]+$/i;

export function isOriginalFile(pathName: string): boolean {
  return ORIGINAL_FILE_RE.test(pathName);
}

// Append a short content hash to a key so the resulting variant URLs are truly
// immutable: replacing a photo mints a new URL, while previously published
// URLs keep serving from disk untouched (nothing is overwritten or deleted).
// Deterministic over the ORIGINAL upload bytes, so re-uploading the identical
// file reuses the same key — a harmless identical overwrite. Hex output stays
// within SAFE_KEY_RE.
// @ai-note: hashing the original (not the encoded variants) means a future
// sharp upgrade could write slightly different encoded bytes under an
// unchanged URL if the same original is re-uploaded — visually identical,
// accepted trade-off.
// @ai-warning: the WP-import rehost path (wp-images.ts) deliberately does NOT
// use this — its keys must stay deterministic so re-imports are idempotent.
export function contentHashKey(key: string, data: Buffer): string {
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 8);
  return `${key}-${hash}`;
}

/**
 * Persist the untouched upload as `${key}-orig.${ext}`.
 *
 * @ai-warning This is the central write chokepoint: `assertSafeKey` and
 * `SAFE_EXT_RE` live HERE, so every path that puts bytes under storageDir —
 * the async upload route, the CLI, and the WordPress re-host — passes the
 * traversal guard. Do not add a write path that bypasses it.
 *
 * `-orig` can never collide with a variant name (variant suffixes are numeric
 * widths). This makes /data/images a complete media archive — a DB restore
 * alone can't bring photos back, and the lossy variants would otherwise be the
 * only copy. The original lives in storageDir (so the incremental backup tar
 * captures it) but is a PRIVATE DR asset: the img-host static mount excludes
 * `-orig.*` via isOriginalFile(), so it is not downloadable.
 */
export async function storeOriginal(
  key: string,
  data: Buffer,
  ext: string,
  { storageDir }: Pick<StorageOptions, 'storageDir'>,
): Promise<string> {
  assertSafeKey(key);
  if (!SAFE_EXT_RE.test(ext)) throw new Error(`unsafe original extension "${ext}"`);
  const rel = `${key}-orig.${ext}`;
  const abs = join(storageDir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return rel;
}

/**
 * Write the generated variants for a key. Returns their relative paths and
 * total byte size (which the media row records as `variant_bytes`).
 *
 * Re-running this for the same key overwrites the same deterministic
 * filenames, which is what makes a crashed mid-encode self-heal on retry.
 */
export async function storeVariantFiles(
  key: string,
  variants: Variant[],
  { storageDir }: Pick<StorageOptions, 'storageDir'>,
): Promise<{ files: string[]; bytes: number }> {
  assertSafeKey(key);
  const files: string[] = [];
  let bytes = 0;
  for (const v of variants) {
    const rel = `${key}-${v.width}.${v.format}`;
    const abs = join(storageDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, v.data);
    files.push(rel);
    bytes += v.data.length;
  }
  return { files, bytes };
}

/** The paste-ready `heroImage:` YAML block returned by the upload routes. */
export function heroSnippet(src: string, width: number, height: number, alt: string): string {
  return [
    'heroImage:',
    `  src: '${src}'`,
    `  width: ${width}`,
    `  height: ${height}`,
    `  alt: '${alt.replace(/'/g, "''")}'`, // YAML single-quote escaping
  ].join('\n');
}

/**
 * Write variants + original in one synchronous call.
 *
 * @ai-note Retained as a thin wrapper over storeOriginal + storeVariantFiles
 * because two of its callers genuinely need the synchronous contract: the CLI
 * uploader, and the WordPress re-host path (which returns {src,width,height}
 * straight into the post body). Only the HTTP upload route went async.
 * storage.test.ts asserts the traversal guards THROUGH this wrapper, which is
 * what keeps those tests meaningful after the split.
 */
export async function storeVariants(
  key: string,
  alt: string,
  result: ProcessResult,
  { storageDir, baseUrl }: StorageOptions,
): Promise<StoredImage> {
  // Original first: it carries the extension check, and a failure there must
  // not leave a half-written variant set behind.
  const origRel = await storeOriginal(key, result.original.data, result.original.ext, { storageDir });
  const { files } = await storeVariantFiles(key, result.variants, { storageDir });
  files.push(origRel);

  const src = `${baseUrl.replace(/\/+$/, '')}/${key}`;
  return {
    src, width: result.width, height: result.height, files,
    snippet: heroSnippet(src, result.width, result.height, alt),
  };
}
