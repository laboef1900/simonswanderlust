// The media library page (media.html). DOM only — every pure helper lives in
// media-api.js, which is unit-tested.
//
// Three rules, all load-bearing at this size (~1900 lines of vanilla JS with no
// reactive layer):
//   1. ONE state object, ONE render(). The grid is rebuilt from state; it is
//      never mutated ad hoc. Five interacting states (selection × folder ×
//      filter × queue × detail-dirty) is where this kind of module rots. The
//      one deliberate exception is the encoding poll (see "encoding poll"),
//      which updates a processing photo's row in `state.items` and repaints
//      only that tile, so selection, focus, scroll and page survive it.
//   2. DOM is built with textContent. `innerHTML` is permitted ONLY for `= ''`.
//      This module renders attacker-influenced EXIF strings, folder names and
//      captions — see the browser-mirror test that pins this.
//   3. No drag-to-reorder anywhere: it has no keyboard equivalent and
//      PRODUCT.md commits to WCAG 2.1 AA. Ordering uses move-up/down buttons.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.MediaApi;
  var copy = window.EditorCopy[document.documentElement.lang === 'de' ? 'de' : 'en'];
  $('mediaIntro').textContent = copy.mediaBrowseHelp;
  $('mediaUploadLabel').textContent = copy.mediaUpload;
  $('detailJump').textContent = copy.mediaDetails;
  function revealDetail() {
    $('detail').focus({ preventScroll: true });
    $('detail').scrollIntoView({ block: 'start' });
  }
  $('detailJump').addEventListener('click', revealDetail);

  var state = {
    me: null,
    folder: '',          // '' = root
    recursive: true,
    q: '',
    tag: '',
    status: '',
    alt: '',             // '' or 'missing' (photos with no alt text in either language)
    altMissing: 0,       // ready photos in this view without alt text, from the last listing
    sort: 'title',
    order: 'asc',
    page: 1,
    pageSize: 60,
    items: [],
    total: 0,
    folders: [],
    selected: [],        // keys, in display order
    anchor: null,        // for shift-range selection
    detailKey: null,
    detailDirty: false,  // unsaved edits in the detail panel; render() leaves it alone while set
    detailItem: null,    // the row the panel was built from (diff base for saveDetail)
    detailGeneration: 0,
    detailSaving: false,
    detailRecovery: null,
    detailObservation: null,
    detailChanged: null, // only this session's acknowledged write, never inferred by a read
    observedKey: null,
    suggest: null,       // in-flight AI suggestion for the panel's photo: { key, controller }
    offers: null,        // suggestions shown under fields that had text: { key, slots: [[inputId, value, what]] }
    queue: null,
  };

  var client = api.makeClient({
    onUnauthed: function () { uploads.pause(); say(copy.uploadNeedsAuth); },
    canWrite: function () { return !!state.me && !uploads.snapshot().paused; },
  });
  // Upload completion means the original was accepted, not that encoding is
  // ready. Reload the current query so the server supplies its actual status
  // and applies the author's folder, filters, sorting and page.
  var refreshUploads = api.debounce(function () { reload(undefined, true); }, 200);
  var uploads = api.createUploadQueue(client, {
    onChange: function (snap) {
      var previousDone = state.queue ? state.queue.done : 0;
      state.queue = snap;
      renderQueue();
      if (snap.done > previousDone) refreshUploads();
    },
  });
  window.addEventListener('beforeunload', function (event) {
    if (!uploads.snapshot().unsettled) return;
    event.preventDefault(); event.returnValue = '';
  });
  window.addEventListener('focus', async function () {
    try { uploads.observeOwner((await client.me()).userId); }
    catch (error) { if (error.status === 401) uploads.pause(); }
  });

  var detailRefresh = window.PublicationRefresh.create({
    resource: function () { return state.detailKey; },
    read: function (signal) {
      // The one read that asks for the variant listing; every other item read keeps its cost.
      return window.PublicationRefresh.json('/media/items/' + state.detailKey + '?versions=1', signal);
    },
    apply: function (item) {
      // Deliberately do not replace detailItem, form values, or conditional-write expectations.
      // PATCH responses, a 409's `current` and poll reads carry no `versions`: the last listing stays.
      state.detailObservation = { impact: item.impact, livePending: item.livePending,
        usedIn: item.usedIn || state.detailObservation?.usedIn || state.detailItem?.usedIn || [],
        versions: api.versionsOf(item.versions) || state.detailObservation?.versions || null };
      renderImpact();
      renderVersions();
    },
    unavailable: function () {
      // A failed read says nothing about the files: the last listing stays, if there was one.
      state.detailObservation = { impact: { availability: 'unavailable' }, livePending: null,
        versions: state.detailObservation?.versions || { availability: 'unavailable' } };
      renderImpact();
      renderVersions();
    },
    unauthorized: function () { uploads.pause(); say(copy.uploadNeedsAuth); },
  });
  // Reuse item responses for observation only, never for form values or write
  // acknowledgement. savePatch alone owns validation and the one recovery GET.
  ['get', 'patch'].forEach(function (method) {
    var request = client[method];
    client[method] = async function (key) {
      var version = detailRefresh.beginAction(key === state.detailKey);
      function observe(item) {
        if (key !== state.detailKey) return;
        try { api.assertItem(item, key); }
        catch (_) { item = { impact: { availability: 'unavailable' }, livePending: null }; }
        detailRefresh.accept(item, version);
      }
      try {
        var item = await request.apply(client, arguments);
        observe(item);
        return item;
      } catch (error) {
        observe(error.current);
        throw error;
      } finally { detailRefresh.endAction(false); }
    };
  });
  // Other mutations have no item projection, so observe after they settle.
  // Background projection reads use PublicationRefresh.json, never this wrapped client.
  ['remove', 'move', 'retry', 'rescan', 'renameFolder', 'deleteFolder', 'createFolder'].forEach(function (method) {
    var mutate = client[method];
    client[method] = async function () {
      detailRefresh.beginAction();
      try { return await mutate.apply(client, arguments); }
      finally { detailRefresh.endAction(); }
    };
  });

  function renderImpact() {
    var box = $('dImpact');
    if (box) window.MediaImpact.render(box, state.detailObservation, state.detailChanged,
      !!state.me?.isAdmin, copy, function () { detailRefresh.refresh(); });
  }

  /**
   * A public image URL this page may link to: HTTP(S) on the image origin or
   * this one, without credentials — the rule MediaAi.photoUrl applies.
   */
  function publicImageUrl(src) {
    try {
      var url = new URL(src, location.origin);
      if (['http:', 'https:'].indexOf(url.protocol) === -1 || url.username || url.password) return null;
      return url.origin === imageOrigin() || url.origin === location.origin ? url.href : null;
    } catch (_) { return null; }
  }

  /**
   * The Versions section: the variant files that exist on disk, from the
   * panel's observation — never derived from the row. It is rebuilt only when
   * the listing changed, so the 30 s refresh never pulls a link out from under
   * a click; when it did change, focus stays on the same version (format and
   * width), else moves to the first link, else to the panel.
   */
  function renderVersions() {
    var box = $('dVersions');
    if (!box) return;
    var versions = state.detailObservation ? state.detailObservation.versions : null;
    var listing = JSON.stringify(versions);
    if (box.dataset.listing === listing) return;
    box.dataset.listing = listing;
    var focusKey = box.contains(document.activeElement) ? document.activeElement.dataset.versionFocus : undefined;
    var focusTarget = null;
    box.innerHTML = '';
    if (!versions || versions.availability !== 'available' || !versions.items.length) {
      box.appendChild(el('p', 'muted', !versions ? copy.mediaVersionsLoading
        : versions.availability === 'processing' ? copy.mediaVersionsProcessing
        : versions.availability === 'unavailable' ? copy.mediaVersionsUnavailable
        : copy.mediaVersionsEmpty));
    } else {
      var list = el('ul', 'media-versions');
      list.setAttribute('role', 'list');
      list.setAttribute('aria-labelledby', 'dVersionsLabel');
      versions.items.forEach(function (version) {
        var row = el('li');
        var href = publicImageUrl(version.src);
        if (href) {
          var link = el('a', null, api.versionLabel(version));
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.dataset.versionFocus = version.format + ':' + version.width;
          link.appendChild(el('span', 'visually-hidden', ' ' + copy.mediaVersionNewTab));
          if (link.dataset.versionFocus === focusKey) focusTarget = link;
          row.appendChild(link);
        } else {
          row.textContent = api.versionLabel(version);
        }
        list.appendChild(row);
      });
      box.appendChild(list);
    }
    if (focusKey) (focusTarget || box.querySelector('a') || $('detail')).focus({ preventScroll: true });
  }

  function say(msg) { $('out').textContent = msg; }
  function photos(n) { return window.AdminFormat.count(n, 'photo'); }

  // ---- the folder and alt filter live in the URL, so a reload keeps them --

  function readUrlState() {
    var params = new URLSearchParams(typeof location.search === 'string' ? location.search : '');
    return { folder: params.get('folder') || '', alt: params.get('alt') === 'missing' ? 'missing' : '' };
  }

  function syncUrl() {
    if (!window.history || typeof window.history.replaceState !== 'function') return;
    var params = new URLSearchParams();
    if (state.folder) params.set('folder', state.folder);
    if (state.alt) params.set('alt', state.alt);
    var query = params.toString();
    window.history.replaceState(null, '', (location.pathname || '') + (query ? '?' + query : ''));
  }

  /** The shortcut modifier the visitor's own keyboard prints. */
  function isMac() {
    var nav = typeof navigator === 'undefined' ? null : navigator;
    return !!nav && /Mac|iPhone|iPad/.test(nav.platform || nav.userAgent || '');
  }

  function fail(err) {
    if (err && (err.status === 401 || err.code === 'owner_changed')) { uploads.pause(); say(copy.uploadNeedsAuth); return; }
    say('Error: ' + (err && err.message ? err.message : String(err)));
  }

  // The configured image host (served by /admin/editor-image-copy.js). Only a
  // thumbnail on that origin or this one is ever sent to a model.
  function imageOrigin() { return window.EditorGalleryImageOrigin || location.origin; }

  // Bulk "Generate details with AI" dialog; created in init().
  var aiDialog = null;

  // ---- data ---------------------------------------------------------------

  // Loads race: a filter change fired before the previous response landed must
  // win, or the grid, the total in say() and the pruned selection all describe
  // a query the author has already typed past. See makeSequence.
  var loads = api.makeSequence();
  var foregroundPending = false;
  var foregroundMessage;

  async function reload(msg, background) {
    var ticket = loads.next();
    // A newer completion request may win the response race, but must still
    // finish an explicit Save/filter/folder action's pending render.
    if (!background) {
      foregroundPending = true;
      foregroundMessage = msg;
    }
    syncUrl();
    try {
      var query = {
        folder: state.folder, recursive: state.recursive, q: state.q, tag: state.tag,
        status: state.status, alt: state.alt, sort: state.sort, order: state.order,
        page: state.page, pageSize: state.pageSize,
      };
      var res;
      while (true) {
        res = await client.list(query);
        if (!loads.isCurrent(ticket)) return;
        var lastPage = Math.max(1, Math.ceil(res.total / query.pageSize));
        if (query.page <= lastPage) break;
        // Deletions, moves and status changes can remove the current page.
        // Only move backwards: concurrent shrinkage may need another correction,
        // but cannot keep this load chasing an ever-growing page count.
        query.page = lastPage;
        if (res.total === 0) break;
      }
      var folders = await client.folders();
      if (!loads.isCurrent(ticket)) return;
      state.page = query.page;
      state.items = res.items;
      state.total = res.total;
      state.altMissing = Number(res.altMissing) || 0;
      state.folders = folders;
      // Drop selections for photos no longer in view.
      var visible = state.items.map(function (i) { return i.key; });
      state.selected = state.selected.filter(function (k) { return visible.indexOf(k) !== -1; });
      // Capture at response time: the author may have moved focus while loading.
      var active = document.activeElement;
      var focusedKey = active && $('grid').contains(active) ? active.dataset.key : null;
      var message = foregroundPending ? foregroundMessage : msg;
      render(!foregroundPending);
      if (focusedKey) focusCell(visible.indexOf(focusedKey));
      say(message != null ? message : photos(state.total));
      foregroundPending = false;
      foregroundMessage = undefined;
    } catch (e) {
      if (loads.isCurrent(ticket)) fail(e);
    }
  }

  // ---- rendering ----------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** The name a photo goes by in a sentence or a caption: its title, else its file name — never the storage path. */
  function photoName(item) { return item.title || String(item.key || '').split('/').pop(); }

  /** Fills `{name}` placeholders; a function replacement, so a `$` in a title stays a `$`. */
  function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, function (_, name) { return String(values[name]); });
  }

  function renderFolders() {
    var list = $('folderTree');
    list.innerHTML = '';
    $('mediaFolderLabel').textContent = copy.mediaFolders + ' · ' + (state.folder || copy.mediaAllPhotos);
    var mk = function (path, label, depth) {
      var li = document.createElement('li');
      var btn = el('button', 'folder-btn' + (state.folder === path ? ' is-current' : ''), label);
      btn.type = 'button';
      btn.setAttribute('aria-current', state.folder === path ? 'true' : 'false');
      btn.style.paddingLeft = (0.4 + depth * 0.8) + 'rem';
      btn.addEventListener('click', function () {
        state.folder = path;
        state.page = 1;
        reload();
      });
      li.appendChild(btn);
      list.appendChild(li);
    };
    mk('', copy.mediaAllPhotos, 0);
    api.folderTree(state.folders).forEach(function (n) { mk(n.path, n.name, n.depth + 1); });
  }

  function renderGrid() {
    var grid = $('grid');
    grid.innerHTML = '';
    var empty = !state.items.length;
    var narrowed = Boolean(state.folder || state.q || state.tag || state.status || state.alt || !state.recursive || state.page > 1);
    $('mediaEmpty').hidden = !empty;
    grid.hidden = empty;
    $('mediaEmptyMessage').textContent = empty
      ? (narrowed ? copy.mediaNoResults + ' ' + copy.mediaNoResultsHelp : copy.mediaEmpty + ' ' + copy.mediaEmptyHelp)
      : '';
    $('emptyShowAll').hidden = !narrowed;
    if (empty) return;
    state.items.forEach(function (item, index) {
      var cell = el('div', 'media-cell' + (state.selected.indexOf(item.key) !== -1 ? ' is-selected' : ''));
      cell.setAttribute('role', 'option');
      cell.setAttribute('aria-selected', state.selected.indexOf(item.key) !== -1 ? 'true' : 'false');
      // Roving tabindex: exactly one cell is tabbable at a time.
      cell.tabIndex = index === 0 ? 0 : -1;
      cell.dataset.key = item.key;
      // F opens the focused photo fullscreen (onGridKey); announced on the tile, where it works.
      cell.setAttribute('aria-keyshortcuts', 'f');
      fillCell(cell, item);
      cell.addEventListener('click', function (ev) { onCellActivate(item.key, ev); });
      cell.addEventListener('keydown', function (ev) { onGridKey(ev, index); });
      grid.appendChild(cell);
    });
  }

  /**
   * The tile's content — photograph, status badge, name, usage. The cell itself
   * (selection, tabindex, listeners) is left alone so the encoding poll can
   * refill a tile without disturbing focus.
   */
  function fillCell(cell, item) {
    cell.innerHTML = '';
    var figure = el('div', 'media-cell__thumb');
    if (item.thumbSrc) {
      var img = document.createElement('img');
      img.src = item.thumbSrc;
      img.alt = '';
      img.loading = 'lazy';
      figure.appendChild(img);
    } else {
      figure.appendChild(el('span', 'thumb-placeholder'));
    }
    cell.appendChild(figure);

    var badge = api.statusLabel(item);
    if (badge) cell.appendChild(el('span', 'media-cell__badge', badge));

    // A title the author gave reads as the photo's name; a bare file name is
    // only a fallback and is set back, so the photograph leads the tile.
    cell.appendChild(el('span', 'media-cell__title' + (item.title ? '' : ' is-filename'), photoName(item)));
    if (item.usedIn && item.usedIn.length) {
      // "(published version)": the live post still renders it although the
      // draft dropped it — the admin has to republish before it can go.
      cell.appendChild(el('span', 'media-cell__used', 'used in: '
        + item.usedIn.map(function (u) {
          return u.title + (u.published && !u.working ? ' (published version)' : '');
        }).join(', ')));
    }
  }

  /**
   * One line above the grid about alt text: how many ready photos in this view
   * have none, with the filter as its action — instead of a tag on every tile
   * (DESIGN.md, "Media leads with the photograph").
   */
  function renderAltLine() {
    var line = $('altMissingLine');
    var text = $('altMissingText');
    var action = $('altMissingAction');
    if (state.alt === 'missing') {
      text.textContent = 'Showing photos without alt text.';
      action.textContent = 'Show all photos in this view';
      line.hidden = false;
    } else if (state.altMissing > 0) {
      text.textContent = window.AdminFormat.count(state.altMissing, 'ready photo') + ' in this view '
        + (state.altMissing === 1 ? 'has' : 'have') + ' no alt text.';
      action.textContent = 'Show only these';
      line.hidden = false;
    } else {
      text.textContent = '';
      action.textContent = '';
      line.hidden = true;
    }
  }

  /** Applies the alt-text filter from the count line or the select; `missing` or ''. */
  function setAltFilter(value) {
    state.alt = value === 'missing' ? 'missing' : '';
    state.page = 1;
    $('fAlt').value = state.alt;
    // The active filter must be visible, so More filters opens with it.
    if (state.alt) setMoreFilters(true);
    reload();
  }

  function setMoreFilters(open) {
    var extra = $('fExtra');
    var more = $('fMore');
    extra.hidden = !open;
    more.setAttribute('aria-expanded', open ? 'true' : 'false');
    more.textContent = open ? 'Fewer filters' : 'More filters';
  }

  function renderToolbar() {
    $('selCount').textContent = state.selected.length
      ? state.selected.length + ' selected'
      : '';
    $('bulkTools').hidden = state.selected.length === 0;
    var target = $('moveTarget');
    var previous = target.value;
    target.innerHTML = '';
    var root = document.createElement('option');
    root.value = '';
    root.textContent = '(root)';
    target.appendChild(root);
    state.folders.forEach(function (f) {
      var opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      target.appendChild(opt);
    });
    target.value = state.folders.indexOf(previous) !== -1 ? previous : '';
    $('pageInfo').textContent = state.total
      ? 'Page ' + state.page + ' of ' + Math.max(1, Math.ceil(state.total / state.pageSize))
      : '';
    $('prevPage').disabled = state.page <= 1;
    $('nextPage').disabled = state.page * state.pageSize >= state.total;
    $('aiAll').disabled = state.total === 0;
    // One AI entry per scope: with a selection, the bulk bar's button acts on
    // it, so the whole-view button steps aside instead of duplicating it.
    $('aiAll').hidden = state.selected.length > 0;
    // "All photos" is a view, not a folder: it cannot be renamed or deleted.
    $('renameFolder').disabled = !state.folder;
    $('deleteFolder').disabled = !state.folder;
  }

  /** A refused file names its reason and what to do instead; it was never sent. */
  function refusalText(reason) {
    if (reason === 'heic') return copy.uploadRefusedHeic;
    if (reason === 'not_image') return copy.uploadRefusedNotImage;
    return copy.uploadRefusedTooLarge.replace('{max}', api.formatBytes(api.MAX_UPLOAD_BYTES));
  }

  /** The server received the file and refused it for good: sending it again can never succeed. */
  function rejectionText(reason) {
    if (reason === 'too_large') return copy.uploadRejectedTooLarge.replace('{max}', api.formatBytes(api.MAX_UPLOAD_BYTES));
    return copy.uploadRejectedUnreadable;
  }

  function renderQueue() {
    var box = $('uploadQueue');
    var snap = state.queue;
    var focusId = box.contains(document.activeElement) ? document.activeElement.dataset.uploadId : undefined;
    var focusTarget = null;
    box.innerHTML = '';
    if (!snap || !snap.total && !snap.paused) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('p', 'muted', snap.done + ' of ' + snap.total + ' uploaded'
      + (snap.failed ? ' · ' + snap.failed + ' failed' : '')
      + (snap.rejected ? ' · ' + copy.uploadRejectedCount.replace('{count}', snap.rejected) : '')
      + (snap.refused ? ' · ' + copy.uploadRefusedCount.replace('{count}', snap.refused) : '')));
    // Phones suspend a backgrounded tab's transfers; encoding needs no tab at all.
    if (snap.unsettled) {
      var keepOpen = el('p', 'upload-keep-open', copy.uploadKeepOpen);
      keepOpen.setAttribute('role', 'status');
      box.appendChild(keepOpen);
    }
    box.appendChild(el('p', 'muted', copy.uploadLimit));
    if (snap.paused) {
      var banner = el('div', 'upload-session');
      banner.setAttribute('role', 'alert');
      banner.appendChild(el('p', '', copy.uploadSessionSummary.replace('{done}', snap.done).replace('{waiting}', snap.waiting)));
      var login = el('a', '', copy.uploadSignIn);
      login.href = '/login?next=%2Fadmin%2F'; login.target = '_blank'; login.rel = 'noopener';
      var resume = el('button', 'btn-secondary', copy.uploadResume); resume.type = 'button';
      resume.addEventListener('click', async function () {
        var me = await uploads.resume();
        if (!me) { say(copy.uploadOwnerChanged); return; }
        await activate(me);
      });
      var stop = el('button', 'btn-secondary', copy.uploadStop); stop.type = 'button';
      stop.addEventListener('click', async function () {
        // The same states stopWaiting() removes: unsent, and the definitely refused or rejected.
        var count = uploads.snapshot().items.filter(function (item) { return ['queued', 'needs-auth', 'failed', 'retryable', 'refused', 'rejected'].indexOf(item.state) !== -1; }).length;
        if (count && await window.AdminConfirm.ask({ title: copy.uploadStop, body: copy.uploadStopConfirm.replace('{count}', count), confirmLabel: copy.uploadStop, danger: true })) uploads.stopWaiting();
      });
      banner.append(login, resume, stop); box.appendChild(banner);
    }
    snap.items.forEach(function (i) {
      var row = el('div', 'upload-row');
      row.tabIndex = -1;
      row.dataset.uploadId = String(i.id);
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', i.name);
      if (focusId === row.dataset.uploadId) focusTarget = row;
      row.appendChild(el('span', 'upload-row__name', i.name));
      var label = i.state === 'unknown' ? copy.uploadUnknown : i.state === 'checking' ? copy.uploadChecking
        : i.state === 'needs-auth' ? copy.uploadNeedsAuth : i.state === 'retryable' ? copy.uploadRetryable
        : i.state === 'gone' ? copy.uploadGone
        : i.state === 'refused' ? refusalText(i.error)
        : i.state === 'rejected' ? rejectionText(i.error)
        // Transferred is not encoded: the grid badge reports processing → ready/failed.
        : i.state === 'done' && !(i.result && i.result.duplicate) ? copy.uploadDone
        : api.queueState(i);
      var settled = i.state === 'refused' || i.state === 'rejected' || i.state === 'failed';
      var status = el('span', 'upload-row__state' + (settled ? ' is-refused' : ''), label);
      status.id = 'upload-state-' + i.id;
      row.appendChild(status);
      row.setAttribute('aria-describedby', status.id);
      if (i.originalRetained) row.appendChild(el('span', 'muted', copy.uploadRetained));
      if (i.reason === 'queue_full' || i.reason === 'recovery_required') row.appendChild(el('span', 'muted', copy.uploadRecoveryRequired));
      if (i.state === 'unknown') {
        var check = el('button', 'btn-secondary', copy.uploadCheckAgain); check.type = 'button'; check.disabled = snap.paused;
        check.dataset.uploadId = row.dataset.uploadId;
        if (focusId === check.dataset.uploadId && !check.disabled) focusTarget = check;
        check.addEventListener('click', function () { uploads.check(i.id); });
        row.appendChild(check);
      }
      box.appendChild(row);
    });
    if (snap.failed) {
      var retry = el('button', 'btn-secondary', copy.uploadRetry + ' (' + snap.failed + ')');
      retry.type = 'button';
      retry.disabled = snap.paused;
      retry.addEventListener('click', function () { uploads.retryFailed(); });
      box.appendChild(retry);
    }
    if ((snap.done || snap.refused || snap.rejected) && snap.active === 0 && !snap.paused && !snap.unsettled) {
      var clear = el('button', 'btn-secondary', 'Clear finished');
      clear.type = 'button';
      clear.addEventListener('click', function () { uploads.clearFinished(); reload(); });
      box.appendChild(clear);
    }
    // A resolved check removes its button; keep keyboard focus on that photo,
    // but never take it back after the author has moved to another control.
    if (focusTarget) focusTarget.focus();
  }

  // The detail panel is the one place on this page the author types. Rebuilding
  // it mid-edit throws that text away, so while `detailDirty` is set the panel
  // is left untouched — whatever reload() or a selection change did to the rest
  // of the page — until the edits are saved or explicitly discarded
  // (see whenReplaceable).
  function renderDetail(background) {
    if (state.detailDirty) return;
    var item = state.items.filter(function (i) { return i.key === state.detailKey; })[0];
    if (!item) state.detailKey = null;
    var selectionChanged = state.observedKey !== state.detailKey;
    if (selectionChanged) {
      detailRefresh.beginAction();
      state.observedKey = state.detailKey;
      state.detailObservation = null;
      state.detailChanged = null;
    }
    var panel = $('detail');
    panel.hidden = !item;
    $('detailJump').hidden = !item;
    var help = $('mediaSelectionHelp');
    help.hidden = !!item;
    // Background completion must not remove a control between focus and typing.
    // Explicit actions (including Save) still refresh the clean panel normally.
    if (background && item && panel.dataset.key === item.key
      && panel.contains(document.activeElement)) return;
    panel.innerHTML = '';
    // A suggestion belongs to the photo it was asked for: once the panel shows
    // another photo (or none), the request is abandoned, never applied, and
    // the offers it left under fields are dropped.
    if (state.suggest && (!item || state.suggest.key !== item.key)) cancelSuggest();
    if (state.offers && (!item || state.offers.key !== item.key)) state.offers = null;
    if (!item) {
      delete panel.dataset.key;
      help.innerHTML = '';
      var hints = el('ul', 'media-detail__hints muted');
      [
        'Shift-click selects a range.',
        (isMac() ? '⌘' : 'Ctrl') + '-click adds or removes one photo.',
        (isMac() ? '⌘' : 'Ctrl') + '+A selects every photo on this page.',
      ].forEach(function (hint) { hints.appendChild(el('li', null, hint)); });
      help.appendChild(hints);
      if (selectionChanged) detailRefresh.endAction();
      return;
    }
    panel.dataset.key = item.key;
    state.detailItem = item;
    state.detailGeneration++;
    state.detailRecovery = null;
    var header = el('div', 'media-detail__header');
    header.appendChild(el('h2', 'section-label', copy.mediaDetails));
    var back = el('button', 'btn-link', copy.mediaBackToPhotos);
    back.type = 'button';
    back.id = 'detailBack';
    back.addEventListener('click', function () {
      whenReplaceable(null, function () {
        state.detailKey = null;
        renderDetail();
        focusCell(state.items.findIndex(function (photo) { return photo.key === item.key; }));
      });
    });
    header.appendChild(back);
    panel.appendChild(header);
    // The photo comes first: alt text and captions are written while looking at it.
    var preview = el('figure', 'media-detail__preview');
    fillPreview(preview, item);
    panel.appendChild(preview);
    // What can be done with the photograph sits directly under it. The storage
    // key is not shown: the author names photos by title, not by path (#570).
    var actions = el('div', 'media-detail__actions');
    var view = el('button', 'btn-secondary', copy.mediaViewFullscreen);
    view.type = 'button';
    view.id = 'dViewer';
    view.addEventListener('click', function () { openViewer(item, 'button'); });
    actions.appendChild(view);
    panel.appendChild(actions);
    renderSuggest(actions, item);

    var fields = [
      { id: 'dTitle', label: 'Title', value: item.title },
      { id: 'dAltDe', label: 'Alt text (DE)', value: item.alt.de },
      { id: 'dAltEn', label: 'Alt text (EN)', value: item.alt.en },
      { id: 'dCapDe', label: 'Caption (DE)', value: item.caption.de },
      { id: 'dCapEn', label: 'Caption (EN)', value: item.caption.en },
      { id: 'dTags', label: 'Tags (comma-separated)', value: (item.tags || []).join(', ') },
    ];
    fields.forEach(function (f) {
      var label = el('label', null, f.label);
      var input = document.createElement('input');
      input.id = f.id;
      input.type = 'text';
      input.value = f.value || '';
      label.appendChild(input);
      panel.appendChild(label);
      // Where a suggestion for a field that already has text is offered.
      var hint = el('p', 'media-ai-hint');
      hint.id = f.id + 'Hint';
      hint.hidden = true;
      panel.appendChild(hint);
    });
    restoreOffers();

    var folderLabel = el('label', null, 'Folder');
    var folderSelect = document.createElement('select');
    folderSelect.id = 'dFolder';
    var rootOpt = document.createElement('option');
    rootOpt.value = '';
    rootOpt.textContent = '(root)';
    folderSelect.appendChild(rootOpt);
    var folders = state.folders;
    // An acknowledged/current item can name a folder created since this list loaded.
    if (item.folder && folders.indexOf(item.folder) === -1) folders = folders.concat(item.folder);
    folders.forEach(function (f) {
      var opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      folderSelect.appendChild(opt);
    });
    folderSelect.value = item.folder;
    folderLabel.appendChild(folderSelect);
    panel.appendChild(folderLabel);

    var save = el('button', null, 'Save details');
    save.id = 'dSave';
    save.type = 'button';
    save.disabled = state.detailSaving;
    save.addEventListener('click', function () { saveDetail(item.key); });
    panel.appendChild(save);
    var unsaved = el('p', 'muted', 'Unsaved changes — Save details to keep them.');
    unsaved.id = 'dUnsaved';
    unsaved.setAttribute('role', 'status');
    unsaved.hidden = true;
    panel.appendChild(unsaved);
    var comparison = el('section');
    comparison.id = 'dCompare';
    comparison.setAttribute('aria-live', 'polite');
    panel.appendChild(comparison);
    var impact = el('section');
    impact.id = 'dImpact';
    impact.setAttribute('aria-live', 'polite');
    panel.appendChild(impact);
    renderImpact();
    if (selectionChanged) detailRefresh.endAction();

    // EXIF is read-only. lat/lng are absent entirely for non-admins. Camera,
    // date and size already sit under the preview; lens and exposure get a row
    // only where the camera recorded them.
    panel.appendChild(el('p', 'section-label', 'File'));
    var dl = el('dl', 'keyfacts-mini');
    var rows = [];
    if (item.exif && item.exif.lens) rows.push(['Lens', item.exif.lens]);
    var exposure = api.formatExposure(item.exif, copy.mediaExposureEquivalent);
    if (exposure) rows.push([copy.mediaExposure, exposure]);
    rows.push(['Original', api.formatBytes(item.origBytes)], ['Variants', api.formatBytes(item.variantBytes)]);
    if (item.exif && item.exif.lat !== null && item.exif.lat !== undefined) {
      rows.push(['GPS', item.exif.lat.toFixed(4) + ', ' + Number(item.exif.lng).toFixed(4)]);
    }
    rows.forEach(function (r) {
      dl.appendChild(el('dt', null, r[0]));
      dl.appendChild(el('dd', null, r[1]));
    });
    panel.appendChild(dl);

    // The variant files themselves, read from disk by the observation (renderVersions).
    var versionsLabel = el('p', 'section-label', copy.mediaVersions);
    versionsLabel.id = 'dVersionsLabel';
    panel.appendChild(versionsLabel);
    var versionsBox = el('div');
    versionsBox.id = 'dVersions';
    panel.appendChild(versionsBox);
    renderVersions();

    renderEncodingActions(panel, item);
  }

  /** The photograph itself, or its status while it has no thumbnail yet; refilled by the poll. */
  function fillPreview(preview, item) {
    preview.innerHTML = '';
    if (item.thumbSrc) {
      var previewImg = document.createElement('img');
      previewImg.src = item.thumbSrc;
      // The fields below are this photo's description; the preview itself adds none.
      previewImg.alt = '';
      if (item.width && item.height) { previewImg.width = item.width; previewImg.height = item.height; }
      preview.appendChild(previewImg);
    } else {
      preview.appendChild(el('span', 'thumb-placeholder', api.statusLabel(item) || copy.mediaNoPreview));
    }
    // Camera, capture time and pixel size: measurements, set in mono (DESIGN.md).
    var shot = [
      item.exif && item.exif.camera,
      item.exif && item.exif.takenAt ? window.AdminFormat.dateTime(item.exif.takenAt, { utc: true }) : '',
      item.width && item.height ? item.width + ' × ' + item.height : '',
    ].filter(Boolean).join(' · ');
    if (shot) preview.appendChild(el('figcaption', 'media-detail__shot', shot));
  }

  /**
   * Retry encoding (failed photos) and Delete photo (admins) at the end of the
   * panel. While the photo is still encoding, Delete is disabled with a note:
   * the server refuses (409) while the encoder may write under this key
   * (#116). The encoding poll flips it the moment the status settles.
   */
  function renderEncodingActions(panel, item) {
    ['dRetry', 'dDelete', 'deleteNote'].forEach(function (id) { var old = $(id); if (old) old.remove(); });
    if (item.status === 'failed') {
      var retryOne = el('button', 'btn-secondary', 'Retry encoding');
      retryOne.type = 'button';
      retryOne.id = 'dRetry';
      retryOne.addEventListener('click', async function () {
        var restore = window.AdminFocus.hold(retryOne);
        retryOne.disabled = true;
        try {
          await client.retry([item.key]);
          await reload('Re-queued for encoding.');
        } catch (e) { retryOne.disabled = false; fail(e); }
        restore($('dDelete'), $('detail'));
      });
      panel.appendChild(retryOne);
    }
    if (!state.me || !state.me.isAdmin) return;
    var del = el('button', 'btn-remove', 'Delete photo');
    del.type = 'button';
    del.id = 'dDelete';
    if (item.status === 'processing') {
      var note = el('p', 'muted', 'Still encoding — Delete becomes available once it finishes or fails.');
      note.id = 'deleteNote';
      del.disabled = true;
      del.setAttribute('aria-describedby', 'deleteNote');
      panel.appendChild(note);
    }
    del.addEventListener('click', function () { deleteOne(item); });
    panel.appendChild(del);
  }

  function render(background) {
    // Completion changes photos, not folder navigation. Queue emissions already
    // repaint their own state; replacing either here would discard focused controls.
    if (!background) renderFolders();
    renderGrid();
    renderAltLine();
    renderToolbar();
    renderDetail(background);
    if (!background) renderQueue();
    schedulePoll();
    // An open viewer follows the page it was opened on: position, ends, a photo that left.
    renderViewer();
  }

  // ---- encoding poll ------------------------------------------------------
  // A tile shows `processing` the moment its upload lands; the encoder finishes
  // later with no event back to this page. While any photo on the page is still
  // processing, re-read those photos every few seconds and update their tiles
  // (and an open panel) in place — no reload, so selection, focus, scroll,
  // filters and page stay put. Paused while the tab is hidden; a failed round
  // says nothing and the next one still runs.

  var POLL_MS = 3000;
  var poll = { timer: null, running: false };

  function processingKeys() {
    return state.items.filter(function (i) { return i.status === 'processing'; }).map(function (i) { return i.key; });
  }

  function stopPoll() {
    clearTimeout(poll.timer);
    poll.timer = null;
  }

  /** Called after every render: keeps one round pending while anything is processing, none otherwise. */
  function schedulePoll() {
    if (document.hidden || poll.running || !processingKeys().length) { stopPoll(); return; }
    if (poll.timer === null) poll.timer = setTimeout(runPoll, POLL_MS);
  }

  async function runPoll() {
    poll.timer = null;
    if (document.hidden || poll.running) return;
    poll.running = true;
    var ready = 0;
    var failed = 0;
    var stop = false;
    var flipped = false; // the open panel's photo finished encoding in this round
    try {
      var keys = processingKeys();
      for (var i = 0; i < keys.length && !document.hidden; i += 1) {
        var fresh;
        try { fresh = await client.get(keys[i]); }
        catch (e) {
          // The 401 path has already paused the queue and said so; keep polling
          // through anything else and let the next round try again.
          if (e && (e.status === 401 || e.code === 'owner_changed')) { stop = true; break; }
          continue;
        }
        var outcome = applyEncoded(keys[i], fresh);
        if (outcome && keys[i] === state.detailKey) flipped = true;
        if (outcome === 'ready') ready += 1;
        else if (outcome === 'failed' || outcome === 'missing') failed += 1;
      }
    } finally {
      poll.running = false;
      if (ready || failed) {
        say([ready ? photos(ready) + ' ready' : '', failed ? (ready ? String(failed) : photos(failed)) + ' failed' : '']
          .filter(Boolean).join(', ') + '.');
      }
      // applyEncoded asked for the open photo's versions at once, but a background
      // read that lands while a later photo is still being read is dropped
      // (PublicationRefresh), and so is the panel's first read when it settles
      // during a round about OTHER photos: ask again now that the round's reads
      // have settled, whenever the open panel still has no versions listing.
      // A read still in flight is reused, never doubled.
      var unlisted = state.detailKey && !(state.detailObservation && state.detailObservation.versions);
      if (flipped || unlisted) detailRefresh.refresh();
      if (!stop) schedulePoll();
    }
  }

  /**
   * Folds a re-read photo into the row the page already holds and repaints its
   * tile and panel. Returns the new status, or null when nothing changed (still
   * processing, paged away meanwhile, or an unusable response).
   */
  function applyEncoded(key, fresh) {
    if (!fresh || typeof fresh !== 'object' || fresh.key !== key || typeof fresh.status !== 'string') return null;
    var index = state.items.findIndex(function (i) { return i.key === key; });
    var current = state.items[index];
    if (!current || current.status !== 'processing' || fresh.status === 'processing') return null;
    // The same object stays in state.items: the tile's listeners and the open
    // panel hold it. Only what encoding changes is copied — never the text the
    // panel's diff base must keep reflecting what the author saw.
    current.status = fresh.status;
    current.error = fresh.error === undefined ? null : fresh.error;
    current.thumbSrc = fresh.thumbSrc === undefined ? current.thumbSrc : fresh.thumbSrc;
    current.fullSrc = fresh.fullSrc === undefined ? current.fullSrc : fresh.fullSrc;
    if (typeof fresh.variantBytes === 'number') current.variantBytes = fresh.variantBytes;
    var cell = $('grid').querySelectorAll('.media-cell')[index];
    if (cell && cell.dataset.key === key) fillCell(cell, current);
    updateOpenDetail(current);
    // A photo that finishes encoding while it is on the viewer's stage appears there.
    if (viewer.currentKey === key) renderViewer();
    // Its variant files exist now: list them without waiting for the 30 s cycle.
    if (state.detailKey === key) detailRefresh.refresh();
    return current.status;
  }

  /** The open panel follows an encoded photo: rebuilt when clean and unfocused, patched in place otherwise. */
  function updateOpenDetail(item) {
    var panel = $('detail');
    if (panel.dataset.key !== item.key) return;
    if (!state.detailDirty && !panel.contains(document.activeElement)) { renderDetail(); return; }
    // The author is typing here: swap the preview, enable Delete, offer Retry
    // and the AI suggestion — and leave every field exactly as it is.
    var preview = panel.querySelector('.media-detail__preview');
    if (preview) fillPreview(preview, item);
    renderEncodingActions(panel, item);
    refreshSuggest(item);
  }

  // ---- selection ----------------------------------------------------------

  function visibleKeys() {
    return state.items.map(function (i) { return i.key; });
  }

  function toggle(key) {
    var at = state.selected.indexOf(key);
    if (at === -1) state.selected.push(key); else state.selected.splice(at, 1);
  }

  /**
   * Runs `proceed` once the detail panel may be replaced: at once when it holds
   * nothing unsaved (or shows `nextKey` already), otherwise after the author
   * confirms discarding — so a mis-click on a neighbouring photo cannot
   * silently eat their text.
   */
  function whenReplaceable(nextKey, proceed) {
    if (!state.detailDirty || nextKey === state.detailKey) { proceed(); return; }
    // A panel without its row still knows its key: name the file, never the path.
    var name = photoName(state.detailItem || { key: $('detail').dataset.key });
    window.AdminConfirm.ask({
      title: 'Discard unsaved details?',
      body: 'The details of "' + name + '" have unsaved changes. Discarding them cannot be undone.',
      confirmLabel: 'Discard changes',
      danger: true,
    }).then(function (ok) {
      if (!ok) return;
      state.detailDirty = false;
      proceed();
    });
  }

  function markDetailDirty() {
    state.detailGeneration++;
    state.detailDirty = true;
    var hint = $('dUnsaved');
    if (hint) hint.hidden = false;
  }

  function onCellActivate(key, ev) {
    var modifier = !!(ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey));
    whenReplaceable(key, function () {
      if (ev && ev.shiftKey && state.anchor) {
        state.selected = api.rangeBetween(visibleKeys(), state.anchor, key);
      } else if (ev && (ev.ctrlKey || ev.metaKey)) {
        toggle(key);
        state.anchor = key;
      } else {
        state.selected = [key];
        state.anchor = key;
      }
      state.detailKey = key;
      render();
      if (window.matchMedia('(max-width: 900px)').matches && !modifier) revealDetail();
    });
  }

  /** Roving tabindex + arrow keys; Space toggles, Shift+Arrow extends, Enter opens details, F the viewer. */
  function onGridKey(ev, index) {
    var keys = visibleKeys();
    var cols = 1;
    var grid = $('grid');
    if (grid.firstElementChild) {
      cols = Math.max(1, Math.round(grid.clientWidth / grid.firstElementChild.offsetWidth)) || 1;
    }
    var next = null;
    // F opens the focused photo fullscreen — on a tile only, never in the panel,
    // where F is select type-ahead and text. Unmodified, so Ctrl/⌘+F stays the
    // browser's; either case, so Caps Lock does not switch it off; not on repeat.
    if ((ev.key === 'f' || ev.key === 'F') && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey && !ev.repeat) {
      ev.preventDefault();
      openViewer(state.items[index], 'tile');
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      whenReplaceable(keys[index], function () {
        state.detailKey = keys[index];
        renderDetail();
        revealDetail();
      });
      return;
    }
    if (ev.key === 'ArrowRight') next = index + 1;
    else if (ev.key === 'ArrowLeft') next = index - 1;
    else if (ev.key === 'ArrowDown') next = index + cols;
    else if (ev.key === 'ArrowUp') next = index - cols;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = keys.length - 1;
    else if (ev.key === ' ' || ev.key === 'Spacebar') {
      ev.preventDefault();
      whenReplaceable(keys[index], function () {
        toggle(keys[index]);
        state.anchor = keys[index];
        state.detailKey = keys[index];
        render();
        focusCell(index);
      });
      return;
    } else if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'a' || ev.key === 'A')) {
      ev.preventDefault();
      state.selected = keys.slice();
      render();
      focusCell(index);
      return;
    } else {
      return;
    }
    ev.preventDefault();
    next = Math.max(0, Math.min(keys.length - 1, next));
    if (ev.shiftKey && state.anchor) {
      state.selected = api.rangeBetween(keys, state.anchor, keys[next]);
    } else {
      state.anchor = keys[next];
      state.selected = [keys[next]];
    }
    // Arrow-browsing moves focus and selection; it only follows with the
    // detail panel when nothing is unsaved there, so a keyboard user can look
    // around without being asked to discard on every keystroke — and
    // detailKey stays what the panel shows, which is what the switch guard
    // in whenReplaceable compares against.
    if (!state.detailDirty) state.detailKey = keys[next];
    render();
    focusCell(next);
  }

  function focusCell(index) {
    var cells = $('grid').querySelectorAll('.media-cell');
    if (cells[index]) {
      cells.forEach(function (c) { c.tabIndex = -1; });
      cells[index].tabIndex = 0;
      cells[index].focus();
    }
  }

  // ---- fullscreen viewer --------------------------------------------------
  // One photo of the current page at its largest variant (#mediaViewer). It is
  // read-only and stands outside the page's state: it never changes the
  // selection, the open details or unsaved edits. It follows the page by KEY —
  // never a node or an index — because reload(), the encoding poll and the
  // detail panel all rebuild what it was opened from while it is open.

  var viewer = {
    currentKey: null,  // the photo on the stage; null while closed
    openerKey: null,   // the photo it was opened from …
    openerKind: null,  // … through the panel's 'button' or a grid 'tile'
    snapshot: null,    // the last row seen for currentKey, shown once it has left the page
    shown: '',         // what the stage holds, so an unchanged photo is neither reloaded nor un-failed
  };

  function openViewer(item, kind) {
    var dialog = $('mediaViewer');
    if (!item || viewer.currentKey !== null || typeof dialog.showModal !== 'function') return;
    viewer.currentKey = viewer.openerKey = item.key;
    viewer.openerKind = kind;
    viewer.snapshot = item;
    renderViewer();
    dialog.showModal();
    // Close first, so Enter leaves again; ←/→ step from anywhere in the dialog.
    $('viewerClose').focus();
  }

  /** Paints the open viewer from state.items: on open, on every step and after any render(). */
  function renderViewer() {
    if (viewer.currentKey === null) return;
    var index = state.items.findIndex(function (i) { return i.key === viewer.currentKey; });
    // A background reload can take the photo off the page: keep showing what
    // was last seen of it, without a position and without stepping.
    var item = index === -1 ? viewer.snapshot : state.items[index];
    viewer.snapshot = item;
    var title = $('viewerTitle');
    title.textContent = photoName(item);
    // As on a tile, a bare file name is a fallback and is set back.
    title.className = 'media-viewer__title' + (item.title ? '' : ' is-filename');
    var alts = $('viewerAlts');
    alts.innerHTML = '';
    ['de', 'en'].forEach(function (locale) {
      var text = item.alt && item.alt[locale];
      if (!text) return;
      var row = el('li');
      row.appendChild(el('span', 'media-viewer__code', locale.toUpperCase()));
      var words = el('span', null, text);
      words.lang = locale;
      row.appendChild(words);
      alts.appendChild(row);
    });
    alts.hidden = !alts.firstElementChild;
    var position = $('viewerPosition');
    position.hidden = index === -1;
    position.textContent = index === -1 ? ''
      : fill(copy.mediaViewerPosition, { n: index + 1, total: state.items.length });
    // At an end a step control stays focusable and says so. Never `disabled`:
    // that would drop a keyboard user's focus to <body> inside the modal.
    $('viewerPrev').setAttribute('aria-disabled', index > 0 ? 'false' : 'true');
    $('viewerNext').setAttribute('aria-disabled', index !== -1 && index < state.items.length - 1 ? 'false' : 'true');
    renderStage(item);
  }

  /** The photograph — or, in words, why there is none. Never a broken image. */
  function renderStage(item) {
    var en = item.alt && item.alt.en;
    var de = item.alt && item.alt.de;
    var src = item.status === 'ready' ? item.fullSrc : null;
    var note = item.status !== 'ready' ? api.statusLabel(item) : src ? '' : copy.mediaNoPreview;
    var shown = [item.key, src || '', note, en || de || '', en ? 'en' : de ? 'de' : ''].join('\n');
    if (viewer.shown === shown) return;
    viewer.shown = shown;
    var stage = $('viewerStage');
    stage.innerHTML = '';
    if (!src) {
      stage.appendChild(el('p', 'media-viewer__note', note));
      return;
    }
    var img = document.createElement('img');
    // The English description, else the German one, in its own language.
    img.alt = en || de || '';
    if (en || de) img.lang = en ? 'en' : 'de';
    img.addEventListener('error', function () {
      // A load that fails after the stage has moved on belongs to no one.
      if (viewer.shown !== shown) return;
      stage.innerHTML = '';
      stage.appendChild(el('p', 'media-viewer__note', copy.mediaViewerLoadError));
      $('viewerLive').textContent = copy.mediaViewerLoadError;
    });
    img.src = src;
    stage.appendChild(img);
  }

  /** One photo back or forward in grid order; no wrap. */
  function stepViewer(delta) {
    var index = state.items.findIndex(function (i) { return i.key === viewer.currentKey; });
    var next = index === -1 ? null : state.items[index + delta];
    if (!next) return;
    viewer.currentKey = next.key;
    renderViewer();
    $('viewerLive').textContent = fill(copy.mediaViewerAnnounce,
      { n: index + delta + 1, total: state.items.length, title: photoName(next) });
  }

  /**
   * Closing hands focus back to where the viewer was opened from, resolved
   * again by key: the panel's button if the panel still shows that photo, else
   * the photo's tile, else the panel, else the grid's roving (or first) tile —
   * and with no photo left on the page, the empty state's upload action.
   */
  function onViewerClose() {
    var key = viewer.openerKey;
    var fromButton = viewer.openerKind === 'button';
    if (key === null) return;
    viewer.currentKey = viewer.openerKey = viewer.openerKind = viewer.snapshot = null;
    viewer.shown = '';
    $('viewerStage').innerHTML = '';
    $('viewerLive').textContent = '';
    var panel = $('detail');
    var button = $('dViewer');
    var cells = $('grid').querySelectorAll('.media-cell');
    var tile = state.items.findIndex(function (i) { return i.key === key; });
    if (fromButton && button && !panel.hidden && panel.dataset.key === key) button.focus();
    else if (cells[tile]) focusCell(tile);
    else if (!panel.hidden) panel.focus({ preventScroll: true });
    else if (cells.length) {
      focusCell(Math.max(0, Array.prototype.findIndex.call(cells, function (cell) { return cell.tabIndex === 0; })));
    } else $('emptyChoosePhotos').focus();
  }

  function bindViewer() {
    var dialog = $('mediaViewer');
    var previous = $('viewerPrev');
    var next = $('viewerNext');
    previous.textContent = copy.mediaViewerPrevious;
    previous.title = copy.mediaViewerPreviousTitle;
    next.textContent = copy.mediaViewerNext;
    next.title = copy.mediaViewerNextTitle;
    $('viewerClose').textContent = copy.mediaViewerClose;
    $('viewerAlts').setAttribute('aria-label', copy.mediaViewerAltLabel);
    previous.addEventListener('click', function () { stepViewer(-1); });
    next.addEventListener('click', function () { stepViewer(1); });
    $('viewerClose').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('keydown', function (ev) {
      // Unmodified only: Alt+← stays the browser's Back.
      if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      stepViewer(ev.key === 'ArrowLeft' ? -1 : 1);
    });
    // Escape (the dialog's native `cancel`) and Close both end here.
    dialog.addEventListener('close', onViewerClose);
  }

  // ---- AI suggestion for the photo in the panel ----------------------------

  /** The thumbnail a model may be shown, or null while the photo has none (still encoding, failed). */
  function suggestUrl(item) {
    return window.MediaAi.photoUrl(item, imageOrigin(), location.origin);
  }

  /** Suggest with AI and its status line, in the row of actions under the photograph. */
  function renderSuggest(row, item) {
    var button = el('button', 'btn-secondary', 'Suggest with AI');
    button.id = 'dSuggest';
    button.type = 'button';
    button.addEventListener('click', function () { suggestDetail(item, suggestUrl(item)); });
    var status = el('p', 'muted');
    status.id = 'dSuggestStatus';
    status.setAttribute('role', 'status');
    row.appendChild(button);
    row.appendChild(status);
    refreshSuggest(item);
  }

  /** Button and note follow the photo's state: unavailable while it has no thumbnail, busy while asking. */
  function refreshSuggest(item) {
    var button = $('dSuggest');
    var status = $('dSuggestStatus');
    if (!button || !status) return;
    var url = suggestUrl(item);
    button.disabled = !url || !!state.suggest;
    button.textContent = state.suggest ? 'Asking the model…' : 'Suggest with AI';
    status.textContent = state.suggest ? 'Asking the photo model…'
      : url ? '' : 'Available once the photo has finished encoding.';
  }

  function cancelSuggest() {
    if (!state.suggest) return;
    state.suggest.controller.abort();
    state.suggest = null;
  }

  function suggestStatus(busy, message) {
    var button = $('dSuggest');
    if (button) {
      button.disabled = busy;
      button.textContent = busy ? 'Asking the model…' : 'Suggest with AI';
    }
    var status = $('dSuggestStatus');
    if (status) status.textContent = message;
  }

  /**
   * Ask the photo model for title, alt, caption and tags. Empty fields are
   * filled; a field that already has text keeps it and offers the suggestion
   * beneath with a Use button. Nothing is saved here — Save details does that.
   */
  async function suggestDetail(item, url) {
    if (state.suggest || !url) return;
    var request = { key: item.key, controller: new AbortController() };
    var signal = request.controller.signal;
    state.suggest = request;
    suggestStatus(true, 'Asking the photo model…');
    var config = null;
    try {
      config = await window.AltSuggest.loadConfig(null, AbortSignal.any([signal, AbortSignal.timeout(15000)]));
      var suggestion = await window.MediaAi.suggest(url, config, signal);
      if (state.suggest !== request || $('detail').dataset.key !== item.key) return;
      suggestStatus(false, applySuggestion(item.key, suggestion));
    } catch (e) {
      if (state.suggest !== request) return;
      var why = config ? window.LLM.mixedContentWarning(config.captionBaseUrl, location.protocol) : '';
      suggestStatus(false, 'Could not suggest details: ' + (e && e.message ? e.message : String(e)) + '. '
        + (why || 'Check the photo-description settings, or fill in the fields by hand.'));
    } finally {
      if (config) config.captionApiKey = null;
      if (state.suggest === request) state.suggest = null;
    }
  }

  /** Puts a suggestion into the panel; returns the status line describing what happened. */
  function applySuggestion(key, s) {
    var slots = [
      ['dTitle', s.title, 'title'],
      ['dAltDe', s.altDe, 'German alt text'],
      ['dAltEn', s.altEn, 'English alt text'],
      ['dCapDe', s.captionDe, 'German caption'],
      ['dCapEn', s.captionEn, 'English caption'],
      ['dTags', (s.tags || []).join(', '), 'tags'],
    ];
    var filled = 0;
    var offers = [];
    slots.forEach(function (slot) {
      var input = $(slot[0]);
      var hint = $(slot[0] + 'Hint');
      var value = slot[1];
      if (!input || !hint || !value) return;
      if (!input.value.trim()) {
        input.value = value;
        filled++;
      } else if (input.value !== value) {
        offerSuggestion(hint, input, value, slot[2]);
        offers.push(slot);
      }
    });
    // Offers don't mark the panel dirty, so render() may rebuild it under
    // them (re-clicking the photo, a reload); renderDetail puts them back.
    state.offers = offers.length ? { key: key, slots: offers } : null;
    var offered = offers.length;
    if (filled) markDetailDirty();
    if (!filled && !offered) return 'The model suggested nothing new for this photo.';
    return (filled ? 'Filled ' + window.AdminFormat.count(filled, 'empty field') + '. ' : '')
      + (offered ? 'Fields that already had text keep it; the suggestion is shown below each. ' : '')
      + 'Review, then Save details.';
  }

  /** Re-shows the offers still pending for the panel's photo after a rebuild. */
  function restoreOffers() {
    if (!state.offers) return;
    state.offers.slots = state.offers.slots.filter(function (slot) {
      var input = $(slot[0]);
      var hint = $(slot[0] + 'Hint');
      if (!input || !hint || input.value === slot[1]) return false;
      offerSuggestion(hint, input, slot[1], slot[2]);
      return true;
    });
    if (!state.offers.slots.length) state.offers = null;
  }

  function offerSuggestion(hint, input, value, what) {
    hint.innerHTML = '';
    hint.appendChild(el('span', 'media-ai-hint__label', 'Suggested: '));
    hint.appendChild(el('span', null, value));
    var use = el('button', 'btn-link', 'Use');
    use.type = 'button';
    use.setAttribute('aria-label', 'Use the suggested ' + what);
    use.addEventListener('click', function () {
      input.value = value;
      hint.hidden = true;
      if (state.offers) {
        state.offers.slots = state.offers.slots.filter(function (slot) { return slot[0] !== input.id; });
        if (!state.offers.slots.length) state.offers = null;
      }
      markDetailDirty();
      input.focus();
    });
    hint.appendChild(use);
    hint.hidden = false;
  }

  // ---- actions ------------------------------------------------------------

  /**
   * PATCHes only the fields the author changed, diffed against the row the
   * panel was built from. A dirty panel is deliberately NOT rebuilt (see
   * renderDetail), so a field they never touched can be stale by the time
   * they save: after a bulk move of the same photo, sending the panel's old
   * folder back would silently undo the move. Untouched means "still what
   * the panel showed", which is why the diff base is the render snapshot and
   * not the freshest row. alt and caption send only the locale that changed,
   * for the same reason: a bulk AI run may have filled the other one meanwhile.
   */
  function detailPatch(retained) {
    var values = {
      title: $('dTitle').value,
      alt: { de: $('dAltDe').value, en: $('dAltEn').value },
      caption: { de: $('dCapDe').value, en: $('dCapEn').value },
      tags: $('dTags').value.split(','),
      folder: $('dFolder').value,
    };
    var patch = api.changedFields(values, state.detailItem);
    // Explicit Use mine still writes an attempted leaf when the author has
    // changed it back to the render value: the compared stored value may differ.
    var attempted = api.expectations(retained || {}, values);
    Object.keys(attempted).forEach(function (field) {
      patch[field] = field === 'alt' || field === 'caption'
        ? Object.assign({}, patch[field], attempted[field]) : attempted[field];
    });
    return patch;
  }

  function showDetailRecovery(key, error) {
    state.detailRecovery = error;
    var box = $('dCompare');
    box.innerHTML = '';
    box.appendChild(el('p', null, error.unsupported ? copy.mediaConditionalUnsupported
      : error.unknown ? copy.mediaConditionalUnknown : copy.mediaConditionalConflict));
    (error.fields || []).forEach(function (field) {
      box.appendChild(el('p', null, field.field + ': ' + copy['mediaConditional' + {
        achieved: 'Achieved', expected: 'Expected', other: 'Other',
      }[field.outcome]] + ' — ' + copy.mediaConditionalMine + ': ' + JSON.stringify(field.intended)
        + '; ' + copy.mediaConditionalStored + ': ' + JSON.stringify(field.stored)));
    });
    if (error.unsupported) return;
    var check = el('button', 'btn-link', copy.mediaConditionalCheck);
    check.type = 'button';
    check.id = 'dCheckStored';
    check.addEventListener('click', async function () {
      check.disabled = true;
      try {
        var current = await client.get(key);
        if ($('detail').dataset.key !== key || state.detailRecovery !== error) return;
        var patch = detailPatch(error.patch);
        showDetailRecovery(key, { unknown: error.unknown, current: current,
          patch: patch, generation: state.detailGeneration,
          fields: api.compareFields(patch, api.expectations(patch, state.detailItem), current, key) });
      } catch (failure) { fail(failure); }
      finally { check.disabled = false; }
    });
    box.appendChild(check);
    if (!error.current) return;
    var mine = el('button', null, copy.mediaConditionalUseMine);
    mine.type = 'button';
    mine.id = 'dUseMine';
    mine.disabled = state.detailSaving;
    mine.addEventListener('click', function () { saveDetail(key, error.current); });
    box.appendChild(mine);
    var generation = error.generation;
    var stored = el('button', 'btn-link', copy.mediaConditionalUseStored);
    stored.type = 'button';
    stored.id = 'dUseStored';
    stored.disabled = state.detailSaving;
    stored.addEventListener('click', function () {
      if (state.detailSaving) return;
      if (state.detailGeneration !== generation) {
        say(copy.mediaConditionalNewer);
        var patch = detailPatch(error.patch);
        showDetailRecovery(key, { unknown: error.unknown, current: error.current,
          patch: patch, generation: state.detailGeneration,
          fields: api.compareFields(patch, api.expectations(patch, state.detailItem), error.current, key) });
        return;
      }
      state.items = state.items.map(function (item) { return item.key === key ? error.current : item; });
      state.detailDirty = false;
      renderDetail();
      void reload();
    });
    box.appendChild(stored);
  }

  function setDetailSaving(saving) {
    state.detailSaving = saving;
    ['dSave', 'dUseMine', 'dUseStored'].forEach(function (id) {
      var control = $(id);
      if (control) control.disabled = saving;
    });
  }

  async function saveDetail(key, current) {
    if (state.detailSaving) return;
    if (state.detailRecovery && !current) { say(copy.mediaConditionalReview); return; }
    var generation = state.detailGeneration;
    var titleInput = $('dTitle');
    var refreshListing = false;
    // Save details (or Use mine) is disabled while it runs and rebuilt after;
    // keyboard focus comes back to Save details rather than falling to <body>.
    var trigger = document.activeElement;
    var restore = window.AdminFocus.hold(trigger && trigger === $('dUseMine') ? trigger : $('dSave'));
    setDetailSaving(true);
    detailRefresh.beginAction();
    state.detailChanged = null;
    renderImpact();
    try {
      var patch = detailPatch(current && state.detailRecovery ? state.detailRecovery.patch : null);
      if (!Object.keys(patch).length) {
        state.detailDirty = false;
        state.detailChanged = { de: { alt: false, caption: false }, en: { alt: false, caption: false } };
        renderDetail();
        return;
      }
      var saved = await api.savePatch(client, key, patch, api.expectations(patch, current || state.detailItem));
      refreshListing = true;
      state.items = state.items.map(function (item) { return item.key === key ? saved : item; });
      if ($('detail').dataset.key !== key) return;
      state.detailChanged = saved.changedDescriptions || null;
      renderImpact();
      if ($('dTitle') !== titleInput) {
        // Navigation discarded that form. Refresh a clean reopened panel, but
        // never advance a new dirty panel's editing base underneath its inputs.
        if (!state.detailDirty) renderDetail();
        return;
      }
      if (state.detailGeneration !== generation) {
        // Advance only acknowledged leaves. Newer inputs stay untouched, and
        // unrelated values in the response must not become unintended edits.
        var acknowledged = api.expectations(patch, saved);
        state.detailItem = Object.assign({}, state.detailItem);
        Object.keys(acknowledged).forEach(function (field) {
          state.detailItem[field] = field === 'alt' || field === 'caption'
            ? Object.assign({}, state.detailItem[field], acknowledged[field]) : acknowledged[field];
        });
        state.detailRecovery = null;
        $('dCompare').innerHTML = '';
        say(copy.mediaConditionalNewer);
        return;
      }
      state.detailDirty = false;
      renderDetail();
      say(copy.mediaConditionalSaved);
    } catch (error) {
      if ($('detail').dataset.key !== key) return;
      if (error.status === 401 || (error.probeError && error.probeError.status === 401)) {
        fail(error.probeError || error);
      }
      if ($('dTitle') !== titleInput) return;
      if (error.unsupported || error.unknown || error.status === 409) {
        error.patch = patch;
        error.generation = generation;
        showDetailRecovery(key, error);
      }
      else fail(error);
    } finally {
      setDetailSaving(false);
      restore($('dSave'));
      detailRefresh.endAction(false);
      // Reconcile server-side filters, order and selection after adoption.
      // reload preserves dirty panels and fences superseded list responses.
      if (refreshListing) void reload();
    }
  }

  async function deleteOne(item) {
    var ok = await window.AdminConfirm.ask({
      title: 'Delete this photo?',
      body: '"' + photoName(item) + '"\n\nThe image files and its metadata are removed. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    var index = state.items.findIndex(function (photo) { return photo.key === item.key; });
    try {
      await client.remove(item.key);
      state.detailKey = null;
      state.detailDirty = false;
      await reload('Photo deleted.');
    } catch (e) { fail(e); return; }
    // The tile is gone and the panel with it: land on the photo that took its
    // place, else the one before it, else the upload action of the empty state.
    var cells = $('grid').querySelectorAll('.media-cell');
    if (cells.length) focusCell(Math.min(Math.max(index, 0), cells.length - 1));
    else $('emptyChoosePhotos').focus();
  }

  // ---- wiring -------------------------------------------------------------

  function bindFilters() {
    // One request per pause in typing, not per keystroke; reload() itself
    // drops any response a later keystroke has already superseded.
    $('fSearch').addEventListener('input', api.debounce(function () {
      state.q = $('fSearch').value;
      state.page = 1;
      reload();
    }, 200));
    $('fStatus').addEventListener('change', function () {
      state.status = $('fStatus').value;
      state.page = 1;
      reload();
    });
    $('fRecursive').addEventListener('change', function () {
      state.recursive = $('fRecursive').checked;
      reload();
    });
    $('fAlt').addEventListener('change', function () { setAltFilter($('fAlt').value); });
    $('altMissingAction').addEventListener('click', function () {
      setAltFilter(state.alt === 'missing' ? '' : 'missing');
    });
    $('fMore').addEventListener('click', function () { setMoreFilters($('fExtra').hidden); });
    $('prevPage').addEventListener('click', function () { state.page = Math.max(1, state.page - 1); reload(); });
    $('nextPage').addEventListener('click', function () { state.page += 1; reload(); });
    // The encoding poll follows the tab: nothing is read while it is hidden.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPoll(); else schedulePoll();
    });
    window.addEventListener('pagehide', stopPoll);
  }

  function bindUpload() {
    var zone = $('dropZone');
    var input = $('fileInput');
    var accept = function (files) {
      if (!files || !files.length) return;
      uploads.add(files, { folder: state.folder });
      say(copy.uploadStarted.replace('{count}', window.AdminFormat.count(files.length, 'file')));
    };
    input.addEventListener('change', function () { accept(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (t) {
      zone.addEventListener(t, function (ev) { ev.preventDefault(); zone.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      zone.addEventListener(t, function (ev) { ev.preventDefault(); zone.classList.remove('is-over'); });
    });
    zone.addEventListener('drop', function (ev) {
      accept(ev.dataTransfer && ev.dataTransfer.files);
    });
  }

  // Each uncertain operation keeps its own bounded read/control. A listing,
  // filter change or later operation cannot erase evidence about selected keys.
  async function folderMoveOperation(operation) {
    var panel = el('section', 'write-recovery');
    var message = el('p', '');
    message.setAttribute('role', 'status');
    var results = el('ul', '');
    var check = el('button', 'btn-secondary', copy.writeCheckAgain); check.type = 'button';
    var again = el('button', 'btn-secondary', operation.kind === 'folder' ? copy.folderCreateAgain : copy.moveAgain); again.type = 'button';
    check.hidden = true; again.hidden = true;
    panel.append(message, results, check, again);
    $('out').insertAdjacentElement('afterend', panel);
    var busy = false;
    async function probe() {
      if (busy) return;
      busy = true; check.disabled = true; again.hidden = true; results.textContent = '';
      message.textContent = operation.kind === 'folder' ? copy.folderChecking : copy.moveChecking;
      try {
        if (operation.kind === 'folder') {
          var folders = await client.folders();
          if (!Array.isArray(folders) || folders.some(function (path) { return typeof path !== 'string'; })) throw new Error('invalid_response');
          state.folders = folders;
          renderFolders();
          renderToolbar();
          var present = folders.indexOf(operation.path) !== -1;
          message.textContent = (present ? copy.folderPresent : copy.folderAbsent) + ' ' + operation.path;
          again.hidden = present;
        } else {
          var lookup = await client.lookup(operation.keys);
          if (!lookup || !Array.isArray(lookup.items) || lookup.items.length !== operation.keys.length
            || new Set(lookup.items.map(function (item) { return item.key; })).size !== operation.keys.length
            || lookup.items.some(function (item) { return operation.keys.indexOf(item.key) === -1 || item.missing !== true && typeof item.folder !== 'string'; })) throw new Error('invalid_response');
          message.textContent = copy.moveStored + ' ' + copy.movePolicy;
          lookup.items.forEach(function (item) { results.appendChild(el('li', '', item.key + ': ' + (item.missing ? copy.moveDeleted : item.folder || '/'))); });
          again.hidden = false;
          // Refresh the visible query separately; the scoped lookup remains its evidence.
          void reload();
        }
      } catch (error) { message.textContent = copy.writeUnknown; if (error.status === 401) fail(error); }
      finally { check.hidden = false; check.disabled = false; busy = false; }
    }
    async function send() {
      if (busy) return;
      busy = true; check.hidden = true; again.hidden = true;
      try {
        var acknowledged = operation.kind === 'folder'
          ? await client.createFolder(operation.path)
          : await client.move(operation.keys, operation.folder);
        if (!acknowledged || acknowledged.ok !== true
          || operation.kind === 'folder' && (!Array.isArray(acknowledged.folders) || acknowledged.folders.indexOf(operation.path) === -1)
          || operation.kind === 'move' && (!Number.isSafeInteger(acknowledged.moved) || acknowledged.moved < 0 || acknowledged.moved > operation.keys.length)) {
          throw Object.assign(new Error('invalid_response'), { unknown: true });
        }
        if (operation.kind === 'folder') {
          // Acknowledged: the recovery panel has nothing to say. Open the new
          // folder and report it where every other outcome is reported.
          panel.remove();
          state.folder = operation.path;
          state.page = 1;
          void reload('Folder created.').catch(function () {});
          return;
        }
        // A valid acknowledgement is displayed separately from this optional refresh.
        message.textContent = copy.moveStored;
        void reload().catch(function () {});
      } catch (error) {
        if (api.isUnknown(error)) { busy = false; await probe(); }
        else { message.textContent = error.message; fail(error); }
      } finally { busy = false; }
    }
    check.addEventListener('click', probe);
    again.addEventListener('click', send);
    await send();
  }

  function bindFolderActions() {
    $('newFolder').addEventListener('click', async function () {
      var parent = state.folder;
      var name = await window.AdminConfirm.prompt({
        title: 'New folder',
        body: parent ? 'Inside "' + parent + '".' : 'At the top level of the library.',
        label: 'Folder name',
        confirmLabel: 'Create folder',
        required: 'Enter a folder name.',
        validate: function (text) { return api.folderNameRefusal(text, parent); },
      });
      if (name === null) return;
      await folderMoveOperation({ kind: 'folder', path: (parent ? parent + '/' : '') + name.normalize('NFC') });
    });
    $('renameFolder').addEventListener('click', async function () {
      if (!state.folder) { say('Pick a folder first.'); return; }
      var from = state.folder;
      var parent = api.parentOf(from);
      var name = await window.AdminConfirm.prompt({
        title: 'Rename folder',
        body: 'The photos and subfolders of "' + from + '" move with it.',
        label: 'Folder name',
        value: from.split('/').pop(),
        confirmLabel: 'Rename folder',
        required: 'Enter a folder name.',
        validate: function (text) { return api.folderNameRefusal(text, parent); },
      });
      if (name === null) return;
      var to = (parent ? parent + '/' : '') + name.normalize('NFC');
      if (to === from) return;
      try {
        var res = await client.renameFolder(from, to);
        state.folder = to;
        await reload('Folder renamed (' + photos(res.moved) + ' moved).');
      } catch (e) { fail(e); }
    });
    $('deleteFolder').addEventListener('click', async function () {
      if (!state.folder) { say('Pick a folder first.'); return; }
      var ok = await window.AdminConfirm.ask({
        title: 'Delete this folder?',
        body: 'Delete the empty folder "' + state.folder + '"?',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await client.deleteFolder(state.folder);
        state.folder = api.parentOf(state.folder);
        await reload('Folder deleted.');
      } catch (e) { fail(e); return; }
      // Delete is disabled for "All photos", so focus moves on to the folder
      // that is now current — the parent, or All photos.
      var current = $('folderTree').querySelectorAll('.is-current')[0];
      if (current) current.focus();
    });
  }

  function bindBulk() {
    $('moveSelected').addEventListener('click', async function () {
      var keys = state.selected.slice();
      if (!keys.length || keys.length > 100) { say(copy.mediaLookupLimit); return; }
      await folderMoveOperation({ kind: 'move', keys: keys, folder: $('moveTarget').value });
    });
    $('retrySelected').addEventListener('click', async function () {
      try {
        var res = await client.retry(state.selected);
        await reload('Re-queued ' + photos(res.queued) + '.');
      } catch (e) { fail(e); }
    });
    $('aiSelected').addEventListener('click', function () { aiDialog.open('selected'); });
    $('aiAll').addEventListener('click', function () {
      aiDialog.open(state.selected.length ? 'selected' : 'all');
    });
    $('clearSelection').addEventListener('click', function () {
      var anchor = state.anchor;
      state.selected = [];
      render();
      // The bulk bar (and this button) is gone: continue from the photo the
      // selection started at, else the first one.
      var keys = visibleKeys();
      focusCell(Math.max(0, keys.indexOf(anchor)));
    });
    $('rescan').addEventListener('click', async function () {
      say('Reconciling…');
      try {
        var r = await client.rescan();
        await reload('Rescan: scanned ' + r.scanned + ', added ' + r.inserted
          + ', alt harvested ' + r.altHarvested + ', marked missing ' + r.markedMissing
          + ', demoted ' + r.demoted + ' (incomplete on disk), re-queued ' + r.recovered + ' for encoding.');
      } catch (e) { fail(e); }
    });
  }

  /** Human description of the current folder + filters, for the AI dialog's scope. */
  function viewDescription() {
    var parts = [state.folder
      ? 'folder “' + state.folder + '”' + (state.recursive ? ' and its subfolders' : '')
      : 'every folder'];
    if (state.q) parts.push('search “' + state.q + '”');
    if (state.status) parts.push('status ' + state.status);
    if (state.alt === 'missing') parts.push('without alt text');
    return parts.join(', ');
  }

  function bindAi() {
    aiDialog = window.MediaAiDialog.attach({
      client: client,
      imageOrigin: imageOrigin(),
      view: function () {
        return {
          selectedItems: state.items.filter(function (i) { return state.selected.indexOf(i.key) !== -1; }),
          total: state.total,
          description: viewDescription(),
          query: {
            folder: state.folder, recursive: state.recursive, q: state.q, tag: state.tag,
            status: state.status, alt: state.alt, sort: state.sort, order: state.order,
          },
        };
      },
      onFinished: function (message) { reload(message); },
    });
  }

  var initialized = false;
  async function activate(me) {
    state.me = me;
    uploads.initialize(me.userId);
    window.Auth.renderHeader(state.me);
    if (!state.me.isAdmin) {
      $('rescan').hidden = true;
      $('renameFolder').hidden = true;
      $('deleteFolder').hidden = true;
    }
    if (initialized) {
      detailRefresh.start(false);
      await reload();
      await detailRefresh.refresh();
      return;
    }
    initialized = true;
    $('mediaFolders').open = !window.matchMedia('(max-width: 900px)').matches;
    $('emptyChoosePhotos').textContent = copy.mediaChoosePhotos;
    $('emptyChoosePhotos').addEventListener('click', function () {
      $('dropZone').open = true;
      $('fileInput').focus();
      $('fileInput').click();
    });
    $('emptyShowAll').textContent = copy.mediaShowAll;
    $('emptyShowAll').addEventListener('click', function () {
      state.folder = state.q = state.tag = state.status = state.alt = '';
      state.recursive = true;
      state.page = 1;
      $('fSearch').value = $('fStatus').value = $('fAlt').value = '';
      $('fRecursive').checked = true;
      $('fSearch').focus();
      reload();
    });
    bindFilters();
    bindUpload();
    bindFolderActions();
    bindBulk();
    bindAi();
    bindViewer();
    // Delegated: the panel's inputs are rebuilt by renderDetail; the panel is not.
    $('detail').addEventListener('input', markDetailDirty);
    $('detail').addEventListener('change', markDetailDirty);
    detailRefresh.start(false);
    // The folder and the alt filter survive a reload through the URL. A folder
    // that no longer exists falls back to All photos instead of an empty view.
    var restored = readUrlState();
    state.alt = restored.alt;
    $('fAlt').value = state.alt;
    if (state.alt) setMoreFilters(true);
    if (restored.folder) {
      try {
        var folders = await client.folders();
        if (folders.indexOf(restored.folder) !== -1) state.folder = restored.folder;
      } catch (_) { /* reload() below reports the failure once */ }
    }
    await reload();
  }
  (async function init() {
    try { await activate(await client.me()); }
    catch (error) { fail(error); }
  })();
})();
