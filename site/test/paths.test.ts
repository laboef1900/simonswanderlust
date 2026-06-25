import { describe, expect, it } from 'vitest';
import { mapPath } from '../src/lib/paths';

describe('mapPath', () => {
  it('mapPath: DE at /karte/, EN at /en/map/', () => {
    expect(mapPath('de')).toBe('/karte/');
    expect(mapPath('en')).toBe('/en/map/');
  });
});
