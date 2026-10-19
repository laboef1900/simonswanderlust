// Current Media rows for the editor's gallery photos.
//
// Gallery alt text and captions come from the media library at build time,
// in each locale, empty strings included; a photo with no library row keeps
// the post's own copy (docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md).
// The editor must show the same thing, so the gallery widgets and the picker
// ask this resolver which photos have a row and what it currently says.
//
// Read-only by construction: it calls GET /media and GET /media/items/* through
// MediaApi's authorized client and nothing else. Editing an article must never
// write to Media as a side effect. No DOM access, so it runs in a `vm` sandbox
// (test/gallery-library.test.ts).
window.GalleryLibrary = (function () {
  // Mirrors SAFE_KEY_RE, MAX_KEY_LEN and the traversal checks of assertSafeKey
  // in src/storage.ts. A URL that cannot be a stored key cannot have a row, and
  // a `..` segment must never reach the request path, where fetch would
  // normalize it into a different route.
  var KEY_RE = /^[a-z0-9][a-z0-9/_-]*$/;
  var MAX_KEY_LEN = 200;

  function safeKey(key) {
    return typeof key === 'string' && key.length <= MAX_KEY_LEN && KEY_RE.test(key)
      && key.indexOf('..') < 0 && key.indexOf('//') < 0 && key.charAt(key.length - 1) !== '/';
  }

  function textOf(map, locale) {
    if (!map || typeof map !== 'object') return '';
    var value = map[locale];
    return typeof value === 'string' ? value : '';
  }

  /** The descriptions a row gives one locale. Title is a label, never alt. */
  function describe(row, locale) {
    return {
      alt: textOf(row && row.alt, locale),
      caption: textOf(row && row.caption, locale),
      title: row && typeof row.title === 'string' ? row.title : '',
      key: row && typeof row.key === 'string' ? row.key : '',
    };
  }

  /**
   * create({ client, imageOrigin, concurrency? })
   *
   * Entries are `{ row }` (a library row whose `src` is exactly the photo URL),
   * `{ missing: true }` (no row — the post's copy stays in charge) or
   * `{ error }` (unknown; never cached, so the next lookup retries).
   */
  function create(opts) {
    var o = opts || {};
    var client = o.client;
    var imageOrigin = o.imageOrigin;
    var limit = Math.max(1, o.concurrency || 4);
    var cache = new Map();
    var inflight = new Map();
    var basePromise = null;
    var generation = 0;
    var running = 0;
    var queue = [];

    function pump() {
      while (running < limit && queue.length) {
        var job = queue.shift();
        running++;
        job.run().then(job.resolve, job.reject).then(function () { running--; pump(); });
      }
    }
    function throttled(run) {
      return new Promise(function (resolve, reject) {
        queue.push({ run: run, resolve: resolve, reject: reject });
        pump();
      });
    }

    /**
     * The image base URL, read off any library row (`src` is `${base}/${key}`).
     * The page knows only the image ORIGIN, and assuming the base has no path
     * would silently miss every row on a deployment where it does. An empty
     * library resolves to null: no photo can have a row.
     */
    function base() {
      if (!basePromise) {
        var mine = generation;
        var pending = client.list({ page: 1, pageSize: 1 }).then(function (res) {
          var row = res && Array.isArray(res.items) ? res.items[0] : undefined;
          if (!row) return null;
          if (typeof row.src !== 'string' || !safeKey(row.key)
            || row.src.slice(-(row.key.length + 1)) !== '/' + row.key) throw new Error('unexpected media row');
          return row.src.slice(0, row.src.length - row.key.length - 1);
        });
        basePromise = pending;
        pending.catch(function () { if (generation === mine && basePromise === pending) basePromise = null; });
      }
      return basePromise;
    }

    function keyFor(src, imageBase) {
      if (imageBase === null) return null;
      var url;
      try { url = new URL(src); } catch (_) { return null; }
      // Origin equality, the renderer's own gallery rule — never a prefix match.
      if (url.origin !== imageOrigin || url.username || url.password || url.search || url.hash) return null;
      if (src.indexOf(imageBase + '/') !== 0) return null;
      var key = src.slice(imageBase.length + 1);
      return safeKey(key) ? key : null;
    }

    function fetchEntry(src) {
      return base().then(function (imageBase) {
        var key = keyFor(src, imageBase);
        if (!key) return { missing: true };
        return throttled(function () { return client.get(key); }).then(function (row) {
          // The site matches the exact URL; so does the editor.
          return row && row.src === src ? { row: row } : { missing: true };
        }, function (error) {
          if (error && error.status === 404) return { missing: true };
          throw error;
        });
      }).catch(function (error) { return { error: error || new Error('lookup failed') }; });
    }

    function entryFor(src, fresh) {
      if (!fresh && cache.has(src)) return Promise.resolve(cache.get(src));
      if (inflight.has(src)) return inflight.get(src);
      var mine = generation;
      var pending = fetchEntry(src).then(function (entry) {
        if (generation === mine) {
          inflight.delete(src);
          if (!entry.error) cache.set(src, entry);
        }
        return entry;
      });
      inflight.set(src, pending);
      return pending;
    }

    /**
     * lookup(srcs, { fresh }) → Promise<Map<src, entry>>. Each URL is requested
     * at most once at a time, however many galleries or locales show it.
     * `fresh` skips settled results — the picker uses it, because a gallery is
     * about to be rewritten from what it returns.
     */
    function lookup(srcs, options) {
      var fresh = !!(options && options.fresh);
      var unique = [];
      (srcs || []).forEach(function (src) {
        if (typeof src === 'string' && src !== '' && unique.indexOf(src) < 0) unique.push(src);
      });
      return Promise.all(unique.map(function (src) {
        return entryFor(src, fresh).then(function (entry) { return [src, entry]; });
      })).then(function (pairs) { return new Map(pairs); });
    }

    /** A settled entry, synchronously; undefined while unknown. */
    function peek(src) { return cache.get(src); }

    /** Drop everything known. Late responses from before are then ignored. */
    function forget() {
      generation++;
      cache.clear();
      inflight.clear();
      basePromise = null;
    }

    return { lookup: lookup, peek: peek, forget: forget };
  }

  return { create: create, describe: describe };
})();
