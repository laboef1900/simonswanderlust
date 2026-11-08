import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { MarkdownManager } from '@tiptap/markdown';
import { decodeHTMLStrict } from 'entities';
import { Lexer } from 'marked';

/** Provenance belongs to a top-level ProseMirror node, not to rendered HTML.
 * Keeping the original spelling separately means an untouched block is never
 * passed through a Markdown serializer just because a neighbour was edited. */
interface OriginalBlock {
  before: string;
  raw: string;
  after: string;
  node: ProseMirrorNode;
  first: boolean;
  phantom?: boolean;
}

export interface SourceSpan {
  node: ProseMirrorNode;
  position: number;
  start: number;
  end: number;
  raw: string;
}

export interface SourceDocument { markdown: string; spans: SourceSpan[] }

type Token = { type: string; raw: string; [key: string]: unknown };
const knownTokens: Record<string, true> = {
  space: true, paragraph: true, text: true, heading: true, blockquote: true,
  list: true, list_item: true, checkbox: true, code: true, codespan: true,
  hr: true, strong: true, em: true, del: true, escape: true, br: true,
  link: true, image: true, table: true, taskList: true, taskItem: true,
};
const punctuation = /[!-/:-@[-`{-~]/;

/** Only conventional web, mail and telephone links can become active links. */
export function safeLink(href: string): boolean {
  const value = href.replace(/[\u0000-\u0020\u007f-\u009f\s]/g, '');
  if (!value) return false;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value);
  return !scheme || /^(https?|mailto|tel)$/i.test(scheme[1] ?? '');
}

export function safeImageUrl(src: string, imageOrigin: string, pageUrl: string): string | null {
  try {
    if (!src.trim()) return null;
    const url = new URL(src, pageUrl);
    const page = new URL(pageUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    if (url.origin !== imageOrigin && url.origin !== page.origin) return null;
    return url.href;
  } catch { return null; }
}

/** Marked gives ranges in newline-normalized input. This table maps every
 * normalized UTF-16 boundary back to the exact original spelling, including CRLF. */
function normalize(source: string): { text: string; boundary: number[] } {
  let text = '';
  const boundary = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\r') {
      if (source[i + 1] === '\n') i++;
      text += '\n';
    } else text += source[i];
    boundary.push(i + 1);
  }
  return { text, boundary };
}

function trailingLines(source: string): [string, string] {
  const match = /(?:\r\n|\r|\n)(?:[ \t]*(?:\r\n|\r|\n))*$/.exec(source);
  return match ? [source.slice(0, match.index), source.slice(match.index)] : [source, ''];
}

function children(value: unknown): Token[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(children);
  const object = value as Record<string, unknown>;
  const self = typeof object.type === 'string' && typeof object.raw === 'string' ? [object as Token] : [];
  // Table cells do not themselves have a type. Never recurse into the raw text
  // of a code token: Markdown/HTML inside a code fence is inert source text.
  if (object.type === 'code' || object.type === 'codespan') return self;
  return self.concat(['tokens', 'items', 'header', 'rows', 'nestedTokens'].flatMap((key) => children(object[key])));
}

export function hasGallery(token: Token): boolean {
  // Code contents are not traversed, but code nodes inside containers are.
  return children(token).some((part) => part.type === 'code' && typeof part.lang === 'string' && /^gallery(?:\s|$)/.test(part.lang));
}

/** Without a closing fence there is no source boundary for a following visual
 * paragraph. Keep the document in Markdown mode until the author closes it. */
function unterminatedFence(token: Token): boolean {
  return children(token).some((part) => {
    if (part.type !== 'code') return false;
    const lines = part.raw.split('\n');
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? '')?.[1];
    if (!opening) return false;
    return !lines.slice(1).some((line) => {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      return closing && closing[0] === opening[0] && closing.length >= opening.length;
    });
  });
}

function unsupported(token: Token): boolean {
  if (/^(?: {0,3}:::+| {0,3}\${2}(?:\s|$)| {0,3}\[[^\]]+\]:| {0,3}\[\^[^\]]+\]:)/m.test(token.raw)) return true;
  return children(token).some((part) => {
    if (!Object.hasOwn(knownTokens, part.type)) return true;
    if ((part.type === 'link' || part.type === 'image')) {
      if (typeof part.href !== 'string' || (part.type === 'link' && !safeLink(decodeHTMLStrict(part.href)))) return true;
      // Reference links depend on definitions elsewhere in the document. Parsing
      // them in isolation would silently turn them into ordinary text.
      if (part.raw.startsWith('[') || part.raw.startsWith('![')) {
        if (!/\]\s*\(/.test(part.raw)) return true;
      }
    }
    return part.type === 'text' && /(?:!?\[[^\]\n]+\]\[[^\]\n]*\]|\[\^[^\]\n]+\]|\[\[[^\]\n]+\]\])/.test(part.raw);
  });
}

/** Tiptap decodes only four named entities in prose. Convert the other valid
 * CommonMark names to numeric references before parsing, so they are decoded
 * as text without turning an encoded asterisk or bracket into Markdown syntax.
 * Code is literal. Protect lexer-established code spans; if a nested
 * container prevents mapping one safely, retain that whole block as source. */
function entitySource(raw: string, token: Token): string | null {
  const additional = (value: string) => {
    for (const match of value.matchAll(/&[A-Za-z][A-Za-z0-9]{1,31};/g)) {
      if (!/^&(amp|lt|gt|quot);$/.test(match[0]) && decodeHTMLStrict(match[0]) !== match[0]) return true;
    }
    return false;
  };
  const parts = children(token);
  const outside = parts.some((part) => {
    if (part.type === 'text' && (!Array.isArray(part.tokens) || !part.tokens.length)) return additional(part.raw);
    if (part.type === 'link' || part.type === 'image') {
      return additional(String(part.href ?? '')) || additional(String(part.title ?? ''))
        || (part.type === 'image' && additional(String(part.text ?? '')));
    }
    return false;
  });
  if (!outside) return raw;
  const protectedRanges: { start: number; end: number }[] = [];
  let codeCursor = 0;
  for (const part of parts) {
    if ((part.type !== 'code' && part.type !== 'codespan') || !additional(part.raw)) continue;
    const start = raw.indexOf(part.raw, codeCursor);
    if (start < 0) return null;
    protectedRanges.push({ start, end: start + part.raw.length });
    codeCursor = start + part.raw.length;
  }
  return raw.replace(/(\\*)&([A-Za-z][A-Za-z0-9]{1,31});/g, (match, slashes: string, name: string, offset: number) => {
    const at = offset + slashes.length;
    if (slashes.length % 2 || /^(amp|lt|gt|quot)$/.test(name)
      || protectedRanges.some((range) => at >= range.start && at < range.end)) return match;
    const entity = `&${name};`;
    const decoded = decodeHTMLStrict(entity);
    if (decoded === entity) return match;
    return slashes + [...decoded].map((character) => `&#${character.codePointAt(0)};`).join('');
  });
}

export class RichSource {
  private serial = 0;
  private readonly originals = new Map<string, OriginalBlock>();

  constructor(private readonly markdown: MarkdownManager) {}

  parse(source: string, nodeFromJSON: (node: JSONContent) => ProseMirrorNode): JSONContent {
    const { text, boundary } = normalize(source);
    const tokens = this.markdown.instance.lexer(text) as Token[];
    if (tokens.some(unterminatedFence)) throw new Error('Unterminated Markdown fence');
    const blocks: JSONContent[] = [];
    let cursor = 0;
    let pending = '';

    const add = (rawWithTail: string, token?: Token) => {
      const [raw, trailing] = trailingLines(rawWithTail);
      if (!raw && !token) { pending += trailing; return; }
      let content: JSONContent | undefined;
      const gallery = token && hasGallery(token);
      if (token && !gallery && !unsupported(token)) {
        try {
          const input = entitySource(raw, token);
          const parsed = input === null ? [] : this.markdown.parse(input).content ?? [];
          // Mixed task/ordinary lists may expand into several nodes. Preserve
          // such blocks as source rather than guessing which bytes belong where.
          if (parsed.length === 1 && parsed[0]) {
            const parsedNode = nodeFromJSON(parsed[0]);
            parsedNode.check();
            // The image extension is inline so images can live in prose.
            // Marked also returns a standalone image at document level; give
            // that inline node its required paragraph instead of an invalid root.
            content = parsedNode.isInline
              ? { type: 'paragraph', content: [parsed[0]] }
              : parsed[0];
          }
        } catch { /* Retain the exact original as a source atom. */ }
      }
      if (!content || !content.type) {
        const directGallery = token?.type === 'code' && gallery;
        content = { type: directGallery ? 'richGallery' : 'richSource', attrs: { raw, galleries: Boolean(gallery) } };
      }
      const key = String(++this.serial);
      content = { ...content, attrs: { ...content.attrs, sourceKey: key } };
      const node = nodeFromJSON(content);
      this.originals.set(key, { before: pending, raw, after: '', node, first: blocks.length === 0 });
      blocks.push(content);
      pending = trailing;
    };

    for (const token of tokens) {
      if (!token.raw) continue;
      const at = text.indexOf(token.raw, cursor);
      // Marked can suppress duplicate definitions. Preserve any omitted region
      // rather than trying to reconstruct it from the rendered document.
      if (at < cursor) break;
      if (at > cursor) {
        const gap = source.slice(boundary[cursor], boundary[at]);
        if (/\S/.test(gap)) add(gap); else pending += gap;
      }
      const end = at + token.raw.length;
      const raw = source.slice(boundary[at], boundary[end]);
      if (token.type === 'space') pending += raw;
      else add(raw, token);
      cursor = end;
    }
    if (cursor < text.length) {
      const rest = source.slice(boundary[cursor]);
      if (/\S/.test(rest)) add(rest); else pending += rest;
    }
    if (!blocks.length) {
      const key = String(++this.serial);
      const paragraph: JSONContent = { type: 'paragraph', attrs: { sourceKey: key } };
      this.originals.set(key, { before: pending, raw: '', after: '', first: true, node: nodeFromJSON(paragraph) });
      blocks.push(paragraph);
      pending = '';
    }
    const last = blocks[blocks.length - 1];
    const key = typeof last?.attrs?.sourceKey === 'string' ? last.attrs.sourceKey : '';
    const record = this.originals.get(key);
    if (record) record.after = pending;
    // An atom-only edge needs a genuine text cursor so typing cannot replace
    // the atom. Empty sentinels have no Markdown bytes until an author types.
    const withCursors: JSONContent[] = [];
    const atom = (block: JSONContent | undefined) => block?.type === 'richSource' || block?.type === 'richGallery';
    const sentinel = () => {
      const id = String(++this.serial);
      const paragraph: JSONContent = { type: 'paragraph', attrs: { sourceKey: id } };
      this.originals.set(id, {
        before: '', raw: '', after: '', first: false, phantom: true,
        node: nodeFromJSON(paragraph),
      });
      return paragraph;
    };
    blocks.forEach((block, index) => {
      if (atom(block) && (index === 0 || atom(blocks[index - 1]))) withCursors.push(sentinel());
      withCursors.push(block);
      if (atom(block) && index === blocks.length - 1) withCursors.push(sentinel());
    });
    return { type: 'doc', content: withCursors };
  }

  render(doc: ProseMirrorNode): SourceDocument {
    const spans: SourceSpan[] = [];
    const used = new Set<string>();
    let result = '';
    let last: OriginalBlock | undefined;
    let visible = 0;
    doc.forEach((node, position) => {
      const key = typeof node.attrs.sourceKey === 'string' ? node.attrs.sourceKey : '';
      const original = !used.has(key) ? this.originals.get(key) : undefined;
      if (original) used.add(key);
      const unchanged = original && node.eq(original.node);
      if (original?.phantom && unchanged) {
        spans.push({ node, position, start: result.length, end: result.length, raw: '' });
        return;
      }
      const before = visible === 0 ? (original?.first ? original.before : '')
        : original?.first ? '\n\n' + original.before : (original?.before || '\n\n');
      visible++;
      result += before;
      const start = result.length;
      let raw: string;
      if (unchanged) raw = original.raw;
      else if (node.type.name === 'richSource' || node.type.name === 'richGallery') raw = String(node.attrs.raw ?? '');
      else raw = this.markdown.serialize({ type: 'doc', content: [node.toJSON() as JSONContent] });
      result += raw;
      spans.push({ node, position, start, end: result.length, raw });
      last = original;
    });
    if (last) result += last.after;
    return { markdown: result, spans };
  }
}

interface CharacterMap { text: string; starts: number[]; ends: number[] }

/** Only lexer-recognized links have hidden destinations. Searching visible
 * prose must never match repeated words inside a URL or quoted link title. */
function linkMetadata(source: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const visit = (raw: string, tokens: Token[], offset: number) => {
    let cursor = 0;
    for (const token of tokens) {
      const start = raw.indexOf(token.raw, cursor);
      if (start < 0) continue;
      cursor = start + token.raw.length;
      if (token.type === 'link' && token.raw.startsWith('[')) {
        let depth = 1;
        let end = 1;
        for (; end < token.raw.length; end++) {
          if (token.raw[end] === '\\') { end++; continue; }
          if (token.raw[end] === '[') depth++;
          if (token.raw[end] === ']' && --depth === 0) break;
        }
        if (!depth) ranges.push({ start: offset + start + end, end: offset + cursor });
      } else if (Array.isArray(token.tokens)) {
        visit(token.raw, token.tokens as Token[], offset + start);
      }
    }
  };
  visit(source, Lexer.lexInline(source) as Token[], 0);
  return ranges;
}

/** Project escapes/entities to their displayed characters, retaining source
 * boundaries. Markdown punctuation remains searchable but never needs to be
 * guessed from a repeated word in a different block. */
function project(source: string, literal = false): CharacterMap {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  const hidden = literal ? [] : linkMetadata(source);
  let range = 0;
  for (let i = 0; i < source.length;) {
    while (hidden[range] && hidden[range]!.end <= i) range++;
    if (hidden[range] && i >= hidden[range]!.start) { i = hidden[range]!.end; continue; }
    const begin = i;
    let value = source[i] ?? '';
    if (!literal && value === '\\' && i + 1 < source.length && punctuation.test(source[i + 1] ?? '')) {
      value = source[i + 1] ?? ''; i += 2;
    } else if (!literal && value === '&') {
      const entity = /^&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(source.slice(i))?.[0];
      const decoded = entity ? decodeHTMLStrict(entity) : '';
      if (entity && decoded !== entity) { value = decoded; i += entity.length; } else i++;
    } else if (value === '\r') {
      if (source[i + 1] === '\n') i++;
      value = '\n'; i++;
    } else i++;
    text += value;
    for (let j = 0; j < value.length; j++) { starts.push(begin); ends.push(i); }
  }
  return { text, starts, ends };
}

interface Point { source: number; position: number }

/** Map an inline image as one atomic source span, including balanced URL
 * parentheses, escaped labels and optional quoted titles. */
function imageRange(raw: string, from: number): { start: number; end: number } | null {
  let start = raw.indexOf('![', from);
  while (start >= 0) {
    let depth = 1;
    let at = start + 2;
    while (at < raw.length && depth) {
      if (raw[at] === '\\') { at += 2; continue; }
      if (raw[at] === '[') depth++;
      if (raw[at] === ']') depth--;
      at++;
    }
    if (depth || raw[at] !== '(') { start = raw.indexOf('![', start + 2); continue; }
    depth = 1;
    let quote = '';
    for (at++; at < raw.length; at++) {
      const character = raw[at] ?? '';
      if (character === '\\') { at++; continue; }
      if (quote) { if (character === quote) quote = ''; continue; }
      if ((character === '"' || character === "'") && /\s/.test(raw[at - 1] ?? '')) { quote = character; continue; }
      if (character === '(') depth++;
      if (character === ')' && --depth === 0) return { start, end: at + 1 };
    }
    start = raw.indexOf('![', start + 2);
  }
  return null;
}

function points(span: SourceSpan): Point[] {
  let normal: CharacterMap | undefined;
  let literal: CharacterMap | undefined;
  const result: Point[] = [];
  const opener = span.node.type.name === 'codeBlock' ? /^[ \t]{0,3}(?:`{3,}|~{3,})[^\r\n]*(?:\r\n|\r|\n)/.exec(span.raw) : null;
  let cursor = opener?.[0].length ?? 0;
  span.node.descendants((node, relative, parent) => {
    const position = span.position + 1 + relative;
    if (node.isText && node.text) {
      const mapped = parent?.type.spec.code || node.marks.some((mark) => mark.type.spec.code)
        ? (literal ??= project(span.raw, true)) : (normal ??= project(span.raw));
      const first = mapped.starts.findIndex((start) => start >= cursor);
      let from = first < 0 ? mapped.text.length : first;
      const found = mapped.text.indexOf(node.text, from);
      if (found < 0) {
        // Soft line breaks can split a run; never search another block.
        for (let i = 0; i < node.text.length; i++) {
          const next = mapped.text.indexOf(node.text[i] ?? '', from);
          if (next < 0) continue;
          result.push({ source: span.start + (mapped.starts[next] ?? 0), position: position + i });
          result.push({ source: span.start + (mapped.ends[next] ?? 0), position: position + i + 1 });
          cursor = mapped.ends[next] ?? cursor;
          from = next + 1;
        }
      } else {
        for (let i = 0; i < node.text.length; i++) {
          result.push({ source: span.start + (mapped.starts[found + i] ?? 0), position: position + i });
          result.push({ source: span.start + (mapped.ends[found + i] ?? 0), position: position + i + 1 });
        }
        cursor = mapped.ends[found + node.text.length - 1] ?? cursor;
      }
    } else if (node.type.name === 'image') {
      const range = imageRange(span.raw, cursor);
      if (range) {
        result.push({ source: span.start + range.start, position });
        result.push({ source: span.start + range.end, position: position + node.nodeSize });
        cursor = range.end;
      }
    }
  });
  return result;
}

export function sourcePosition(document: SourceDocument, position: number): number {
  for (const span of document.spans) {
    const end = span.position + span.node.nodeSize;
    if (position < span.position || position > end) continue;
    if (span.node.isAtom) return position <= span.position ? span.start : span.end;
    const matches = points(span).filter((point) => point.position === position);
    // At the end of a marked run choose the boundary before its closing
    // punctuation; at the beginning choose the boundary after its opening.
    if (matches.length) return matches[0]!.source;
    if (position <= span.position + 1) return span.start;
    if (position >= end - 1) return span.end;
    return span.start;
  }
  return position <= 0 ? 0 : document.markdown.length;
}

export function editorPosition(document: SourceDocument, source: number, doc: ProseMirrorNode): number {
  const offset = Math.max(0, Math.min(document.markdown.length, source));
  let best: Point | undefined;
  let distance = Infinity;
  for (const span of document.spans) {
    const candidates = span.node.isAtom
      ? [{ source: span.start, position: span.position }, { source: span.end, position: span.position + span.node.nodeSize }]
      : [
        { source: span.start, position: span.position + 1 },
        ...(offset >= span.start && offset <= span.end ? points(span) : []),
        { source: span.end, position: span.position + span.node.nodeSize - 1 },
      ];
    for (const point of candidates) {
      const delta = Math.abs(point.source - offset);
      if (delta < distance || (delta === distance && point.source <= offset && (best?.source ?? Infinity) > offset)) {
        best = point; distance = delta;
      }
    }
  }
  return Math.max(0, Math.min(doc.content.size, best?.position ?? 0));
}
