// Advisory checks of one unsaved locale. Load gallery-fence.js first.
// No DOM, network, persistence, or draft mutation; all markdown lines are 1-indexed.
window.EditorLinter = (function () {
  function text(value) {
    return String(value == null ? '' : value);
  }

  function lintLength(value, min, max, label) {
    var count = text(value).length;
    if (count < min) return { status: 'warn', count: count, message: label + ' is too short (aim for ' + min + '–' + max + ' characters).' };
    if (count > max) return { status: 'warn', count: count, message: label + ' is too long (aim for ' + min + '–' + max + ' characters).' };
    return { status: 'pass', count: count };
  }

  function lintTitle(value) { return lintLength(value, 20, 70, 'Title'); }
  function lintExcerpt(value) { return lintLength(value, 100, 160, 'Excerpt'); }

  function result(findings) {
    return { status: findings.length ? 'warn' : 'pass', findings: findings };
  }

  function blank(value, replacement) { return value.replace(/[^\r\n]/g, replacement || ' '); }

  function escapedAt(value, at) {
    var slashes = 0;
    while (at > 0 && value.charAt(--at) === '\\') slashes++;
    return slashes % 2 === 1;
  }

  // Preserve offsets/newlines when hiding examples. Delimiter runs must match
  // exactly: a single backtick inside a double-backtick span does not close it.
  function hideCodeSpans(value) {
    var runs = [];
    var re = /`+/g;
    var match;
    while ((match = re.exec(value))) runs.push({ start: match.index, end: re.lastIndex, size: match[0].length });
    var next = new Map();
    var closers = [];
    for (var i = runs.length - 1; i >= 0; i--) {
      closers[i] = next.get(runs[i].size);
      next.set(runs[i].size, i);
    }
    var parts = [];
    var pos = 0;
    for (var j = 0; j < runs.length; j++) {
      var end = closers[j];
      if (end === undefined || escapedAt(value, runs[j].start)) continue;
      parts.push(value.slice(pos, runs[j].start), blank(value.slice(runs[j].start, runs[end].end), '\0'));
      pos = runs[end].end;
      j = end;
    }
    parts.push(value.slice(pos));
    return parts.join('');
  }

  function prepare(markdown) {
    var source = text(markdown);
    var blocks = window.GalleryFence.scanFences(source);
    var parts = [];
    var pos = 0;
    blocks.forEach(function (block) {
      // Process prose separately so a code span cannot bridge a fenced block.
      parts.push(hideCodeSpans(source.slice(pos, block.start)), blank(source.slice(block.start, block.end)));
      pos = block.end;
    });
    parts.push(hideCodeSpans(source.slice(pos)));
    var starts = [0];
    for (var i = 0; i < source.length; i++) {
      if (source.charAt(i) === '\n') starts.push(i + 1);
    }
    return { source: source, visible: parts.join(''), blocks: blocks, starts: starts };
  }

  function lineAt(starts, offset) {
    var low = 0;
    var high = starts.length;
    while (low + 1 < high) {
      var mid = Math.floor((low + high) / 2);
      if (starts[mid] <= offset) low = mid;
      else high = mid;
    }
    return low + 1;
  }

  function headingsIn(doc) {
    var findings = [];
    // The article title already supplies level 1, including before the first
    // body heading. CommonMark also permits an empty ATX heading at end of line.
    var previous = 1;
    doc.visible.split('\n').forEach(function (line, index) {
      var heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line.replace(/\r$/, ''));
      if (!heading) return;
      var level = heading[1].length;
      if (level === 1) findings.push({ code: 'body-h1', message: 'The article title already supplies H1; use H2 or below in the body.', line: index + 1 });
      if (level > previous + 1) findings.push({ code: 'heading-level-skipped', message: 'Heading skips from H' + previous + ' to H' + level + '.', line: index + 1 });
      previous = level;
    });
    return result(findings);
  }

  // The inline destination subset used by wp-content.ts's markdownImages:
  // escaped labels/destinations, angle destinations, balanced URL parentheses,
  // optional titles and multiline labels. Reference links/HTML are not scanned.
  var INLINE_RE = /(!?)\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^<>\n]*)>|((?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))*))(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?\s*\)/g;

  function inlineIn(doc) {
    var items = [];
    INLINE_RE.lastIndex = 0;
    var match;
    while ((match = INLINE_RE.exec(doc.visible))) {
      if (escapedAt(doc.visible, match.index)) continue;
      items.push({
        image: match[1] === '!',
        alt: match[2],
        destination: (match[3] === undefined ? match[4] : match[3]).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1'),
        line: lineAt(doc.starts, match.index),
      });
    }
    return items;
  }

  function altIn(input, doc, inline) {
    var findings = [];
    if (text(input.heroSrc).trim() && !text(input.heroAlt).trim()) {
      findings.push({ code: 'missing-alt', message: 'Add alt text to the hero image.', target: 'hero' });
    }
    inline.forEach(function (item) {
      if (item.image && !item.alt.trim()) findings.push({ code: 'missing-alt', message: 'Add alt text to this inline image.', line: item.line, target: 'inline' });
    });
    doc.blocks.forEach(function (block) {
      if (!block.isGallery) return;
      var firstLine = lineAt(doc.starts, block.start);
      var lines = doc.source.slice(block.start, block.end).split('\n');
      var end = block.unterminated ? lines.length : lines.length - 1;
      for (var i = 1; i < end; i++) {
        // Parse each line through the picker's metadata decoder, preserving the
        // original line even when blank/directive lines occur between photos.
        var photo = window.GalleryFence.parse(lines[i]).lines[0];
        if (photo && !text(photo.alt).trim()) findings.push({ code: 'missing-alt', message: 'Add alt text to this gallery image.', line: firstLine + i, target: 'gallery' });
      }
    });
    findings.sort(function (a, b) { return (a.line || 0) - (b.line || 0); });
    return result(findings);
  }

  function linksIn(inline) {
    var count = inline.filter(function (item) {
      var destination = item.destination;
      return !item.image && destination !== '' && !/^(?:[a-z][a-z\d+.-]*:|[\\/]{2}|#|\?)/i.test(destination);
    }).length;
    var checked = result(count ? [] : [{ code: 'missing-internal-link', message: 'Consider linking to another story using a relative path.' }]);
    checked.count = count;
    return checked;
  }

  function lintHeadings(markdown) { return headingsIn(prepare(markdown)); }
  function lintAltText(input) {
    input = input || {};
    var doc = prepare(input.markdown);
    return altIn(input, doc, inlineIn(doc));
  }
  function lintInternalLinks(markdown) {
    return linksIn(inlineIn(prepare(markdown)));
  }

  function lintStory(input) {
    input = input || {};
    var doc = prepare(input.markdown);
    var inline = inlineIn(doc);
    var title = lintTitle(input.title);
    var excerpt = lintExcerpt(input.excerpt);
    var headings = headingsIn(doc);
    var altText = altIn(input, doc, inline);
    var internalLinks = linksIn(inline);
    var warningCount = (title.status === 'warn' ? 1 : 0) + (excerpt.status === 'warn' ? 1 : 0)
      + headings.findings.length + altText.findings.length + internalLinks.findings.length;
    return { title: title, excerpt: excerpt, headings: headings, altText: altText, internalLinks: internalLinks, pass: warningCount === 0, warningCount: warningCount };
  }

  return {
    lintTitle: lintTitle,
    lintExcerpt: lintExcerpt,
    lintHeadings: lintHeadings,
    lintAltText: lintAltText,
    lintInternalLinks: lintInternalLinks,
    lintStory: lintStory,
  };
})();
