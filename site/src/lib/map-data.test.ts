import { describe, expect, it } from 'vitest';
import type { Trip } from '../src/lib/trips';
import { tripPins, tripGeometry } from '../src/lib/map-data';

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
});
