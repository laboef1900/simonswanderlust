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
  var STATUSES = ['draft', 'published', 'unpublished', 'missing-en'];
  var SORTS = ['updated', 'date', 'title'];
  var ORDERS = ['desc', 'asc'];
  var MAX_QUERY_LENGTH = 200;

  function text(v) {
    return typeof v === 'string' ? v : '';
  }

  /**
   * Thumbnail URL for a post summary, or null when there is no usable hero.
   *
   * `heroSrc` is a base URL with no width/format suffix, and `variantWidths()`
   * never upscales. `min(640, heroWidth)` is therefore the smallest generated
   * width. `heroFormat: "jpeg"` selects JPEG-only variants; omission preserves
   * the existing WebP thumbnail.
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
    var format = post && post.heroFormat;
    if (!src) return null;
    if (typeof width !== 'number' || !isFinite(width) || Math.floor(width) !== width || width <= 0) return null;
    if (format !== undefined && format !== 'jpeg') return null;
    return src + '-' + Math.min(SMALLEST_WIDTH, width) + '.' + (format || 'webp');
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
    var cats = Array.isArray(post.categories) ? post.categories.join(' ') : '';
    var tags = Array.isArray(post.tags) ? post.tags.join(' ') : '';
    var haystack = [post.titleDe, post.slugDe, post.slugEn, post.country, cats, tags]
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
   * `unpublished` and `missing-en` are readiness states derived from the
   * summary fields; draft/published retain their existing meaning.
   */
  function apply(posts, opts) {
    var o = opts || {};
    var needle = text(o.q).trim().toLowerCase();
    var status = text(o.status);
    var region = text(o.region);
    var country = text(o.country);
    var filtered = (posts || []).filter(function (p) {
      if (status === 'unpublished' && p.hasUnpublishedChanges !== true) return false;
      if (status === 'missing-en' && p.hasEnBody !== false) return false;
      if (status && status !== 'unpublished' && status !== 'missing-en' && p.status !== status) return false;
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

  /**
   * Read filter state from a URL query. Every enum is allow-listed, country is
   * checked against the loaded inventory, and free text is bounded before it
   * reaches a control. Invalid/stale values fall back to the inventory default.
   */
  function fromSearch(search, availableCountries) {
    var params = new URLSearchParams(typeof search === 'string' ? search : '');
    var q = text(params.get('q')).slice(0, MAX_QUERY_LENGTH);
    var status = text(params.get('status'));
    var region = text(params.get('region'));
    var country = text(params.get('country'));
    var sort = text(params.get('sort'));
    var order = text(params.get('order'));
    return {
      q: q,
      status: STATUSES.indexOf(status) !== -1 ? status : '',
      region: REGIONS.indexOf(region) !== -1 ? region : '',
      country: (availableCountries || []).indexOf(country) !== -1 ? country : '',
      sort: SORTS.indexOf(sort) !== -1 ? sort : 'updated',
      order: ORDERS.indexOf(order) !== -1 ? order : 'desc',
    };
  }

  /** Compact canonical query string: defaults stay out of the URL. */
  function toSearch(opts) {
    var o = opts || {};
    var params = new URLSearchParams();
    var q = text(o.q).slice(0, MAX_QUERY_LENGTH);
    if (q) params.set('q', q);
    if (STATUSES.indexOf(o.status) !== -1) params.set('status', o.status);
    if (REGIONS.indexOf(o.region) !== -1) params.set('region', o.region);
    if (text(o.country)) params.set('country', text(o.country));
    if (SORTS.indexOf(o.sort) !== -1 && o.sort !== 'updated') params.set('sort', o.sort);
    if (ORDERS.indexOf(o.order) !== -1 && o.order !== 'desc') params.set('order', o.order);
    return params.toString();
  }

  /** Number of non-default controls currently hidden inside “More filters”. */
  function extraFilterCount(opts) {
    var o = opts || {};
    return Number(Boolean(o.region)) + Number(Boolean(o.country)) +
      Number(o.sort && o.sort !== 'updated') + Number(o.order && o.order !== 'desc');
  }

  return {
    REGIONS: REGIONS,
    apply: apply,
    countries: countries,
    extraFilterCount: extraFilterCount,
    fromSearch: fromSearch,
    thumbUrl: thumbUrl,
    toSearch: toSearch,
  };
})();
