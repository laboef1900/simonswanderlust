// "Choose from library" — a modal photo picker for the editor's hero fields.
//
// Built on a native <dialog>: focus trap, Esc, `inert` background, ::backdrop
// and focus restoration all come for free, which is the same reasoning behind
// the blog's lightbox. Single-select only in this phase; the multi-select
// gallery picker is a separate piece of work (#75) that needs ordering UI.
//
// Same rules as media-browser.js: textContent only, `innerHTML` solely for
// `= ''`, one state object and one render().
window.MediaPicker = (function () {
  var api = window.MediaApi;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /**
   * open({ onPick, onUnauthed }) resolves through onPick with the chosen media
   * item (the full row, so the caller gets src/width/height/alt without a
   * second request).
   */
  function open(opts) {
    var o = opts || {};
    var client = api.makeClient({ onUnauthed: o.onUnauthed || function () { location.href = '/login'; } });
    var state = { items: [], total: 0, q: '', page: 1, pageSize: 40, selected: null };

    var dialog = document.createElement('dialog');
    dialog.className = 'admin-modal';

    var head = el('div', 'admin-modal__head');
    head.appendChild(el('h2', null, 'Choose a photo'));
    var count = el('span', 'muted');
    head.appendChild(count);
    dialog.appendChild(head);

    var search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search key, title, alt or caption';
    search.setAttribute('aria-label', 'Search the media library');
    dialog.appendChild(search);

    var grid = el('div', 'media-grid');
    grid.setAttribute('role', 'listbox');
    grid.setAttribute('aria-label', 'Library photos');
    dialog.appendChild(grid);

    var foot = el('div', 'admin-modal__foot');
    var pager = el('span', 'muted');
    foot.appendChild(pager);
    var prev = el('button', 'btn-secondary', 'Previous');
    var next = el('button', 'btn-secondary', 'Next');
    var cancel = el('button', 'btn-remove', 'Cancel');
    var choose = el('button', null, 'Use this photo');
    [prev, next, cancel, choose].forEach(function (b) { b.type = 'button'; foot.appendChild(b); });
    dialog.appendChild(foot);
    document.body.appendChild(dialog);

    function render() {
      grid.innerHTML = '';
      count.textContent = state.total + ' photo(s)';
      pager.textContent = 'Page ' + state.page;
      prev.disabled = state.page <= 1;
      next.disabled = state.page * state.pageSize >= state.total;
      choose.disabled = !state.selected;
      state.items.forEach(function (item, index) {
        var cell = el('div', 'media-cell' + (state.selected === item.key ? ' is-selected' : ''));
        cell.setAttribute('role', 'option');
        cell.setAttribute('aria-selected', state.selected === item.key ? 'true' : 'false');
        cell.tabIndex = index === 0 ? 0 : -1;
        var thumb = el('div', 'media-cell__thumb');
        if (item.thumbSrc) {
          var img = document.createElement('img');
          img.src = item.thumbSrc;
          img.alt = '';
          img.loading = 'lazy';
          thumb.appendChild(img);
        } else {
          thumb.appendChild(el('span', 'thumb-placeholder'));
        }
        cell.appendChild(thumb);
        var badge = api.statusLabel(item);
        if (badge) cell.appendChild(el('span', 'media-cell__badge', badge));
        cell.appendChild(el('span', 'media-cell__title', item.title || item.key.split('/').pop()));
        if (item.usedIn && item.usedIn.length) {
          // "Did I already use this shot?" is a picker-time question.
          cell.appendChild(el('span', 'media-cell__used', 'used in: '
            + item.usedIn.map(function (u) { return u.title; }).join(', ')));
        }
        var pick = function () { state.selected = item.key; render(); };
        cell.addEventListener('click', pick);
        cell.addEventListener('dblclick', function () { pick(); commit(); });
        cell.addEventListener('keydown', function (ev) {
          if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); pick(); }
        });
        grid.appendChild(cell);
      });
    }

    async function load() {
      try {
        // Only `ready` photos are offered: one still encoding has no variants,
        // and picking it would put a URL that 404s into a post.
        var res = await client.list({ q: state.q, status: 'ready', page: state.page, pageSize: state.pageSize });
        state.items = res.items;
        state.total = res.total;
        render();
      } catch (e) {
        grid.innerHTML = '';
        grid.appendChild(el('p', 'muted', 'Could not load the library: ' + (e && e.message ? e.message : e)));
      }
    }

    function close() {
      dialog.close();
      dialog.remove();
    }

    function commit() {
      var item = state.items.filter(function (i) { return i.key === state.selected; })[0];
      if (!item) return;
      close();
      if (o.onPick) o.onPick(item);
    }

    var debounce = null;
    search.addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () { state.q = search.value; state.page = 1; load(); }, 200);
    });
    prev.addEventListener('click', function () { state.page = Math.max(1, state.page - 1); load(); });
    next.addEventListener('click', function () { state.page += 1; load(); });
    cancel.addEventListener('click', close);
    choose.addEventListener('click', commit);
    // Esc fires `cancel` on a native dialog — clean up the node too.
    dialog.addEventListener('cancel', function () { dialog.remove(); });

    dialog.showModal();
    load();
  }

  return { open: open };
})();
