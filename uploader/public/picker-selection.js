// The media picker's ordered multi-selection (#75).
//
// Extracted from media-picker.js so it is testable — test/picker-selection.test.ts
// runs this IIFE in a `vm` sandbox, the same precedent as posts-filter.js.
// Nothing here touches the DOM or the network; media-picker.js owns the wiring.
//
// @ai-note Selection holds media ROWS, not keys, because it must survive paging:
// a photo picked on page 1 is gone from the grid once the author pages to 2, and
// the caller still needs its dimensions, alt and caption.
//
// @ai-note `preselect` matches on `src`, not `key`. `src` is `${baseUrl}/${key}`,
// so deriving a key from a gallery URL would assume the image base URL has no
// path component. Comparing the URL the fence already stores avoids that.
window.PickerSelection = (function () {
  /** Sorts after every preselected photo — see `insert`. */
  var UNRANKED = Infinity;

  /**
   * create({ preselect }) → an ordered selection.
   *
   * `preselect` is the list of photo URLs the caller's gallery already contains,
   * in fence order. They are adopted page by page as `adopt()` sees them, because
   * the library returns 40 rows at a time and a gallery's photos need not all be
   * on the first one.
   */
  function create(opts) {
    var o = opts || {};

    var order = [];
    (o.preselect || []).forEach(function (src) {
      if (typeof src === 'string' && src !== '' && order.indexOf(src) < 0) order.push(src);
    });
    /** Preselected URLs not yet seen on a loaded page. */
    var pending = order.slice();
    /** [{ item, rank }] — `rank` is the photo's index in `order`, or UNRANKED. */
    var entries = [];
    /**
     * Set once the author moves or removes something.
     *
     * @ai-warning After that, `adopt` appends rather than inserting by fence
     * order. Re-deriving positions inside a list the author has arranged by hand
     * would silently undo their arrangement — which is exactly what the first
     * version of this code did, by re-sorting the whole selection on every page
     * load for as long as any preselected URL stayed unmatched (a photo deleted
     * from the library never matches, so "for as long as" meant "forever").
     */
    var arranged = false;

    function rankOf(src) {
      var at = order.indexOf(typeof src === 'string' ? src : '');
      return at < 0 ? UNRANKED : at;
    }

    function indexOf(key) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].item.key === key) return i;
      }
      return -1;
    }

    function insert(entry) {
      if (!arranged) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].rank > entry.rank) {
            entries.splice(i, 0, entry);
            return;
          }
        }
      }
      entries.push(entry);
    }

    /**
     * Adopt whichever preselected photos this page of rows carries.
     *
     * A preselected URL the library no longer has is simply never adopted, which
     * is the correct outcome for a deleted photo — but it also means `pending`
     * may never empty, so nothing here may depend on it doing so.
     */
    function adopt(rows) {
      var added = 0;
      if (!pending.length) return added;
      (rows || []).forEach(function (item) {
        if (!item || typeof item.src !== 'string') return;
        var want = pending.indexOf(item.src);
        if (want < 0 || indexOf(item.key) >= 0) return;
        pending.splice(want, 1);
        insert({ item: item, rank: rankOf(item.src) });
        added++;
      });
      return added;
    }

    /** Add if absent, drop if present. Adding always appends: the author clicked it last. */
    function toggle(item) {
      if (!item) return false;
      var at = indexOf(item.key);
      if (at >= 0) {
        remove(at);
        return false;
      }
      entries.push({ item: item, rank: rankOf(item.src) });
      return true;
    }

    /** Single-select: one photo replaces the selection outright. */
    function set(item) {
      entries = item ? [{ item: item, rank: 0 }] : [];
    }

    function move(from, to) {
      if (from < 0 || from >= entries.length) return false;
      if (to < 0 || to >= entries.length || to === from) return false;
      arranged = true;
      entries.splice(to, 0, entries.splice(from, 1)[0]);
      return true;
    }

    function remove(index) {
      if (index < 0 || index >= entries.length) return false;
      arranged = true;
      entries.splice(index, 1);
      return true;
    }

    return {
      adopt: adopt,
      toggle: toggle,
      set: set,
      move: move,
      remove: remove,
      indexOf: indexOf,
      size: function () { return entries.length; },
      items: function () { return entries.map(function (e) { return e.item; }); },
      /** Test/diagnostic only — how many preselected URLs are still unmatched. */
      pending: function () { return pending.length; },
    };
  }

  return { create: create };
})();
