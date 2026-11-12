// Media library: transport, state and pure helpers. NO DOM ACCESS AT ALL —
// that is what makes this half testable in the `vm` sandbox (see
// media-api.test.ts, following the draft-guard.js precedent).
//
// @ai-warning The upload queue uses XMLHttpRequest, not fetch(): fetch cannot
// report upload progress, and a 100-photo batch with no progress bar is
// unusable. That means it is the ONE admin request path that does not go
// through Auth's shared 401 handling, so it carries its own — see `onUnauthed`.
window.MediaApi = (function () {
  /** Browser-side upload concurrency. Transfer-bound, so higher than the
   *  server's encode concurrency (2, which is CPU/memory-bound and enforced
   *  server-side because a client limit is advisory — a second tab bypasses it). */
  var UPLOAD_CONCURRENCY = 3;
  /** The server's multipart `fileSize` cap (src/server.ts). The server stays
   *  authoritative; this only spares a phone a 25 MB transfer it would refuse. */
  var MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

  /**
   * Why a picked file is not sent at all, or null to send it. Only what the
   * browser can know for certain: size, a non-image type, and HEIC/HEIF, which
   * the shipped sharp build cannot decode (it reads only the AV1 flavour of
   * HEIF, i.e. AVIF — src/pipeline.ts). A missing type or size is never a
   * reason: the server decides.
   */
  function uploadRefusal(file) {
    var type = typeof file.type === 'string' ? file.type.toLowerCase() : '';
    // The name only decides when the browser supplies no type: a transcoded
    // JPEG that kept its .HEIC name is still sent.
    if (/^image\/hei[cf](-sequence)?$/.test(type) || (!type && /\.hei[cf]$/i.test(String(file.name || '')))) return 'heic';
    if (type && type.indexOf('image/') !== 0) return 'not_image';
    if (typeof file.size === 'number' && file.size > MAX_UPLOAD_BYTES) return 'too_large';
    return null;
  }

  // ---- pure helpers -------------------------------------------------------

  /** Human-readable byte size; mirrors formatBytes in src/disk.ts. */
  function formatBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '0 B';
    var units = ['B', 'kB', 'MB', 'GB', 'TB'];
    var v = n;
    var i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
  }

  /**
   * A server message as a sentence: capital, full stop. Server strings are
   * lowercase codes or fragments ("invalid folder"); the author reads
   * "Could not …: Invalid folder."
   */
  function sentence(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return '';
    t = t.charAt(0).toUpperCase() + t.slice(1);
    return /[.!?]$/.test(t) ? t : t + '.';
  }

  // One segment of a folder path, as media-conditional.js accepts it: 1–64
  // characters, letters/digits at both ends, letters, digits, spaces, `_`, `.`
  // and `-` between. Nesting and total length are capped there as well.
  var FOLDER_NAME_MAX = 64;
  var FOLDER_DEPTH_MAX = 6;
  var FOLDER_PATH_MAX = 200;

  /**
   * Why a folder name typed into the New folder / Rename folder prompt cannot
   * be used, as a sentence — or '' when the server will accept it under
   * `parent`. Checked here so the refusal reads under the field instead of
   * arriving as a raw server error after the request.
   */
  function folderNameRefusal(name, parent) {
    var text = String(name == null ? '' : name).trim().normalize('NFC');
    if (!text) return 'Enter a folder name.';
    if (text.indexOf('/') !== -1) return 'A folder name cannot contain a slash. Create one level at a time.';
    if (/[\p{C}\p{Zl}\p{Zp}]/u.test(text)) return 'A folder name cannot contain control or invisible characters.';
    if (text.length > FOLDER_NAME_MAX) return 'A folder name can be at most ' + FOLDER_NAME_MAX + ' characters.';
    if (!/^[\p{L}\p{N}]/u.test(text) || !/[\p{L}\p{N}]$/u.test(text)) return 'A folder name must start and end with a letter or a digit.';
    if (!/^[\p{L}\p{N} _.\-]*$/u.test(text)) return 'A folder name can contain only letters, digits, spaces, hyphens, underscores and dots.';
    var path = parent ? parent + '/' + text : text;
    if (path.split('/').length > FOLDER_DEPTH_MAX) return 'Folders can be nested at most ' + FOLDER_DEPTH_MAX + ' levels deep.';
    if (path.length > FOLDER_PATH_MAX) return 'The full folder path can be at most ' + FOLDER_PATH_MAX + ' characters.';
    // The shared rule set has the last word, so the two can never drift apart silently.
    try { window.MediaConditional.assertSafeFolder(path); }
    catch (_) { return 'This folder name cannot be used.'; }
    return '';
  }

  /**
   * Selection range math for shift-click / Shift+Arrow.
   * Returns the keys between anchor and target inclusive, in display order.
   */
  function rangeBetween(keys, anchorKey, targetKey) {
    var a = keys.indexOf(anchorKey);
    var b = keys.indexOf(targetKey);
    if (a === -1 || b === -1) return targetKey ? [targetKey] : [];
    return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  /** Folder tree nodes from the flat path list the server returns. */
  function folderTree(paths) {
    var nodes = [];
    (paths || []).slice().sort(function (a, b) { return a.localeCompare(b); }).forEach(function (p) {
      var segs = p.split('/');
      nodes.push({ path: p, name: segs[segs.length - 1], depth: segs.length - 1 });
    });
    return nodes;
  }

  /**
   * Parent of a folder path, or '' for a top-level one.
   * Used to keep the tree consistent after a delete.
   */
  function parentOf(path) {
    var i = String(path || '').lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i);
  }

  /** A single status label for the grid badge. */
  function statusLabel(item) {
    if (!item) return '';
    if (item.status === 'ready') return '';
    if (item.status === 'processing') return 'processing';
    if (item.status === 'missing') return 'file missing';
    return 'failed: ' + (item.error || 'unknown');
  }

  // ---- camera settings and stored versions (Photo details) ----------------

  /** What an exposure field holds when the camera recorded it: a positive, finite number. */
  function measured(value) {
    return typeof value === 'number' && isFinite(value) && value > 0 ? value : null;
  }

  /** Up to `decimals` decimals with trailing zeros dropped: 2.8, 8, 0.95. */
  function trimmed(value, decimals) {
    return String(Number(value.toFixed(decimals)));
  }

  /**
   * A shutter time in seconds, without its unit. Below one second cameras
   * record a reciprocal, so 0.004 reads "1/250" — but only when that reciprocal
   * really is the stored value: N ≥ 2 and within 1 % of it (the #371 reciprocal
   * rule). 0.8 s is not "1/1" and 0.3 s is not "1/3".
   */
  function shutter(seconds) {
    if (seconds >= 1) return trimmed(seconds, 1);
    var n = Math.round(1 / seconds);
    return n >= 2 && Math.abs(1 / n - seconds) <= 0.01 * seconds ? '1/' + n : trimmed(seconds, 2);
  }

  /**
   * Focal length, aperture, shutter time and ISO as one line — "24 mm · f/2.8 ·
   * 1/250 s · ISO 200" — without the parts the camera did not record; '' when
   * it recorded none of them. `equivalentLabel` ("equiv.") comes from the
   * page's copy, so this module stays dictionary-free; mm, f/, s and ISO are
   * notation, not copy.
   */
  function formatExposure(exif, equivalentLabel) {
    if (!exif) return '';
    var parts = [];
    var focal = measured(exif.focalLength);
    var focal35 = measured(exif.focalLength35mm);
    var equivalent = focal35 === null ? ''
      : Math.round(focal35) + ' mm' + (equivalentLabel ? ' ' + equivalentLabel : '');
    if (focal !== null) {
      // A 35 mm equivalent is whole millimetres: the same number twice says nothing.
      parts.push(trimmed(focal, focal >= 10 ? 0 : 1) + ' mm'
        + (equivalent && Math.round(focal35) !== Math.round(focal) ? ' (' + equivalent + ')' : ''));
    } else if (equivalent) {
      parts.push(equivalent);
    }
    var fNumber = measured(exif.fNumber);
    if (fNumber !== null) parts.push('f/' + trimmed(fNumber, 2));
    var seconds = measured(exif.exposureTime);
    if (seconds !== null) parts.push(shutter(seconds) + ' s');
    var iso = measured(exif.iso);
    if (iso !== null) parts.push('ISO ' + Math.round(iso));
    return parts.join(' · ');
  }

  // Format names are data, not copy: the same in every language.
  var VERSION_FORMATS = { avif: 'AVIF', webp: 'WebP', jpeg: 'JPEG' };

  /**
   * The `versions` member of `GET /media/items/*?versions=1` in the one shape
   * the panel renders, or null when a payload carries none (PATCH responses, a
   * 409's `current`, poll reads). A member that is not what the route promises
   * reads as unavailable — never as a shorter or stranger list.
   */
  function versionsOf(value) {
    if (value === undefined || value === null) return null;
    if (value.availability === 'processing') return { availability: 'processing' };
    var count = function (n) { return typeof n === 'number' && isFinite(n) && n >= 0; };
    var listed = value.availability === 'available' && Array.isArray(value.items) && value.items.every(function (v) {
      return !!v && Object.prototype.hasOwnProperty.call(VERSION_FORMATS, v.format)
        && count(v.width) && v.width > 0 && (v.height === null || count(v.height))
        && count(v.bytes) && typeof v.src === 'string';
    });
    if (!listed) return { availability: 'unavailable' };
    return { availability: 'available', items: value.items.map(function (v) {
      return { format: v.format, width: v.width, height: v.height, bytes: v.bytes, src: v.src };
    }) };
  }

  /** One stored version as a line: "AVIF · 1920 × 1280 · 412 kB". The height is a dash when its header could not be read. */
  function versionLabel(version) {
    return VERSION_FORMATS[version.format] + ' · ' + version.width + ' × '
      + (version.height === null ? '—' : version.height) + ' · ' + formatBytes(version.bytes);
  }

  /**
   * State label for one upload-queue row. A duplicate names the folder the
   * photo already lives in: the server keeps a curated folder on re-upload
   * (#135), so "done" alone would suggest it landed where the author dropped it.
   * A definite failure the author may send again reads as a sentence, never as
   * the server's raw string; a rejection (see uploadRejection) is worded by the
   * page from its reason.
   */
  function queueState(item) {
    if (item.state === 'uploading') return Math.round(item.progress * 100) + '%';
    if (item.state === 'failed') return 'Could not upload: ' + sentence(item.error || 'unknown error');
    if (item.state === 'done' && item.result && item.result.duplicate) {
      return 'already in ' + (item.result.folder || 'root');
    }
    return item.state;
  }

  /** Query string for GET /media from a filter state object. */
  function listQuery(state) {
    var s = state || {};
    var parts = [];
    var put = function (k, v) {
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    };
    // folder:'' is the ROOT filter, not "no filter" — pushed directly so the
    // empty-value skip in put() cannot swallow it.
    if (s.folder !== undefined && s.folder !== null) {
      parts.push('folder=' + encodeURIComponent(s.folder));
    }
    if (s.recursive) put('recursive', '1');
    put('q', s.q);
    put('tag', s.tag);
    put('status', s.status);
    put('alt', s.alt);
    put('sort', s.sort);
    put('order', s.order);
    put('page', s.page);
    put('pageSize', s.pageSize);
    return parts.length ? '?' + parts.join('&') : '';
  }

  /**
   * Trailing-edge debounce: `fn` runs once, `ms` after the LAST call in a
   * burst. Used for search-as-you-type so a word costs one request, not one
   * per keystroke.
   */
  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { timer = null; fn.apply(null, args); }, ms);
    };
  }

  /**
   * Monotonic tickets for in-flight loads. Responses arrive in any order —
   * "no" can answer after "norw" — so a loader takes a ticket before it
   * fetches and applies the response only while that ticket is still the
   * newest. Superseded responses are dropped, never merged.
   */
  function makeSequence() {
    var current = 0;
    return {
      next: function () { return ++current; },
      isCurrent: function (ticket) { return ticket === current; },
    };
  }

  // All public metadata writers use this leaf-level contract, including AI.
  function mediaLeaves(patch) {
    var leaves = [];
    Object.keys(patch).forEach(function (field) {
      if (field === 'alt' || field === 'caption') {
        Object.keys(patch[field]).forEach(function (locale) { leaves.push([field, locale]); });
      } else leaves.push([field]);
    });
    return leaves;
  }
  function leafValue(item, leaf) {
    return leaf.length === 2 ? (item[leaf[0]] || {})[leaf[1]] || '' : item[leaf[0]] || (leaf[0] === 'tags' ? [] : '');
  }
  function putLeaf(item, leaf, value) {
    if (leaf.length === 2) (item[leaf[0]] = item[leaf[0]] || {})[leaf[1]] = value;
    else item[leaf[0]] = value;
  }
  function expectations(patch, item, empty) {
    var expect = {};
    mediaLeaves(patch).forEach(function (leaf) {
      putLeaf(expect, leaf, empty ? (leaf[0] === 'tags' ? [] : '') : leafValue(item, leaf));
    });
    return window.MediaConditional.canonicalizePatch(expect);
  }
  function changedFields(values, base) {
    var canonical = window.MediaConditional.canonicalizePatch(values);
    var previous = expectations(canonical, base);
    var patch = {};
    mediaLeaves(canonical).forEach(function (leaf) {
      if (JSON.stringify(leafValue(canonical, leaf)) !== JSON.stringify(leafValue(previous, leaf))) {
        putLeaf(patch, leaf, leafValue(canonical, leaf));
      }
    });
    return patch;
  }
  function assertItem(item, key) {
    var invalid = function () { throw Object.assign(new Error('invalid_media_response'), { unknown: true }); };
    if (!item || typeof item !== 'object' || Array.isArray(item) || item.key !== key) invalid();
    var values = {};
    ['title', 'alt', 'caption', 'tags', 'folder'].forEach(function (field) {
      if (!Object.prototype.hasOwnProperty.call(item, field)) invalid();
      values[field] = item[field];
    });
    ['alt', 'caption'].forEach(function (field) {
      if (!values[field] || !Object.prototype.hasOwnProperty.call(values[field], 'de')
        || !Object.prototype.hasOwnProperty.call(values[field], 'en')) invalid();
    });
    try { window.MediaConditional.canonicalizePatch(values); } catch (_) { invalid(); }
    return item;
  }
  function compareFields(patch, expect, current, key) {
    var stored = expectations(patch, assertItem(current, key));
    return mediaLeaves(patch).map(function (leaf) {
      var intended = leafValue(patch, leaf);
      var expected = leafValue(expect, leaf);
      var value = leafValue(stored, leaf);
      return { field: leaf.join('.'), intended: intended, expected: expected, stored: value,
        outcome: JSON.stringify(value) === JSON.stringify(intended) ? 'achieved'
          : JSON.stringify(value) === JSON.stringify(expected) ? 'expected' : 'other' };
    });
  }
  async function savePatch(client, key, patch, expect) {
    var conditional = window.MediaConditional.canonicalizeConditional({
      conditional: { version: 1, patch: patch, expect: expect },
    });
    try {
      var saved = await client.patch(key, conditional.patch, conditional.expect);
      if (!saved || saved.conditionalVersion !== 1) {
        throw Object.assign(new Error('media_conditional_unsupported'), { unsupported: true });
      }
      var acknowledged = compareFields(conditional.patch, conditional.expect, saved, key);
      if (acknowledged.some(function (field) { return field.outcome !== 'achieved'; })) {
        throw Object.assign(new Error('invalid_media_response'), { unknown: true });
      }
      return saved;
    } catch (error) {
      if (error.unsupported) throw error;
      if (error.status === 409 && error.current) {
        try { error.fields = compareFields(conditional.patch, conditional.expect, error.current, key); }
        catch (invalidCurrent) { error.current = null; error.probeError = invalidCurrent; }
      } else if (isUnknown(error)) {
        error.unknown = true;
        error.current = null;
        error.fields = undefined;
        try {
          var current = await client.get(key);
          error.fields = compareFields(conditional.patch, conditional.expect, current, key);
          error.current = current;
        } catch (probeError) { error.probeError = probeError; }
      }
      throw error;
    }
  }

  // ---- transport ----------------------------------------------------------

  function makeClient(opts) {
    var onUnauthed = (opts && opts.onUnauthed) || function () {};
    var fetchImpl = (opts && opts.fetch) || window.fetch.bind(window);
    var XHR = (opts && opts.XMLHttpRequest) || window.XMLHttpRequest;

    async function request(method, url, body, bounded) {
      if (method !== 'GET' && url !== '/media/lookup' && opts && opts.canWrite && !opts.canWrite()) {
        throw Object.assign(new Error('session_ended'), { status: 401 });
      }
      var controller = bounded ? new AbortController() : null;
      var timer;
      var init = { method: method, cache: 'no-store' };
      if (controller) init.signal = controller.signal;
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      var work = async function () {
        var res = await fetchImpl(url, init);
        if (res.status === 401) { onUnauthed(); throw Object.assign(new Error('unauthorized'), { status: 401 }); }
        var parsed;
        try { parsed = await res.json(); } catch (e) {
          throw Object.assign(new Error('invalid_response'), { status: res.status, unknown: res.ok || res.status >= 500 });
        }
        if (!res.ok) throw Object.assign(new Error(parsed.error || ('HTTP ' + res.status)), {
          status: res.status, code: parsed.code, current: parsed.current, unknown: res.status >= 500,
        });
        return parsed;
      };
      try {
        if (!bounded) return await work();
        return await Promise.race([work(), new Promise(function (_, reject) {
          timer = setTimeout(function () { controller.abort(); reject(new Error('read_timeout')); }, 15000);
        })]);
      } finally { clearTimeout(timer); }
    }

    /**
     * Upload one file with progress. Its own 401 handling is deliberate:
     * this is the only path that does not go through the shared fetch wrapper.
     */
    function uploadOne(file, fields, handlers) {
      var h = handlers || {};
      return new Promise(function (resolve, reject) {
        var fd = new FormData();
        Object.keys(fields || {}).forEach(function (k) {
          if (fields[k] !== undefined && fields[k] !== null && fields[k] !== '') fd.append(k, fields[k]);
        });
        fd.append('file', file, file.name);
        var xhr = new XHR();
        var timer;
        var settled = false;
        function finish(error, body) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve(body);
        }
        function watchdog() {
          clearTimeout(timer);
          timer = setTimeout(function () {
            finish(Object.assign(new Error('upload_stalled'), { unknown: true }));
            xhr.abort();
          }, 120000);
        }
        xhr.open('POST', '/upload');
        if (xhr.upload) {
          xhr.upload.onprogress = function (e) {
            watchdog();
            if (e.lengthComputable && h.onProgress) h.onProgress(e.loaded / e.total);
          };
          xhr.upload.onload = watchdog;
        }
        xhr.onload = function () {
          if (xhr.status === 401) {
            onUnauthed();
            finish(Object.assign(new Error('unauthorized'), { status: 401 }));
            return;
          }
          var body;
          try { body = JSON.parse(xhr.responseText); } catch (e) { /* Classified below. */ }
          if (xhr.status >= 200 && xhr.status < 300 && body) finish(null, body);
          else finish(Object.assign(new Error(body && body.error || 'upload_unknown'), {
            status: xhr.status, code: body && body.code,
            unknown: xhr.status < 400 || xhr.status >= 500 || xhr.status === 429,
          }));
        };
        xhr.onerror = function () { finish(Object.assign(new Error('network_error'), { unknown: true })); };
        xhr.onabort = function () { finish(Object.assign(new Error('upload_aborted'), { unknown: true })); };
        watchdog();
        try { xhr.send(fd); } catch (e) { finish(Object.assign(e, { unknown: true })); }
      });
    }

    return {
      list: function (state) { return request('GET', '/media' + listQuery(state)); },
      get: function (key) { return request('GET', '/media/items/' + key, undefined, true); },
      patch: function (key, patch, expect) {
        var conditional = window.MediaConditional.canonicalizeConditional({ conditional: { version: 1, patch: patch, expect: expect } });
        return request('PATCH', '/media/items/' + key, { conditional: conditional });
      },
      remove: function (key) { return request('DELETE', '/media/items/' + key); },
      move: function (keys, folder) { return request('POST', '/media/move', { keys: keys, folder: folder }); },
      lookup: function (keys) { return request('POST', '/media/lookup', { keys: keys }, true); },
      me: function () { return request('GET', '/auth/me', undefined, true); },
      receipt: function (id) { return request('GET', '/upload/receipts/' + encodeURIComponent(id), undefined, true); },
      retry: function (keys) { return request('POST', '/media/retry', { keys: keys }); },
      rescan: function () { return request('POST', '/media/rescan'); },
      folders: function () { return request('GET', '/media/folders', undefined, true); },
      createFolder: function (path) { return request('POST', '/media/folders', { path: path }); },
      renameFolder: function (from, to) { return request('PATCH', '/media/folders', { from: from, to: to }); },
      deleteFolder: function (path) { return request('DELETE', '/media/folders', { path: path }); },
      queue: function () { return request('GET', '/media/queue'); },
      uploadOne: uploadOne,
    };
  }

  // ---- upload queue -------------------------------------------------------

  function isUnknown(error) {
    return !!error.unknown || !error.status || error.status >= 500 || error.status === 429;
  }

  /**
   * Why the server definitively refused the file itself, or null when the
   * failure is about something else. Sending the same bytes again can never
   * succeed, so such a row is `rejected`: not counted in or resent by "Send
   * upload again", and cleared with the finished ones. A 400 without a `code`
   * is the upload route's own verdict on the image ("expected an image file",
   * "invalid key or image", "could not read that image"); coded 400s describe
   * the request's identity, not the file.
   */
  function uploadRejection(error) {
    if (error.status === 413) return 'too_large';
    if (error.status === 400 && !error.code) return 'unreadable';
    return null;
  }

  /** One immutable file identity, never persisted. Only server retry generations
   * authorize retransmission after an uncertain request. */
  function createUploadAttempt(client, file, fields, ownerId, options) {
    var o = options || {};
    var frozen = Object.freeze(Object.assign({}, fields));
    var uploadId = (o.randomUUID || function () { return window.crypto.randomUUID(); })();
    var item = { uploadId: uploadId, ownerUserId: ownerId, state: o.refusal ? 'refused' : 'queued', progress: 0, result: null, error: o.refusal || null };
    var retryGeneration = 0;
    var unresolved = false;
    var busy = false;
    function changed() { if (o.onChange) o.onChange(view()); }
    function view() { return Object.assign({}, item); }
    function ownerMatches() { return !!ownerId && (!o.canAdopt || o.canAdopt(ownerId)); }
    function accept(body, probe) {
      if (!body || body.ownerUserId !== ownerId || body.uploadId !== uploadId || !ownerMatches()) return false;
      if (body.state === 'accepted') {
        var result = probe ? body.result : body;
        if (!result || typeof result.key !== 'string' || typeof result.src !== 'string'
          || !Number.isFinite(result.width) || result.width <= 0 || !Number.isFinite(result.height) || result.height <= 0) return false;
        item.result = result;
        item.state = 'done'; item.progress = 1; unresolved = false;
        return true;
      }
      if (body.state === 'retryable' && Number.isSafeInteger(body.retryGeneration) && body.retryGeneration > retryGeneration) {
        retryGeneration = body.retryGeneration;
        item.state = 'retryable'; unresolved = false;
        return true;
      }
      if (body.state === 'gone') { item.state = 'gone'; unresolved = false; return true; }
      if (body.state === 'pending') {
        item.reason = body.reason;
        item.originalRetained = body.originalRetained === true;
      }
      return false;
    }
    async function probe() {
      item.state = 'checking'; changed();
      try {
        if (!accept(await client.receipt(uploadId), true)) item.state = 'unknown';
      } catch (error) {
        item.state = 'unknown';
        if (error.status === 401 || error.code === 'owner_changed') {
          if (o.onPause) o.onPause();
        }
      }
      changed();
    }
    return {
      snapshot: view,
      send: async function () {
        if (busy || !ownerMatches() || ['queued', 'failed', 'needs-auth', 'retryable'].indexOf(item.state) === -1 || unresolved) return;
        busy = true; item.state = 'uploading'; item.error = null; item.progress = 0; changed();
        try {
          var body = await client.uploadOne(file, Object.assign({}, frozen, {
            uploadId: uploadId, expectedOwnerId: ownerId, retryGeneration: retryGeneration,
          }), { onProgress: function (p) { item.progress = p; changed(); } });
          if (!accept(body, false)) {
            unresolved = true;
            await probe();
          }
        } catch (error) {
          item.error = error.message;
          var rejection = unresolved ? null : uploadRejection(error);
          if (error.status === 401 || error.code === 'owner_changed') {
            item.state = unresolved ? 'unknown' : 'needs-auth';
            if (o.onPause) o.onPause();
          } else if (isUnknown(error) || error.code === 'upload_generation_changed') {
            unresolved = true; await probe();
          } else if (rejection) {
            item.state = 'rejected'; item.error = rejection;
          } else {
            item.state = unresolved ? 'unknown' : 'failed';
          }
        } finally { busy = false; changed(); }
      },
      check: async function () {
        if (busy || !ownerMatches() || item.state !== 'unknown') return;
        busy = true;
        try { await probe(); } finally { busy = false; changed(); }
      },
    };
  }

  /** Queue pause is independent of in-flight work: a 401 never cancels another
   * file's evidence. Resume is explicit and limited to the captured owner. */
  function createUploadQueue(client, opts) {
    var o = opts || {};
    var concurrency = o.concurrency || UPLOAD_CONCURRENCY;
    var onChange = o.onChange || function () {};
    var items = [];
    var running = 0;
    var nextId = 1;
    var paused = false;
    var currentOwner = null;
    var owner = null;
    function notify() { onChange(snapshot()); }
    function pause() { paused = true; notify(); }
    function pump() {
      while (!paused && running < concurrency) {
        var next = items.find(function (i) { return i.waiting; });
        if (!next) break;
        start(next);
      }
      notify();
    }
    function start(item) {
      item.waiting = false;
      running++;
      item.attempt.send().finally(function () { running--; pump(); });
    }
    function snapshot() {
      var rows = items.map(function (i) { return Object.assign({ id: i.id, name: i.name }, i.attempt.snapshot()); });
      return {
        items: rows, total: rows.length, paused: paused, ownerUserId: owner, currentOwnerId: currentOwner,
        done: rows.filter(function (i) { return i.state === 'done'; }).length,
        failed: rows.filter(function (i) { return i.state === 'failed' || i.state === 'retryable'; }).length,
        refused: rows.filter(function (i) { return i.state === 'refused'; }).length,
        rejected: rows.filter(function (i) { return i.state === 'rejected'; }).length,
        waiting: rows.filter(function (i) { return ['done', 'gone', 'refused', 'rejected'].indexOf(i.state) === -1; }).length,
        active: running,
        unsettled: rows.some(function (i) { return ['queued', 'uploading', 'needs-auth', 'unknown', 'checking', 'retryable'].indexOf(i.state) !== -1; }),
      };
    }
    return {
      initialize: function (id) { if (!owner) { owner = id; currentOwner = id; } },
      pause: pause,
      observeOwner: function (id) { currentOwner = id; if (id !== owner) pause(); },
      resume: async function () {
        var me;
        try { me = await client.me(); } catch (_) { pause(); return false; }
        currentOwner = me.userId;
        if (!owner && items.length === 0) owner = currentOwner;
        if (!owner || currentOwner !== owner) { pause(); return false; }
        paused = false;
        items.forEach(function (i) {
          var s = i.attempt.snapshot().state;
          if (s === 'queued' || s === 'needs-auth') i.waiting = true;
        });
        pump();
        return me;
      },
      add: function (files, fields) {
        if (!owner) return;
        Array.prototype.forEach.call(files, function (file) {
          var refusal = uploadRefusal(file);
          var item = { id: nextId++, name: file.name, waiting: !refusal };
          item.attempt = createUploadAttempt(client, file, fields || {}, owner, {
            randomUUID: o.randomUUID, onChange: notify, onPause: pause, refusal: refusal,
            canAdopt: function (id) { return id === currentOwner && !paused; },
          });
          items.push(item);
        });
        pump();
      },
      check: async function (id) {
        var item = items.find(function (i) { return i.id === id; });
        if (item && !paused) await item.attempt.check();
      },
      retryFailed: function () {
        if (paused) return;
        items.forEach(function (i) {
          if (['failed', 'retryable'].indexOf(i.attempt.snapshot().state) !== -1) i.waiting = true;
        });
        pump();
      },
      stopWaiting: function () {
        // Unknown/in-flight evidence and landed records are never discarded.
        items = items.filter(function (i) {
          return ['queued', 'needs-auth', 'failed', 'retryable', 'refused', 'rejected'].indexOf(i.attempt.snapshot().state) === -1;
        });
        notify();
      },
      clearFinished: function () {
        items = items.filter(function (i) { return ['done', 'refused', 'rejected'].indexOf(i.attempt.snapshot().state) === -1; });
        notify();
      },
      snapshot: snapshot,
    };
  }

  return {
    UPLOAD_CONCURRENCY: UPLOAD_CONCURRENCY,
    MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES,
    uploadRefusal: uploadRefusal,
    uploadRejection: uploadRejection,
    formatBytes: formatBytes,
    sentence: sentence,
    folderNameRefusal: folderNameRefusal,
    rangeBetween: rangeBetween,
    folderTree: folderTree,
    parentOf: parentOf,
    statusLabel: statusLabel,
    formatExposure: formatExposure,
    versionsOf: versionsOf,
    versionLabel: versionLabel,
    queueState: queueState,
    listQuery: listQuery,
    debounce: debounce,
    makeSequence: makeSequence,
    makeClient: makeClient,
    expectations: expectations,
    changedFields: changedFields,
    compareFields: compareFields,
    assertItem: assertItem,
    savePatch: savePatch,
    isUnknown: isUnknown,
    createUploadAttempt: createUploadAttempt,
    createUploadQueue: createUploadQueue,
  };
})();
