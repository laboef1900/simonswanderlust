import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { processImage } from './pipeline.js';
import { assertSafeKey, storeVariants } from './storage.js';
import { safeFetch } from './safe-fetch.js';
import { walkStorageKeys } from './media-sync.js';
import { VARIANT_FILE_RE } from './media-files.js';
import { FORMATS, variantWidths } from './variants.js';

export interface RehostResult { src: string; width: number; height: number }

export async function rehostImage(
  url: string, key: string, alt: string,
  opts: { storageDir: string; baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number },
): Promise<RehostResult> {
  // @ai-warning: `url` is taken from an uploaded WordPress export, so it is
  // attacker-influenced. safeFetch applies the SSRF guard + timeout + byte cap.
  const { buffer } = await safeFetch(url, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });
  const result = await processImage(buffer);
  const stored = await storeVariants(key, alt, result, { storageDir: opts.storageDir, baseUrl: opts.baseUrl });
  return { src: stored.src, width: stored.width, height: stored.height };
}

/**
 * "Has this key already been re-hosted?" — answered from disk.
 *
 * @ai-context docs/superpowers/specs/2026-07-30-wxr-import-hardening-design.md
 *   §Resumability — issue #85.
 *
 * @ai-note There is deliberately NO state file. The importer's keys are
 * deterministic and un-hashed — every other write path (`POST /upload`, the
 * editor, the bulk library, the CLI) appends `-<hash8>` via `contentHashKey`,
 * see the @ai-warning there — so the un-hashed `trips/<slug>/<name>` namespace
 * belongs to this importer alone and /data/images IS the record. That removes a
 * whole trust boundary (no parser, no validation, no growth cap, no symlink
 * vector, no `images['__proto__']` path) and cannot disagree with the bytes
 * that will actually be served.
 */
export interface RehostResume {
  /** The stored result for `key`, or null when it must be (re-)fetched. */
  lookup(key: string): Promise<RehostResult | null>;
}

/**
 * The hero slot, whose key is `trips/<slug>/hero` and therefore encodes nothing
 * about the source URL — so disk cannot tell an already-fetched featured image
 * from a *different* one now occupying that slot.
 *
 * @ai-warning Do not "optimise" this away to save one fetch per pair. Without
 * it, changing a post's featured image in WordPress and re-importing silently
 * keeps the old photo. Matches `trips/x/hero`, not `trips/x/hero-shot`.
 */
const HERO_KEY_RE = /(?:^|\/)hero$/;

export async function createRehostResume(
  opts: { storageDir: string; baseUrl: string },
): Promise<RehostResume> {
  // ONE snapshot for the whole run, deliberately never refreshed: two pairs can
  // then never read each other's in-run writes, and a `nameFromUrl` collision
  // within a pair still fetches twice and lets the second overwrite the first,
  // exactly as it did before this feature existed.
  const onDisk = await walkStorageKeys(opts.storageDir);
  const base = opts.baseUrl.replace(/\/+$/, '');

  /** Every variant `storeVariantFiles` must have written for this intrinsic width. */
  const expectedVariants = (key: string, width: number): string[] =>
    variantWidths(width).flatMap((w) => FORMATS.map((f) => `${key}-${w}.${f}`));

  return {
    async lookup(key) {
      if (HERO_KEY_RE.test(key)) return null;
      // Re-assert at the READ boundary too: this builds filesystem paths, and
      // the key is derived from an attacker-influenced export.
      try { assertSafeKey(key); } catch { return null; }

      const hit = onDisk.get(key);
      if (!hit?.largestVariant) return null;

      // `variantWidths` always ends with the intrinsic width, so the largest
      // webp's FILENAME carries it (variants.ts:15-16).
      const width = Number(VARIANT_FILE_RE.exec(hit.largestVariant)?.[1] ?? 0);
      if (!Number.isInteger(width) || width <= 0) return null;

      // Fail closed on a partial set. `storeVariantFiles` writes with plain
      // `writeFile` and has no cleanup on failure, so a crashed encode or an
      // ENOSPC leaves some files and no record — trusting that would publish a
      // srcset pointing at variants nobody ever wrote.
      for (const rel of expectedVariants(key, width)) {
        try {
          const st = await stat(join(opts.storageDir, rel));
          if (!st.isFile() || st.size === 0) return null;
        } catch {
          return null;
        }
      }

      // Height comes from the file that will actually be served, never from a
      // record that could outlive it. The width check makes this a
      // dimension-identity test, not merely an existence test.
      try {
        const meta = await sharp(join(opts.storageDir, hit.largestVariant)).metadata();
        const height = meta.height ?? 0;
        if (meta.width !== width || height <= 0) return null;
        return { src: `${base}/${key}`, width, height };
      } catch {
        return null;
      }
    },
  };
}
