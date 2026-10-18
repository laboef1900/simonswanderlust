// Media library AI details: title, alt text and caption (DE + EN) and tags,
// suggested by the caption vision provider, browser-direct. NO DOM ACCESS —
// media-browser.js owns the page; this half is unit-tested in a `vm` sandbox
// like media-api.js.
//
// @ai-note Three write rules carry the bulk run, all deliberate:
//   1. A suggestion never CLEARS a field: an empty model value is never written.
//   2. Without `replace`, only empty fields are filled, decided against the row
//      re-read right before its PATCH — not the list snapshot the run started
//      from — so text saved elsewhere during a slow model call survives. That
//      also makes a stopped or failed run resumable: run it again.
//   3. Stop means stop: no PATCH is sent once the signal has aborted.
// @ai-context docs/superpowers/specs/2026-10-18-media-ai-details-design.md
window.MediaAi = (function () {
  /** A run stops after this many failures in a row: a down provider, a wrong
   *  key or a model that cannot see images is one problem, not 300. */
  const MAX_CONSECUTIVE_FAILURES = 3;
  /** MAX_PAGE_SIZE in src/media-store.ts; the server clamps anything larger. */
  const PAGE_SIZE = 200;
  const FIELDS = ['title', 'alt', 'caption', 'tags'];
  const LOCALES = ['de', 'en'];

  function text(value) { return typeof value === 'string' ? value.trim() : ''; }

  function chosen(fields) { return FIELDS.filter((field) => fields && fields[field]); }

  /** The suggestion's value for one slot: '' when the model left it out. */
  function suggested(suggestion, field, locale) {
    if (field === 'title') return text(suggestion.title);
    return text(suggestion[field + (locale === 'de' ? 'De' : 'En')]);
  }

  function suggestedTags(suggestion) {
    return Array.isArray(suggestion.tags) ? suggestion.tags.map(text).filter(Boolean) : [];
  }

  function isEmpty(item, field, locale) {
    if (field === 'title') return !text(item.title);
    if (field === 'tags') return !(item.tags && item.tags.length);
    return !text(item[field] && item[field][locale]);
  }

  /** True when a run would send this photo to the model at all. */
  function needsWork(item, fields, replace) {
    const selected = chosen(fields);
    if (!selected.length) return false;
    if (replace) return true;
    return selected.some((field) => field === 'title' || field === 'tags'
      ? isEmpty(item, field)
      : LOCALES.some((locale) => isEmpty(item, field, locale)));
  }

  function countWork(items, fields, replace) {
    return items.filter((item) => needsWork(item, fields, replace)).length;
  }

  /** True when the suggestion carries a value for at least one selected slot. */
  function hasAny(suggestion, fields) {
    return chosen(fields).some((field) => {
      if (field === 'tags') return suggestedTags(suggestion).length > 0;
      if (field === 'title') return !!suggested(suggestion, 'title');
      return LOCALES.some((locale) => !!suggested(suggestion, field, locale));
    });
  }

  /**
   * The minimal PATCH /media/items/* body for one photo, or null when nothing
   * would change. alt/caption carry only the locales being written, so the
   * other locale is never sent back stale.
   */
  function patchFor(item, suggestion, fields, replace) {
    const patch = {};
    for (const field of chosen(fields)) {
      if (field === 'title') {
        const title = suggested(suggestion, 'title');
        if (title && (replace || isEmpty(item, 'title')) && title !== item.title) patch.title = title;
      } else if (field === 'tags') {
        const tags = suggestedTags(suggestion);
        const current = item.tags || [];
        if (tags.length && (replace || isEmpty(item, 'tags')) && tags.join('\n') !== current.join('\n')) patch.tags = tags;
      } else {
        for (const locale of LOCALES) {
          const value = suggested(suggestion, field, locale);
          const have = (item[field] && item[field][locale]) || '';
          if (value && (replace || isEmpty(item, field, locale)) && value !== have) {
            (patch[field] = patch[field] || {})[locale] = value;
          }
        }
      }
    }
    return Object.keys(patch).length ? patch : null;
  }

  /**
   * The display variant to send to the model, or null. Only HTTP(S) URLs on
   * the image origin or this page's origin, without credentials — the rule the
   * editor's gallery previews apply (previewUrl in editor-galleries.js).
   */
  function photoUrl(item, imageOrigin, pageOrigin) {
    if (!item || item.status !== 'ready' || typeof item.thumbSrc !== 'string' || !item.thumbSrc) return null;
    try {
      const url = new URL(item.thumbSrc, pageOrigin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      return url.origin === imageOrigin || url.origin === pageOrigin ? url.href : null;
    } catch {
      return null;
    }
  }

  /**
   * Suggest details for one photo with a caption config the caller loaded
   * (AltSuggest.loadConfig) and owns, including its request-local key. The
   * download + resize get their own 15 s deadline, as in suggestHosted; the
   * model call keeps the configured caption timeout.
   */
  async function suggest(url, config, signal) {
    const preparation = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    let prep;
    try {
      prep = await window.AltSuggest.prepHosted(url, config.captionMaxEdge, preparation);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('Photo download failed: ' + (error && error.message ? error.message : 'unknown error'));
    }
    return window.LLM.describePhoto(config.captionBaseUrl, config.lmModel, config.captionPrompt,
      prep.dataUrl, config.captionTimeoutMs, signal, config.captionApiKey);
  }

  /**
   * Every photo a list query matches, across pages. `list(page, pageSize)`
   * resolves `{ items, total }`; a row that shifted pages between requests is
   * kept once.
   */
  async function collectAll(list, signal) {
    const items = [];
    const seen = new Set();
    for (let page = 1; ; page++) {
      if (signal) signal.throwIfAborted();
      const res = await list(page, PAGE_SIZE);
      for (const item of res.items) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        items.push(item);
      }
      if (!res.items.length || page * PAGE_SIZE >= res.total) return items;
    }
  }

  function message(error) {
    return error && error.message ? String(error.message) : 'unknown error';
  }

  /**
   * Generate and save details for `items`, one photo at a time.
   *
   * opts: { items, fields, replace, config, client: { get, patch }, imageOrigin,
   *         pageOrigin, signal, onProgress?(report), describe? }
   * `describe(url, config, signal)` defaults to suggest() and is a test seam.
   * Resolves with the final report; a per-photo failure is recorded, never thrown.
   * report.stopped: null (finished) | 'cancelled' | 'failures'.
   */
  async function runBulk(opts) {
    const { items, fields, replace, config, client, signal } = opts;
    const describe = opts.describe || suggest;
    const report = { total: items.length, processed: 0, saved: 0, skipped: 0, failed: [], stopped: null, current: null };
    const emit = () => {
      if (opts.onProgress) opts.onProgress({ ...report, failed: report.failed.slice() });
    };
    let streak = 0;

    async function one(item) {
      if (!needsWork(item, fields, replace)) return 'skipped';
      const url = photoUrl(item, opts.imageOrigin, opts.pageOrigin);
      if (!url) throw new Error('No hosted display image for this photo');
      const suggestion = await describe(url, config, signal);
      if (!hasAny(suggestion, fields)) throw new Error('The model returned none of the selected fields');
      signal.throwIfAborted();
      let fresh;
      try { fresh = await client.get(item.key); } catch (error) { throw new Error('Could not re-read the photo: ' + message(error)); }
      const patch = patchFor(fresh, suggestion, fields, replace);
      if (!patch) return 'skipped';
      signal.throwIfAborted();
      try { await client.patch(item.key, patch); } catch (error) { throw new Error('Could not save: ' + message(error)); }
      return 'saved';
    }

    for (const item of items) {
      if (signal.aborted) { report.stopped = 'cancelled'; break; }
      report.current = item.key;
      emit();
      try {
        const outcome = await one(item);
        report[outcome] += 1;
        streak = 0;
      } catch (error) {
        if (signal.aborted) { report.stopped = 'cancelled'; break; }
        report.failed.push({ key: item.key, reason: message(error) });
        streak += 1;
      }
      report.processed += 1;
      if (streak >= MAX_CONSECUTIVE_FAILURES) { report.stopped = 'failures'; break; }
    }
    report.current = null;
    emit();
    return report;
  }

  return {
    MAX_CONSECUTIVE_FAILURES, PAGE_SIZE,
    needsWork, countWork, patchFor, photoUrl, suggest, collectAll, runBulk,
  };
})();
