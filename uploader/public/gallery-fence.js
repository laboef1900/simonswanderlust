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
// the author-facing format means the picker remains an authoring aid. Gallery
// identity and source ranges come exclusively from the authenticated analyzer.
//
import { escapeMeta, unescapeMeta, parsePhotoLine, galleryWarnings, MAX_GALLERY_TEXT as MAX_TEXT } from './gallery-photo-line.js';

// Same rules as media-picker.js: textContent only, one state object, no innerHTML.
window.GalleryFence = (function () {

  // ── the #layout: directive (#66) ───────────────────────────────────────
  //
  // Layout directives mirror the renderer; parity tests pin their vocabulary.
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

  // Photo fields are parsed atomically by the shared, dependency-free codec.

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
   * parse(content) → { directives, lines }
   *
   * Accepts logical gallery content supplied by source analysis, never source
   * delimiters or container prefixes. Photo metadata policy is unchanged.
   */
  function parse(text) {
    var directives = [];
    var lines = [];

    String(text == null ? '' : text).split('\n').forEach(function (raw) {
      var line = raw.trim();
      if (line === '') return;
      if (line.charAt(0) === '#') { directives.push(line); return; }

      var photo = parsePhotoLine(raw);
      if (!photo.valid) { lines.push(photo); return; }
      var out = { src: photo.src };
      ['width', 'height', 'alt', 'caption', 'captionOverride', 'format'].forEach(function (name) {
        if (photo[name] !== undefined) out[name] = photo[name];
      });
      lines.push(out);
    });

    return { directives: directives, lines: lines };
  }

  /** Change only alt fields for this photo, retaining every other field and line. */
  function withAlt(text, src, value) {
    var field = 'alt="' + escapeMeta(String(value).slice(0, MAX_TEXT)) + '"';
    return String(text).split('\n').map(function (raw) {
      var photo = parsePhotoLine(raw);
      if (!photo.valid || photo.src !== src) return raw;
      var alts = photo.fields.filter(function (part) { return part.name === 'alt'; });
      if (alts.length) {
        // Replace all duplicate alt values without touching other field spelling.
        for (var i = alts.length - 1; i >= 0; i--) {
          raw = raw.slice(0, alts[i].start) + field + raw.slice(alts[i].end);
        }
        return raw;
      }
      var suffix = raw.slice(raw.trimEnd().length);
      return raw.trimEnd() + ' | ' + field + suffix;
    }).join('\n');
  }

  // A small snapshot cache shares one request between widgets and quick checks.
  // Mutations explicitly request fresh analysis; failures are never cached.
  var analyses = new Map();
  async function analyze(body, options) {
    var text = String(body == null ? '' : body);
    if (!(options && options.fresh) && analyses.has(text)) return analyses.get(text);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 10000);
    var pending = (async function () {
      try {
        var response = await fetch('/gallery/analyze', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bodyMarkdown: text }), signal: controller.signal,
        });
        if (!response.ok) {
          var error = new Error('Gallery analysis unavailable');
          error.status = response.status;
          throw error;
        }
        var result = await response.json();
        if (!result || result.bodyMarkdown !== text || !Array.isArray(result.blocks)) {
          throw new Error('Gallery analysis snapshot mismatch');
        }
        return result;
      } finally { clearTimeout(timer); }
    })();
    analyses.set(text, pending);
    while (analyses.size > 2) analyses.delete(analyses.keys().next().value);
    try { return await pending; }
    catch (error) {
      if (analyses.get(text) === pending) analyses.delete(text);
      throw error;
    }
  }

  async function scanFences(body, options) { return (await analyze(body, options)).blocks; }

  function blockAt(analysis, cursor) {
    var found = null;
    analysis.blocks.forEach(function (block) {
      if (cursor >= block.start && cursor <= block.end
        && (!found || (block.start >= found.start && block.end <= found.end))) found = block;
    });
    return found;
  }

  async function fenceAt(body, cursor, options) {
    var analysis = await analyze(body, options);
    var block = blockAt(analysis, cursor);
    return block && block.isGallery
      ? Object.assign({ text: analysis.bodyMarkdown.slice(block.start, block.end) }, block) : null;
  }


  async function altEdit(body, src, value) {
    var analysis = await analyze(body, { fresh: true });
    var helpers = await import('./gallery-source-edits.js');
    var edits = [];
    var lines = analysis.blocks.filter(function (block) { return block.isGallery && !block.unterminated; })
      .flatMap(function (block) { return block.lines; });
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i];
      var replacement = withAlt(line.text, src, value);
      if (replacement !== line.text) {
        helpers.galleryLineEdits(line, replacement).forEach(function (edit) { edits.push(edit); });
      }
    }
    return edits.sort(function (a, b) { return b.start - a.start || b.end - a.end; });
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
  async function insertBlockAt(body, cursor, block) {
    var text = String(body == null ? '' : body);
    var line = String(block == null ? '' : block);
    var at = Math.max(0, Math.min(text.length, Number(cursor) || 0));
    var enclosing = blockAt(await analyze(text, { fresh: true }), at);
    if (!enclosing) return { text: line, start: at, cursor: at + line.length, relocated: false };
    if (enclosing.unterminated) {
      return { text: '', start: at, cursor: at, relocated: false, blocked: 'unterminated' };
    }
    return insertAfterBlock(text, enclosing, line);
  }

  function insertAfterBlock(text, enclosing, line) {
    var newline = enclosing.newline || '\n';
    var prefix = enclosing.prefix || '';
    if (!prefix) {
      var pad = padding(text, enclosing.end);
      return { text: pad.prefix + line + pad.suffix, start: enclosing.end,
        cursor: enclosing.end + pad.prefix.length + line.length + 2, relocated: true };
    }
    var inserted = newline + prefix + newline + prefix + line.replace(/\n/g, newline + prefix) + newline + prefix + newline + prefix;
    return { text: inserted, start: enclosing.end, cursor: enclosing.end + inserted.length, relocated: true };
  }

  /** Fresh, authoritative range edit; never replace an author's whole document. */
  async function replaceFenceAt(body, cursor, fence) {
    var text = String(body == null ? '' : body);
    var block = String(fence == null ? '' : fence);
    var analysis = await analyze(text, { fresh: true });
    var enclosing = blockAt(analysis, cursor);
    var found = enclosing && enclosing.isGallery ? enclosing : null;
    if (enclosing && enclosing.unterminated) {
      return { text: '', start: enclosing.start, end: enclosing.start, cursor: enclosing.start, replaced: false, blocked: 'unterminated' };
    }
    if (found && parse(found.content).lines.some(function (line) { return line.valid === false; })) {
      return { text: '', start: found.start, end: found.start, cursor: found.start, replaced: false, blocked: 'invalid_metadata' };
    }
    if (found && block === '') {
      // Never swallow neighboring list items, quotes, or prose.
      return { text: '', start: found.start, end: found.end, cursor: found.start, replaced: true };
    }
    if (found) {
      // `fence` is our canonical serializer's output, not arbitrary Markdown.
      var content = block.slice(block.indexOf('\n') + 1, block.lastIndexOf('\n'));
      var helpers = await import('./gallery-source-edits.js');
      var edit = helpers.galleryContentEdit(text, found, content);
      var following = 0;
      while (following < 2 && text.charAt(found.end + following) === '\n') following++;
      return Object.assign(edit, { cursor: found.end + edit.text.length - (edit.end - edit.start) + following, replaced: true });
    }
    var at = Math.max(0, Math.min(text.length, Number(cursor) || 0));
    if (!block) return { text: '', start: at, end: at, cursor: at, replaced: false };
    if (enclosing) {
      var relocated = insertAfterBlock(text, enclosing, block);
      return Object.assign(relocated, { end: relocated.start, replaced: false });
    }
    var pad = padding(text, at);
    return { text: pad.prefix + block + pad.suffix, start: at, end: at,
      cursor: at + pad.prefix.length + block.length + 2, replaced: false };
  }

  return {
    galleryWarnings: galleryWarnings,
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
    analyze: analyze,
    altEdit: altEdit,
    scanFences: scanFences,
    fenceAt: fenceAt,
    replaceFenceAt: replaceFenceAt,
    insertBlockAt: insertBlockAt,
  };
})();
