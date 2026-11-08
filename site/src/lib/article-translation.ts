import { markdownToHast, markdownToMdast, type Position } from 'satteri';
import { decodeHTMLStrict } from 'entities';
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import type { Element, Root } from 'hast';
import { MARKDOWN_FEATURES } from './markdown-features.js';
import { galleryCode, sanitizedBodyTree } from './gallery-identity.js';
import { analyzeRenderedBody, type ImageDims } from './body-images.js';
import {
  analyzeGallerySource, positionedText, rawUnits,
  type GalleryAnalysis, type GalleryLine, type SourceContainer, type Unit,
} from './gallery-source.js';
import { escapeMeta, parsePhotoLine, unescapeMeta, MAX_GALLERY_TEXT } from '../../../uploader/public/gallery-photo-line.js';
import { applyGalleryEdits, galleryLineEdits } from '../../../uploader/public/gallery-source-edits.js';

export type TranslationErrorCode = 'translation_invalid_input' | 'translation_input_limit'
  | 'translation_unsupported_source' | 'translation_invalid_output' | 'translation_structure_mismatch';

/** Source, provider output and parser exceptions never become public error text. */
export class TranslationError extends Error {
  constructor(readonly code: TranslationErrorCode) {
    super(code);
    this.name = 'TranslationError';
  }
}

interface ArticleSource { title: string; excerpt: string; bodyMarkdown: string; images: Record<string, ImageDims> }
interface TranslationInput { sourceLocale: 'de' | 'en'; targetLocale: 'de' | 'en'; source: ArticleSource }
interface TextSlot { id: string; text: string }
interface Range { start: number; end: number }
interface Edit extends Range { text: string }
interface SourceNode {
  type: string; position?: Position; children?: SourceNode[]; value?: string;
  tagName?: string; properties?: Record<string, unknown>; data?: unknown;
  url?: string; title?: string | null; alt?: string | null; identifier?: string; referenceType?: string;
  [key: string]: unknown;
}
interface ParsedSource { mdast: SourceNode; rendered: SourceNode; html: string }
interface Binding extends TextSlot {
  limit: number;
  target: 'title' | 'excerpt' | { src: string; field: 'alt' | 'caption' } | ((text: string) => Edit[]);
}
interface Plan {
  source: ArticleSource; slots: Binding[]; warnings: string[];
  images: Record<string, ImageDims>; fingerprint: string;
}

const LIMITS = { body: 100_000, title: 1000, excerpt: 4000, images: 2000, slots: 2000, inputText: 100_000, outputText: 300_000, prose: 12_000 };
const forbiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const unpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const htmlParser = unified().use(rehypeParse, { fragment: true });
const htmlWriter = unified().use(rehypeStringify, { allowDangerousHtml: true });
const fail = (code: TranslationErrorCode): never => { throw new TranslationError(code); };
const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end;
const own = (object: object, key: PropertyKey) => Object.hasOwn(object, key);

function record(value: unknown, code: TranslationErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(code);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) return fail(code);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: string[], optional: string[], code: TranslationErrorCode) {
  if (required.some((key) => !own(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) fail(code);
}

function text(value: unknown, max: number, code: TranslationErrorCode, limitCode = code): string {
  if (typeof value !== 'string' || forbiddenControls.test(value) || unpairedSurrogate.test(value)) return fail(code);
  if (value.length > max) return fail(limitCode);
  return value;
}

function inputOf(input: unknown): TranslationInput {
  const code = 'translation_invalid_input';
  const value = record(input, code);
  keys(value, ['sourceLocale', 'targetLocale', 'source'], [], code);
  if ((value.sourceLocale !== 'de' && value.sourceLocale !== 'en')
    || (value.targetLocale !== 'de' && value.targetLocale !== 'en') || value.sourceLocale === value.targetLocale) fail(code);
  const source = record(value.source, code);
  keys(source, ['title', 'excerpt', 'bodyMarkdown', 'images'], [], code);
  const title = text(source.title, LIMITS.title, code, 'translation_input_limit');
  const excerpt = text(source.excerpt, LIMITS.excerpt, code, 'translation_input_limit');
  const bodyMarkdown = text(source.bodyMarkdown, LIMITS.body, code, 'translation_input_limit');
  const entries = record(source.images, code);
  if (Object.keys(entries).length > LIMITS.images) fail('translation_input_limit');
  const images: Record<string, ImageDims> = {};
  for (const [src, entry] of Object.entries(entries)) {
    if (['__proto__', 'constructor', 'prototype'].includes(src) || forbiddenControls.test(src) || unpairedSurrogate.test(src)) fail(code);
    const meta = record(entry, code);
    keys(meta, ['width', 'height'], ['alt', 'caption', 'format'], code);
    if (!Number.isSafeInteger(meta.width) || Number(meta.width) <= 0 || !Number.isSafeInteger(meta.height) || Number(meta.height) <= 0) fail(code);
    if (own(meta, 'format') && meta.format !== 'jpeg') fail(code);
    images[src] = {
      width: meta.width as number, height: meta.height as number,
      ...(own(meta, 'alt') ? { alt: text(meta.alt, MAX_GALLERY_TEXT, code, 'translation_input_limit') } : {}),
      ...(own(meta, 'caption') ? { caption: text(meta.caption, MAX_GALLERY_TEXT, code, 'translation_input_limit') } : {}),
      ...(meta.format === 'jpeg' ? { format: meta.format } : {}),
    };
  }
  return { sourceLocale: value.sourceLocale as 'de' | 'en', targetLocale: value.targetLocale as 'de' | 'en', source: { title, excerpt, bodyMarkdown, images } };
}

function bounds(node: SourceNode, source: string): Range {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || !Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || end < start || end > source.length) return fail('translation_unsupported_source');
  return { start, end };
}

function walk(node: SourceNode, visit: (node: SourceNode) => void) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function canonical(source: string): ParsedSource {
  const mdast = markdownToMdast(source, { features: MARKDOWN_FEATURES }) as SourceNode;
  const hast = markdownToHast(source, { features: MARKDOWN_FEATURES });
  const html = htmlWriter.stringify(hast as Root);
  return { mdast, rendered: sanitizedBodyTree(html) as SourceNode, html };
}

/** Remove only textual values, not node types, properties, reference IDs or URLs.
 * Exact untouched source bytes are retained by bounded source edits; these two
 * trees additionally detect changes in Markdown and HTML interpretation. */
function treeShape(node: SourceNode, html: boolean, galleryText = false): unknown {
  const inGallery = galleryText || (html && node.type === 'element' && galleryCode(node as unknown as Element) !== null);
  const shape: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'position' || key === 'children' || key === 'value') continue;
    if (!html && ((node.type === 'image' || node.type === 'imageReference') && (key === 'alt' || key === 'title'))) {
      shape[key] = value === null ? null : ''; continue;
    }
    if (html && node.tagName === 'img' && key === 'properties') {
      const properties = { ...node.properties };
      if (own(properties, 'alt')) properties.alt = '';
      if (own(properties, 'title')) properties.title = '';
      shape.properties = properties;
    } else shape[key] = value;
  }
  // A raw-HTML photo attribute can span several text nodes. Source edits retain
  // every intervening tag, while the analyzer owns the concatenated photo text.
  if (node.children) shape.children = node.children.filter((child) => !inGallery || child.type !== 'text')
    .map((child) => treeShape(child, html, inGallery));
  return shape;
}

function galleryShape(analysis: GalleryAnalysis): unknown {
  return analysis.blocks.map((block, index) => ({
    kind: block.kind, isGallery: block.isGallery, unterminated: block.unterminated,
    parent: analysis.blocks.findIndex((other, parent) => parent < index && other.start < block.start && other.end >= block.end),
    lines: block.isGallery ? block.lines.map((line) => {
      if (!line.text.trim() || line.text.trimStart().startsWith('#')) return line.text;
      const photo = parsePhotoLine(line.text);
      if (!photo.valid) return line.text;
      const edits = photo.fields.filter((field) => ['alt', 'caption', 'caption-override'].includes(field.name))
        .map((field) => ({ start: field.start + field.name.length + 2, end: field.end - 1, text: '' }));
      return applyGalleryEdits(line.text, edits);
    }) : undefined,
  }));
}

function fingerprint(parsed: ParsedSource, galleries: GalleryAnalysis): string {
  return JSON.stringify([treeShape(parsed.mdast, false), treeShape(parsed.rendered, true), galleryShape(galleries)]);
}

/** Entities cannot create delimiters, HTML, list markers, table cells or smart
 * punctuation. GFM can autolink decoded text anyway: the structural fingerprint
 * deliberately refuses that output rather than changing text or allowing links. */
function escapeProse(value: string): string {
  return value.replace(/[!-/:-@[-`{-~\t\r\n]|^\s+|\s+$/gu, (part) => Array.from(part, (char) => `&#${char.codePointAt(0)};`).join(''));
}

function unitLine(units: Unit[], value: string, source: string, prefix = ''): GalleryLine {
  if (!units.length || units.map((unit) => unit.value).join('') !== value) return fail('translation_unsupported_source');
  let at = 0;
  const spans: GalleryLine['spans'] = [];
  for (const unit of units) {
    const span = { start: unit.start, end: unit.end, from: at, to: at + unit.value.length };
    const previous = spans.at(-1);
    if (previous && previous.end === span.start && previous.to === span.from
      && previous.end - previous.start === previous.to - previous.from
      && span.end - span.start === span.to - span.from) {
      previous.end = span.end;
      previous.to = span.to;
    } else spans.push(span);
    at = span.to;
  }
  return { text: value, start: units[0]!.start, end: units.at(-1)!.end, prefix, newline: source.includes('\r\n') ? '\r\n' : '\n', html: false, spans };
}

/** Project parser-proven logical offsets; never search for a matching string. */
function sliceLine(line: GalleryLine, from: number, to: number): GalleryLine {
  const spans = line.spans.filter((span) => span.to > from && span.from < to).map((span) => {
    const left = Math.max(from, span.from);
    const right = Math.min(to, span.to);
    const direct = span.end - span.start === span.to - span.from;
    if (!direct && (left !== span.from || right !== span.to)) return fail('translation_unsupported_source');
    return { start: direct ? span.start + left - span.from : span.start, end: direct ? span.end - span.to + right : span.end, from: left - from, to: right - from };
  });
  if (to <= from || !spans.length) return fail('translation_unsupported_source');
  return { ...line, text: line.text.slice(from, to), start: spans[0]!.start, end: spans.at(-1)!.end, spans };
}

function fragmentLinks(parsed: ParsedSource): boolean {
  let found = false;
  walk(parsed.mdast, (node) => { if ((node.type === 'link' || node.type === 'definition') && node.url?.startsWith('#')) found = true; });
  walk(parsed.rendered, (node) => { if (node.tagName === 'a' && typeof node.properties?.href === 'string' && node.properties.href.startsWith('#')) found = true; });
  return found;
}

/** The same installed parser recognizes otherwise-disabled author syntax solely
 * to protect it. This does not enable an extension in production or serialize it. */
function opaqueExtensions(source: string): Range[] {
  const tree = markdownToMdast(source, { features: {
    ...MARKDOWN_FEATURES, math: true, directive: true, wikilinks: true,
    headingAttributes: true, definitionList: true, superscript: true, subscript: true,
  } }) as SourceNode;
  const ranges: Range[] = [];
  walk(tree, (node) => {
    if (['math', 'inlineMath', 'containerDirective', 'leafDirective', 'textDirective', 'wikiLink', 'wikilink',
      'descriptionList', 'superscript', 'subscript'].includes(node.type) || (node.type === 'heading' && node.data)) ranges.push(bounds(node, source));
  });
  return ranges;
}

/** An unsupported component can be raw-open / Markdown children / raw-close,
 * rather than one HTML block. Keep that whole parser-owned occurrence opaque.
 * An unclosed occurrence conservatively owns the remainder of its container. */
function opaqueBodyImages(tree: SourceNode, source: string): Range[] {
  const ranges: Range[] = [];
  walk(tree, (parent) => {
    const openings: Range[] = [];
    for (const node of parent.children ?? []) {
      if (node.type !== 'html') continue;
      const raw = node.value ?? '';
      if (/^<BodyImage(?=[\s/>])/iu.test(raw) && !imageAttributes(raw, 0)) {
        const range = bounds(node, source);
        if (/<\/BodyImage\s*>\s*$/iu.test(raw)) ranges.push(range);
        else openings.push(range);
      } else if (/^<\/BodyImage\s*>\s*$/iu.test(raw) && openings.length) {
        ranges.push({ start: openings.pop()!.start, end: bounds(node, source).end });
      }
    }
    if (openings.length) ranges.push({ start: openings[0]!.start, end: bounds(parent, source).end });
  });
  return ranges;
}

function labelEnd(source: string, from: number, to: number): number {
  if (source[from] !== '[') return fail('translation_unsupported_source');
  let depth = 1;
  for (let at = from + 1; at < to; at++) {
    if (source[at] === '\\') { at++; continue; }
    if (source[at] === '`') {
      let end = at + 1;
      while (source[end] === '`') end++;
      const run = source.slice(at, end);
      const closing = source.indexOf(run, end);
      if (closing >= 0 && closing < to) { at = closing + run.length - 1; continue; }
    }
    if (source[at] === '[') depth++;
    if (source[at] === ']' && --depth === 0) return at;
  }
  return fail('translation_unsupported_source');
}

function markdownTitle(source: string, range: Range, value: string): Range {
  let end = range.end - 1;
  if (source[end] !== ')') return fail('translation_unsupported_source');
  while (end > range.start && /\s/u.test(source[end - 1]!)) end--;
  const closer = source[--end];
  const opener = closer === ')' ? '(' : closer;
  if (opener !== '(' && opener !== '"' && opener !== "'") return fail('translation_unsupported_source');
  for (let at = end - 1; at > range.start; at--) {
    if (source[at] !== opener) continue;
    let slash = at - 1;
    while (source[slash] === '\\') slash--;
    if ((at - slash - 1) % 2) continue;
    const decoded = decodeHTMLStrict(source.slice(at + 1, end).replace(/\\([!-/:-@[-`{-~])/gu, '$1'));
    if (decoded === value) return { start: at + 1, end };
  }
  return fail('translation_unsupported_source');
}

interface Attribute extends Range { name: string; value: string; quote: string }
function imageAttributes(value: string, start: number): { end: number; bodyImage: boolean; attributes: Attribute[] } | null {
  const name = /^<(img|BodyImage)\b/iu.exec(value.slice(start));
  if (!name) return null;
  const bodyImage = name[1] === 'BodyImage';
  if (name[1]?.toLowerCase() === 'bodyimage' && !bodyImage) return null;
  const attributes: Attribute[] = [];
  let at = start + name[0].length;
  const attr = /\s+([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}|([^\s"'=<>`]+)))?/y;
  while (at < value.length) {
    const close = /^\s*(\/?)>/.exec(value.slice(at));
    if (close) return bodyImage && close[1] !== '/' ? null : { end: at + close[0].length, bodyImage, attributes };
    attr.lastIndex = at;
    const match = attr.exec(value);
    if (!match) return null;
    const raw = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (raw !== undefined) {
      const quote = match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : match[4] !== undefined ? '{' : '';
      const finish = attr.lastIndex - (quote ? 1 : 0);
      attributes.push({ name: match[1]!.toLowerCase(), value: raw, quote, start: finish - raw.length, end: finish });
    }
    at = attr.lastIndex;
  }
  return null;
}

async function createPlan(input: TranslationInput): Promise<Plan> {
  const source = input.source;
  const body = source.bodyMarkdown;
  const warnings = new Set<string>();
  const slots: Binding[] = [];
  let total = 0;
  const provenance: Edit[] = [];
  const add = (value: string, limit: number, target: Binding['target']) => {
    if (!value.trim()) return;
    text(value, limit === MAX_GALLERY_TEXT ? MAX_GALLERY_TEXT : Number.MAX_SAFE_INTEGER, 'translation_invalid_input', 'translation_input_limit');
    total += value.length;
    if (slots.length >= LIMITS.slots || total > LIMITS.inputText) fail('translation_input_limit');
    slots.push({ id: `s${slots.length.toString(36).padStart(4, '0')}`, text: value, limit, target });
    if (typeof target === 'function') provenance.push(...target(value === 'Translation' ? 'Übersetzung' : 'Translation'));
  };
  add(source.title, LIMITS.title, 'title');
  add(source.excerpt, LIMITS.excerpt, 'excerpt');
  const parsed = canonical(body);
  const galleries = await analyzeGallerySource(body);
  const protectedRanges = [...opaqueExtensions(body), ...opaqueBodyImages(parsed.mdast, body)];
  if (protectedRanges.length) warnings.add('opaque-source-retained');
  const retainedHeadings = fragmentLinks(parsed);
  const references = new Set(analyzeRenderedBody(parsed.html).sources);
  const definitions = new Map<string, SourceNode>();
  walk(parsed.mdast, (node) => { if (node.type === 'definition' && node.identifier && !definitions.has(node.identifier)) definitions.set(node.identifier, node); });

  for (const block of galleries.blocks) {
    if (!block.isGallery) { warnings.add('opaque-source-retained'); continue; }
    warnings.add('library-metadata-authoritative');
    if (block.unterminated || (block.content && !block.lines.length)) fail('translation_unsupported_source');
    for (const line of block.lines) {
      if (!line.text.trim() || line.text.trimStart().startsWith('#')) continue;
      const photo = parsePhotoLine(line.text);
      if (photo.src) references.add(photo.src);
      if (!photo.valid) { warnings.add('opaque-source-retained'); continue; }
      for (const field of photo.fields) {
        if (field.name !== 'alt' && field.name !== 'caption' && field.name !== 'caption-override') continue;
        const from = field.start + field.name.length + 2;
        const to = field.end - 1;
        const value = unescapeMeta(line.text.slice(from, to));
        text(value, MAX_GALLERY_TEXT, 'translation_invalid_input', 'translation_input_limit');
        if (!value.trim()) continue;
        const span = sliceLine(line, from, to);
        add(value, MAX_GALLERY_TEXT, (translated) => translated === value ? [] : galleryLineEdits(span, escapeMeta(translated)));
      }
    }
  }

  const isProtected = (range: Range) => protectedRanges.some((other) => overlaps(range, other))
    || galleries.blocks.some((other) => overlaps(range, other));

  const prose = (node: SourceNode, containers: SourceContainer[]) => {
    const range = bounds(node, body);
    // MDAST retains CRLF in text values; the shared HAST provenance mapper
    // consumes logical LF and keeps the original physical newline span.
    const units = positionedText((node.value ?? '').replace(/\r\n?/gu, '\n'), body, range.start, range.end, containers);
    let run: Unit[] = [];
    const flush = () => {
      if (!run.length) return;
      const value = run.map((unit) => unit.value).join('');
      if (value.trim()) {
        const line = unitLine(run, value, body);
        const from = value.length - value.trimStart().length;
        const to = value.trimEnd().length;
        const span = sliceLine(line, from, to);
        const original = value.slice(from, to);
        add(original, LIMITS.prose, (translated) => translated === original ? [] : galleryLineEdits(span, escapeProse(translated)));
      }
      run = [];
    };
    for (const unit of units) {
      if (unit.value.includes('\n') || isProtected(unit)) { flush(); continue; }
      run.push(unit);
    }
    flush();
  };

  const rawImages = (node: SourceNode) => {
    const range = bounds(node, body);
    const raw = (node.value ?? '').replace(/\r\n?/gu, '\n');
    const rawTree = htmlParser.parse(raw) as SourceNode;
    let line: GalleryLine | undefined;
    let supported = false;
    walk(rawTree, (element) => {
      if (element.tagName !== 'img' && element.tagName !== 'bodyimage') return;
      const offset = element.position?.start.offset;
      if (offset === undefined) return fail('translation_unsupported_source');
      const image = imageAttributes(raw, offset);
      if (!image) { warnings.add('opaque-source-retained'); return; }
      const src = image.attributes.find((attribute) => attribute.name === 'src');
      const format = image.attributes.find((attribute) => attribute.name === 'format' && (attribute.quote === '"' || attribute.quote === '{'));
      const sourceUrl = src ? (image.bodyImage ? (src.quote === '{' ? src.value.trim() : src.value) : decodeHTMLStrict(src.value)) : '';
      if (image.bodyImage && (!src || !sourceUrl || (src.quote !== '"' && src.quote !== '{')
        || (format && (format.quote === '{' ? format.value.trim() : format.value) !== 'jpeg'))) {
        warnings.add('opaque-source-retained'); return;
      }
      line ??= unitLine(rawUnits(raw, body, range.start, range.end), raw, body,
        (body.slice(body.lastIndexOf('\n', range.start - 1) + 1, range.start)
          .match(/^(?:(?:[ \t]*>[ \t]?)|(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+)|[ \t]+)*/u)?.[0] ?? '')
          .replace(/(?:[-+*]|\d+[.)])[ \t]+/gu, (marker) => ' '.repeat(marker.length)));
      const opening = sliceLine(line, offset, image.end);
      if (isProtected(opening)) return;
      supported = true;
      if (sourceUrl) references.add(sourceUrl);
      const seen = new Set<string>();
      for (const attribute of image.attributes) {
        if (attribute.name !== 'alt' && attribute.name !== 'title') continue;
        if (seen.has(attribute.name) || (attribute.quote !== '"' && attribute.quote !== "'")
          || (image.bodyImage && attribute.quote !== '"')) { warnings.add('opaque-source-retained'); continue; }
        seen.add(attribute.name);
        const value = image.bodyImage
          ? decodeHTMLStrict(attribute.value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
          : decodeHTMLStrict(attribute.value);
        text(value, MAX_GALLERY_TEXT, 'translation_invalid_input', 'translation_input_limit');
        if (!value.trim()) continue;
        const span = sliceLine(line, attribute.start, attribute.end);
        add(value, MAX_GALLERY_TEXT, (translated) => {
          if (translated === value) return [];
          // BodyImage is HTML-decoded into a Markdown label on Save. Carry
          // escaped plain text through BOTH boundaries, including newlines.
          const content = image.bodyImage ? escapeProse(translated) : translated;
          const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, attribute.quote === "'" ? '&#39;' : "'");
          return galleryLineEdits(span, escaped);
        });
      }
    });
    // Raw wrappers/text are retained even when supported images occur inside.
    if (!supported || raw.replace(/<(?:img|BodyImage)\b(?:"[^"]*"|'[^']*'|[^'">])*>/giu, '').trim()) warnings.add('opaque-source-retained');
  };

  const visit = (node: SourceNode, containers: SourceContainer[] = []) => {
    if (node.type !== 'root') {
      const range = bounds(node, body);
      if (protectedRanges.some((other) => other.start <= range.start && other.end >= range.end)) return;
      if (galleries.blocks.some((other) => other.start <= range.start && other.end >= range.end)) return;
    }
    if (node.type === 'heading' && retainedHeadings) { warnings.add('headings-retained-for-fragments'); return; }
    if (node.type === 'text') { prose(node, containers); return; }
    if (node.type === 'html') { rawImages(node); return; }
    if (node.type === 'image' || node.type === 'imageReference') {
      const range = bounds(node, body);
      const definition = node.identifier ? definitions.get(node.identifier) : undefined;
      const src = node.url ?? definition?.url;
      if (src) references.add(src);
      if (node.type === 'imageReference' && node.referenceType !== 'full') { warnings.add('opaque-source-retained'); return; }
      if (body.slice(range.start, range.start + 2) !== '![') return fail('translation_unsupported_source');
      const end = labelEnd(body, range.start + 1, range.end);
      const value = node.alt ?? '';
      text(value, MAX_GALLERY_TEXT, 'translation_invalid_input', 'translation_input_limit');
      add(value, MAX_GALLERY_TEXT, (translated) => translated === value ? [] : [{ start: range.start + 2, end, text: escapeProse(translated) }]);
      if (node.type === 'image' && node.title) {
        text(node.title, MAX_GALLERY_TEXT, 'translation_invalid_input', 'translation_input_limit');
        const titleRange = markdownTitle(body, range, node.title);
        const title = node.title;
        add(title, MAX_GALLERY_TEXT, (translated) => translated === title ? [] : [{ ...titleRange, text: escapeProse(translated) }]);
      } else if (definition?.title) warnings.add('opaque-source-retained');
      return;
    }
    if (node.type === 'link' && body[bounds(node, body).start] !== '[') { warnings.add('opaque-source-retained'); return; }
    if (node.type === 'linkReference' && node.referenceType !== 'full') { warnings.add('opaque-source-retained'); return; }
    if (['definition', 'footnoteReference', 'break', 'thematicBreak'].includes(node.type)) return;
    if (!['root', 'paragraph', 'heading', 'emphasis', 'strong', 'delete', 'blockquote', 'list', 'listItem',
      'table', 'tableRow', 'tableCell', 'link', 'linkReference', 'footnoteDefinition'].includes(node.type)) {
      warnings.add('opaque-source-retained'); return;
    }
    let nested = containers;
    if (node.type === 'blockquote') nested = [...containers, { kind: 'quote' }];
    if (node.type === 'listItem') {
      const first = node.children?.find((child) => child.position)?.position;
      nested = [...containers, { kind: 'list', indent: Math.max(0, first && node.position ? first.start.column - node.position.start.column : 0) }];
    }
    for (const child of node.children ?? []) visit(child, nested);
  };
  visit(parsed.mdast);
  const images: Record<string, ImageDims> = {};
  for (const src of references) {
    if (!own(source.images, src)) continue;
    const meta = source.images[src]!;
    images[src] = { ...meta };
    if (meta.alt !== undefined) add(meta.alt, MAX_GALLERY_TEXT, { src, field: 'alt' });
    if (meta.caption !== undefined) add(meta.caption, MAX_GALLERY_TEXT, { src, field: 'caption' });
  }
  // Prove both disjoint provenance and unchanged interpretation before inference.
  // The validator repeats the same comparison with the actual translated text.
  const originalShape = fingerprint(parsed, galleries);
  if (provenance.length) {
    const neutral = applyGalleryEdits(body, provenance);
    if (fingerprint(canonical(neutral), await analyzeGallerySource(neutral)) !== originalShape) fail('translation_unsupported_source');
  }
  return { source, slots, warnings: [...warnings], images, fingerprint: originalShape };
}

async function planOf(input: unknown): Promise<Plan> {
  const source = inputOf(input);
  try { return await createPlan(source); }
  catch (error) {
    if (error instanceof TranslationError) throw error;
    return fail('translation_unsupported_source');
  }
}

export async function prepareTranslation(input: unknown): Promise<{ slots: TextSlot[]; warnings: string[] }> {
  const plan = await planOf(input);
  return { slots: plan.slots.map(({ id, text }) => ({ id, text })), warnings: plan.warnings };
}

export async function validateTranslation(input: unknown, output: unknown): Promise<ArticleSource> {
  const plan = await planOf(input);
  const code = 'translation_invalid_output';
  const result = record(output, code);
  keys(result, ['translations'], [], code);
  if (!Array.isArray(result.translations) || result.translations.length !== plan.slots.length) return fail(code);
  if (Reflect.ownKeys(result.translations).length !== result.translations.length + 1) return fail(code);
  const expected = new Map(plan.slots.map((slot) => [slot.id, slot]));
  const translated = new Map<string, string>();
  let total = 0;
  for (const entry of result.translations) {
    const item = record(entry, code);
    keys(item, ['id', 'text'], [], code);
    if (typeof item.id !== 'string' || !expected.has(item.id) || translated.has(item.id)) return fail(code);
    const value = text(item.text, expected.get(item.id)!.limit, code);
    if (!value.trim() || (total += value.length) > LIMITS.outputText) return fail(code);
    translated.set(item.id, value);
  }
  const patch: ArticleSource = { title: plan.source.title, excerpt: plan.source.excerpt, bodyMarkdown: plan.source.bodyMarkdown, images: plan.images };
  const edits: Edit[] = [];
  for (const slot of plan.slots) {
    const value = translated.get(slot.id);
    if (value === undefined) return fail(code);
    if (typeof slot.target === 'function') edits.push(...slot.target(value));
    else if (typeof slot.target === 'string') patch[slot.target] = value;
    else patch.images[slot.target.src]![slot.target.field] = value;
  }
  try {
    patch.bodyMarkdown = applyGalleryEdits(plan.source.bodyMarkdown, edits);
    const parsed = canonical(patch.bodyMarkdown);
    const galleries = await analyzeGallerySource(patch.bodyMarkdown);
    if (fingerprint(parsed, galleries) !== plan.fingerprint) fail('translation_structure_mismatch');
  } catch (error) {
    if (error instanceof TranslationError) throw error;
    return fail('translation_structure_mismatch');
  }
  return patch;
}
