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
   * open({ onPick, onUnauthed, multiple, preselect })
   *
   * Resolves through onPick with the chosen media item — the full row, so the
   * caller gets src/width/height/alt without a second request. With
   * `multiple: true` it resolves with an ORDERED ARRAY instead, and `preselect`
   * (an array of photo URLs) seeds the selection so "Edit gallery" reopens with
   * the current photos already chosen.
   *
   * @ai-note `preselect` matches on `src`, not `key`, because that is what a
   * gallery fence line actually stores. Deriving a key from a URL would mean
   * assuming the image base URL has no path component — `src` is
   * `${baseUrl}/${key}`, so a base with a path breaks the derivation. Comparing
   * the URL the caller already has avoids the assumption entirely.
   *
   * @ai-note Selection is held as item OBJECTS, not keys, because it must
   * survive paging: a photo picked on page 1 is gone from `state.items` once
   * the author pages to 2, and the caller needs its dimensions and alt text.
   */
  function open(opts) {
    var o = opts || {};
    var multiple = !!o.multiple;
    var client = api.makeClient({ onUnauthed: o.onUnauthed || function () { location.href = '/login'; } });
    var state = { items: [], total: 0, q: '', page: 1, pageSize: 40, picked: [] };

    var preselectOrder = (o.preselect || []).slice();
    var pendingPreselect = preselectOrder.slice();

    function indexOfKey(key) {
      for (var i = 0; i < state.picked.length; i++) {
        if (state.picked[i].key === key) return i;
      }
      return -1;
    }

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
    if (multiple) {
      strip = el('div', 'picker-strip');
      strip.appendChild(el('h3', null, 'Selected — this is the order they appear in'));
      stripList = el('ol', 'picker-strip__list');
      stripList.setAttribute('aria-label', 'Selected photos, in gallery order');
      strip.appendChild(stripList);
      dialog.appendChild(strip);
    }

    function move(from, to) {
      if (to < 0 || to >= state.picked.length) return;
      var moved = state.picked.splice(from, 1)[0];
      state.picked.splice(to, 0, moved);
      render();
      // Keep focus on the button the author just used, at its new position.
      var sel = stripList.querySelectorAll('.picker-strip__item');
      var target = sel[to];
      if (target) {
        var btn = target.querySelector(from > to ? '[data-act="up"]' : '[data-act="down"]');
        if (btn) btn.focus();
      }
    }

    function renderStrip() {
      if (!multiple) return;
      stripList.innerHTML = '';
      if (!state.picked.length) {
        stripList.appendChild(el('li', 'muted', 'Nothing selected yet — click photos above.'));
        return;
      }
      state.picked.forEach(function (item, i) {
        var li = el('li', 'picker-strip__item');
        var label = item.title || item.key.split('/').pop();
        if (item.thumbSrc) {
          var img = document.createElement('img');
          img.src = item.thumbSrc;
          img.alt = '';
          img.loading = 'lazy';
          li.appendChild(img);
        }
        li.appendChild(el('span', 'picker-strip__pos', String(i + 1)));
        li.appendChild(el('span', 'picker-strip__name', label));

        var up = el('button', 'btn-secondary', '↑');
        up.type = 'button';
        up.dataset.act = 'up';
        up.disabled = i === 0;
        up.setAttribute('aria-label', 'Move ' + label + ' earlier');
        up.addEventListener('click', function () { move(i, i - 1); });

        var down = el('button', 'btn-secondary', '↓');
        down.type = 'button';
        down.dataset.act = 'down';
        down.disabled = i === state.picked.length - 1;
        down.setAttribute('aria-label', 'Move ' + label + ' later');
        down.addEventListener('click', function () { move(i, i + 1); });

        var drop = el('button', 'btn-remove', '×');
        drop.type = 'button';
        drop.setAttribute('aria-label', 'Remove ' + label + ' from the gallery');
        drop.addEventListener('click', function () {
          state.picked.splice(i, 1);
          render();
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
    var choose = el('button', null, multiple ? 'Insert gallery' : 'Use this photo');
    [prev, next, cancel, choose].forEach(function (b) { b.type = 'button'; foot.appendChild(b); });
    dialog.appendChild(foot);
    document.body.appendChild(dialog);

    function render() {
      grid.innerHTML = '';
      count.textContent = state.total + ' photo(s)';
      pager.textContent = 'Page ' + state.page;
      prev.disabled = state.page <= 1;
      next.disabled = state.page * state.pageSize >= state.total;
      choose.disabled = state.picked.length === 0;
      state.items.forEach(function (item, index) {
        var at = indexOfKey(item.key);
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
        cell.appendChild(el('span', 'media-cell__title', item.title || item.key.split('/').pop()));
        if (item.usedIn && item.usedIn.length) {
          // "Did I already use this shot?" is a picker-time question.
          cell.appendChild(el('span', 'media-cell__used', 'used in: '
            + item.usedIn.map(function (u) { return u.title; }).join(', ')));
        }
        var pick = function () {
          if (!multiple) { state.picked = [item]; render(); return; }
          var existing = indexOfKey(item.key);
          if (existing >= 0) state.picked.splice(existing, 1);
          else state.picked.push(item);
          render();
        };
        cell.addEventListener('click', pick);
        cell.addEventListener('dblclick', function () { pick(); commit(); });
        cell.addEventListener('keydown', function (ev) {
          if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); pick(); }
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
        // Seed from `preselect` once, on first load: the caller knows the keys
        // of the current gallery but not the rows, so adopt whichever of them
        // this page carries. Any not on this page are added as the author pages
        // to them — a preselected key the library no longer has simply drops,
        // which is the correct outcome for a deleted photo.
        if (pendingPreselect.length) {
          res.items.forEach(function (item) {
            var want = pendingPreselect.indexOf(item.src);
            if (want >= 0 && indexOfKey(item.key) < 0) {
              state.picked.push(item);
              pendingPreselect.splice(want, 1);
            }
          });
          state.picked.sort(function (a, b) {
            return preselectOrder.indexOf(a.src) - preselectOrder.indexOf(b.src);
          });
        }
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
      if (!state.picked.length) return;
      var picked = state.picked.slice();
      close();
      if (o.onPick) o.onPick(multiple ? picked : picked[0]);
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
