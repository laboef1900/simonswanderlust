// "Choose from library" — a modal photo picker for the editor's hero fields
// (single-select) and its gallery blocks (multi-select, #75).
//
// Built on a native <dialog>: focus trap, Esc, `inert` background, ::backdrop
// and focus restoration all come for free, which is the same reasoning behind
// the blog's lightbox.
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
   * A human name for a row. Falls back through the URL because a photo carried
   * in from a post's gallery is a placeholder with no `key` and no `title` until
   * its library row is adopted.
   */
  function labelOf(item) {
    if (item.title) return item.title;
    var path = item.key || item.src || '';
    return String(path).split('/').pop() || String(path);
  }

  /**
   * open({ onPick, onUnauthed, multiple, preselect })
   *
   * Resolves through onPick with the chosen media item — the full row, so the
   * caller gets src/width/height/alt without a second request. With
   * `multiple: true` it resolves with an ORDERED ARRAY instead.
   *
   * `preselect` is an array of ITEM OBJECTS the caller already has, not URLs —
   * `{src, width, height}` reconstructed from the caller's own data is enough.
   * The whole selection therefore exists before the first library request, which
   * is what stops a photo the library never pages into view from being dropped
   * on confirm. See the @ai-warning in picker-selection.js.
   *
   * With `multiple: true`, `onPick` may also receive an EMPTY array — the author
   * cleared the selection, which for a gallery means "remove this block".
   */
  function open(opts) {
    var o = opts || {};
    var multiple = !!o.multiple;
    var client = api.makeClient({ onUnauthed: o.onUnauthed || function () { location.href = '/login'; } });
    var state = { items: [], total: 0, q: '', page: 1, pageSize: 40 };
    var picked = window.PickerSelection.create({ preselect: o.preselect });

    var dialog = document.createElement('dialog');
    dialog.className = 'admin-modal';

    var head = el('div', 'admin-modal__head');
    head.appendChild(el('h2', null, multiple ? 'Choose photos' : 'Choose a photo'));
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
    if (multiple) grid.setAttribute('aria-multiselectable', 'true');
    dialog.appendChild(grid);

    // The ordering strip. Gallery order is the fence's line order, so the
    // author needs to see and change it — and reordering must be operable
    // without a pointer (WCAG 2.2 AA), which is why these are buttons and not
    // drag handles.
    var strip = null;
    var stripList = null;
    var stripCount = null;
    if (multiple) {
      strip = el('div', 'picker-strip');
      var stripHead = el('div', 'picker-strip__head');
      stripHead.appendChild(el('h3', null, 'Selected — this is the order they appear in'));
      // The list scrolls, so the count has to be stated: an author who cannot
      // see the whole strip still needs to know how many photos they are about
      // to write, and how many of those the current view is not showing.
      //
      // It doubles as the strip's live region (the same visible-count pattern as
      // media.html and posts.html). Reordering otherwise has NO announced
      // outcome — pressing ↑ moves a row the author cannot see and re-labels
      // nothing, so a screen-reader user hears "Move X earlier, button" and is
      // told nothing about what happened (WCAG 2.2 AA, SC 4.1.3).
      stripCount = el('span', 'muted');
      stripCount.setAttribute('aria-live', 'polite');
      stripCount.setAttribute('aria-atomic', 'true');
      stripHead.appendChild(stripCount);
      strip.appendChild(stripHead);
      stripList = el('ol', 'picker-strip__list');
      stripList.setAttribute('aria-label', 'Selected photos, in gallery order');
      strip.appendChild(stripList);
      dialog.appendChild(strip);
    }

    /**
     * Focus a button in the strip row at `index`, preferring `act`.
     *
     * @ai-note The fallbacks are the point, not defensive padding. Moving a photo
     * to the first or last position — the two most common reorders — leaves the
     * button the author just pressed disabled at its new position, and `.focus()`
     * on a disabled button is a no-op that drops focus to <body>, i.e. out of the
     * author's place in the dialog.
     */
    function focusInRow(index, act) {
      var rows = stripList.querySelectorAll('.picker-strip__item');
      var row = rows[index] || rows[rows.length - 1];
      if (!row) { choose.focus(); return; }
      var order = [act, act === 'up' ? 'down' : 'up', 'remove'];
      for (var i = 0; i < order.length; i++) {
        var btn = row.querySelector('[data-act="' + order[i] + '"]');
        if (btn && !btn.disabled) { btn.focus(); return; }
      }
      choose.focus();
    }

    /** One-shot message for the strip's live region, consumed by renderStrip. */
    var announce = '';

    function move(from, to) {
      var label = labelOf(picked.items()[from] || {});
      if (!picked.move(from, to)) return;
      announce = 'Moved ' + label + ' to position ' + (to + 1) + ' of ' + picked.size() + '.';
      render();
      focusInRow(to, from > to ? 'up' : 'down');
    }

    function renderStrip() {
      if (!multiple) return;
      stripList.innerHTML = '';
      var total = picked.size();
      var offscreen = picked.unresolved();
      var summary = total === 0
        ? ''
        : total + ' photo(s)'
          + (offscreen ? ' — ' + offscreen + ' not in this view, still in the gallery' : '');
      // The action, then the standing count — so the announcement says what
      // changed and the text left on screen still says where things stand.
      stripCount.textContent = [announce, summary].filter(Boolean).join(' ');
      announce = '';
      if (!total) {
        stripList.appendChild(el('li', 'muted', o.emptyHint || 'Nothing selected yet — click photos above.'));
        return;
      }
      picked.items().forEach(function (item, i) {
        var li = el('li', 'picker-strip__item');
        var label = labelOf(item);
        if (item.thumbSrc) {
          var img = document.createElement('img');
          img.src = item.thumbSrc;
          img.alt = '';
          img.loading = 'lazy';
          li.appendChild(img);
        } else {
          li.appendChild(el('span', 'thumb-placeholder'));
        }
        li.appendChild(el('span', 'picker-strip__pos', String(i + 1)));
        li.appendChild(el('span', 'picker-strip__name', label));
        // A photo carried in from the post whose library row has not been seen
        // yet. It is fully selected and will be written back — it just has no
        // thumbnail. Say so rather than letting it look like a broken entry.
        if (!picked.isResolved(i)) {
          li.appendChild(el('span', 'picker-strip__pending', 'in gallery'));
        }

        var up = el('button', 'btn-secondary', '↑');
        up.type = 'button';
        up.dataset.act = 'up';
        up.disabled = i === 0;
        up.setAttribute('aria-label', 'Move ' + label + ' earlier');
        up.addEventListener('click', function () { move(i, i - 1); });

        var down = el('button', 'btn-secondary', '↓');
        down.type = 'button';
        down.dataset.act = 'down';
        down.disabled = i === picked.size() - 1;
        down.setAttribute('aria-label', 'Move ' + label + ' later');
        down.addEventListener('click', function () { move(i, i + 1); });

        var drop = el('button', 'btn-remove', '×');
        drop.type = 'button';
        drop.dataset.act = 'remove';
        drop.setAttribute('aria-label', 'Remove ' + label + ' from the gallery');
        drop.addEventListener('click', function () {
          picked.remove(i);
          announce = 'Removed ' + label + '.';
          render();
          // The row is gone; land on whatever took its place rather than <body>.
          if (picked.size()) focusInRow(i, 'remove');
          else choose.focus();
        });

        [up, down, drop].forEach(function (b) { li.appendChild(b); });
        stripList.appendChild(li);
      });
    }

    var foot = el('div', 'admin-modal__foot');
    var pager = el('span', 'muted');
    foot.appendChild(pager);
    var prev = el('button', 'btn-secondary', 'Previous');
    var next = el('button', 'btn-secondary', 'Next');
    var cancel = el('button', 'btn-remove', 'Cancel');
    var choose = el('button', null, o.confirmLabel || (multiple ? 'Insert gallery' : 'Use this photo'));
    [prev, next, cancel, choose].forEach(function (b) { b.type = 'button'; foot.appendChild(b); });
    dialog.appendChild(foot);
    document.body.appendChild(dialog);

    /** Move the roving tabindex to `index` and focus it. */
    function focusCell(index) {
      var cells = grid.querySelectorAll('.media-cell');
      if (!cells[index]) return;
      for (var i = 0; i < cells.length; i++) cells[i].tabIndex = i === index ? 0 : -1;
      cells[index].focus();
    }

    function render() {
      grid.innerHTML = '';
      count.textContent = state.total + ' photo(s)';
      pager.textContent = 'Page ' + state.page;
      prev.disabled = state.page <= 1;
      next.disabled = state.page * state.pageSize >= state.total;
      // Multi-select may commit an empty selection: that removes the gallery.
      choose.disabled = !multiple && picked.size() === 0;
      state.items.forEach(function (item, index) {
        var at = picked.indexOf(item.src);
        var cell = el('div', 'media-cell' + (at >= 0 ? ' is-selected' : ''));
        cell.setAttribute('role', 'option');
        cell.setAttribute('aria-selected', at >= 0 ? 'true' : 'false');
        if (multiple && at >= 0) {
          // Show the position, so the grid and the strip agree at a glance.
          cell.appendChild(el('span', 'media-cell__order', String(at + 1)));
        }
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
        cell.appendChild(el('span', 'media-cell__title', labelOf(item)));
        if (item.usedIn && item.usedIn.length) {
          // "Did I already use this shot?" is a picker-time question.
          cell.appendChild(el('span', 'media-cell__used', 'used in: '
            + item.usedIn.map(function (u) { return u.title; }).join(', ')));
        }
        var pick = function () {
          if (multiple) picked.toggle(item);
          else picked.set(item);
          render();
        };
        cell.addEventListener('click', pick);
        // Double-click-to-confirm only makes sense when one photo IS the answer.
        // In multi-select the author is still building a list, and a stray
        // double-click would close the dialog on whatever happened to be chosen
        // — which, for a gallery, is a write to the post.
        if (!multiple) cell.addEventListener('dblclick', function () { pick(); commit(); });
        // Roving tabindex needs arrow keys to rove: without them only the first
        // cell is reachable by Tab, which makes selecting several photos for a
        // gallery impossible without a pointer (WCAG 2.2 AA). Same shape as
        // media-browser.js's onGridKey, including its column arithmetic.
        cell.addEventListener('keydown', function (ev) {
          if (ev.key === ' ' || ev.key === 'Enter') {
            ev.preventDefault();
            pick();
            focusCell(index); // render() rebuilt the grid — the old node is gone
            return;
          }
          var cols = 1;
          if (grid.firstElementChild) {
            cols = Math.max(1, Math.round(grid.clientWidth / grid.firstElementChild.offsetWidth)) || 1;
          }
          var to = null;
          if (ev.key === 'ArrowRight') to = index + 1;
          else if (ev.key === 'ArrowLeft') to = index - 1;
          else if (ev.key === 'ArrowDown') to = index + cols;
          else if (ev.key === 'ArrowUp') to = index - cols;
          else if (ev.key === 'Home') to = 0;
          else if (ev.key === 'End') to = state.items.length - 1;
          if (to === null) return;
          ev.preventDefault();
          focusCell(Math.max(0, Math.min(state.items.length - 1, to)));
        });
        grid.appendChild(cell);
      });
      renderStrip();
    }

    async function load() {
      try {
        // Only `ready` photos are offered: one still encoding has no variants,
        // and picking it would put a URL that 404s into a post.
        var res = await client.list({ q: state.q, status: 'ready', page: state.page, pageSize: state.pageSize });
        state.items = res.items;
        state.total = res.total;
        // The caller knows the URLs of the current gallery but not the rows, so
        // adopt whichever of them this page carries; the rest are picked up as
        // the author pages to them. See picker-selection.js for what adoption
        // may and may not reorder.
        picked.adopt(res.items);
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
      var items = picked.items();
      // Single-select has nothing to say with an empty selection; multi-select
      // does — "no photos" is how an author removes a gallery.
      if (!multiple && !items.length) return;
      close();
      if (o.onPick) o.onPick(multiple ? items : items[0]);
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
