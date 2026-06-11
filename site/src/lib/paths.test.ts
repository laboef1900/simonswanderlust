import { describe, expect, it } from 'vitest';
import { aboutPath, homePath, regionPath, regionsIndexPath, regionSlugs, regions } from './paths';

describe('paths', () => {
  it('home: DE at root, EN prefixed', () => {
    expect(homePath('de')).toBe('/');
    expect(homePath('en')).toBe('/en/');
  });

  it('about pages keep the live WordPress slugs', () => {
    expect(aboutPath('de')).toBe('/uber-mich/');
    expect(aboutPath('en')).toBe('/en/about-me/');
  });

  it('region pages keep the live WordPress slugs', () => {
    expect(regionsIndexPath('de')).toBe('/reiseziele/');
    expect(regionsIndexPath('en')).toBe('/en/destinations/');
    expect(regionPath('europe', 'de')).toBe('/reiseziele/europa/');
    expect(regionPath('europe', 'en')).toBe('/en/destinations/europe/');
    expect(regionPath('north-america', 'de')).toBe('/reiseziele/nordamerika/');
    expect(regionPath('south-america', 'en')).toBe('/en/destinations/south-america/');
  });

  it('every region has a slug per locale', () => {
    for (const region of regions) {
      expect(regionSlugs[region].de).toBeTruthy();
      expect(regionSlugs[region].en).toBeTruthy();
    }
  });
});
