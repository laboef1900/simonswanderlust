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
// site/src/lib/gallery-layout.ts. They cannot import one another (browser IIFE vs. an ESM
// module in a different tsconfig), so `test/gallery-fence.test.ts` asserts they
// agree character for character. Change one and you MUST change the other: a
// divergence corrupts alt text and captions containing `|`, a newline or a
// quote, silently, at save time.
//
// Same rules as media-picker.js: textContent only, one state object, no innerHTML.
window.GalleryFence = (function () {
  // Mirrors site/src/lib/gallery-layout.ts. Order is load-bearing in both directions:
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
  var LAYOUTS = ['column', 'breakout', 'slider'];
  var DEFAULT_LAYOUT = 'column';
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

  // Mirrors the renderer's caption directive: first match wins, unknown is visible.
  var CAPTIONS_RE = /^\s*#\s*captions\s*:\s*(\S*)\s*$/i;
  function captionsVisible(directives) {
    var lines = directives || [];
    for (var i = 0; i < lines.length; i++) {
      var match = CAPTIONS_RE.exec(String(lines[i]));
      if (match) return String(match[1]).toLowerCase() !== 'hidden';
    }
    return true;
  }

  function withCaptions(directives, visible) {
    var kept = (directives || []).filter(function (d) { return !CAPTIONS_RE.test(String(d)); });
    return visible === false ? ['#captions: hidden'].concat(kept) : kept;
  }

  // Mirrors DIMS_RE / ATTR_RE and MAX_TEXT in src/body-content.ts.
  var DIMS_RE = /^(\d{1,6})x(\d{1,6})$/;
  var ATTR_RE = /^(alt|caption|caption-override|format)="([^"]*)"$/;
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
   * A row from the media library carries its localized descriptions as
   * `{ de, en }` maps. A placeholder seeded from the post (`fromPost`, no row
   * found yet) carries none — the shape, not a flag, says which one this is.
   */
  function isLibraryRow(item) {
    return !!item && (
      (item.alt !== null && typeof item.alt === 'object')
      || (item.caption !== null && typeof item.caption === 'object'));
  }

  /**
   * serialize(items, locale, directives?, postMeta?, captionOverrides?) → a complete ```gallery block.
   *
   * `directives` are `#`-prefixed lines carried through from an existing fence
   * (e.g. #66's `#layout: slider`). They are emitted first and never parsed —
   * this module has no opinion about what they mean, only that editing a
   * gallery must not silently discard them.
   *
   * `postMeta` maps a photo URL to the metadata already recorded FOR THIS POST
   * (its `images` entry, plus anything hand-typed on the fence line).
   *
   * Precedence (docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md):
   * a LIBRARY ROW's alt and caption are authoritative, empty strings included —
   * the site renders them over the post's copy on every build, so writing the
   * post's older text here would only make the stored fallback disagree with
   * what the author just confirmed. A photo with no library row (an unresolved
   * placeholder) keeps the post's metadata exactly. The JPEG-only marker
   * describes the stored variants, so the post's recorded `format` is kept in
   * both cases.
   * `captionOverrides` holds explicit gallery-local edits, including empty text.
   * These stay on the photo line rather than entering the URL-keyed images map.
   *
   * @ai-warning `postMeta` is load-bearing in two ways. `normalizeGalleryFences`
   * lets a value present on the line beat the stored `images` entry, and keeps
   * the stored entry when the line says nothing (src/body-content.ts). So for an
   * unresolved photo it is what carries the post's text across; and for a
   * library row whose alt/caption is now EMPTY, a prior value in `postMeta` is
   * what forces an explicit `alt=""`/`caption=""` — omitting the attribute would
   * let the save resurrect the stale copy as the stored fallback.
   */
  function serialize(items, locale, directives, postMeta, captionOverrides) {
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
      // Retain any unsaved text metadata too: an unresolved photo must not lose
      // its alt merely because the picker could not recover its dimensions.
      var hasDimensions = usableDim(item.width) && usableDim(item.height);
      if (!hasDimensions && !item.fromPost) return;

      var prior = metaFor(postMeta, src);
      var parts = [src];
      if (hasDimensions) parts.push(item.width + 'x' + item.height);
      var format = typeof prior.format === 'string' ? prior.format : item.format;
      if (format === 'jpeg') parts.push('format="jpeg"');
      var library = isLibraryRow(item);
      var alt = (library ? pickLocale(item.alt, locale)
        : typeof prior.alt === 'string' ? prior.alt : '').slice(0, MAX_TEXT);
      var caption = (library ? pickLocale(item.caption, locale)
        : typeof prior.caption === 'string' ? prior.caption : '').slice(0, MAX_TEXT);
      // An empty value is written only when it must replace something the post
      // recorded: a deliberate clear on an unresolved photo, or a library value
      // that is now empty over an older post copy.
      if (alt !== '' || typeof prior.alt === 'string') parts.push('alt="' + escapeMeta(alt) + '"');
      if (caption !== '' || typeof prior.caption === 'string') parts.push('caption="' + escapeMeta(caption) + '"');
      if (captionOverrides && typeof captionOverrides[src] === 'string') {
        parts.push('caption-override="' + escapeMeta(captionOverrides[src].slice(0, MAX_TEXT)) + '"');
      }
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
          else if (attr[1] === 'caption') out.caption = value;
          else if (attr[1] === 'caption-override') out.captionOverride = value;
          else if (value === 'jpeg') out.format = value;
        }
      });
      lines.push(out);
    });

    return { directives: directives, lines: lines };
  }

  /** Change only alt fields for this photo, retaining every other field and line. */
  function withAlt(text, src, value) {
    var field = 'alt="' + escapeMeta(String(value).slice(0, MAX_TEXT)) + '"';
    return String(text).split('\n').map(function (raw) {
      var photo = parse(raw).lines[0];
      if (!photo || photo.src !== src) return raw;
      var cr = raw.endsWith('\r') ? '\r' : '';
      var fields = (cr ? raw.slice(0, -1) : raw).split('|');
      var rest = fields.slice(1).filter(function (part) {
        var attr = ATTR_RE.exec(part.trim());
        return !attr || attr[1] !== 'alt';
      });
      return [fields[0]].concat(rest).join('|').trimEnd() + ' | ' + field + cr;
    }).join('\n');
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
   *  4. A trailing '\r' is stripped before the fence test, as the server does.
   *     Left on the line it lands in the info string, so a CRLF closer never
   *     matched rule 2 and a perfectly closed gallery was "unterminated" (#142).
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
      var raw = lines[i];
      var lineStart = pos;
      var lineEnd = pos + raw.length;
      pos = lineEnd + 1; // + newline

      // Keep CRLF intact: split('\n') leaves the '\r' on the line, and the
      // server (`rewriteFences`) strips it before testing the fence. Left in,
      // it lands in `info` and a closer never matches CLOSER_TAIL_RE (#142).
      var line = raw.charAt(raw.length - 1) === '\r' ? raw.slice(0, -1) : raw;

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
   * The blank lines a block inserted at `at` needs to stand alone: `prefix`
   * completes the separator before it (none at the very start), `suffix` the
   * one after it — also at EOF, so the caret the editor leaves at the end of
   * the range edit is never on the block's last line. Without that suffix the
   * next uploaded image was concatenated to a gallery's closing ``` and opened
   * the fence over all following story content (#333).
   */
  function padding(text, at) {
    var prefix = at === 0 ? '' : new Array(2 - runBefore(text, at) + 1).join('\n');
    var trailing = 0;
    while (trailing < 2 && text.charAt(at + trailing) === '\n') trailing++;
    return { prefix: prefix, suffix: new Array(2 - trailing + 1).join('\n') };
  }

  /**
   * insertBlockAt(body, cursor, block) → { text, start, cursor, relocated, blocked? }
   *
   * Where a block the editor is about to write at `cursor` — an uploaded
   * image's `![alt](src)` line — may safely go, as a range edit inserting
   * `text` at `start` with the caret at `cursor` afterwards. Outside every
   * fence that is the cursor itself, unpadded (`relocated: false`): the caller
   * may insert as it always has, replacing a selection if there is one. Inside
   * a fence it is the position after the block, padded to stand alone
   * (`relocated: true`): on the closer's own line the image turns the closing
   * ``` into text and a gallery swallows the rest of the story; between the
   * fences of a gallery it is a photo line the renderer ignores; in any other
   * block it is literal text. `blocked: 'unterminated'` when the enclosing
   * fence has no closer, as replaceFenceAt reports it — there is no "after"
   * to relocate to, and the caller must make no edit.
   */
  function insertBlockAt(body, cursor, block) {
    var text = String(body == null ? '' : body);
    var line = String(block == null ? '' : block);
    var at = Math.max(0, Math.min(text.length, Number(cursor) || 0));
    var enclosing = blockAt(text, at);
    if (!enclosing) return { text: line, start: at, cursor: at + line.length, relocated: false };
    if (enclosing.unterminated) {
      return { text: '', start: at, cursor: at, relocated: false, blocked: 'unterminated' };
    }
    var pad = padding(text, enclosing.end);
    return {
      text: pad.prefix + line + pad.suffix,
      start: enclosing.end,
      cursor: enclosing.end + pad.prefix.length + line.length + 2,
      relocated: true,
    };
  }

  /**
   * replaceFenceAt(body, cursor, fence) → { text, start, end, cursor, replaced, blocked? }
   *
   * A RANGE EDIT, not a new document: `text` replaces `[start, end)`. The caller
   * applies it with `cm.replaceRange`, which keeps CodeMirror's undo history —
   * `mde.value()` would discard it, so a mis-inserted gallery could not be undone.
   * `cursor` is where the caret belongs in the NEW document: after the block
   * and the blank line that follows it, so what the author writes next can
   * never land on the closing ``` (#333).
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
      return { text: '', start: found.start, end: found.start, cursor: found.start, replaced: false, blocked: 'unterminated' };
    }

    if (found && block === '') {
      // Removal: swallow the blank line the fence left behind, so repeated
      // insert/remove cycles do not stack up empty lines.
      var end = found.end;
      var after = 0;
      while (text.charAt(end + after) === '\n') after++;
      var keep = Math.max(0, Math.min(after, 2 - runBefore(text, found.start)));
      return { text: '', start: found.start, end: end + after - keep, cursor: found.start, replaced: true };
    }
    if (found) {
      // The text around the fence is left byte for byte; the caret skips the
      // separator that is already there (up to the blank line).
      var following = 0;
      while (following < 2 && text.charAt(found.end + following) === '\n') following++;
      return { text: block, start: found.start, end: found.end, cursor: found.start + block.length + following, replaced: true };
    }
    if (block === '') {
      var noop = Math.max(0, Math.min(text.length, Number(cursor) || 0));
      return { text: '', start: noop, end: noop, cursor: noop, replaced: false };
    }

    var at = Math.max(0, Math.min(text.length, Number(cursor) || 0));

    // The cursor is inside some OTHER fenced block (a ```js example, say).
    // Inserting there would make this gallery's closer close that block. Land
    // after it instead — the only position that is both safe and predictable.
    var enclosing = blockAt(text, at);
    if (enclosing) {
      if (enclosing.unterminated) {
        return { text: '', start: at, end: at, cursor: at, replaced: false, blocked: 'unterminated' };
      }
      at = enclosing.end;
    }

    // Existing newlines at `at` plus the suffix always make exactly one blank
    // line, so the caret lands on the first line after it.
    var pad = padding(text, at);
    return {
      text: pad.prefix + block + pad.suffix,
      start: at,
      end: at,
      cursor: at + pad.prefix.length + block.length + 2,
      replaced: false,
    };
  }

  return {
    // escapeMeta/unescapeMeta have no caller in the page — serialize and parse
    // use them internally. They are exported so test/gallery-fence.test.ts can
    // compare them character for character against gallery-layout.ts's pair,
    // which is the only thing keeping the duplicated rule honest. Do not drop
    // them as dead exports; that deletes the test's handle on the invariant.
    escapeMeta: escapeMeta,
    unescapeMeta: unescapeMeta,
    LAYOUTS: LAYOUTS,
    DEFAULT_LAYOUT: DEFAULT_LAYOUT,
    layoutOf: layoutOf,
    withLayout: withLayout,
    captionsVisible: captionsVisible,
    withCaptions: withCaptions,
    serialize: serialize,
    parse: parse,
    withAlt: withAlt,
    scanFences: scanFences,
    fenceAt: fenceAt,
    replaceFenceAt: replaceFenceAt,
    insertBlockAt: insertBlockAt,
  };
})();
