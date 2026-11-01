// Pure source edits shared by the server and the unbundled browser. Classification
// and spans come ONLY from /gallery/analyze; this module never parses Markdown.
function encode(text, line) {
  // Raw HTML may be inline in Markdown. Entity-encode punctuation so an edit
  // cannot become emphasis, a link, or smart punctuation on the next parse.
  const value = line.html ? text.replace(/[!-/:-@[-`{-~]/g, (char) => '&#' + char.charCodeAt(0) + ';') : text;
  return value.replace(/\n/g, (line.newline || '\n') + line.prefix);
}

export function galleryLineEdits(line, replacement) {
  if (replacement === line.text) return [];
  let from = 0;
  let to = line.text.length;
  let replacementEnd = replacement.length;
  while (from < to && from < replacementEnd && line.text[from] === replacement[from]) from++;
  while (to > from && replacementEnd > from && line.text[to - 1] === replacement[replacementEnd - 1]) {
    to--;
    replacementEnd--;
  }
  // An entity (including a two-codepoint named entity) is an indivisible source
  // span. Expand a partial edit, preserving its unchanged logical characters.
  for (const span of line.spans) {
    if (span.end - span.start === span.to - span.from) continue;
    if (span.from < from && span.to > from) from = span.from;
    if (span.from < to && span.to > to) {
      replacementEnd += span.to - to;
      to = span.to;
    }
  }
  const touched = line.spans.filter((span) => span.to > from && span.from < to).map((span) => {
    if (span.end - span.start !== span.to - span.from) return span;
    return {
      start: span.start + Math.max(0, from - span.from),
      end: span.end - Math.max(0, span.to - to),
    };
  });
  const value = encode(replacement.slice(from, replacementEnd), line);
  if (!touched.length) {
    const next = line.spans.find((span) => span.to > from);
    const at = next ? next.start + (next.end - next.start === next.to - next.from ? from - next.from : 0) : line.end;
    return [{ start: at, end: at, text: value }];
  }
  // Leave every intervening HTML tag/container prefix untouched. Put replacement
  // text at the first changed text span, delete only the remaining text spans.
  return touched.map((span, index) => ({ start: span.start, end: span.end, text: index === 0 ? value : '' }));
}

export function applyGalleryEdits(body, edits) {
  const sorted = edits.slice().sort((a, b) => b.start - a.start || b.end - a.end);
  let end = body.length;
  const pieces = [];
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > end) throw new Error('Invalid gallery source span');
    pieces.push(body.slice(edit.end, end), edit.text);
    end = edit.start;
  }
  pieces.push(body.slice(0, end));
  return pieces.reverse().join('');
}


/** A single undoable range edit, retaining fences/HTML wrappers and containers. */
export function galleryContentEdit(body, block, content) {
  if (block.unterminated) throw new Error('Unterminated gallery');
  if (block.content === content) return { start: block.contentStart, end: block.contentStart, text: '' };
  const values = content === '' ? [] : content.split('\n');
  const edits = [];
  block.lines.forEach((line, index) => {
    let value = values[index] || '';
    if (index === block.lines.length - 1 && values.length > block.lines.length) {
      value += '\n' + values.slice(block.lines.length).join('\n');
    }
    for (const edit of galleryLineEdits(line, value)) edits.push(edit);
  });
  if (!block.lines.length && values.length) {
    const line = { html: block.kind === 'html', newline: block.newline, prefix: block.prefix };
    const value = encode(values.join('\n'), line);
    edits.push({ start: block.contentStart, end: block.contentStart, text: value + (block.kind === 'fence' ? block.newline + block.prefix : '') });
  }
  if (!edits.length) return { start: block.contentStart, end: block.contentStart, text: '' };
  let start = body.length;
  let end = 0;
  for (const edit of edits) { start = Math.min(start, edit.start); end = Math.max(end, edit.end); }
  const changed = applyGalleryEdits(body, edits);
  return { start, end, text: changed.slice(start, changed.length - (body.length - end)) };
}
