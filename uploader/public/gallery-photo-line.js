/** One dependency-free metadata grammar for browser, save, export and render.
 * Gallery membership is supplied by the authoritative source analyzer, never
 * inferred here. Invalid input is atomic: no recognized metadata is exposed.
 */
/** @typedef {'dimensions'|'alt'|'caption'|'caption-override'|'format'|'unknown'} GalleryField */
/** @typedef {'unknown_field'|'malformed_field'|'invalid_dimensions'|'unsupported_format'} GalleryReason */
/** @typedef {{name: GalleryField|'empty', start: number, end: number}} PhotoField */
/** @typedef {{valid: true, raw: string, src: string, fields: PhotoField[], width?: number, height?: number, alt?: string, caption?: string, captionOverride?: string, format?: 'jpeg'}} PhotoRecord */
/** @typedef {{valid: false, raw: string, src: string, diagnostic: {field: GalleryField, reason: GalleryReason, offset: number}}} InvalidPhoto */
/** @typedef {{code: 'invalid_gallery_metadata', line: number, column: number, field: GalleryField, reason: GalleryReason}} GalleryDiagnostic */
/** @typedef {GalleryDiagnostic & {locale: 'de'|'en'}} GalleryWarning */

export const MAX_GALLERY_TEXT = 1000;

/** Escape ampersands first so literal entities survive the inverse.
 * @param {string} value */
export function escapeMeta(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/\r?\n/g, '&#10;');
}

/** @param {string} value */
export function unescapeMeta(value) {
  return String(value).replace(/&#10;/g, '\n').replace(/&#124;/g, '|')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Complete recognition precedes every consumer's mutation. Last recognized
 * duplicate wins, as before; empty fields remain ignored.
 * @param {string} raw
 * @returns {PhotoRecord | InvalidPhoto}
 */
export function parsePhotoLine(raw) {
  const separator = raw.indexOf('|');
  const src = (separator < 0 ? raw : raw.slice(0, separator)).trim();
  /** @type {PhotoRecord} */
  const record = { valid: true, raw, src, fields: [] };
  if (separator < 0) return record;
  let at = separator + 1;
  while (at <= raw.length) {
    const next = raw.indexOf('|', at);
    const end = next < 0 ? raw.length : next;
    const part = raw.slice(at, end);
    const text = part.trim();
    const start = at + part.length - part.trimStart().length;
    if (text) {
      const dims = /^(\d{1,6})x(\d{1,6})$/.exec(text);
      const attr = /^(alt|caption|caption-override|format)="([^"]*)"$/.exec(text);
      /** @type {GalleryField} */
      let name = 'unknown';
      /** @type {GalleryReason | undefined} */
      let reason;
      if (dims) {
        name = 'dimensions';
        const width = Number(dims[1]);
        const height = Number(dims[2]);
        if (width <= 0 || height <= 0) reason = 'invalid_dimensions';
        else { record.width = width; record.height = height; }
      } else if (attr) {
        name = /** @type {GalleryField} */ (attr[1]);
        const value = unescapeMeta(attr[2] || '').slice(0, MAX_GALLERY_TEXT);
        if (name === 'alt') record.alt = value;
        else if (name === 'caption') record.caption = value;
        else if (name === 'caption-override') record.captionOverride = value;
        else if (value === 'jpeg') record.format = value;
        else reason = 'unsupported_format';
      } else {
        const known = /^(alt|caption-override|caption|format)(?=\s|=|$)/.exec(text);
        if (known) { name = /** @type {GalleryField} */ (known[1]); reason = 'malformed_field'; }
        else if (/^\d|^x\d/.test(text)) { name = 'dimensions'; reason = 'invalid_dimensions'; }
        else reason = 'unknown_field';
      }
      if (reason) return { valid: false, raw, src, diagnostic: { field: name, reason, offset: start } };
      record.fields.push({ name, start, end: start + text.length });
    } else record.fields.push({ name: 'empty', start: at, end });
    if (next < 0) break;
    at = next + 1;
  }
  return record;
}

/** An invalid suffix must not leak even a valid-looking earlier override.
 * @param {string} line */
export function readCaptionOverride(line) {
  const record = parsePhotoLine(line);
  return record.valid ? record.captionOverride : undefined;
}

/** Map logical offsets through #354 provenance, including raw HTML entities,
 * inline tags and container prefixes. Coordinates refer to submitted source,
 * never to normalized Markdown. Columns use editor-compatible UTF-16 offsets.
 * @param {import('../../site/src/lib/gallery-source.js').GalleryAnalysis} analysis
 * @returns {GalleryDiagnostic[]}
 */
export function galleryDiagnostics(analysis) {
  const starts = [0];
  const breaks = /\r\n|\r|\n/g;
  let match;
  while ((match = breaks.exec(analysis.bodyMarkdown))) starts.push(match.index + match[0].length);
  /** @type {GalleryDiagnostic[]} */
  const warnings = [];
  for (const block of analysis.blocks) {
    if (!block.isGallery) continue;
    for (const line of block.lines) {
      if (!line.text.trim() || line.text.trim().startsWith('#')) continue;
      const record = parsePhotoLine(line.text);
      if (record.valid) continue;
      const { offset, field, reason } = record.diagnostic;
      const span = line.spans.find((item) => item.from <= offset && item.to > offset);
      const source = span ? span.start + (span.end - span.start === span.to - span.from ? offset - span.from : 0) : line.end;
      let low = 0;
      let high = starts.length;
      while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if (starts[middle] <= source) low = middle;
        else high = middle;
      }
      warnings.push({ code: 'invalid_gallery_metadata', line: low + 1, column: source - starts[low] + 1, field, reason });
    }
  }
  return warnings;
}

/** @param {import('../../site/src/lib/gallery-source.js').GalleryAnalysis} analysis
 * @param {'de'|'en'} locale
 * @returns {GalleryWarning[]} */
export function galleryWarnings(analysis, locale) {
  return galleryDiagnostics(analysis).map((warning) => ({ ...warning, locale }));
}
