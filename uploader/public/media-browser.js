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
    queue: null,
    busy: false,
  };

  var client = api.makeClient({ onUnauthed: function () { location.href = '/login'; } });
  var uploads = api.createUploadQueue(client, {
    onChange: function (snap) { state.queue = snap; renderQueue(); },
  });

  function say(msg) { $('out').textContent = msg; }

  function fail(err) {
    say('Error: ' + (err && err.message ? err.message : String(err)));
  }

  // ---- data ---------------------------------------------------------------

  async function reload(msg) {
    state.busy = true;
    try {
      var res = await client.list({
        folder: state.folder, recursive: state.recursive, q: state.q, tag: state.tag,
        status: state.status, sort: state.sort, order: state.order,
        page: state.page, pageSize: state.pageSize,
      });
      state.items = res.items;
      state.total = res.total;
      state.folders = await client.folders();
      // Drop selections for photos no longer in view.
      var visible = state.items.map(function (i) { return i.key; });
      state.selected = state.selected.filter(function (k) { return visible.indexOf(k) !== -1; });
      render();
      say(msg != null ? msg : state.total + ' photo(s)');
    } catch (e) {
      fail(e);
    } finally {
      state.busy = false;
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
        cell.appendChild(el('span', 'media-cell__used', 'used in: '
          + item.usedIn.map(function (u) { return u.title; }).join(', ')));
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
      row.appendChild(el('span', 'upload-row__state',
        i.state === 'uploading' ? Math.round(i.progress * 100) + '%'
          : i.state === 'failed' ? (i.error || 'failed') : i.state));
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

  function renderDetail() {
    var panel = $('detail');
    panel.innerHTML = '';
    var item = state.items.filter(function (i) { return i.key === state.detailKey; })[0];
    if (!item) {
      panel.appendChild(el('p', 'muted', 'Select a photo to edit its details.'));
      return;
    }
    panel.appendChild(el('p', 'section-label', 'Photo'));
    panel.appendChild(el('p', 'media-key', item.key));

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
    });

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
    save.type = 'button';
    save.addEventListener('click', function () { saveDetail(item.key); });
    panel.appendChild(save);

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

  function onCellActivate(key, ev) {
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
    state.detailKey = keys[next];
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

  // ---- actions ------------------------------------------------------------

  async function saveDetail(key) {
    try {
      await client.patch(key, {
        title: $('dTitle').value,
        alt: { de: $('dAltDe').value, en: $('dAltEn').value },
        caption: { de: $('dCapDe').value, en: $('dCapEn').value },
        tags: $('dTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
        folder: $('dFolder').value,
      });
      await reload('Saved.');
    } catch (e) { fail(e); }
  }

  async function deleteOne(item) {
    if (!confirm('Delete "' + (item.title || item.key) + '"?\n\nThe image files and its metadata are removed. This cannot be undone.')) return;
    try {
      await client.remove(item.key);
      state.detailKey = null;
      await reload('Deleted.');
    } catch (e) { fail(e); }
  }

  // ---- wiring -------------------------------------------------------------

  function bindFilters() {
    $('fSearch').addEventListener('input', function () {
      state.q = $('fSearch').value;
      state.page = 1;
      reload();
    });
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
      if (!confirm('Delete the empty folder "' + state.folder + '"?')) return;
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
    $('clearSelection').addEventListener('click', function () {
      state.selected = [];
      render();
    });
    $('rescan').addEventListener('click', async function () {
      say('Reconciling…');
      try {
        var r = await client.rescan();
        await reload('Rescan: scanned ' + r.scanned + ', added ' + r.inserted
          + ', alt harvested ' + r.altHarvested + ', marked missing ' + r.markedMissing + '.');
      } catch (e) { fail(e); }
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
    await reload();
  })();
})();
