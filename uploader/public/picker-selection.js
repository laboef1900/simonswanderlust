// The media picker's ordered multi-selection (#75).
//
// Extracted from media-picker.js so it is testable — test/picker-selection.test.ts
// runs this IIFE in a `vm` sandbox, the same precedent as posts-filter.js.
// Nothing here touches the DOM or the network; media-picker.js owns the wiring.
//
// @ai-warning The selection is seeded from the CALLER's photos, in full, before
// the library is ever queried — `preselect` is an array of item objects, not
// URLs. This is load-bearing. The library pages 40 rows at a time ordered by
// upload date, so an older post's gallery photos are usually on no page the
// author will visit; an earlier version adopted preselected photos only as it
// happened to meet them in a page, which meant confirming the dialog silently
// dropped every photo it had not seen. A gallery's own photos must not depend on
// where they sort in someone's media library.
//
// @ai-note Identity is `src`, not `key`. `src` is `${baseUrl}/${key}`, and `src`
// is what a gallery fence line stores — so a photo carried in from the post has
// one but no key. Deriving a key from a URL would additionally assume the image
// base URL has no path component.
window.PickerSelection = (function () {
  function usableDim(n) {
    return typeof n === 'number' && isFinite(n) && n > 0;
  }

  /**
   * create({ preselect }) → an ordered selection.
   *
   * `preselect` holds the caller's current photos in order. They may be
   * PLACEHOLDERS — `{src, width, height}` reconstructed from a gallery fence and
   * the post's `images` map, with no `key`, `title` or `thumbSrc`. `adopt()`
   * upgrades a placeholder in place when the matching library row turns up, so
   * the author gets a thumbnail and a name without the entry ever moving.
   */
  function create(opts) {
    var o = opts || {};
    var entries = []; // { item, upgraded }

    function indexOf(src) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].item.src === src) return i;
      }
      return -1;
    }

    (o.preselect || []).forEach(function (item) {
      if (!item || typeof item.src !== 'string' || item.src === '') return;
      if (indexOf(item.src) >= 0) return; // the same photo twice in one fence
      entries.push({ item: item, upgraded: false });
    });

    /**
     * Fold a freshly loaded page of library rows into the selection.
     *
     * Upgrade only — never inserts and never reorders, so paging and searching
     * cannot disturb an order the author arranged (or the fence's own order).
     */
    function adopt(rows) {
      var upgraded = 0;
      (rows || []).forEach(function (row) {
        if (!row || typeof row.src !== 'string') return;
        var at = indexOf(row.src);
        if (at < 0 || entries[at].upgraded) return;
        var placeholder = entries[at].item;
        // The library row is authoritative for identity and dimensions, but a
        // placeholder carries the dimensions the POST recorded — keep those if
        // the row's are unreadable, so a photo whose probe failed still renders.
        var merged = {};
        for (var k in row) if (Object.prototype.hasOwnProperty.call(row, k)) merged[k] = row[k];
        if (!usableDim(merged.width) && usableDim(placeholder.width)) merged.width = placeholder.width;
        if (!usableDim(merged.height) && usableDim(placeholder.height)) merged.height = placeholder.height;
        if (placeholder.fromPost) merged.fromPost = true;
        entries[at] = { item: merged, upgraded: true };
        upgraded++;
      });
      return upgraded;
    }

    /** Add if absent, drop if present. Adding always appends: the author clicked it last. */
    function toggle(item) {
      if (!item || typeof item.src !== 'string') return false;
      var at = indexOf(item.src);
      if (at >= 0) {
        entries.splice(at, 1);
        return false;
      }
      entries.push({ item: item, upgraded: true });
      return true;
    }

    /** Single-select: one photo replaces the selection outright. */
    function set(item) {
      entries = item ? [{ item: item, upgraded: true }] : [];
    }

    function move(from, to) {
      if (from < 0 || from >= entries.length) return false;
      if (to < 0 || to >= entries.length || to === from) return false;
      entries.splice(to, 0, entries.splice(from, 1)[0]);
      return true;
    }

    function remove(index) {
      if (index < 0 || index >= entries.length) return false;
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
      /** How many entries are still placeholders — the picker labels them. */
      unresolved: function () {
        var n = 0;
        entries.forEach(function (e) { if (!e.upgraded) n++; });
        return n;
      },
      isResolved: function (index) {
        return !!(entries[index] && entries[index].upgraded);
      },
    };
  }

  return { create: create };
})();
