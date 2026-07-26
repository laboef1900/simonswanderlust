// Pure search/filter/sort helpers for the posts list, plus the hero-thumbnail
// URL math. Extracted from posts.html's inline script so it is testable —
// admin-pages.test.ts runs this IIFE in a `vm` sandbox, the same way it tests
// draft-guard.js. DOM wiring stays inline in the page; nothing here touches
// the DOM or the network.
//
// @ai-note Filtering is CLIENT-side on purpose: `GET /posts` returns the whole
// list, which at ~20 posts is a few KB. Move it server-side when the payload
// or row count makes the full load noticeable — realistically a few hundred
// posts, or sooner if PostSummary grows large fields. The list query is
// already narrowed to summary columns (see PostListRow in posts.ts), so the
// remaining cost is roughly linear in row count.
window.PostsFilter = (function () {
  // Closed set, enforced by validateForPublish (REGIONS in posts.ts) — so the
  // region filter is a fixed dropdown. `country` is free text and must be
  // derived from the loaded rows instead.
  var REGIONS = ['europe', 'north-america', 'south-america'];

  /** Standard variant widths, mirroring uploader/src/variants.ts WIDTHS. */
  var SMALLEST_WIDTH = 640;

  function text(v) {
    return typeof v === 'string' ? v : '';
  }

  /**
   * Thumbnail URL for a post summary, or null when there is no usable hero.
   *
   * `heroSrc` is a base URL with no width/format suffix, and `variantWidths()`
   * never upscales: a hero narrower than 640px has no `-640.webp`, only
   * `-<intrinsicWidth>.webp`. `min(640, heroWidth)` is correct for every case
   * because 640 is the smallest standard width. webp matches what GET /images
   * picks for its own thumbnails.
   *
   * Returns null for the empty-src draft placeholder (two independent sources
   * of it: PLACEHOLDER_HERO in posts.ts and another in wp-import.ts) and for a
   * non-positive-integer width, since heroWidth comes from unverified jsonb.
   * The caller should ALSO wire an onerror fallback — a width that is a
   * plausible integer but wrong still yields a 404.
   */
  function thumbUrl(post) {
    var src = text(post && post.heroSrc);
    var width = post && post.heroWidth;
    if (!src) return null;
    if (typeof width !== 'number' || !isFinite(width) || Math.floor(width) !== width || width <= 0) return null;
    return src + '-' + Math.min(SMALLEST_WIDTH, width) + '.webp';
  }

  /** Free-text countries present in the loaded rows, de-duplicated and sorted. */
  function countries(posts) {
    var seen = {};
    var out = [];
    (posts || []).forEach(function (p) {
      var c = text(p && p.country).trim();
      if (c && !Object.prototype.hasOwnProperty.call(seen, c)) { seen[c] = true; out.push(c); }
    });
    return out.sort(function (a, b) { return a.localeCompare(b); });
  }

  function matchesQuery(post, needle) {
    if (!needle) return true;
    var haystack = [post.titleDe, post.slugDe, post.slugEn, post.country]
      .map(text).join(' ').toLowerCase();
    return haystack.indexOf(needle) !== -1;
  }

  var SORTERS = {
    updated: function (a, b) { return new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0); },
    date: function (a, b) { return text(a.date).localeCompare(text(b.date)); },
    title: function (a, b) { return text(a.titleDe).localeCompare(text(b.titleDe)); },
  };

  /**
   * opts: { q, status, region, country, sort, order }. Every field is optional;
   * unknown `sort` falls back to 'updated' and unknown `order` to 'desc', so a
   * stale bookmark or a hand-edited control can never produce a broken list.
   */
  function apply(posts, opts) {
    var o = opts || {};
    var needle = text(o.q).trim().toLowerCase();
    var status = text(o.status);
    var region = text(o.region);
    var country = text(o.country);
    var filtered = (posts || []).filter(function (p) {
      if (status && p.status !== status) return false;
      if (region && p.region !== region) return false;
      if (country && p.country !== country) return false;
      return matchesQuery(p, needle);
    });
    // @ai-warning: own-property lookup, not `SORTERS[o.sort]`. `sort` comes
    // from a query-string-ish control, and a bare index would resolve
    // 'toString' / 'valueOf' to an Object.prototype method — which is truthy,
    // so the `|| SORTERS.updated` fallback never fires and the list silently
    // sorts by a comparator that returns a string.
    var sorter = Object.prototype.hasOwnProperty.call(SORTERS, o.sort) ? SORTERS[o.sort] : SORTERS.updated;
    var sign = o.order === 'asc' ? 1 : -1;
    // Sort a copy: callers keep the fetched array as the unfiltered source.
    return filtered.slice().sort(function (a, b) { return sign * sorter(a, b); });
  }

  return { REGIONS: REGIONS, apply: apply, countries: countries, thumbUrl: thumbUrl };
})();
