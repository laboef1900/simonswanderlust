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
   * Format an EXIF capture time.
   * @ai-warning getUTC* ONLY. EXIF stores naive wall-clock with no zone and the
   * server relabels those digits as UTC, so a shot taken at 18:23 in Norway is
   * stored as 18:23Z. A local-time formatter double-shifts it and silently
   * mislabels photos across timezones.
   */
  function formatTakenAt(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
      + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
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
    put('sort', s.sort);
    put('order', s.order);
    put('page', s.page);
    put('pageSize', s.pageSize);
    return parts.length ? '?' + parts.join('&') : '';
  }

  // ---- transport ----------------------------------------------------------

  function makeClient(opts) {
    var onUnauthed = (opts && opts.onUnauthed) || function () {};
    var fetchImpl = (opts && opts.fetch) || window.fetch.bind(window);
    var XHR = (opts && opts.XMLHttpRequest) || window.XMLHttpRequest;

    async function request(method, url, body) {
      var init = { method: method };
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      var res = await fetchImpl(url, init);
      if (res.status === 401) { onUnauthed(); throw new Error('unauthorized'); }
      var parsed = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(parsed.error || ('HTTP ' + res.status));
      return parsed;
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
        xhr.open('POST', '/upload');
        if (xhr.upload && h.onProgress) {
          xhr.upload.onprogress = function (e) {
            if (e.lengthComputable) h.onProgress(e.loaded / e.total);
          };
        }
        xhr.onload = function () {
          if (xhr.status === 401) { onUnauthed(); reject(new Error('unauthorized')); return; }
          var body = {};
          try { body = JSON.parse(xhr.responseText); } catch (e) { /* non-JSON error body */ }
          if (xhr.status >= 200 && xhr.status < 300) resolve(body);
          else reject(new Error(body.error || ('HTTP ' + xhr.status)));
        };
        xhr.onerror = function () { reject(new Error('network error')); };
        xhr.onabort = function () { reject(new Error('cancelled')); };
        xhr.send(fd);
      });
    }

    return {
      list: function (state) { return request('GET', '/media' + listQuery(state)); },
      get: function (key) { return request('GET', '/media/items/' + key); },
      patch: function (key, fields) { return request('PATCH', '/media/items/' + key, fields); },
      remove: function (key) { return request('DELETE', '/media/items/' + key); },
      move: function (keys, folder) { return request('POST', '/media/move', { keys: keys, folder: folder }); },
      retry: function (keys) { return request('POST', '/media/retry', { keys: keys }); },
      rescan: function () { return request('POST', '/media/rescan'); },
      folders: function () { return request('GET', '/media/folders'); },
      createFolder: function (path) { return request('POST', '/media/folders', { path: path }); },
      renameFolder: function (from, to) { return request('PATCH', '/media/folders', { from: from, to: to }); },
      deleteFolder: function (path) { return request('DELETE', '/media/folders', { path: path }); },
      queue: function () { return request('GET', '/media/queue'); },
      uploadOne: uploadOne,
    };
  }

  // ---- upload queue -------------------------------------------------------

  /**
   * Bounded-concurrency upload queue with per-file state.
   *
   * Failed UPLOADS are tracked separately from failed ENCODES: one laptop sleep
   * or one 503 in a 100-file batch must not leave the author guessing which
   * files landed, hence `retryFailed()`. The tab must stay open for the
   * uploads (bandwidth), but not for encoding, which continues server-side.
   */
  function createUploadQueue(client, opts) {
    var o = opts || {};
    var concurrency = o.concurrency || UPLOAD_CONCURRENCY;
    var onChange = o.onChange || function () {};
    var items = [];   // { id, file, fields, state, progress, error, result }
    var running = 0;
    var nextId = 1;

    // @ai-warning: `let`, not `var`. `var` is function-scoped, so with
    // concurrency > 1 every iteration of this loop would share ONE binding and
    // the first upload's callbacks would write their state onto the second
    // item — silently mislabelling which files landed.
    function start(item) {
      running++;
      item.state = 'uploading';
      item.progress = 0;
      onChange(snapshot());
      client.uploadOne(item.file, item.fields, {
        onProgress: function (p) { item.progress = p; onChange(snapshot()); },
      }).then(function (body) {
        item.state = 'done';
        item.progress = 1;
        item.result = body;
      }, function (err) {
        item.state = 'failed';
        item.error = err && err.message ? err.message : String(err);
      }).then(function () {
        running--;
        onChange(snapshot());
        pump();
      });
    }

    function pump() {
      while (running < concurrency) {
        var next = items.find(function (i) { return i.state === 'queued'; });
        if (!next) break;
        start(next);
      }
      onChange(snapshot());
    }

    function snapshot() {
      return {
        items: items.map(function (i) {
          return { id: i.id, name: i.file && i.file.name, state: i.state, progress: i.progress, error: i.error, result: i.result };
        }),
        total: items.length,
        done: items.filter(function (i) { return i.state === 'done'; }).length,
        failed: items.filter(function (i) { return i.state === 'failed'; }).length,
        active: running,
      };
    }

    return {
      add: function (files, fields) {
        Array.prototype.forEach.call(files, function (file) {
          items.push({ id: nextId++, file: file, fields: fields || {}, state: 'queued', progress: 0, error: null, result: null });
        });
        pump();
      },
      retryFailed: function () {
        items.forEach(function (i) {
          if (i.state === 'failed') { i.state = 'queued'; i.error = null; i.progress = 0; }
        });
        pump();
      },
      clearFinished: function () {
        items = items.filter(function (i) { return i.state !== 'done'; });
        onChange(snapshot());
      },
      snapshot: snapshot,
    };
  }

  return {
    UPLOAD_CONCURRENCY: UPLOAD_CONCURRENCY,
    formatBytes: formatBytes,
    formatTakenAt: formatTakenAt,
    rangeBetween: rangeBetween,
    folderTree: folderTree,
    parentOf: parentOf,
    statusLabel: statusLabel,
    listQuery: listQuery,
    makeClient: makeClient,
    createUploadQueue: createUploadQueue,
  };
})();
