import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { processImage } from './pipeline.js';
import { assertSafeKey, storeVariants } from './storage.js';
import { safeFetch } from './safe-fetch.js';
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

/**
 * Matches `<name>-orig.<ext>` for one key basename — the untouched original
 * `storeOriginal` retains. `name` comes from a key that has already passed
 * `assertSafeKey`, so it holds no regex metacharacters, but escape it anyway
 * rather than relying on that from two modules away.
 */
const ORIG_OF = (name: string): RegExp =>
  new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-orig\\.[a-z0-9]+$`, 'i');

export async function createRehostResume(
  opts: { storageDir: string; baseUrl: string },
): Promise<RehostResume> {
  const base = opts.baseUrl.replace(/\/+$/, '');

  // One directory listing per directory for the whole run, cached and
  // deliberately never refreshed. Two pairs live under different
  // `trips/<slug>/` prefixes, so neither can read the other's in-run writes, and
  // a `nameFromUrl` collision within a pair still fetches twice and lets the
  // second overwrite the first, exactly as it did before this feature existed.
  const listings = new Map<string, Set<string>>();
  const entriesOf = async (dir: string): Promise<Set<string>> => {
    const hit = listings.get(dir);
    if (hit) return hit;
    let names: Set<string>;
    try {
      names = new Set(await readdir(join(opts.storageDir, dir)));
    } catch {
      names = new Set(); // missing directory ⇒ nothing has been re-hosted here
    }
    listings.set(dir, names);
    return names;
  };

  return {
    async lookup(key) {
      if (HERO_KEY_RE.test(key)) return null;
      // Re-assert at the READ boundary too: this builds filesystem paths, and
      // the key is derived from an attacker-influenced export.
      try { assertSafeKey(key); } catch { return null; }

      const slash = key.lastIndexOf('/');
      const dir = slash === -1 ? '' : key.slice(0, slash);
      const name = key.slice(slash + 1);
      const names = await entriesOf(dir);

      // @ai-warning The intrinsic width MUST come from the retained original,
      // never from the largest surviving variant. `storeVariants` writes the
      // original first and then the variants in ASCENDING width
      // (storage.ts:150 then pipeline.ts's `for (const w of
      // variantWidths(width))`), so a SIGKILL / OOM / ENOSPC truncates the TOP
      // widths — and a top-truncated set is byte-for-byte indistinguishable
      // from a complete set for a smaller photo. Deriving the expected set from
      // what survived would therefore accept it, resume at a silently
      // downscaled size, and never re-fetch on this run or any later one.
      const orig = [...names].find((n) => ORIG_OF(name).test(n));
      if (orig === undefined) return null;

      let width = 0;
      let height = 0;
      try {
        const meta = await sharp(join(opts.storageDir, dir, orig)).metadata();
        // Match `probeImage`: the orientation-corrected size is what
        // `processImage` recorded and what the variants were resized against.
        width = meta.autoOrient?.width ?? meta.width ?? 0;
        height = meta.autoOrient?.height ?? meta.height ?? 0;
      } catch {
        return null; // unreadable or truncated original ⇒ re-fetch
      }
      if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) return null;

      // Fail closed on a partial set, measured against the original's width.
      // `storeVariantFiles` writes with plain `writeFile` and has no cleanup on
      // failure, so a crashed encode leaves files and no record — trusting that
      // would publish a srcset pointing at variants nobody ever wrote.
      for (const w of variantWidths(width)) {
        for (const format of FORMATS) {
          const file = `${name}-${w}.${format}`;
          if (!names.has(file)) return null;
          try {
            const st = await stat(join(opts.storageDir, dir, file));
            if (!st.isFile() || st.size === 0) return null;
          } catch {
            return null;
          }
        }
      }

      return { src: `${base}/${key}`, width, height };
    },
  };
}
