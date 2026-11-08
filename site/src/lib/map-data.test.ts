import { describe, expect, it } from 'vitest';
import type { Trip } from './trips';
import { tripPins, tripGeometry, type TripGeometry } from './map-data';
import type { PublicTrack } from './public-track';
import type { PublicStopRoute } from './public-stop-route';

type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
  : false;
const contentShape: Exact<Pick<Trip['data'], 'track'>, { track?: PublicTrack }> = true;
const mapShape: Exact<Pick<TripGeometry, 'track'>, { track?: PublicTrack }> = true;
const track: PublicTrack = {
  version: 1, type: 'MultiLineString',
  coordinates: [[[1.1234, 2.3456], [2, 3]], [[20, 30], [21, 31]]],
};

// Minimal Trip stub — only the fields the helpers read.
function trip(id: string, data: Partial<Trip['data']>): Trip {
  return { id, data: {
    title: 'T', country: 'C', region: 'europe', coordinates: { lat: 1, lng: 2 }, date: new Date('2024-01-01'), translationKey: id.split('/')[1],
    heroImage: { src: 'https://img.example/trips/x/hero', width: 1920, height: 1280, alt: 'Harbour at dusk' },
    ...data,
  } } as unknown as Trip;
}

describe('tripPins', () => {
  it('builds [lng,lat] Points with localized hrefs, one per locale trip', () => {
    const all = [
      trip('de/rhodos', { title: 'Rhodos', coordinates: { lat: 36.4, lng: 28.2 }, country: 'Griechenland', region: 'europe' }),
      trip('en/rhodes', { title: 'Rhodes', coordinates: { lat: 36.4, lng: 28.2 }, country: 'Greece', region: 'europe' }),
    ];
    const fc = tripPins(all, 'de');
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
    const f = fc.features[0];
    expect(f.geometry.coordinates).toEqual([28.2, 36.4]); // [lng, lat]
    expect(f.properties).toMatchObject({ title: 'Rhodos', href: '/rhodos/', country: 'Griechenland', region: 'europe' });
  });
  it('uses /en/ hrefs for the en locale', () => {
    const all = [trip('en/rhodes', { coordinates: { lat: 1, lng: 2 } })];
    expect(tripPins(all, 'en').features[0].properties.href).toBe('/en/rhodes/');
  });
  it('is empty for an empty collection', () => {
    expect(tripPins([], 'de').features).toEqual([]);
  });
  it('keeps overview maps pin-only even for stories with tracks and stops', () => {
    const plain = trip('de/x', {});
    const routed = trip('de/x', { track, stops: [{ name: 'Stop', lat: 3, lng: 4 }] });
    expect(tripPins([routed], 'de')).toEqual(tripPins([plain], 'de'));
    expect(Object.keys(tripPins([routed], 'de').features[0]!.geometry)).toEqual(['type', 'coordinates']);
  });
  it('numbers pins as travel-log entries, oldest first, whatever the display order', () => {
    const all = [
      trip('en/newest', { date: new Date('2024-06-01') }),
      trip('en/oldest', { date: new Date('2020-01-01') }),
      trip('en/middle', { date: new Date('2022-01-01') }),
      trip('de/other-locale', { date: new Date('2019-01-01') }),
    ];
    expect(tripPins(all, 'en').features.map((f) => [f.properties.href, f.properties.number])).toEqual([
      ['/en/newest/', 3], ['/en/middle/', 2], ['/en/oldest/', 1],
    ]);
  });
  it('gives each pin its smallest photo variant, a decorative alt when it only repeats the title, and a clamped focus', () => {
    const [described, titled, small] = tripPins([
      trip('en/a', { date: new Date('2024-03-01'), heroImage: { src: 'https://img.example/a/hero', width: 1920, height: 1280, alt: 'Canoe on a black river', focus: { x: 140, y: 30.4 } } }),
      trip('en/b', { date: new Date('2024-02-01'), title: 'Rhodes', heroImage: { src: 'https://img.example/b/hero', width: 1920, height: 1280, alt: 'RHODES' } }),
      trip('en/c', { date: new Date('2024-01-01'), heroImage: { src: 'https://img.example/c/hero', width: 480, height: 320, alt: 'Dunes', format: 'jpeg' } }),
    ], 'en').features.map((f) => f.properties.photo);
    expect(described).toEqual({ src: 'https://img.example/a/hero-640.webp', width: 1920, height: 1280, alt: 'Canoe on a black river', position: '100% 30%' });
    expect(titled).toEqual({ src: 'https://img.example/b/hero-640.webp', width: 1920, height: 1280, alt: '' });
    // Never upscaled: a frame narrower than 640 uses its own width.
    expect(small!.src).toBe('https://img.example/c/hero-480.jpeg');
  });
});

describe('tripGeometry', () => {
  it('returns the pin and a Point per stop ([lng,lat])', () => {
    const t = trip('de/x', { coordinates: { lat: 10, lng: 20 }, stops: [{ name: 'A', lat: 11, lng: 21 }] });
    const g = tripGeometry(t);
    expect(g.pin.geometry.coordinates).toEqual([20, 10]);
    expect(g.stops).toHaveLength(1);
    expect(g.stops[0]).toMatchObject({ properties: { name: 'A' }, geometry: { coordinates: [21, 11] } });
  });
  it('has no stops when none are defined', () => {
    expect(tripGeometry(trip('de/x', {})).stops).toEqual([]);
  });
  it('preserves discontinuous public runs without mixing them into the stop points', () => {
    const geometry = tripGeometry(trip('de/x', { track }));
    expect(geometry.track).toEqual(track);
    expect(geometry.stops).toEqual([]);
    expect(Object.keys(geometry)).toEqual(['pin', 'stops', 'track']);
    expect(JSON.parse(JSON.stringify(geometry)).track).toEqual(track);
  });
  it('omits track entirely for route-free stories', () => {
    expect(tripGeometry(trip('de/x', {}))).not.toHaveProperty('track');
  });
  it('pins content-inferred and map track types exactly, including optional additions', () => {
    expect([contentShape, mapShape]).toEqual([true, true]);
  });
});

describe('tripGeometry stop routes (#513)', () => {
  const stopRoute: PublicStopRoute = { version: 1, runs: [
    { kind: 'road', coordinates: [[23.7275, 37.9838], [23.3439, 37.9961], [22.9322, 37.9407]] },
    { kind: 'straight', coordinates: [[21.7346, 38.2466], [28.2278, 36.4341]] },
  ] };
  const stops = [
    { name: 'Athens', lat: 37.9838, lng: 23.7275 },
    { name: 'Megara (via)', lat: 37.9961, lng: 23.3439, via: true },
    { name: 'Corinth', lat: 37.9407, lng: 22.9322, profile: 'bike' as const },
    { name: 'Rhodes', lat: 36.4341, lng: 28.2278 },
  ];

  it.each([
    ['track only', { track }, ['track']],
    ['stop route only', { stopRoute }, ['stopRoute']],
    ['both: the GPX track wins', { track, stopRoute }, ['track']],
    ['neither', {}, []],
  ] as const)('%s', (_name, data, lines) => {
    const geometry = tripGeometry(trip('de/x', data));
    expect(Object.keys(geometry).filter((key) => key === 'track' || key === 'stopRoute')).toEqual(lines);
  });

  it('drops via points from pins and names but leaves the stored line untouched, in stop order', () => {
    const geometry = tripGeometry(trip('de/x', { stops, stopRoute }));
    expect(geometry.stops.map((stop) => stop.properties.name)).toEqual(['Athens', 'Corinth', 'Rhodes']);
    expect(JSON.stringify(geometry)).not.toContain('Megara');
    expect(geometry.stopRoute).toEqual(stopRoute);
  });
});
