// Legacy WordPress URL redirects (issue #35). The old WP site served a family
// of non-post URLs (feeds, auto-generated category archives) that the Astro
// rebuild has no routes for; the not-found handler in server.ts 301s them to
// their new equivalents so subscribers and indexed links survive the cutover.
//
// @ai-context The /reiseziele/... and /en/destinations/... region slugs are
// duplicated from site/src/lib/paths.ts `regionSlugs` (the uploader cannot
// import site sources). They are frozen by the SEO slug contract (CLAUDE.md
// Golden Rule 2), so the duplication is safe — keep both in sync regardless.
//
// @ai-note Deliberate non-redirects, decided in issue #35:
// - /wp-content/uploads/YYYY/MM/<file> image URLs are an accepted loss: the
//   old URL carries no post slug, so it cannot be mapped onto the new
//   `trips/<slug>/<filename-slug>` key scheme (wp-import.ts), a 301 would
//   have to pick a concrete width/format variant on the img host, and no
//   mapping table was persisted at import time.
// - /?p=<id> shortlinks resolve to `/` and serve the homepage — acceptable.
// - Tag/date archives are not mappable from repo data; extend the map below
//   once the real WXR inventory is available.

/**
 * Ordered legacy-URL map. Keys are normalized paths (no query string, no
 * trailing slash); targets are final post-cutover URLs (301s get cached
 * aggressively, so targets must be contract-frozen).
 */
export const LEGACY_REDIRECTS: ReadonlyArray<readonly [string, string]> = [
  // WordPress feed family → Astro-generated RSS feeds.
  ['/feed', '/rss.xml'],
  ['/feed/atom', '/rss.xml'],
  ['/comments/feed', '/rss.xml'],
  // Polylang per-language feed URLs for the EN tree.
  ['/en/feed', '/en/rss.xml'],
  ['/en/feed/atom', '/en/rss.xml'],
  ['/en/comments/feed', '/en/rss.xml'],
  // WP auto category archives → region pages (slugs from paths.ts regionSlugs).
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
export function legacyRedirect(rawUrl: string): string | undefined {
  const path = rawUrl.split('?', 1)[0] ?? '';
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return lookup.get(normalized);
}
