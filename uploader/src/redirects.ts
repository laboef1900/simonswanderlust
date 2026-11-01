import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LANGUAGE, validateLanguage, type LanguageConfig } from './language.js';

// Legacy WordPress URL redirects (issue #35). The old WP site served a family
// of non-post URLs (feeds, auto-generated category archives) that the Astro
// rebuild has no routes for; the not-found handler in server.ts 301s them to
// their new equivalents so subscribers and indexed links survive the cutover.
//
// @ai-context This map encodes the DE-primary WordPress layout (#283 §8.7).
// The targets are frozen by Golden Rule 2; language eligibility comes from
// the activated release, never the current database or target-file existence.
//
// @ai-note Deliberate non-redirects, decided in issue #35:
// - /wp-content/uploads/YYYY/MM/<file> image URLs are an accepted loss: the
//   old URL carries no post slug, so it cannot be mapped onto the new
//   `trips/<slug>/<filename-slug>` key scheme (wp-import.ts), a 301 would
//   have to pick a concrete width/format variant on the img host, and no
//   mapping table was persisted at import time.
// - /?p=<id> shortlinks resolve to `/` and serve the homepage — acceptable.
//   The same applies to the `/?feed=rss2` query-form feed URL: it also
//   resolves to `/` and stays unmapped (query-based routing is out of scope).
// - Tag/date archives are not mappable from repo data; extend the map below
//   once the real WXR inventory is available.
// - The `/category/` (DE) and `/en/category/` (EN) archive bases are
//   best-effort: the real WP install may have used a localized or custom
//   category base, which is unverifiable from the repo (no real WXR export
//   checked in). Wrong entries are harmless (those URLs 404 today anyway);
//   confirm the actual base from the WXR inventory before Phase 4.

/**
 * Ordered legacy-URL map. Keys are normalized paths (no query string, no
 * trailing slash); targets are final post-cutover URLs (301s get cached
 * aggressively, so targets must be contract-frozen).
 */
export const LEGACY_REDIRECTS: ReadonlyArray<readonly [string, string]> = [
  // WordPress feed family → Astro-generated RSS feeds. /feed/rss2, /feed/rss
  // and /feed/rdf are WP's built-in aliases of the default feed.
  ['/feed', '/rss.xml'],
  ['/feed/atom', '/rss.xml'],
  ['/feed/rss2', '/rss.xml'],
  ['/feed/rss', '/rss.xml'],
  ['/feed/rdf', '/rss.xml'],
  ['/comments/feed', '/rss.xml'],
  // Polylang per-language feed URLs for the EN tree.
  ['/en/feed', '/en/rss.xml'],
  ['/en/feed/atom', '/en/rss.xml'],
  ['/en/feed/rss2', '/en/rss.xml'],
  ['/en/feed/rss', '/en/rss.xml'],
  ['/en/feed/rdf', '/en/rss.xml'],
  ['/en/comments/feed', '/en/rss.xml'],
  // WP auto category archives → region pages (slugs from paths.ts regionSlugs).
  // Only these three regions existed on WordPress; asia/africa/oceania/
  // antarctica (2026-10-19) never had a /category/ URL, so they get no entry.
  // A target is only built while its region has a published story in that
  // locale (site `liveRegions`) — an empty region's archive 301s into a 404.
  ['/category/europa', '/reiseziele/europa/'],
  ['/category/nordamerika', '/reiseziele/nordamerika/'],
  ['/category/suedamerika', '/reiseziele/suedamerika/'],
  ['/en/category/europe', '/en/destinations/europe/'],
  ['/en/category/north-america', '/en/destinations/north-america/'],
  ['/en/category/south-america', '/en/destinations/south-america/'],
];

const lookup: ReadonlyMap<string, string> = new Map(LEGACY_REDIRECTS);

/**
 * Returns the 301 target for a legacy WordPress URL, or undefined if the
 * path is not a known legacy URL. Strips the query string and a trailing
 * slash before the exact-match lookup, so `/feed`, `/feed/` and
 * `/feed/?withoutcomments=1` all resolve.
 */
export function legacyRedirect(rawUrl: string, language: LanguageConfig = DEFAULT_LANGUAGE): string | undefined {
  if (language.primary !== 'de') return undefined;
  const path = rawUrl.split('?', 1)[0] ?? '';
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (normalized.startsWith('/en/') && !language.locales.includes('en')) return undefined;
  return lookup.get(normalized);
}

/**
 * Read only the bounded, app-generated root HTML tag, through one open file
 * descriptor (one activated release even if `current` changes during the read).
 * A historical root without either metadata attribute is pre-#285 DE-bilingual.
 * Missing, malformed or partially written metadata never inherits that default.
 */
export async function legacyRedirectForRelease(rawUrl: string, currentDir: string): Promise<string | undefined> {
  if (!legacyRedirect(rawUrl)) return undefined;
  let file;
  try {
    file = await open(join(currentDir, 'index.html'), 'r');
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const opening = /^\s*(?:<!doctype html>\s*)?<html\b([^>]*)>/i.exec(buffer.toString('utf8', 0, bytesRead));
    if (!opening) return undefined;
    const attributes = opening[1]!;
    const markers = attributes.match(/\bdata-site-(?:primary|locales)\b/g) ?? [];
    if (markers.length === 0) return legacyRedirect(rawUrl, DEFAULT_LANGUAGE);
    if (markers.length !== 2) return undefined;
    const values: Record<string, string> = {};
    const matches = attributes.matchAll(/\s(data-site-(?:primary|locales))\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g);
    for (const match of matches) {
      const name = match[1]!;
      if (Object.hasOwn(values, name)) return undefined;
      values[name] = match[2] ?? match[3] ?? match[4]!;
    }
    if (Object.keys(values).length !== 2) return undefined;
    const language = validateLanguage({
      primary: values['data-site-primary'],
      locales: values['data-site-locales']!.split(','),
    });
    return legacyRedirect(rawUrl, language);
  } catch {
    // No read-error or integrity-error fallback, and no dependency on Postgres.
    return undefined;
  } finally {
    await file?.close();
  }
}
