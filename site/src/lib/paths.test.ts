import { describe, expect, it } from 'vitest';
import { ui, type Locale, type UIKey } from '../i18n/ui';
import { aboutPath, homePath, mapPath, regionPath, regionsIndexPath, regionSlugs, regions } from './paths';

const locales: Locale[] = ['de', 'en'];

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
    // Only these three exist on WordPress (src/redirects.ts maps their old
    // /category/ URLs); they must never change.
    expect(regionPath('europe', 'de')).toBe('/reiseziele/europa/');
    expect(regionPath('europe', 'en')).toBe('/en/destinations/europe/');
    expect(regionPath('north-america', 'de')).toBe('/reiseziele/nordamerika/');
    expect(regionPath('north-america', 'en')).toBe('/en/destinations/north-america/');
    expect(regionPath('south-america', 'de')).toBe('/reiseziele/suedamerika/');
    expect(regionPath('south-america', 'en')).toBe('/en/destinations/south-america/');
  });

  it('the four non-WordPress regions use the slugs the 2026-10-19 spec fixed', () => {
    expect(regionPath('asia', 'de')).toBe('/reiseziele/asien/');
    expect(regionPath('asia', 'en')).toBe('/en/destinations/asia/');
    expect(regionPath('africa', 'de')).toBe('/reiseziele/afrika/');
    expect(regionPath('africa', 'en')).toBe('/en/destinations/africa/');
    expect(regionPath('oceania', 'de')).toBe('/reiseziele/ozeanien/');
    expect(regionPath('oceania', 'en')).toBe('/en/destinations/oceania/');
    expect(regionPath('antarctica', 'de')).toBe('/reiseziele/antarktis/');
    expect(regionPath('antarctica', 'en')).toBe('/en/destinations/antarctica/');
  });

  it('lists the regions in display order', () => {
    expect(regions).toEqual([
      'europe',
      'asia',
      'africa',
      'north-america',
      'south-america',
      'oceania',
      'antarctica',
    ]);
  });

  it('every region has a URL-safe slug per locale, unique within that locale', () => {
    for (const locale of locales) {
      const slugs = regions.map((region) => regionSlugs[region][locale]);
      for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(new Set(slugs).size).toBe(regions.length);
    }
  });

  it('every region has a label in both locales', () => {
    // The pages look labels up with a `region.${region}` cast, so a missing
    // key would type-check and render `undefined`.
    for (const locale of locales) {
      for (const region of regions) {
        expect(ui[locale][`region.${region}` as UIKey]).toBeTruthy();
      }
    }
  });
});

describe('mapPath', () => {
  it('mapPath: DE at /karte/, EN at /en/map/', () => {
    expect(mapPath('de')).toBe('/karte/');
    expect(mapPath('en')).toBe('/en/map/');
  });
});
