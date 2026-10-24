import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { GPX_LIMITS, validateGeometry, type PrivateGeometry, type PrivatePoint } from '../public/gpx-geometry.js';
import { GpxError } from './gpx-errors.js';

export interface GpxPreview {
  geometry: PrivateGeometry;
  waypoints: { name: string; lng: number; lat: number }[];
  counts: { tracks: number; routes: number; sourceSegments: number; inputPoints: number; points: number;
    segments: number; waypoints: number; droppedSegments: number; antimeridianSplits: number };
}
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const GPX_NS: Record<string, string> = { 'http://www.topografix.com/GPX/1/0': '1.0', 'http://www.topografix.com/GPX/1/1': '1.1' };
const XML_REFERENCES: Record<string, string> = { amp: '&', lt: '<', gt: '>', apos: "'", quot: '"' };
const whitespace = /^[\x20\t\r\n]*$/;
const space = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;
function trim(text: string): string {
  let start = 0, end = text.length;
  while (start < end && space(text.charCodeAt(start))) start++;
  while (end > start && space(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}
function xmlFailure(): never { throw new GpxError('gpx_invalid_xml'); }
function pointFailure(): never { throw new GpxError('gpx_invalid_points'); }
function limit(): never { throw new GpxError('gpx_limit'); }
const validChar = (n: number) => n === 9 || n === 10 || n === 13 || (n >= 0x20 && n <= 0xd7ff)
  || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);

export function assertGpxDecoders(): void {
  try {
    for (const encoding of ['utf-8', 'utf-16le', 'utf-16be']) new TextDecoder(encoding, { fatal: true });
  } catch { throw new GpxError('gpx_unavailable', 503); }
}

function decode(bytes: Uint8Array): string {
  if (!bytes.byteLength) xmlFailure();
  if (bytes.byteLength > GPX_LIMITS.fileBytes) throw new GpxError('gpx_too_large', 413);
  // Reject UTF-32 first: its LE BOM begins with the UTF-16LE BOM.
  if ((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0)
    || (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)) throw new GpxError('gpx_invalid_encoding');
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new GpxError('gpx_invalid_encoding'); }
  for (const char of text) if (!validChar(char.codePointAt(0)!)) xmlFailure();
  // Conservative by design, even inside comments/CDATA; declarations never reach the library.
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || /<!(?!--|\[CDATA\[)/.test(text)) xmlFailure();
  let rest = text;
  if (text.startsWith('<?xml')) {
    const end = text.indexOf('?>');
    if (end < 0) xmlFailure();
    const declaration = text.slice(0, end + 2);
    const match = /^<\?xml[\x20\t\r\n]+version[\x20\t\r\n]*=[\x20\t\r\n]*(['"])1\.0\1(?:[\x20\t\r\n]+encoding[\x20\t\r\n]*=[\x20\t\r\n]*(['"])([A-Za-z][A-Za-z0-9._-]*)\2)?(?:[\x20\t\r\n]+standalone[\x20\t\r\n]*=[\x20\t\r\n]*(['"])(?:yes|no)\4)?[\x20\t\r\n]*\?>$/.exec(declaration);
    if (!match) xmlFailure();
    const declared = match[3]?.toLowerCase();
    if (declared && declared !== encoding && !(declared === 'utf-16' && encoding !== 'utf-8')) throw new GpxError('gpx_invalid_encoding');
    rest = text.slice(end + 2);
  }
  // Close well-formedness gaps in XMLValidator (comment bodies, raw '<' in attributes,
  // non-XML whitespace and ']]>' in ordinary text). Count depth before tree allocation too.
  const tagName = /\/?[^\s/<>=!?'"`]+/uy;
  const attribute = /[^\s/<>=!?'"`]+[\x20\t\r\n]*=[\x20\t\r\n]*(?:"[^"<]*"|'[^'<]*')/uy;
  let depth = 0;
  for (let position = 0; position < rest.length;) {
    const start = rest.indexOf('<', position);
    if (rest.slice(position, start < 0 ? rest.length : start).includes(']]>')) xmlFailure();
    if (start < 0) break;
    if (rest.startsWith('<!--', start)) {
      const end = rest.indexOf('-->', start + 4);
      if (end < 0 || rest.slice(start + 4, end).includes('--') || rest[end - 1] === '-') xmlFailure();
      position = end + 3;
    } else if (rest.startsWith('<![CDATA[', start)) {
      const end = rest.indexOf(']]>', start + 9);
      if (end < 0 || depth === 0) xmlFailure();
      position = end + 3;
    } else {
      tagName.lastIndex = start + 1;
      const matched = tagName.exec(rest);
      if (!matched) xmlFailure();
      position = tagName.lastIndex;
      const closing = matched[0].startsWith('/');
      if (!closing && ++depth > GPX_LIMITS.nesting) limit();
      for (;;) {
        const beforeSpace = position;
        while (position < rest.length && /[\x20\t\r\n]/.test(rest[position]!)) position++;
        if (rest[position] === '>') {
          position++;
          if (closing) depth--;
          break;
        }
        if (!closing && rest.startsWith('/>', position)) { depth--; position += 2; break; }
        if (closing || position === beforeSpace) xmlFailure();
        attribute.lastIndex = position;
        if (!attribute.exec(rest)) xmlFailure();
        position = attribute.lastIndex;
      }
      if (depth < 0) xmlFailure();
    }
  }
  return text;
}

function references(text: string): string {
  return text.replace(/&([^;&]*);|&/g, (_whole: string, entity: string | undefined) => {
    if (entity !== undefined && Object.hasOwn(XML_REFERENCES, entity)) return XML_REFERENCES[entity]!;
    if (entity !== undefined && /^(?:#\d+|#x[\da-fA-F]+)$/.test(entity)) {
      const n = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (validChar(n)) return String.fromCodePoint(n);
    }
    return xmlFailure();
  });
}

type OrderedNode = Record<string, unknown>;
function nodes(value: unknown): OrderedNode[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item))) return xmlFailure();
  return value as OrderedNode[];
}
function textValue(value: unknown): string { return typeof value === 'string' ? value : xmlFailure(); }
function scalar(children: OrderedNode[]): string {
  let result = '';
  for (const child of children) {
    if ('#text' in child) result += references(textValue(child['#text']));
    else if ('#cdata' in child) {
      for (const piece of nodes(child['#cdata'])) result += textValue(piece['#text']);
    } else pointFailure();
  }
  return result;
}
// XML Namespaces 1.0 NCName ranges (colon is deliberately absent).
const startName = 'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const ncName = new RegExp(`^[${startName}][${startName}0-9.\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$`, 'u');
function qname(name: string): [string, string] {
  const parts = name.split(':');
  if (parts.length > 2 || parts.some((part) => !ncName.test(part))) return xmlFailure();
  return parts.length === 1 ? ['', parts[0]!] : [parts[0]!, parts[1]!];
}
function decimal(value: string | undefined, min: number, max: number): number {
  if (value === undefined) return pointFailure();
  const lexeme = trim(value);
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(lexeme)) return pointFailure();
  const number = Number(lexeme);
  if (!Number.isFinite(number) || number < min || number > max) return pointFailure();
  return number;
}
function timestamp(value: string): string {
  const text = trim(value);
  if (text.length > 35) return pointFailure();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match) return pointFailure();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = match[8]!;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]!
    || hour > 23 || minute > 59 || second > 59
    || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4)) > 59
      || (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4)) !== 0)))) return pointFailure();
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) return pointFailure();
  const iso = new Date(millis).toISOString();
  if (!/^(?!0000)\d{4}-/.test(iso)) return pointFailure();
  return iso;
}

type Kind = 'root' | 'track' | 'segment' | 'route' | 'point' | 'waypoint' | 'other';
interface Candidate { point?: PrivatePoint; name: string; invalid: boolean; seen: Set<string> }

export function parseGpx(bytes: Uint8Array): GpxPreview {
  assertGpxDecoders();
  try {
    const text = decode(bytes);
    if (XMLValidator.validate(text) !== true) xmlFailure();
    const parser = new XMLParser({
      preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
      cdataPropName: '#cdata', parseTagValue: false, parseAttributeValue: false, processEntities: false,
      htmlEntities: false, removeNSPrefix: false, ignoreDeclaration: true, ignorePiTags: true,
      trimValues: false, maxNestedTags: 32, strictReservedNames: true,
      onDangerousProperty: () => xmlFailure(),
    });
    // The original was validated above. External XML whitespace carries no
    // data; do not build a multi-megabyte preserved text node for it.
    const document = nodes(parser.parse(trim(text)) as unknown);
    const geometry: PrivateGeometry = { version: 1, segments: [] };
    const waypoints: GpxPreview['waypoints'] = [];
    const counts: GpxPreview['counts'] = { tracks: 0, routes: 0, sourceSegments: 0, inputPoints: 0,
      points: 0, segments: 0, waypoints: 0, droppedSegments: 0, antimeridianSplits: 0 };
    let rootCount = 0;
    let gpxUri = '';
    let invalidPoints = 0;
    const emit = (points: PrivatePoint[]) => {
      if (points.length < 2) { counts.droppedSegments++; return; }
      if (geometry.segments.length === GPX_LIMITS.segments) limit();
      geometry.segments.push({ points });
      counts.points += points.length;
    };
    function walk(list: OrderedNode[], inherited: Map<string, string>, parent: Kind | null, depth: number,
      segment?: PrivatePoint[], candidate?: Candidate): void {
      for (const node of list) {
        if ('#text' in node) {
          const value = references(textValue(node['#text']));
          if (parent === null && !whitespace.test(value)) xmlFailure();
          continue;
        }
        if ('#cdata' in node) {
          if (parent === null) xmlFailure();
          for (const piece of nodes(node['#cdata'])) textValue(piece['#text']);
          continue;
        }
        if (depth > GPX_LIMITS.nesting) limit();
        const elementKeys = Object.keys(node).filter((key) => key !== ':@');
        if (elementKeys.length !== 1) xmlFailure();
        const tag = elementKeys[0]!;
        const children = nodes(node[tag]);
        const attrs = new Map<string, string>();
        if (node[':@'] !== undefined) {
          const raw = node[':@'];
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) xmlFailure();
          for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (!key.startsWith('@_')) xmlFailure();
            attrs.set(key.slice(2), references(textValue(value)));
          }
        }
        const namespaces = new Map(inherited);
        for (const [name, value] of attrs) {
          if (name === 'xmlns') {
            if (value === XML_NS || value === XMLNS_NS) xmlFailure();
            namespaces.set('', value);
          } else if (name.startsWith('xmlns:')) {
            const [, prefix] = qname(name);
            if (prefix === 'xmlns' || !value || value === XMLNS_NS || (prefix === 'xml') !== (value === XML_NS)) xmlFailure();
            namespaces.set(prefix, value);
          }
        }
        const resolve = (name: string, attribute: boolean): [string, string] => {
          const [prefix, local] = qname(name);
          if (prefix === 'xmlns' || (prefix && !namespaces.has(prefix))) return xmlFailure();
          return [prefix ? namespaces.get(prefix)! : attribute ? '' : (namespaces.get('') ?? ''), local];
        };
        const [uri, local] = resolve(tag, false);
        const expanded = new Set<string>();
        for (const name of attrs.keys()) {
          if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
          const [attrUri, attrLocal] = resolve(name, true);
          const key = `${attrUri}\u0000${attrLocal}`;
          if (expanded.has(key)) xmlFailure();
          expanded.add(key);
        }
        let kind: Kind = 'other';
        if (parent === null) {
          if (++rootCount !== 1 || local !== 'gpx' || !Object.hasOwn(GPX_NS, uri) || attrs.get('version') !== GPX_NS[uri]) xmlFailure();
          gpxUri = uri;
          kind = 'root';
        } else if (uri === gpxUri) {
          if (parent === 'root' && local === 'trk') { kind = 'track'; counts.tracks++; }
          if (parent === 'root' && local === 'rte') { kind = 'route'; counts.routes++; }
          if (parent === 'track' && local === 'trkseg') kind = 'segment';
          if ((parent === 'segment' && local === 'trkpt') || (parent === 'route' && local === 'rtept')) kind = 'point';
          if (parent === 'root' && local === 'wpt') kind = 'waypoint';
        }
        if (kind === 'segment' || kind === 'route') {
          if (++counts.sourceSegments > GPX_LIMITS.segments) limit();
          const points: PrivatePoint[] = [];
          walk(children, namespaces, kind, depth + 1, points);
          let run: PrivatePoint[] = [];
          for (const point of points) {
            if (run.length && Math.abs(run[run.length - 1]!.lng - point.lng) > 180) {
              counts.antimeridianSplits++;
              emit(run);
              run = [];
            }
            run.push(point);
          }
          emit(run);
        } else if (kind === 'point' || kind === 'waypoint') {
          if (kind === 'point' && ++counts.inputPoints > GPX_LIMITS.points) limit();
          if (kind === 'waypoint' && ++counts.waypoints > GPX_LIMITS.waypoints) limit();
          const current: Candidate = { name: '', invalid: false, seen: new Set() };
          try { current.point = { lat: decimal(attrs.get('lat'), -90, 90), lng: decimal(attrs.get('lon'), -180, 180) }; }
          catch (error) { if (!(error instanceof GpxError) || error.code !== 'gpx_invalid_points') throw error; current.invalid = true; }
          walk(children, namespaces, kind, depth + 1, segment, current);
          if (current.invalid || !current.point) invalidPoints++;
          else if (kind === 'point') segment!.push(current.point);
          else waypoints.push({ name: current.name, lat: current.point.lat, lng: current.point.lng });
        } else {
          if (candidate && (parent === 'point' || parent === 'waypoint') && uri === gpxUri
            && (local === 'ele' || local === 'time' || local === 'name')) {
            try {
              if (candidate.seen.has(local)) pointFailure();
              candidate.seen.add(local);
              const value = scalar(children);
              if (local === 'ele') { const elevation = decimal(value, -12000, 100000); if (candidate.point) candidate.point.elevation = elevation; }
              if (local === 'time') { const time = timestamp(value); if (candidate.point) candidate.point.time = time; }
              if (local === 'name') {
                let length = 0;
                for (const _char of value) if (++length > GPX_LIMITS.nameCodePoints) pointFailure();
                candidate.name = value;
              }
            } catch (error) { if (!(error instanceof GpxError) || error.code !== 'gpx_invalid_points') throw error; candidate.invalid = true; }
          }
          walk(children, namespaces, kind, depth + 1, segment);
        }
      }
    }
    walk(document, new Map([['xml', XML_NS]]), null, 1);
    if (invalidPoints) throw new GpxError('gpx_invalid_points', 422, invalidPoints);
    if (rootCount !== 1) xmlFailure();
    if (!geometry.segments.length && !waypoints.length) throw new GpxError('gpx_empty');
    counts.segments = geometry.segments.length;
    validateGeometry(geometry, true);
    const preview = { geometry, waypoints, counts };
    if (Buffer.byteLength(JSON.stringify(preview)) > GPX_LIMITS.normalizedBytes) limit();
    return preview;
  } catch (error) {
    if (error instanceof GpxError) throw error;
    // Library exceptions can contain raw XML: never expose or retain their cause.
    throw new GpxError('gpx_invalid_xml');
  }
}
