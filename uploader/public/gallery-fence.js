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

  // ── the #layout: directive (#66) ───────────────────────────────────────
  //
  // @ai-warning LAYOUT_RE and LAYOUTS duplicate LAYOUT_DIRECTIVE_RE and
  // GALLERY_MODES in site/src/lib/gallery-layout.ts, for the same reason
  // escapeMeta does: a browser IIFE cannot import an ESM module from the other
  // tree. The two MUST agree about what counts as a directive and what values
  // are known, or the picker shows "Break-out" for a gallery the site renders
  // as a slider — a silent lie about the author's own choice, only visible
  // after publishing. test/gallery-fence.test.ts runs both over one corpus.
  var LAYOUTS = ['breakout', 'column', 'slider'];
  var DEFAULT_LAYOUT = 'breakout';
  var LAYOUT_RE = /^\s*#\s*layout\s*:\s*(\S*)\s*$/i;

  /** The mode a fence's directives select. First wins; unknown ⇒ the default. */
  function layoutOf(directives) {
    var lines = directives || [];
    for (var i = 0; i < lines.length; i++) {
      var m = LAYOUT_RE.exec(String(lines[i]));
      if (!m) continue;
      var value = String(m[1] || '').toLowerCase();
      return LAYOUTS.indexOf(value) >= 0 ? value : DEFAULT_LAYOUT;
    }
    return DEFAULT_LAYOUT;
  }

  /**
   * `directives` with the layout set to `mode`, preserving every other line.
   *
   * The default mode writes NO directive: a gallery the author never changed
   * the layout of comes back out byte-identical, so switching modes and back
   * leaves no trace in the body. An unknown mode is treated as the default
   * rather than written through, so the picker can never author a directive
   * the renderer would reject.
   */
  function withLayout(directives, mode) {
    var kept = (directives || []).filter(function (d) { return !LAYOUT_RE.test(String(d)); });
    var value = LAYOUTS.indexOf(String(mode).toLowerCase()) >= 0 ? String(mode).toLowerCase() : DEFAULT_LAYOUT;
    if (value === DEFAULT_LAYOUT) return kept;
    return ['#layout: ' + value].concat(kept);
  }

  // Mirrors DIMS_RE / ATTR_RE and MAX_TEXT in src/body-content.ts.
  var DIMS_RE = /^(\d{1,6})x(\d{1,6})$/;
  var ATTR_RE = /^(alt|caption)="([^"]*)"$/;
  var MAX_TEXT = 1000;

  // Mirrors FENCE_OPEN_RE in src/body-content.ts: up to 3 spaces of indent
  // (CommonMark), a run of 3+ backticks or tildes, then the info string.
  var FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

  function usableDim(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n > 0 && n <= 999999;
  }

  function pickLocale(map, locale) {
    if (!map || typeof map !== 'object') return '';
    var v = map[locale];
    return typeof v === 'string' ? v : '';
  }

  function metaFor(map, src) {
    if (!map || typeof map !== 'object') return {};
    var v = map[src];
    return v && typeof v === 'object' ? v : {};
  }

  /**
   * serialize(items, locale, directives?, postMeta?) → a complete ```gallery block.
   *
   * `directives` are `#`-prefixed lines carried through from an existing fence
   * (e.g. #66's `#layout: slider`). They are emitted first and never parsed —
   * this module has no opinion about what they mean, only that editing a
   * gallery must not silently discard them.
   *
   * `postMeta` maps a photo URL to the alt/caption already recorded FOR THIS
   * POST (its `images` entry, plus anything hand-typed on the fence line). It
   * wins over the media library's own alt/caption.
   *
   * @ai-warning `postMeta` is load-bearing, not a nicety. `normalizeGalleryFences`
   * lets a value present on the line beat the stored `images` entry
   * (src/body-content.ts), and the stored fence is bare URLs — so without this,
   * re-serializing from library rows silently overwrites every photo's
   * post-specific alt and caption with the library defaults, at save time, where
   * the author cannot see it happen.
   */
  function serialize(items, locale, directives, postMeta) {
    var lines = [];
    (directives || []).forEach(function (d) {
      var t = String(d).trim();
      if (t.charAt(0) === '#') lines.push(t);
    });

    (items || []).forEach(function (item) {
      if (!item || typeof item.src !== 'string' || item.src.trim() === '') return;
      var src = item.src.trim();

      // A 0-dimension row is what an unreadable probe leaves behind, and the
      // renderer skips such a photo — so a NEWLY PICKED one must never reach the
      // fence. A photo already in the post is different: dropping it would
      // delete an author's photo to avoid writing a line that was already there.
      // Emit the bare URL, which is exactly the stored form, and leave whatever
      // the `images` map holds for it untouched (normalizeGalleryFences returns
      // a single-field line unchanged).
      if (!usableDim(item.width) || !usableDim(item.height)) {
        if (item.fromPost) lines.push(src);
        return;
      }

      var prior = metaFor(postMeta, src);
      var parts = [src, item.width + 'x' + item.height];
      // An empty string in `postMeta` is a deliberate clear and is respected;
      // only an absent key falls back to the library row.
      var alt = (typeof prior.alt === 'string' ? prior.alt : pickLocale(item.alt, locale)).slice(0, MAX_TEXT);
      var caption = (typeof prior.caption === 'string'
        ? prior.caption
        : pickLocale(item.caption, locale)).slice(0, MAX_TEXT);
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
   * fenceAt(body, cursor) → { text, start, end } | null
   *
   * Locate the ```gallery fence the cursor sits inside, so "Edit gallery" can
   * reopen the picker with the current photos preselected and the current
   * directives preserved.
   *
   * @ai-warning What counts as a gallery, and where a fence ends, MUST match
   * `rewriteFences` in src/body-content.ts exactly, or the two disagree about
   * which block is which: a fence the picker thinks it owns but the server does
   * not gets replaced without ever being normalized, and one the server treats
   * as a gallery but the picker cannot see gets a second fence nested inside it.
   * `test/gallery-fence.test.ts` runs both scanners over one corpus and compares
   * — add cases there rather than trusting this comment. Three rules earn their
   * keep, all of them found by that comparison disagreeing:
   *
   *  1. The gallery test is the server's three conditions — column 0, backticks,
   *     info string exactly `gallery` — not `startsWith('```gallery')`, which
   *     claimed ```gallery-notes and missed a 4-backtick ````gallery.
   *  2. A closer's tail is `[ \t]*`, NOT `.trim() === ''`. `String.trim` also
   *     strips NBSP, U+2028 and friends, so a fence line ending in a pasted NBSP
   *     closed the block here and not on the server.
   *  3. An unterminated fence runs to EOF, as CommonMark and the server both
   *     have it. Returning null instead made the picker nest a second gallery
   *     inside the first.
   *
   * Recognising an ENCLOSING fence stays deliberately liberal (indent and tildes
   * included), also matching the server: being generous about what protects
   * content is the safe direction to be wrong in.
   */
  /** Mirrors the server's closing-fence regex tail — space and tab only. */
  var CLOSER_TAIL_RE = /^[ \t]*$/;

  /** Every top-level fenced block in `text`, in order. */
  function scanFences(text) {
    var lines = text.split('\n');
    var blocks = [];
    var pos = 0;
    var open = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var lineStart = pos;
      var lineEnd = pos + line.length;
      pos = lineEnd + 1; // + newline

      var m = FENCE_RE.exec(line);
      if (!m) continue;
      var indent = m[1] || '';
      var run = m[2] || '';
      var info = m[3] || '';
      var marker = run.charAt(0);

      if (open === null) {
        // CommonMark: a backtick fence's info string may not contain a backtick.
        if (marker === '`' && info.indexOf('`') >= 0) continue;
        open = {
          start: lineStart,
          marker: marker,
          len: run.length,
          isGallery: indent === '' && marker === '`' && info.trim() === 'gallery',
        };
        continue;
      }

      // A closer is the same character, at least as long, and nothing else.
      if (marker !== open.marker || run.length < open.len || !CLOSER_TAIL_RE.test(info)) continue;
      blocks.push({ start: open.start, end: lineEnd, isGallery: open.isGallery, unterminated: false });
      open = null;
    }

    if (open !== null) {
      blocks.push({ start: open.start, end: text.length, isGallery: open.isGallery, unterminated: true });
    }
    return blocks;
  }

  /** The fenced block the cursor sits in, gallery or not — null outside every fence. */
  function blockAt(text, cursor) {
    var blocks = scanFences(text);
    for (var i = 0; i < blocks.length; i++) {
      if (cursor >= blocks[i].start && cursor <= blocks[i].end) return blocks[i];
    }
    return null;
  }

  function fenceAt(body, cursor) {
    var text = String(body == null ? '' : body);
    var block = blockAt(text, cursor);
    if (!block || !block.isGallery) return null;
    return {
      text: text.slice(block.start, block.end),
      start: block.start,
      end: block.end,
      unterminated: block.unterminated,
    };
  }

  /** Newlines immediately before `at`, capped at the 2 a blank line needs. */
  function runBefore(text, at) {
    var n = 0;
    while (n < 2 && at - n - 1 >= 0 && text.charAt(at - n - 1) === '\n') n++;
    return n;
  }

  /**
   * replaceFenceAt(body, cursor, fence) → { text, start, end, replaced, blocked? }
   *
   * A RANGE EDIT, not a new document: `text` replaces `[start, end)`. The caller
   * applies it with `cm.replaceRange`, which keeps CodeMirror's undo history —
   * `mde.value()` would discard it, so a mis-inserted gallery could not be undone.
   *
   * Replaces the gallery fence under the cursor ("Edit gallery"), or inserts at
   * the cursor when there is none ("Insert gallery"). An empty `fence` removes
   * the block under the cursor, and is a no-op when there is none.
   *
   * When `blocked` is set the caller must make NO edit and show the reason:
   *   'unterminated' — the gallery under the cursor has no closing fence, so its
   *                    extent runs to EOF and replacing it would eat the rest of
   *                    the post. Ask the author to close it instead of guessing.
   *
   * @ai-note Insertion pads with blank lines as needed, and relocates out of an
   * enclosing fence. A fence must open at column 0 to be a fence at all, so
   * splicing raw at a mid-paragraph cursor produces literal text the renderer and
   * `normalizeGalleryFences` both ignore — a gallery that silently is not one.
   * Worse, splicing inside a ```js block makes the new gallery's CLOSER close the
   * js fence, turning the code into prose and leaving the js closer to open an
   * unterminated block over the rest of the body.
   */
  function replaceFenceAt(body, cursor, fence) {
    var text = String(body == null ? '' : body);
    var block = String(fence == null ? '' : fence);
    var found = fenceAt(text, cursor);

    if (found && found.unterminated) {
      return { text: '', start: found.start, end: found.start, replaced: false, blocked: 'unterminated' };
    }

    if (found && block === '') {
      // Removal: swallow the blank line the fence left behind, so repeated
      // insert/remove cycles do not stack up empty lines.
      var end = found.end;
      var after = 0;
      while (text.charAt(end + after) === '\n') after++;
      var keep = Math.max(0, Math.min(after, 2 - runBefore(text, found.start)));
      return { text: '', start: found.start, end: end + after - keep, replaced: true };
    }
    if (found) return { text: block, start: found.start, end: found.end, replaced: true };
    if (block === '') {
      var noop = Math.max(0, Math.min(text.length, Number(cursor) || 0));
      return { text: '', start: noop, end: noop, replaced: false };
    }

    var at = Math.max(0, Math.min(text.length, Number(cursor) || 0));

    // The cursor is inside some OTHER fenced block (a ```js example, say).
    // Inserting there would make this gallery's closer close that block. Land
    // after it instead — the only position that is both safe and predictable.
    var enclosing = blockAt(text, at);
    if (enclosing) {
      if (enclosing.unterminated) {
        return { text: '', start: at, end: at, replaced: false, blocked: 'unterminated' };
      }
      at = enclosing.end;
    }

    var prefix = at === 0 ? '' : new Array(2 - runBefore(text, at) + 1).join('\n');
    var trailing = 0;
    while (trailing < 2 && text.charAt(at + trailing) === '\n') trailing++;
    var suffix = at === text.length ? '' : new Array(2 - trailing + 1).join('\n');
    return { text: prefix + block + suffix, start: at, end: at, replaced: false };
  }

  return {
    // escapeMeta/unescapeMeta have no caller in the page — serialize and parse
    // use them internally. They are exported so test/gallery-fence.test.ts can
    // compare them character for character against src/body-content.ts's pair,
    // which is the only thing keeping the duplicated rule honest. Do not drop
    // them as dead exports; that deletes the test's handle on the invariant.
    escapeMeta: escapeMeta,
    unescapeMeta: unescapeMeta,
    LAYOUTS: LAYOUTS,
    DEFAULT_LAYOUT: DEFAULT_LAYOUT,
    layoutOf: layoutOf,
    withLayout: withLayout,
    serialize: serialize,
    parse: parse,
    fenceAt: fenceAt,
    replaceFenceAt: replaceFenceAt,
  };
})();
