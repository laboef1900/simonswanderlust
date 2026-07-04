import { createHash } from 'node:crypto';
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

export async function storeVariants(
  key: string,
  alt: string,
  result: ProcessResult,
  { storageDir, baseUrl }: StorageOptions,
): Promise<StoredImage> {
  assertSafeKey(key);
  const files: string[] = [];
  for (const v of result.variants) {
    const rel = `${key}-${v.width}.${v.format}`;
    const abs = join(storageDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, v.data);
    files.push(rel);
  }

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
