import { describe, expect, it } from 'vitest';
import type { Trip } from './trips';
import { tripPins, tripGeometry, type TripGeometry } from './map-data';
import type { PublicTrack } from './public-track';

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
  return { id, data: { title: 'T', country: 'C', region: 'europe', coordinates: { lat: 1, lng: 2 }, date: new Date('2024-01-01'), ...data } } as unknown as Trip;
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
