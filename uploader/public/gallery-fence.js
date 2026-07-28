// Gallery fence serialization for the editor's photo picker (#75).
//
// The picker's job is to write the SAME text an author would type by hand:
//
//     ```gallery
//     https://img…/a | 3000x2000 | alt="…" | caption="…"
//     ```
//
// It deliberately does not touch the post's `images` map. `normalizeGalleryFences`
// (src/body-content.ts) already lifts that metadata into `images` at the store
// chokepoint on save, and the WXR importer depends on the same path. Emitting
// the author-facing format means the picker is an authoring aid, not a second
// data path — and needs no server change at all.
//
// @ai-warning The escape rule below duplicates `escapeMeta`/`unescapeMeta` in
// src/body-content.ts. They cannot import one another (browser IIFE vs. an ESM
// module in a different tsconfig), so `test/gallery-fence.test.ts` asserts they
// agree character for character. Change one and you MUST change the other: a
// divergence corrupts alt text and captions containing `|`, a newline or a
// quote, silently, at save time.
//
// Same rules as media-picker.js: textContent only, one state object, no innerHTML.
window.GalleryFence = (function () {
  // Mirrors src/body-content.ts. Order is load-bearing in both directions:
  // `&` is escaped FIRST so that a literal `&quot;` in the source round-trips,
  // and `&amp;` is unescaped LAST for the same reason.
  function escapeMeta(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\|/g, '&#124;')
      .replace(/\r?\n/g, '&#10;');
  }

  function unescapeMeta(s) {
    return String(s)
      .replace(/&#10;/g, '\n')
      .replace(/&#124;/g, '|')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  // Mirrors DIMS_RE / ATTR_RE and MAX_TEXT in src/body-content.ts.
  var DIMS_RE = /^(\d{1,6})x(\d{1,6})$/;
  var ATTR_RE = /^(alt|caption)="([^"]*)"$/;
  var MAX_TEXT = 1000;

  var FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

  function usableDim(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n > 0 && n <= 999999;
  }

  function pickLocale(map, locale) {
    if (!map || typeof map !== 'object') return '';
    var v = map[locale];
    return typeof v === 'string' ? v : '';
  }

  /**
   * serialize(items, locale, directives?) → a complete ```gallery block.
   *
   * `directives` are `#`-prefixed lines carried through from an existing fence
   * (e.g. #66's `#layout: slider`). They are emitted first and never parsed —
   * this module has no opinion about what they mean, only that editing a
   * gallery must not silently discard them.
   */
  function serialize(items, locale, directives) {
    var lines = [];
    (directives || []).forEach(function (d) {
      var t = String(d).trim();
      if (t.charAt(0) === '#') lines.push(t);
    });

    (items || []).forEach(function (item) {
      if (!item || typeof item.src !== 'string' || item.src.trim() === '') return;
      // A 0-dimension row is what an unreadable probe leaves behind. The
      // renderer skips such a photo, so it must never reach the fence.
      if (!usableDim(item.width) || !usableDim(item.height)) return;

      var parts = [item.src.trim(), item.width + 'x' + item.height];
      var alt = pickLocale(item.alt, locale).slice(0, MAX_TEXT);
      var caption = pickLocale(item.caption, locale).slice(0, MAX_TEXT);
      if (alt !== '') parts.push('alt="' + escapeMeta(alt) + '"');
      if (caption !== '') parts.push('caption="' + escapeMeta(caption) + '"');
      lines.push(parts.join(' | '));
    });

    return '```gallery\n' + (lines.length ? lines.join('\n') + '\n' : '') + '```';
  }

  /**
   * parse(text) → { directives, lines }
   *
   * Accepts a full fence block or bare lines, and both the authored form
   * (`url | WxH | alt="…"`) and the stored form (a bare URL, after
   * normalizeGalleryFences has lifted the metadata away).
   */
  function parse(text) {
    var directives = [];
    var lines = [];

    String(text == null ? '' : text).split('\n').forEach(function (raw) {
      var line = raw.trim();
      if (line === '') return;
      if (FENCE_RE.test(line)) return; // the ```gallery delimiters themselves
      if (line.charAt(0) === '#') { directives.push(line); return; }

      var fields = line.split('|').map(function (f) { return f.trim(); });
      var src = fields[0] || '';
      if (src === '') return;

      var out = { src: src };
      fields.slice(1).forEach(function (field) {
        var dims = DIMS_RE.exec(field);
        if (dims) {
          out.width = Number(dims[1]);
          out.height = Number(dims[2]);
          return;
        }
        var attr = ATTR_RE.exec(field);
        if (attr) {
          var value = unescapeMeta(attr[2] || '').slice(0, MAX_TEXT);
          if (attr[1] === 'alt') out.alt = value;
          else out.caption = value;
        }
      });
      lines.push(out);
    });

    return { directives: directives, lines: lines };
  }

  /**
   * replaceFenceAt(body, cursor, fence) → { body, replaced }
   *
   * If the cursor sits inside a ```gallery fence, replace that whole fence
   * ("Edit gallery"). Otherwise insert at the cursor ("Insert gallery").
   *
   * Only a fence whose info string is exactly `gallery` is eligible: a ```js
   * block the author is editing must never be swallowed. Opening requires
   * column 0, matching what the editor and export.ts produce; the closing fence
   * may be longer than the opener, per CommonMark — the same rule the server's
   * line scanner follows.
   */
  function replaceFenceAt(body, cursor, fence) {
    var text = String(body == null ? '' : body);
    var lines = text.split('\n');
    var pos = 0;
    var open = null; // { start, end, marker }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var lineStart = pos;
      var lineEnd = pos + line.length;
      pos = lineEnd + 1; // + newline

      var m = FENCE_RE.exec(line);
      if (!m) continue;

      if (open === null) {
        if (line.indexOf('```gallery') !== 0) {
          // A non-gallery fence: skip to its close so its body can't be
          // mistaken for top-level content.
          var closer = m[1];
          for (var j = i + 1; j < lines.length; j++) {
            pos += lines[j].length + 1;
            var cm = FENCE_RE.exec(lines[j]);
            if (cm && cm[1].charAt(0) === closer.charAt(0) && cm[1].length >= closer.length
              && lines[j].trim() === cm[1]) { i = j; break; }
            i = j;
          }
          continue;
        }
        open = { start: lineStart, marker: m[1] };
      } else if (line.trim() === m[1] && m[1].charAt(0) === open.marker.charAt(0)
        && m[1].length >= open.marker.length) {
        if (cursor >= open.start && cursor <= lineEnd) {
          return {
            body: text.slice(0, open.start) + fence + text.slice(lineEnd),
            replaced: true,
          };
        }
        open = null;
      }
    }

    var at = Math.max(0, Math.min(text.length, Number(cursor) || 0));
    return { body: text.slice(0, at) + fence + text.slice(at), replaced: false };
  }

  return {
    escapeMeta: escapeMeta,
    unescapeMeta: unescapeMeta,
    serialize: serialize,
    parse: parse,
    replaceFenceAt: replaceFenceAt,
  };
})();
