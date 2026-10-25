import { describe, expect, it } from 'vitest';
import { GPX_LIMITS } from '../public/gpx-geometry.js';
import { parseGpx } from '../src/gpx-parser.js';
import { GpxError } from '../src/gpx-errors.js';
import { createGpxWorker } from '../src/gpx-worker.js';

const ns = 'http://www.topografix.com/GPX/1/1';
const gpx = (body: string) => `<gpx xmlns="${ns}" version="1.1">${body}</gpx>`;
const point = (lng = '0', lat = '0', children = '') => `<trkpt lat="${lat}" lon="${lng}">${children}</trkpt>`;
const track = (points = point() + point('1')) => `<trk><trkseg>${points}</trkseg></trk>`;
const parse = (xml: string) => parseGpx(Buffer.from(xml));
function encoded(text: string, encoding: 'utf-8' | 'utf-16le' | 'utf-16be'): Buffer {
  if (encoding === 'utf-8') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
  const bytes = Buffer.from(`\ufeff${text}`, 'utf16le');
  return encoding === 'utf-16be' ? bytes.swap16() : bytes;
}
function failure(xml: string | Uint8Array, code: string, invalidPoints?: number): void {
  let error: unknown;
  try { parseGpx(typeof xml === 'string' ? Buffer.from(xml) : xml); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(GpxError);
  expect(error).toMatchObject({ code, message: code });
  if (invalidPoints !== undefined) expect(error).toMatchObject({ invalidPoints });
  expect(error).not.toHaveProperty('cause');
  expect(JSON.stringify(error)).not.toContain('PRIVATE_SENTINEL');
}

describe('strict encoding and XML boundary', () => {
  it.each(['utf-8', 'utf-16le', 'utf-16be'] as const)('accepts %s with compatible declaration and BOM', (encoding) => {
    const xml = `<?xml version="1.0" encoding="${encoding.toUpperCase()}"?>${gpx(track())}`;
    expect(parseGpx(encoded(xml, encoding)).counts.points).toBe(2);
    expect(parseGpx(encoded(gpx(track()), encoding)).counts.points).toBe(2);
  });

  it.each(['utf-16le', 'utf-16be'] as const)('accepts generic UTF-16 and rejects encoded declarations in %s', (encoding) => {
    expect(parseGpx(encoded(`<?xml version='1.0' encoding='UTF-16'?>${gpx(track())}`, encoding)).counts.points).toBe(2);
    for (const declaration of [
      '<!DOCTYPE gpx SYSTEM "https://PRIVATE_SENTINEL.invalid/entity">',
      '<!DOCTYPE gpx [<!ENTITY x "PRIVATE_SENTINEL">]>',
      '<!ENTITY x "PRIVATE_SENTINEL">', '<!dOcTyPe gpx>', '<!ELEMENT gpx ANY>',
    ]) failure(encoded(declaration + gpx(track()), encoding), 'gpx_invalid_xml');
  });

  it('rejects malformed bytes, UTF-32, BOM-less UTF-16, NUL and invalid XML characters', () => {
    for (const bytes of [Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from([0, 0, 0xfe, 0xff]),
      Buffer.from([0xc0, 0xaf]), Buffer.from([0xff, 0xfe, 0x00, 0xd8]), Buffer.from([0xfe, 0xff, 0xd8, 0]),
      Buffer.from([0xff, 0xfe, 0x61])]) failure(bytes, 'gpx_invalid_encoding');
    for (const bytes of [Buffer.from(gpx(track()), 'utf16le'), Buffer.from(gpx(track()), 'utf16le').swap16()]) {
      expect(() => parseGpx(bytes)).toThrow(GpxError);
    }
    for (const char of ['\u0000', '\u0001', '\ufffe', '\uffff']) failure(gpx(track() + `<extensions>${char}</extensions>`), 'gpx_invalid_xml');
  });

  it('requires declarations to be first, unique, XML 1.0 and encoding-consistent', () => {
    for (const prefix of [' <?xml version="1.0"?>', '<?xml version="1.1"?>', '<?xml?>',
      '<?xml version="1.0"?><?xml version="1.0"?>', '<?xml-stylesheet href="PRIVATE_SENTINEL"?>',
      '<!-- comment --><?xml version="1.0"?>']) failure(prefix + gpx(track()), 'gpx_invalid_xml');
    for (const encoding of ['UTF-16', 'UTF-16LE', 'ISO-8859-1']) failure(`<?xml version="1.0" encoding="${encoding}"?>${gpx(track())}`, 'gpx_invalid_encoding');
    failure(encoded(`<?xml version="1.0" encoding="UTF-16BE"?>${gpx(track())}`, 'utf-16le'), 'gpx_invalid_encoding');
  });

  it.each(['utf-8', 'utf-16le', 'utf-16be'] as const)('accepts empty XML comments in %s without changing route geometry', (encoding) => {
    const xml = `<!---->${gpx(`<!---->${track(point() + '<!---->' + point('1'))}<!---->`)}<!---->`;
    expect(parseGpx(encoded(xml, encoding)).geometry).toEqual({
      version: 1, segments: [{ points: [{ lng: 0, lat: 0 }, { lng: 1, lat: 0 }] }],
    });
  });

  it('rejects malformed XML, comments, extra roots and conservatively declaration-looking text', () => {
    for (const xml of ['', '<gpx', gpx(track()) + gpx(''), gpx(track()) + '<extra/>',
      gpx(track() + '<!-- invalid -- comment -->'), gpx(track() + '<!-- invalid --->'),
      gpx(track() + '<extensions a="<bad"/>'), gpx(track() + '<extensions>]]></extensions>'),
      gpx(track() + '<extensions\u00a0a="bad"/>'), gpx(track() + '<extensions a\u00a0="bad"/>'),
      gpx(track() + '<extensions><![CDATA[<!DOCTYPE PRIVATE_SENTINEL>]]></extensions>'),
      gpx(track() + '<!-- <!ENTITY PRIVATE_SENTINEL> -->'), gpx(track() + '<extensions><?unsafe x?></extensions>')]) {
      failure(xml, 'gpx_invalid_xml');
    }
  });

  it('decodes references exactly once and preserves CDATA literal ampersands and order', () => {
    const result = parse(gpx('<wpt lat="&#48;" lon="&#x30;"><name>A&amp;<![CDATA[&literal;]]>&#x1F30D;&lt;&gt;&quot;&apos;&amp;amp;</name></wpt>'));
    expect(result.waypoints).toEqual([{ lat: 0, lng: 0, name: 'A&&literal;🌍<>"\'&amp;' }]);
    expect(result.geometry.segments).toEqual([]);
    expect(parse(gpx('<wpt lat="0" lon="0"><name><![CDATA[<?literal?>]]></name></wpt>')).waypoints[0]!.name).toBe('<?literal?>');
  });

  it('rejects bad and unknown references throughout unknown subtrees and attributes', () => {
    for (const reference of ['&#0;', '&#xD800;', '&#1114112;', '&#xFFFE;', '&private;', '&missing']) {
      failure(gpx(track() + `<extensions a="${reference}">PRIVATE_SENTINEL</extensions>`), 'gpx_invalid_xml');
      failure(gpx(track() + `<extensions>${reference}</extensions>`), 'gpx_invalid_xml');
    }
  });
});

describe('namespace-aware GPX extraction', () => {
  it('preserves mixed track/route order, normalizes lon, and retains only permitted private fields', () => {
    const result = parse(gpx(`<trk><name>PRIVATE_SENTINEL</name><trkseg>${point('0', '0', '<ele>-12.5</ele><time>2024-02-29T12:30:00+02:30</time><extensions><speed>900</speed></extensions>')}${point('1')}</trkseg></trk><rte><rtept lat="2" lon="2"/><rtept lat="3" lon="3"/></rte>${track(point('4') + point('5'))}`));
    expect(result.counts).toMatchObject({ tracks: 2, routes: 1, sourceSegments: 3, inputPoints: 6, points: 6, segments: 3 });
    expect(result.geometry.segments.map((run) => run.points[0]!.lng)).toEqual([0, 2, 4]);
    expect(result.geometry.segments[0]!.points[0]).toEqual({ lat: 0, lng: 0, elevation: -12.5, time: '2024-02-29T10:00:00.000Z' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    expect(JSON.stringify(result)).not.toContain('speed');
  });

  it('accepts prefixed GPX 1.0 and element-scoped namespace changes without treating foreign lookalikes as points', () => {
    const xml = '<p:gpx xmlns:p="http://www.topografix.com/GPX/1/0" version="1.0"><p:trk><p:trkseg><p:trkpt lat="0" lon="0"/><p:trkpt lat="1" lon="1"/><trkpt xmlns="urn:foreign" lat="bad" lon="bad"/></p:trkseg></p:trk><p:extensions><p:trk><p:trkseg><p:trkpt lat="bad"/></p:trkseg></p:trk></p:extensions><wpt xmlns="urn:foreign" lat="bad"/></p:gpx>';
    expect(parse(xml).counts).toMatchObject({ points: 2, inputPoints: 2, waypoints: 0 });
  });

  it('rejects missing/mismatched namespaces, unbound prefixes and reserved rebinding even in ignored data', () => {
    for (const xml of ['<gpx version="1.1"/>', `<gpx xmlns="${ns}" version="1.0"/>`,
      gpx(track() + '<extensions><u:private/></extensions>'),
      gpx(track() + '<extensions xmlns:xml="urn:private"/>'),
      gpx(track() + '<extensions xmlns:x="http://www.w3.org/XML/1998/namespace"/>'),
      gpx(track() + '<extensions xmlns:xmlns="urn:private"/>'),
      gpx(track() + '<extensions xmlns:p=""/>'),
      gpx(track() + '<extensions xmlns="http://www.w3.org/2000/xmlns/"/>'),
      gpx(track() + '<extensions xmlns:x="urn:x" xmlns:y="urn:x" x:a="1" y:a="2"/>')]) failure(xml, 'gpx_invalid_xml');
  });

  it('does not accept namespace-qualified coordinates and counts every malformed point including waypoints', () => {
    failure(gpx(`<trk><trkseg><trkpt xmlns:p="urn:x" p:lat="0" lon="0"/>${point('1', '91')}${point('2')}</trkseg></trk><wpt lat="NaN" lon="0"/>`), 'gpx_invalid_points', 3);
  });

  it('splits raw antimeridian discontinuities, drops short runs, and never joins unrelated segments', () => {
    const result = parse(gpx(track(point('178') + point('179') + point('-179') + point('-178')) + track(point('180') + point('-180')) + '<trk><trkseg/></trk>'));
    expect(result.geometry.segments.map((run) => run.points.map((p) => p.lng))).toEqual([[178, 179], [-179, -178]]);
    expect(result.counts).toMatchObject({ antimeridianSplits: 2, droppedSegments: 3, sourceSegments: 3, points: 4 });
  });

  it('accepts standalone waypoint-only previews but never invents a line from singleton points', () => {
    expect(parse(gpx('<wpt lat="90" lon="180"><name>North</name><ele>100000</ele><time>0001-01-01T00:00:00Z</time></wpt>')).waypoints).toEqual([{ name: 'North', lat: 90, lng: 180 }]);
    failure(gpx(track(point())), 'gpx_empty');
    failure(gpx(''), 'gpx_empty');
    expect(parse(gpx('<wpt lat="0" lon="0"/>')).waypoints[0]!.name).toBe('');
  });
});

describe('point scalars and resource boundaries', () => {
  it.each(['', 'NaN', 'Infinity', '0x10', '1e2', '1_0', '90.001', '\u00a00'])('rejects invalid latitude %j', (lat) => {
    failure(gpx(track(point('0', lat) + point('1'))), 'gpx_invalid_points', 1);
  });

  it('accepts XML whitespace, decimal edge forms, poles and both longitude endpoints', () => {
    expect(parse(gpx(track(point(' +.0 ', '\t-90\n') + point('180.', '+90.')))).counts.points).toBe(2);
    expect(parse(gpx(track(point('-180', '-90') + point('-179', '90')))).counts.points).toBe(2);
  });

  it.each(['<ele/>', '<ele>100001</ele>', '<ele>-12000.1</ele>', '<ele>1e3</ele>',
    '<ele><value>1</value></ele>', '<ele>1</ele><ele>2</ele>',
    '<time>2023-02-29T00:00:00Z</time>', '<time>2024-04-31T00:00:00Z</time>',
    '<time>0000-01-01T00:00:00Z</time>', '<time>2024-01-01T00:00:00</time>',
    '<time>2024-01-01T24:00:00Z</time>', '<time>2024-01-01T00:00:60Z</time>',
    '<time>2024-01-01T00:00:00+14:01</time>', '<time>0001-01-01T00:00:00+01:00</time>',
    '<name><b>PRIVATE_SENTINEL</b></name>'])('rejects malformed present scalar %s', (scalar) => {
    failure(gpx(track(point('0', '0', scalar) + point('1'))), 'gpx_invalid_points', 1);
  });

  it('bounds decoded names by Unicode code points, not UTF-16 units or encoded reference length', () => {
    const name = '&#x1F30D;'.repeat(200);
    expect(parse(gpx(`<wpt lat="0" lon="0"><name>${name}</name></wpt>`)).waypoints[0]!.name).toBe('🌍'.repeat(200));
    failure(gpx(`<wpt lat="0" lon="0"><name>${name}x</name></wpt>`), 'gpx_invalid_points', 1);
  });

  it('counts self-closing depth and checks unknown extensions independently of parser depth checks', () => {
    expect(parse(gpx(track() + '<x>'.repeat(30) + '<leaf/>' + '</x>'.repeat(30))).counts.points).toBe(2);
    failure(gpx(track() + '<x>'.repeat(31) + '<leaf/>' + '</x>'.repeat(31)), 'gpx_limit');
  });

  it('accepts the route point cap and refuses the next point before singleton dropping', () => {
    expect(parse(gpx(track(point().repeat(GPX_LIMITS.points)))).counts.points).toBe(GPX_LIMITS.points);
    failure(gpx(track(point().repeat(GPX_LIMITS.points + 1))), 'gpx_limit');
  });

  it('counts empty source segments, caps normalized antimeridian runs, and counts waypoints', () => {
    expect(parse(gpx(track() + '<trk><trkseg/></trk>'.repeat(99))).counts.sourceSegments).toBe(100);
    failure(gpx(track() + '<trk><trkseg/></trk>'.repeat(100)), 'gpx_limit');
    const alternating = Array.from({ length: 101 }, (_, i) => point(i % 2 ? '-179' : '179').repeat(2)).join('');
    failure(gpx(track(alternating)), 'gpx_limit');
    expect(parse(gpx('<wpt lat="0" lon="0"/>'.repeat(500))).counts.waypoints).toBe(500);
    failure(gpx('<wpt lat="bad" lon="0"/>'.repeat(501)), 'gpx_limit');
  });

  it('refuses bytes over 5 MiB and parses maximum-size internal whitespace within the worker deadline', async () => {
    failure(new Uint8Array(GPX_LIMITS.fileBytes + 1), 'gpx_too_large');
    const skeleton = gpx(track() + '<!-- -->');
    const padded = skeleton.replace('<!-- -->', `<!--${' '.repeat(GPX_LIMITS.fileBytes - Buffer.byteLength(skeleton) + 1)}-->`);
    expect(Buffer.byteLength(padded)).toBe(GPX_LIMITS.fileBytes);
    const worker = createGpxWorker();
    try { expect((await worker.parse(Buffer.from(padded))).counts.points).toBe(2); }
    finally { await worker.close(); }
  });
});
