import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProcessResult } from './pipeline.js';

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

export async function storeVariants(
  key: string,
  alt: string,
  result: ProcessResult,
  { storageDir, baseUrl }: StorageOptions,
): Promise<StoredImage> {
  assertSafeKey(key);
  if (!SAFE_EXT_RE.test(result.original.ext)) {
    throw new Error(`unsafe original extension "${result.original.ext}"`);
  }
  const files: string[] = [];
  for (const v of result.variants) {
    const rel = `${key}-${v.width}.${v.format}`;
    const abs = join(storageDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, v.data);
    files.push(rel);
  }
  // Persist the untouched upload alongside the variants: `-orig` can never
  // collide with a variant name (variant suffixes are numeric widths). This
  // makes /data/images a complete media archive — a DB restore alone can't
  // bring photos back, and the lossy variants would otherwise be the only copy.
  // @ai-warning: the original lives in storageDir (so the incremental backup
  // tar captures it) but is a PRIVATE DR asset — the server's img-host static
  // mount excludes `-orig.*` via isOriginalFile(), so it is not downloadable.
  const origRel = `${key}-orig.${result.original.ext}`;
  const origAbs = join(storageDir, origRel);
  await mkdir(dirname(origAbs), { recursive: true });
  await writeFile(origAbs, result.original.data);
  files.push(origRel);

  const src = `${baseUrl.replace(/\/+$/, '')}/${key}`;
  const snippet = [
    'heroImage:',
    `  src: '${src}'`,
    `  width: ${result.width}`,
    `  height: ${result.height}`,
    `  alt: '${alt.replace(/'/g, "''")}'`, // YAML single-quote escaping
  ].join('\n');

  return { src, width: result.width, height: result.height, files, snippet };
}
