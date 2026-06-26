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
