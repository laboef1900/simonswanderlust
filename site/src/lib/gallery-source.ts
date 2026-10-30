import { markdownToHast, type Position } from 'satteri';
import { unified } from 'unified';
import rehypeStringify from 'rehype-stringify';
import { visit, SKIP } from 'unist-util-visit';
import { EntityDecoder, DecodingMode, htmlDecodeTree } from 'entities/decode';
import type { Element, Root } from 'hast';
import { MARKDOWN_FEATURES } from './markdown-features.js';
import { galleryCode, sanitizedBodyTree, textOf } from './gallery-identity.js';

export interface GallerySpan { start: number; end: number; from: number; to: number }
export interface GalleryLine {
  text: string; start: number; end: number; prefix: string; newline: string;
  html: boolean; spans: GallerySpan[];
}
export interface GalleryBlock {
  start: number; end: number; isGallery: boolean; unterminated: boolean;
  kind: 'fence' | 'html' | 'code'; content: string; lines: GalleryLine[];
  contentStart: number; contentEnd: number; prefix: string; newline: string;
}
export interface GalleryAnalysis { bodyMarkdown: string; blocks: GalleryBlock[] }

/** Do not expose source in errors: the route uses the sanitized error path. */
export class GallerySourceError extends Error {
  constructor() { super('Gallery source analysis could not map the document safely'); }
}
interface SourceNode {
  type: string; tagName?: string; properties?: Element['properties'];
  children?: SourceNode[]; value?: string; position?: Position;
}
interface PhysicalLine { start: number; end: number; next: number; text: string; newline: string }
interface Unit { start: number; end: number; value: string }
interface RawRegion { start: number; end: number; units?: Unit[]; resolve: () => Unit[] }
interface CodeRegion { start: number; end: number; node: SourceNode }
type SourceContainer = { kind: 'quote' } | { kind: 'list'; indent: number };
const stringify = unified().use(rehypeStringify, { allowDangerousHtml: true });
const fail = (): never => { throw new GallerySourceError(); };

function physicalLines(source: string, start: number, end: number): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let at = start;
  while (at < end) {
    let stop = at;
    while (stop < end && source[stop] !== '\n' && source[stop] !== '\r') stop++;
    let next = stop;
    if (next < end) next += source[next] === '\r' && source[next + 1] === '\n' ? 2 : 1;
    lines.push({ start: at, end: stop, next, text: source.slice(at, stop), newline: source.slice(stop, next) });
    at = next;
  }
  return lines;
}

/** Satteri positions count Unicode scalar values, NOT UTF-8 or UTF-16.
 * Explicit conversion is pinned by astral/CRLF tests; HTML parser positions are
 * already UTF-16 and must not pass through this conversion a second time. */
function sourceOffsets(source: string): number[] {
  const offsets = [0];
  let offset = 0;
  for (const scalar of source) { offset += scalar.length; offsets.push(offset); }
  return offsets;
}

/** Map one parser-established logical line onto its physical line. Only the
 * bounded line suffix is matched; duplicated text elsewhere is never searched.
 * A consumed indentation tab can leave synthetic spaces in Satteri's value. */
function mapLine(logical: string, line: PhysicalLine, html: boolean): GalleryLine {
  let at = line.end - logical.length;
  const spans: GallerySpan[] = [];
  let synthetic = 0;
  if (at < line.start || line.text.slice(at - line.start).replace(/\0/g, '\uFFFD') !== logical) {
    const trimmed = logical.replace(/^ +/, '');
    const suffixStart = line.end - trimmed.length;
    if (!logical.startsWith(' ') || suffixStart <= line.start ||
      line.text.slice(suffixStart - line.start) !== trimmed ||
      line.text[suffixStart - line.start - 1] !== '\t') fail();
    synthetic = logical.length - trimmed.length;
    // The tab is also container indentation, so it cannot be deleted merely
    // because normalization trims its synthetic residual spaces.
    at = suffixStart;
    spans.push({ start: at, end: at, from: 0, to: synthetic });
  }
  if (logical.length > synthetic) spans.push({ start: at, end: line.end, from: synthetic, to: logical.length });
  return { text: logical, start: at, end: line.end, prefix: line.text.slice(0, at - line.start), newline: line.newline, html, spans };
}

function appendSpan(spans: GallerySpan[], span: GallerySpan) {
  const last = spans.at(-1);
  if (last && last.end === span.start && last.to === span.from &&
    last.end - last.start === last.to - last.from && span.end - span.start === span.to - span.from) {
    last.end = span.end; last.to = span.to;
  } else spans.push(span);
}

/** Source provenance for raw HTML, including prefixes stripped by Markdown. */
function rawUnits(value: string, source: string, start: number, end: number): Unit[] {
  const physical = physicalLines(source, start, end);
  const logical = value.split(/\r\n|\r|\n/);
  const units: Unit[] = [];
  for (let i = 0; i < logical.length; i++) {
    const text = logical[i] ?? '';
    const line = physical[i];
    if (!line) {
      if (text === '' && i === logical.length - 1) break;
      return fail();
    }
    const mapped = mapLine(text, line, true);
    for (const span of mapped.spans) {
      for (let j = span.from; j < span.to; j++) {
        const direct = span.to - span.from === span.end - span.start;
        units.push({ start: direct ? span.start + j - span.from : span.start, end: direct ? span.start + j - span.from + 1 : span.end, value: text[j] ?? '' });
      }
    }
    if (i < logical.length - 1) units.push({ start: line.end, end: line.next, value: '\n' });
  }
  if (units.map((unit) => unit.value).join('') !== value.replace(/\r\n|\r/g, '\n')) fail();
  return units;
}

/**
 * Positioned text can occur between inline raw <pre>/<code> tags. Satteri has
 * already decided its inline grammar. Keep unchanged token runs exact and map
 * transformed punctuation to its parser-owned source span, never search another
 * occurrence of the text. Entity/escape spelling stays attached to that span.
 */
function positionedText(value: string, source: string, start: number, end: number, containers: SourceContainer[]): Unit[] {
  const original = source.slice(start, end);
  const direct = (text: string, at: number): Unit[] => {
    const units: Unit[] = [];
    for (const char of text) {
      units.push({ start: at, end: at + char.length, value: char });
      at += char.length;
    }
    return units;
  };
  if (original === value) return direct(value, start);
  const decode = (text: string, at: number) => {
    const byOffset: Unit[] = [];
    for (const unit of direct(text, at)) {
      for (let i = 0; i < unit.value.length; i++) byOffset.push(unit);
    }
    const decoded = decodedUnits(text, (offset) => byOffset[offset] ?? fail());
    const unescaped: Unit[] = [];
    for (let i = 0; i < decoded.length; i++) {
      const token = decoded[i]!;
      const next = decoded[i + 1];
      if (token.value === '\\' && next && /^[!-/:-@[-`{-~]$/u.test(next.value)) {
        unescaped.push({ start: token.start, end: next.end, value: next.value }); i++;
      } else unescaped.push(token);
    }
    return unescaped;
  };
  const logical = value.split('\n');
  const tokens: Unit[] = [];
  let logicalRow = 0;
  // Soft-line nodes span container prefixes absent from their logical value.
  // Only parser-established ancestors consume prefixes. Decode entities before
  // counting logical lines: an encoded newline need not be a physical newline.
  physicalLines(source, start, end).forEach((row, index) => {
    let at = row.start;
    if (index > 0) {
      for (const container of containers) {
        if (container.kind === 'quote') {
          const prefix = source.slice(at, row.end).match(/^[ \t]*>[ \t]?/u)?.[0];
          if (prefix) at += prefix.length;
        } else {
          let columns = 0;
          while (at < row.end && columns < container.indent && /[ \t]/u.test(source[at]!)) {
            columns += source[at] === '\t' ? 4 - (columns % 4) : 1;
            at++;
          }
        }
      }
      const leading = source.slice(at, row.end).match(/^[ \t]*/u)?.[0].length ?? 0;
      const retained = logical[logicalRow]?.match(/^[ \t]*/u)?.[0].length ?? 0;
      at += Math.max(0, leading - retained);
    }
    for (const token of decode(source.slice(at, row.end), at)) {
      tokens.push(token);
      if (token.value === '\n') logicalRow++;
    }
    if (row.newline) {
      tokens.push({ start: row.end, end: row.next, value: '\n' });
      logicalRow++;
    }
  });
  if (tokens.map((token) => token.value).join('') === value) return tokens;
  const result: Unit[] = [];
  let lineStart = 0;
  let line = 0;
  for (let i = 0; i <= tokens.length; i++) {
    if (i < tokens.length && tokens[i]!.value !== '\n') continue;
    const text = logical[line++];
    if (text === undefined) return fail();
    for (const unit of alignPositionedTokens(tokens.slice(lineStart, i), text)) result.push(unit);
    if (i < tokens.length) result.push(tokens[i]!);
    lineStart = i + 1;
  }
  if (line !== logical.length) return fail();
  return result;
}

/** Punctuation transforms stay within one logical line and its source tokens. */
function alignPositionedTokens(tokens: Unit[], value: string): Unit[] {
  if (tokens.map((token) => token.value).join('') === value) return tokens;
  let first = 0;
  let from = 0;
  while (first < tokens.length && value.startsWith(tokens[first]!.value, from)) {
    from += tokens[first]!.value.length; first++;
  }
  let last = tokens.length;
  let to = value.length;
  while (last > first && to >= from + tokens[last - 1]!.value.length &&
    value.slice(to - tokens[last - 1]!.value.length, to) === tokens[last - 1]!.value) {
    to -= tokens[last - 1]!.value.length; last--;
  }
  if (first === last) return fail();
  return [...tokens.slice(0, first),
    { start: tokens[first]!.start, end: tokens[last - 1]!.end, value: value.slice(from, to) },
    ...tokens.slice(last)];
}

/** Serialize the parser's HAST with the installed HTML serializer while tracking
 * emitted raw/code regions. Parsing the COMPLETE HTML (not isolated raw fragments)
 * preserves HTML's tree-repair and sanitization semantics across node boundaries. */
function mappedHtml(root: SourceNode, source: string, offsets: number[]) {
  const chunks: string[] = [];
  const raw: RawRegion[] = [];
  const code: CodeRegion[] = [];
  let length = 0;
  const emit = (value: string) => { chunks.push(value); length += value.length; };
  const bounds = (node: SourceNode) => {
    const start = offsets[node.position?.start.offset ?? -1];
    const end = offsets[node.position?.end.offset ?? -1];
    if (start === undefined || end === undefined) return fail();
    return { start, end };
  };
  const walk = (node: SourceNode, containers: SourceContainer[] = []) => {
    if (node.type === 'root') { for (const child of node.children ?? []) walk(child, containers); return; }
    if (node.type === 'raw') {
      const { start, end } = bounds(node);
      const value = (node.value ?? '').replace(/\r\n|\r/g, '\n');
      raw.push({ start: length, end: length + value.length, resolve: () => rawUnits(value, source, start, end) });
      emit(value); return;
    }
    if (node.type === 'text' && node.position) {
      const range = bounds(node);
      const encoded = stringify.stringify(node as unknown as Root);
      raw.push({ start: length, end: length + encoded.length, resolve: () => {
        const units = positionedText(node.value ?? '', source, range.start, range.end, containers);
        const provenance: Unit[] = [];
        let serialized = '';
        const unitNode = { type: 'text' as const, value: '' };
        const unitRoot: Root = { type: 'root', children: [unitNode] };
        for (const unit of units) {
          unitNode.value = unit.value;
          const part = stringify.stringify(unitRoot);
          serialized += part;
          for (let i = 0; i < part.length; i++) provenance.push(unit);
        }
        if (serialized !== encoded) return fail();
        return provenance;
      } });
      emit(encoded);
      return;
    }
    if (node.type === 'element' && node.children?.length) {
      const start = length;
      // The installed serializer owns escaping/tag spelling. Split its empty
      // wrapper at the opening tag boundary, respecting quoted attributes;
      // no sentinel can collide with author text or control characters.
      const shell = stringify.stringify({ ...node, children: [] } as unknown as Root);
      let index = 0;
      let quote = '';
      for (; index < shell.length; index++) {
        const char = shell[index];
        if (quote) { if (char === quote) quote = ''; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === '>') break;
      }
      if (index === shell.length) fail();
      index++;
      emit(shell.slice(0, index));
      let nested = containers;
      if (node.tagName === 'blockquote') nested = [...containers, { kind: 'quote' }];
      if (node.tagName === 'li') {
        const first = node.children.find((child) => child.position)?.position;
        const indent = first && node.position ? first.start.column - node.position.start.column : 0;
        nested = [...containers, { kind: 'list', indent: Math.max(0, indent) }];
      }
      for (const child of node.children) walk(child, nested);
      emit(shell.slice(index));
      if (node.tagName === 'pre' && node.position) code.push({ start, end: length, node });
      return;
    }
    emit(stringify.stringify(node as unknown as Root));
  };
  walk(root);
  return { html: chunks.join(''), raw, code, bounds };
}

function fenceBlock(node: SourceNode, source: string, start: number, end: number, isGallery: boolean): GalleryBlock {
  const rows = physicalLines(source, start, end);
  const opener = rows[0];
  const run = opener?.text.match(/^(`{3,}|~{3,})/u)?.[0];
  const code = node.children?.find((child) => child.tagName === 'code');
  // Satteri retains internal CRLF in multi-line code; the HTML parser normalizes
  // those newlines before rendering. Map logical lines, not raw carriage returns.
  const content = code ? textOf(code).replace(/\r\n?/g, '\n').replace(/\n$/, '') : '';
  if (!opener || !run) return { start, end, isGallery, unterminated: false, kind: 'code', content, lines: [], contentStart: start, contentEnd: end, prefix: '', newline: '\n' };
  const values = content === '' ? [] : content.split('\n');
  const last = rows.at(-1);
  // This is only closure provenance for an ALREADY PARSED code node. It cannot
  // admit/reject gallery identity; the sanitized pre/code predicate does that.
  const closing = last && last !== opener && new RegExp(`^[ >\\t]*${run[0] === '`' ? '`' : '~'}{${run.length},}[ \\t]*$`).test(last.text) && rows.length - 2 >= values.length;
  const contentRows = rows.slice(1, closing ? -1 : undefined);
  const lines = values.map((value, index) => {
    const row = contentRows[index];
    if (!row) return fail();
    return mapLine(value, row, false);
  });
  // Preserve explicit empty logical rows too, making an empty gallery editable.
  if (!values.length && contentRows.length) lines.push(mapLine('', contentRows[0]!, false));
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const openingPrefix = source.slice(lineStart, start);
  // List markers only occur on the opener; its content's continuation supplies
  // the authoritative prefix. For an empty list gallery use equal-width indent.
  const prefix = lines[0]?.prefix ?? openingPrefix.replace(/(?:[-+*]|\d+[.)])([ \t]+)$/u, (marker) => ' '.repeat(marker.length));
  const contentStart = lines[0]?.start ?? (closing && last ? last.start + prefix.length : opener.next);
  return { start, end, isGallery, unterminated: !closing, kind: 'fence', content, lines, contentStart, contentEnd: lines.at(-1)?.end ?? contentStart, prefix, newline: opener.newline || '\n' };
}

function decodedUnits(value: string, sourceAt: (offset: number) => Unit): Unit[] {
  const result: Unit[] = [];
  let decoded = '';
  const decoder = new EntityDecoder(htmlDecodeTree, (point) => { decoded += String.fromCodePoint(point); });
  for (let i = 0; i < value.length;) {
    let count = 1;
    decoded = value[i] ?? '';
    if (value[i] === '&') {
      decoded = '';
      decoder.startEntity(DecodingMode.Legacy);
      count = decoder.write(value, i + 1);
      if (count < 0) count = decoder.end();
      if (count <= 0) { count = 1; decoded = '&'; }
    } else if (value[i] === '\r') {
      count = value[i + 1] === '\n' ? 2 : 1; decoded = '\n';
    } else if (value[i] === '\0') decoded = '\uFFFD';
    const first = sourceAt(i);
    const last = sourceAt(i + count - 1);
    const previous = result.at(-1);
    if (previous && previous.start === first.start && previous.end === last.end) previous.value += decoded;
    else result.push({ start: first.start, end: last.end, value: decoded });
    i += count;
  }
  return result;
}

export async function analyzeGallerySource(bodyMarkdown: string): Promise<GalleryAnalysis> {
  const offsets = sourceOffsets(bodyMarkdown);
  const tree = markdownToHast(bodyMarkdown, { features: MARKDOWN_FEATURES }) as SourceNode;
  const mapped = mappedHtml(tree, bodyMarkdown, offsets);
  const rendered = sanitizedBodyTree(mapped.html);
  const blocks: GalleryBlock[] = [];
  const codeByStart = new Map(mapped.code.map((region) => [region.start, region]));
  const sourceAt = (offset: number): Unit => {
    let low = 0;
    let high = mapped.raw.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const region = mapped.raw[mid]!;
      if (offset < region.start) high = mid - 1;
      else if (offset >= region.end) low = mid + 1;
      else {
        region.units ??= region.resolve();
        return region.units[offset - region.start] ?? fail();
      }
    }
    return fail();
  };
  const sourceEnd = (offset: number): number => {
    let low = 0;
    let high = mapped.raw.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (mapped.raw[mid]!.start < offset) low = mid + 1;
      else high = mid;
    }
    const region = mapped.raw[low - 1];
    if (!region) return fail();
    return sourceAt(Math.min(offset, region.end) - 1).end;
  };
  visit(rendered, 'element', (pre) => {
    if (pre.tagName !== 'pre') return;
    const code = galleryCode(pre);
    const start = pre.position?.start.offset;
    const end = pre.position?.end.offset;
    if (start === undefined || end === undefined) return fail();
    const generated = codeByStart.get(start);
    if (generated && generated.end === end) {
      const range = mapped.bounds(generated.node);
      blocks.push(fenceBlock(generated.node, bodyMarkdown, range.start, range.end, code !== null));
      return SKIP;
    }
    const rangeStart = sourceAt(start).start;
    const rangeEnd = sourceEnd(end);
    const closed = /<\/pre[\t\n\f\r ]*>$/iu.test(mapped.html.slice(start, end));
    if (!code) {
      blocks.push({ start: rangeStart, end: rangeEnd, isGallery: false, unterminated: !closed,
        kind: 'html', content: textOf(pre), lines: [], contentStart: rangeStart,
        contentEnd: rangeEnd, prefix: '', newline: '\n' });
      return;
    }
    const units: Unit[] = [];
    visit(code, 'text', (node) => {
      const from = node.position?.start.offset;
      const to = node.position?.end.offset;
      if (from === undefined || to === undefined) return fail();
      const decoded = decodedUnits(mapped.html.slice(from, to), (offset) => sourceAt(from + offset));
      if (decoded.map((unit) => unit.value).join('') !== node.value) return fail();
      for (const unit of decoded) units.push(unit);
    });
    const content = textOf(code);
    const lines: GalleryLine[] = [];
    // An empty code element still has an explicit insertion point after its
    // opening tag; use the HTML parser's element range, never a global match.
    const codeStart = code.position?.start.offset;
    if (codeStart === undefined) return fail();
    let tagEnd = codeStart;
    let quote = '';
    for (; tagEnd < mapped.html.length; tagEnd++) {
      const char = mapped.html[tagEnd];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    const contentStart = units[0]?.start ?? sourceAt(tagEnd).end;
    let current: GalleryLine = { text: '', start: contentStart, end: contentStart, prefix: '', newline: '\n', html: true, spans: [] };
    for (const unit of units) {
      if (unit.value === '\n') {
        current.newline = bodyMarkdown.slice(unit.start, unit.end).includes('\r\n') ? '\r\n' : '\n';
        lines.push(current);
        current = { text: '', start: unit.end, end: unit.end, prefix: '', newline: current.newline, html: true, spans: [] };
      } else {
        if (!current.text) current.start = unit.start;
        appendSpan(current.spans, { start: unit.start, end: unit.end, from: current.text.length, to: current.text.length + unit.value.length });
        current.text += unit.value; current.end = unit.end;
      }
    }
    if (current.text || !lines.length) lines.push(current);
    // This adapter only recovers continuation bytes before an already mapped
    // raw HTML gallery; it never admits or rejects a gallery. Inline raw HTML
    // can follow prose, so stop at the first non-container byte.
    const openingLine = bodyMarkdown.lastIndexOf('\n', rangeStart - 1) + 1;
    const before = bodyMarkdown.slice(openingLine, rangeStart);
    const container = before.match(/^(?:(?:[ \t]*>[ \t]?)|(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+)|[ \t]+)*/u)?.[0] ?? '';
    const continuation = container.replace(/(?:[-+*]|\d+[.)])[ \t]+/gu, (marker) => ' '.repeat(marker.length));
    for (const line of lines) {
      const physicalStart = bodyMarkdown.lastIndexOf('\n', line.start - 1) + 1;
      const prefix = bodyMarkdown.slice(physicalStart, line.start);
      // Only Markdown container bytes preceding this raw HTML source node are
      // a continuation prefix; HTML tags remain outside editable text spans.
      line.prefix = /^[ >\t]*$/u.test(prefix) ? prefix : continuation;
    }
    const codeEnd = code.position?.end.offset;
    const codeClosed = codeEnd !== undefined && /<\/code[\t\n\f\r ]*>$/iu.test(mapped.html.slice(codeStart, codeEnd));
    blocks.push({ start: rangeStart, end: rangeEnd, isGallery: true, unterminated: !closed || !codeClosed, kind: 'html', content: content.replace(/\n$/, ''), lines, contentStart, contentEnd: lines.at(-1)?.end ?? contentStart, prefix: continuation, newline: lines[0]?.newline ?? '\n' });
    return SKIP;
  });
  blocks.sort((a, b) => a.start - b.start || b.end - a.end);
  const ancestors: GalleryBlock[] = [];
  for (const block of blocks) {
    while (ancestors.length && block.start >= ancestors.at(-1)!.end) ancestors.pop();
    const parent = ancestors.at(-1);
    // The renderer descends through nongallery HTML <pre> containers. Only
    // proper containment there is valid; crossing or duplicate ranges are not.
    if (parent && (parent.kind !== 'html' || parent.isGallery
      || block.start === parent.start || block.end > parent.end)) fail();
    ancestors.push(block);
  }
  for (const block of blocks) {
    let previousEnd = block.start;
    for (const line of block.lines) {
      let logical = 0;
      if (line.text.includes('\n')) fail();
      for (const span of line.spans) {
        if (span.start < previousEnd || span.end < span.start || span.end > block.end ||
          span.from !== logical || span.to < span.from) fail();
        previousEnd = span.end;
        logical = span.to;
      }
      if (logical !== line.text.length) fail();
    }
  }
  return { bodyMarkdown, blocks };
}
