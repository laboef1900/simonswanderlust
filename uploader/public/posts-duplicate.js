// "New from this one" — the copy semantics for duplicating a post.
//
// Pure logic, extracted from posts.html so it is testable in the `vm` sandbox
// (same precedent as draft-guard.js / posts-filter.js / media-api.js). The
// whole feature is client-side: GET the pair → mutate the JSON → POST it back.
// `POST /posts` already mints a fresh translationKey via `randomUUID()` on the
// empty-key path, so there is no new endpoint and no new store method.
//
// The principle: **structure copies, identity resets.** The feature exists
// because key facts, stops, region and country code repeat across trips in the
// same region; the things that make a post *that trip* must not come along.
window.PostsDuplicate = (function () {
  /**
   * Fields that carry over vs. reset — signed off on the issue, and two of
   * these are correctness rather than preference:
   *
   *   · `images` COPIES, and is not optional. `body-images.ts` skips any image
   *     absent from the map, so copying a body without it silently breaks every
   *     photo in the post.
   *   · `coordinates` RESETS. A copy of a Norway trip must not silently claim
   *     Norway's coordinates. {lat:0,lng:0} is the established incomplete-draft
   *     placeholder — `draftWithDefaults` writes it and the preview skips
   *     rendering it, so it reads as "not set yet" everywhere.
   *
   * @ai-warning `date` resets to TODAY, not to empty. `posts.date` is
   * `date NOT NULL` with no default and Postgres rejects `''` outright
   * ("invalid input syntax for type date"), so a blank date cannot be saved at
   * all — verified against the real database. Today is the honest reset for a
   * brand-new draft, and the author overwrites it before publishing.
   */
  function duplicatePayload(pair, slugs, today) {
    // Duck-typed, not `instanceof Date`: that compares against THIS realm's
    // Date constructor, so a Date handed in from another realm (an iframe, or
    // the vm sandbox the unit tests use) would silently fall through to "now"
    // and make the reset date untestable.
    var now = today && typeof today.getUTCFullYear === 'function' ? today : new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var isoDate = now.getUTCFullYear() + '-' + pad(now.getUTCMonth() + 1) + '-' + pad(now.getUTCDate());
    // Deep-copy every carried structure. The caller serializes this straight to
    // JSON and navigates away, so aliasing is harmless TODAY — but the function
    // reads as a copy, is unit-tested as a copy, and the moment anything mutates
    // the payload before sending (adding a default, stripping a field) it would
    // silently edit the SOURCE post's in-memory object too.
    //
    // @ai-warning JSON round-trip, not structuredClone: this file also runs
    // inside `vm.runInNewContext` in the unit tests, where only ECMAScript
    // intrinsics exist — `structuredClone` is a host global and is undefined
    // there. JSON is lossless for this payload, which is JSON on the wire anyway.
    var clone = function (v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };
    var locale = function (src, slug) {
      return {
        locale: src.locale,
        slug: slug,
        title: src.title,                 // the author rewrites it; an empty one blocks validateDraft
        excerpt: src.excerpt,
        country: src.country,             // the repeating structure this feature exists for
        heroImage: clone(src.heroImage),  // cheap to replace; a placeholder would just mean re-uploading
        bodyMarkdown: src.bodyMarkdown,
        images: clone(src.images) || {},  // mandatory — see above
        // Spread only when present so the copy does not gain an empty key the source never had.
        ...(src.keyFacts && Object.keys(src.keyFacts).length ? { keyFacts: clone(src.keyFacts) } : {}),
      };
    };
    return {
      // Empty key ⇒ the store mints a new translation_key. Never reuse the
      // source's, or the copy would overwrite it.
      translationKey: '',
      status: 'draft',             // the store forces this anyway (existing?.status ?? 'draft')
      shared: {
        date: isoDate,                       // reset (identity)
        coordinates: { lat: 0, lng: 0 },     // reset (identity) — see @ai-warning
        countryCode: pair.shared.countryCode,
        region: pair.shared.region,
        // The repeating structure this feature exists for. Spread only when
        // present so the copy does not gain empty keys the source never had.
        ...(pair.shared.route ? { route: pair.shared.route } : {}),
        ...(pair.shared.stops && pair.shared.stops.length ? { stops: clone(pair.shared.stops) } : {}),
      },
      de: locale(pair.de, slugs.de),
      en: locale(pair.en, slugs.en),
    };
  }

  /**
   * Validate the two slugs the dialog asks for BEFORE anything is created.
   * Returns an error message, or null when both are usable.
   *
   * @ai-note Slugs are asked for up front rather than derived, deliberately:
   * they are an SEO contract (Golden Rule 2) and a silently-derived one is the
   * kind of thing that gets published by accident. It also sidesteps a
   * pre-existing bug — a slugless draft collides with itself, because the
   * uniqueness check still runs on the empty string, so "copy with blank slugs
   * and let the author fill them in" would 409 on the second one.
   */
  var SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
  function slugError(slugs) {
    if (!slugs || !slugs.de || !slugs.de.trim()) return 'A German slug is required.';
    if (!slugs.en || !slugs.en.trim()) return 'An English slug is required.';
    if (!SLUG_RE.test(slugs.de.trim())) return 'Invalid German slug (lowercase a-z, 0-9, hyphen).';
    if (!SLUG_RE.test(slugs.en.trim())) return 'Invalid English slug (lowercase a-z, 0-9, hyphen).';
    if (slugs.de.trim() === slugs.en.trim()) {
      // Not fatal server-side (uniqueness is per locale) but almost certainly a
      // mistake, and it makes the two language URLs indistinguishable.
      return 'The DE and EN slugs should differ.';
    }
    return null;
  }

  return { duplicatePayload: duplicatePayload, slugError: slugError };
})();
