// The media library page (media.html). DOM only — every pure helper lives in
// media-api.js, which is unit-tested.
//
// Three rules, all load-bearing at this size (~700 lines of vanilla JS with no
// reactive layer):
//   1. ONE state object, ONE render(). The grid is rebuilt from state; it is
//      never mutated ad hoc. Five interacting states (selection × folder ×
//      filter × queue × detail-dirty) is where this kind of module rots.
//   2. DOM is built with textContent. `innerHTML` is permitted ONLY for `= ''`.
//      This module renders attacker-influenced EXIF strings, folder names and
//      captions — see the browser-mirror test that pins this.
//   3. No drag-to-reorder anywhere: it has no keyboard equivalent and
//      PRODUCT.md commits to WCAG 2.1 AA. Ordering uses move-up/down buttons.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.MediaApi;

  var state = {
    me: null,
    folder: '',          // '' = root
    recursive: true,
    q: '',
    tag: '',
    status: '',
    sort: 'uploaded',
    order: 'desc',
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
    suggest: null,       // in-flight AI suggestion for the panel's photo: { key, controller }
    offers: null,        // suggestions shown under fields that had text: { key, slots: [[inputId, value, what]] }
    queue: null,
  };

  var client = api.makeClient({ onUnauthed: function () { location.href = '/login'; } });
  var uploads = api.createUploadQueue(client, {
    onChange: function (snap) { state.queue = snap; renderQueue(); },
  });

  function say(msg) { $('out').textContent = msg; }

  function fail(err) {
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

  async function reload(msg) {
    var ticket = loads.next();
    try {
      var res = await client.list({
        folder: state.folder, recursive: state.recursive, q: state.q, tag: state.tag,
        status: state.status, sort: state.sort, order: state.order,
        page: state.page, pageSize: state.pageSize,
      });
      var folders = await client.folders();
      if (!loads.isCurrent(ticket)) return;
      state.items = res.items;
      state.total = res.total;
      state.folders = folders;
      // Drop selections for photos no longer in view.
      var visible = state.items.map(function (i) { return i.key; });
      state.selected = state.selected.filter(function (k) { return visible.indexOf(k) !== -1; });
      render();
      say(msg != null ? msg : state.total + ' photo(s)');
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

  function renderFolders() {
    var list = $('folderTree');
    list.innerHTML = '';
    var mk = function (path, label, depth) {
      var li = document.createElement('li');
      var btn = el('button', 'folder-btn' + (state.folder === path ? ' is-current' : ''), label);
      btn.type = 'button';
      btn.style.paddingLeft = (0.4 + depth * 0.8) + 'rem';
      btn.addEventListener('click', function () {
        state.folder = path;
        state.page = 1;
        reload();
      });
      li.appendChild(btn);
      list.appendChild(li);
    };
    mk('', 'All photos', 0);
    api.folderTree(state.folders).forEach(function (n) { mk(n.path, n.name, n.depth + 1); });
  }

  function renderGrid() {
    var grid = $('grid');
    grid.innerHTML = '';
    if (!state.items.length) {
      grid.appendChild(el('p', 'muted', 'No photos here yet.'));
      return;
    }
    state.items.forEach(function (item, index) {
      var cell = el('div', 'media-cell' + (state.selected.indexOf(item.key) !== -1 ? ' is-selected' : ''));
      cell.setAttribute('role', 'option');
      cell.setAttribute('aria-selected', state.selected.indexOf(item.key) !== -1 ? 'true' : 'false');
      // Roving tabindex: exactly one cell is tabbable at a time.
      cell.tabIndex = index === 0 ? 0 : -1;
      cell.dataset.key = item.key;

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

      cell.appendChild(el('span', 'media-cell__title', item.title || item.key.split('/').pop()));
      if (item.usedIn && item.usedIn.length) {
        // "(published version)": the live post still renders it although the
        // draft dropped it — the admin has to republish before it can go.
        cell.appendChild(el('span', 'media-cell__used', 'used in: '
          + item.usedIn.map(function (u) {
            return u.title + (u.published && !u.working ? ' (published version)' : '');
          }).join(', ')));
      }

      cell.addEventListener('click', function (ev) { onCellActivate(item.key, ev); });
      cell.addEventListener('keydown', function (ev) { onGridKey(ev, index); });
      grid.appendChild(cell);
    });
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
  }

  function renderQueue() {
    var box = $('uploadQueue');
    var snap = state.queue;
    box.innerHTML = '';
    if (!snap || !snap.total) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('p', 'muted', snap.done + ' of ' + snap.total + ' uploaded'
      + (snap.failed ? ' · ' + snap.failed + ' failed' : '')));
    snap.items.forEach(function (i) {
      var row = el('div', 'upload-row');
      row.appendChild(el('span', 'upload-row__name', i.name));
      row.appendChild(el('span', 'upload-row__state', api.queueState(i)));
      box.appendChild(row);
    });
    if (snap.failed) {
      var retry = el('button', 'btn-secondary', 'Retry failed (' + snap.failed + ')');
      retry.type = 'button';
      retry.addEventListener('click', function () { uploads.retryFailed(); });
      box.appendChild(retry);
    }
    if (snap.done && snap.active === 0) {
      var clear = el('button', 'btn-secondary', 'Clear finished');
      clear.type = 'button';
      clear.addEventListener('click', function () { uploads.clearFinished(); reload(); });
      box.appendChild(clear);
    }
  }

  // The detail panel is the one place on this page the author types. Rebuilding
  // it mid-edit throws that text away, so while `detailDirty` is set the panel
  // is left untouched — whatever reload() or a selection change did to the rest
  // of the page — until the edits are saved or explicitly discarded
  // (see detailReplaceable).
  function renderDetail() {
    if (state.detailDirty) return;
    var panel = $('detail');
    panel.innerHTML = '';
    var item = state.items.filter(function (i) { return i.key === state.detailKey; })[0];
    // A suggestion belongs to the photo it was asked for: once the panel shows
    // another photo (or none), the request is abandoned, never applied, and
    // the offers it left under fields are dropped.
    if (state.suggest && (!item || state.suggest.key !== item.key)) cancelSuggest();
    if (state.offers && (!item || state.offers.key !== item.key)) state.offers = null;
    if (!item) {
      delete panel.dataset.key;
      panel.appendChild(el('p', 'muted', 'Select a photo to edit its details.'));
      return;
    }
    panel.dataset.key = item.key;
    state.detailItem = item;
    panel.appendChild(el('p', 'section-label', 'Photo'));
    panel.appendChild(el('p', 'media-key', item.key));
    renderSuggest(panel, item);

    var fields = [
      { id: 'dTitle', label: 'Title', value: item.title },
      { id: 'dAltDe', label: 'Alt (DE)', value: item.alt.de },
      { id: 'dAltEn', label: 'Alt (EN)', value: item.alt.en },
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
    state.folders.forEach(function (f) {
      var opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f;
      folderSelect.appendChild(opt);
    });
    folderSelect.value = item.folder;
    folderLabel.appendChild(folderSelect);
    panel.appendChild(folderLabel);

    var save = el('button', 'btn-secondary', 'Save details');
    save.id = 'dSave';
    save.type = 'button';
    save.addEventListener('click', function () { saveDetail(item.key); });
    panel.appendChild(save);
    var unsaved = el('p', 'muted', 'Unsaved changes — Save details to keep them.');
    unsaved.id = 'dUnsaved';
    unsaved.setAttribute('role', 'status');
    unsaved.hidden = true;
    panel.appendChild(unsaved);

    // EXIF is read-only. lat/lng are absent entirely for non-admins.
    panel.appendChild(el('p', 'section-label', 'Camera'));
    var dl = el('dl', 'keyfacts-mini');
    var rows = [
      ['Taken', api.formatTakenAt(item.exif && item.exif.takenAt)],
      ['Camera', item.exif && item.exif.camera],
      ['Lens', item.exif && item.exif.lens],
      ['Size', item.width && item.height ? item.width + '×' + item.height : '—'],
      ['Original', api.formatBytes(item.origBytes)],
      ['Variants', api.formatBytes(item.variantBytes)],
    ];
    if (item.exif && item.exif.lat !== null && item.exif.lat !== undefined) {
      rows.push(['GPS', item.exif.lat.toFixed(4) + ', ' + Number(item.exif.lng).toFixed(4)]);
    }
    rows.forEach(function (r) {
      dl.appendChild(el('dt', null, r[0]));
      dl.appendChild(el('dd', null, r[1] || '—'));
    });
    panel.appendChild(dl);

    if (item.status === 'failed') {
      var retryOne = el('button', 'btn-secondary', 'Retry encoding');
      retryOne.type = 'button';
      retryOne.addEventListener('click', function () {
        client.retry([item.key]).then(function () { reload('Re-queued for encoding.'); }, fail);
      });
      panel.appendChild(retryOne);
    }
    if (state.me && state.me.isAdmin) {
      var del = el('button', 'btn-remove', 'Delete photo');
      del.type = 'button';
      if (item.status === 'processing') {
        // The server refuses (409) while the encoder may still write under
        // this key (#116); say so up front instead of after the confirm.
        // `state.items` only changes on reload(), so offer a one-item
        // re-check that flips the button in place — a full re-render would
        // throw away whatever the admin has typed into the details form.
        var note = el('p', 'muted', 'Still encoding — delete becomes available once it finishes or fails. ');
        note.id = 'deleteNote';
        var recheck = el('button', 'btn-link', 'Check again');
        recheck.type = 'button';
        recheck.addEventListener('click', async function () {
          try {
            var fresh = await client.get(item.key);
            item.status = fresh.status; item.error = fresh.error;
            if (fresh.status === 'processing') { say('Still encoding.'); return; }
            del.disabled = false;
            del.removeAttribute('aria-describedby');
            note.remove();
            say(fresh.status === 'ready' ? 'Encoding finished.' : 'Encoding ' + fresh.status + '.');
          } catch (e) { fail(e); }
        });
        note.appendChild(recheck);
        del.disabled = true;
        del.setAttribute('aria-describedby', 'deleteNote');
        panel.appendChild(note);
      }
      del.addEventListener('click', function () { deleteOne(item); });
      panel.appendChild(del);
    }
  }

  function render() {
    renderFolders();
    renderGrid();
    renderToolbar();
    renderDetail();
    renderQueue();
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
   * True when the detail panel may be replaced. Asks first if it holds unsaved
   * edits, so a mis-click on a neighbouring photo cannot silently eat them.
   */
  function detailReplaceable(nextKey) {
    if (!state.detailDirty || nextKey === state.detailKey) return true;
    var key = $('detail').dataset.key || state.detailKey;
    if (!confirm('Discard the unsaved changes to "' + key + '"?')) return false;
    state.detailDirty = false;
    return true;
  }

  function markDetailDirty() {
    state.detailDirty = true;
    var hint = $('dUnsaved');
    if (hint) hint.hidden = false;
  }

  function onCellActivate(key, ev) {
    if (!detailReplaceable(key)) return;
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
  }

  /** Roving tabindex + arrow keys; Space toggles, Shift+Arrow extends. */
  function onGridKey(ev, index) {
    var keys = visibleKeys();
    var cols = 1;
    var grid = $('grid');
    if (grid.firstElementChild) {
      cols = Math.max(1, Math.round(grid.clientWidth / grid.firstElementChild.offsetWidth)) || 1;
    }
    var next = null;
    if (ev.key === 'ArrowRight') next = index + 1;
    else if (ev.key === 'ArrowLeft') next = index - 1;
    else if (ev.key === 'ArrowDown') next = index + cols;
    else if (ev.key === 'ArrowUp') next = index - cols;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = keys.length - 1;
    else if (ev.key === ' ' || ev.key === 'Spacebar') {
      ev.preventDefault();
      if (!detailReplaceable(keys[index])) return;
      toggle(keys[index]);
      state.anchor = keys[index];
      state.detailKey = keys[index];
      render();
      focusCell(index);
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
    // in detailReplaceable compares against.
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

  // ---- AI suggestion for the photo in the panel ----------------------------

  function renderSuggest(panel, item) {
    var url = window.MediaAi.photoUrl(item, imageOrigin(), location.origin);
    var row = el('div', 'media-ai-suggest');
    var button = el('button', 'btn-secondary', state.suggest ? 'Asking the model…' : 'Suggest with AI');
    button.id = 'dSuggest';
    button.type = 'button';
    button.disabled = !url || !!state.suggest;
    button.addEventListener('click', function () { suggestDetail(item, url); });
    var status = el('p', 'muted', state.suggest ? 'Asking the photo model…'
      : url ? '' : 'Available once the photo has finished encoding.');
    status.id = 'dSuggestStatus';
    status.setAttribute('role', 'status');
    row.appendChild(button);
    row.appendChild(status);
    panel.appendChild(row);
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
    return (filled ? 'Filled ' + filled + ' empty field' + (filled === 1 ? '' : 's') + '. ' : '')
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
  function detailPatch() {
    var base = state.detailItem;
    var patch = {};
    var title = $('dTitle').value;
    if (title !== (base.title || '')) patch.title = title;
    var pair = function (field, deId, enId) {
      var changed = {};
      if ($(deId).value !== (base[field].de || '')) changed.de = $(deId).value;
      if ($(enId).value !== (base[field].en || '')) changed.en = $(enId).value;
      if (Object.keys(changed).length) patch[field] = changed;
    };
    pair('alt', 'dAltDe', 'dAltEn');
    pair('caption', 'dCapDe', 'dCapEn');
    var tags = $('dTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    if (tags.join('\n') !== (base.tags || []).join('\n')) patch.tags = tags;
    var folder = $('dFolder').value;
    if (folder !== (base.folder || '')) patch.folder = folder;
    return patch;
  }

  async function saveDetail(key) {
    try {
      await client.patch(key, detailPatch());
      state.detailDirty = false;
      await reload('Saved.');
    } catch (e) { fail(e); }
  }

  async function deleteOne(item) {
    var ok = await window.AdminConfirm.ask({
      title: 'Delete this photo?',
      body: '"' + (item.title || item.key) + '"\n\nThe image files and its metadata are removed. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await client.remove(item.key);
      state.detailKey = null;
      state.detailDirty = false;
      await reload('Deleted.');
    } catch (e) { fail(e); }
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
    $('fSort').addEventListener('change', function () { state.sort = $('fSort').value; reload(); });
    $('fOrder').addEventListener('change', function () { state.order = $('fOrder').value; reload(); });
    $('fRecursive').addEventListener('change', function () {
      state.recursive = $('fRecursive').checked;
      reload();
    });
    var more = $('fMore');
    if (more) more.addEventListener('click', function () {
      var extra = $('fExtra');
      extra.hidden = !extra.hidden;
      more.setAttribute('aria-expanded', extra.hidden ? 'false' : 'true');
      more.textContent = extra.hidden ? 'More filters' : 'Fewer filters';
    });
    $('prevPage').addEventListener('click', function () { state.page = Math.max(1, state.page - 1); reload(); });
    $('nextPage').addEventListener('click', function () { state.page += 1; reload(); });
  }

  function bindUpload() {
    var zone = $('dropZone');
    var input = $('fileInput');
    var accept = function (files) {
      if (!files || !files.length) return;
      uploads.add(files, { folder: state.folder });
      say('Uploading ' + files.length + ' file(s) — you can keep working; encoding continues on the server.');
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

  function bindFolderActions() {
    $('newFolder').addEventListener('click', async function () {
      var path = prompt('New folder name (inside "' + (state.folder || 'root') + '"):');
      if (!path) return;
      var full = state.folder ? state.folder + '/' + path : path;
      try { await client.createFolder(full); await reload('Folder created.'); } catch (e) { fail(e); }
    });
    $('renameFolder').addEventListener('click', async function () {
      if (!state.folder) { say('Pick a folder first.'); return; }
      var to = prompt('Rename "' + state.folder + '" to:', state.folder);
      if (!to || to === state.folder) return;
      try {
        var res = await client.renameFolder(state.folder, to);
        state.folder = to;
        await reload('Folder renamed (' + res.moved + ' photo(s) moved).');
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
      } catch (e) { fail(e); }
    });
  }

  function bindBulk() {
    $('moveSelected').addEventListener('click', async function () {
      try {
        var res = await client.move(state.selected, $('moveTarget').value);
        await reload('Moved ' + res.moved + ' photo(s).');
      } catch (e) { fail(e); }
    });
    $('retrySelected').addEventListener('click', async function () {
      try {
        var res = await client.retry(state.selected);
        await reload('Re-queued ' + res.queued + ' photo(s).');
      } catch (e) { fail(e); }
    });
    $('aiSelected').addEventListener('click', function () { aiDialog.open('selected'); });
    $('aiAll').addEventListener('click', function () {
      aiDialog.open(state.selected.length ? 'selected' : 'all');
    });
    $('clearSelection').addEventListener('click', function () {
      state.selected = [];
      render();
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
            status: state.status, sort: state.sort, order: state.order,
          },
        };
      },
      onFinished: function (message) { reload(message); },
    });
  }

  (async function init() {
    state.me = await window.Auth.ensureAuthed();
    if (!state.me) return;
    window.Auth.renderHeader(state.me);
    if (!state.me.isAdmin) {
      $('rescan').hidden = true;
      $('renameFolder').hidden = true;
      $('deleteFolder').hidden = true;
    }
    bindFilters();
    bindUpload();
    bindFolderActions();
    bindBulk();
    bindAi();
    // Delegated: the panel's inputs are rebuilt by renderDetail; the panel is not.
    $('detail').addEventListener('input', markDetailDirty);
    $('detail').addEventListener('change', markDetailDirty);
    await reload();
  })();
})();
