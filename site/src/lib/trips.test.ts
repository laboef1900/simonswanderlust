import { describe, expect, it } from 'vitest';
import { useTranslations } from '../i18n/ui';
import { regions } from './paths';
import {
  byLocale,
  entryNumberOf,
  heroAltOf,
  localeOf,
  pathOf,
  slugOf,
  liveRegions,
  regionCounts,
  statsLine,
  translationOf,
  tripStats,
  type Trip,
} from './trips';

function fake(id: string, date: string, translationKey: string): Trip {
  return { id, data: { date: new Date(date), translationKey } } as unknown as Trip;
}

function fakeWithPlace(id: string, countryCode: string, region: string): Trip {
  return {
    id,
    data: { date: new Date('2024-01-01'), translationKey: id, countryCode, region },
  } as unknown as Trip;
}

function fakeWithAlt(title: string, alt: string): Trip {
  return { id: 'de/x', data: { title, heroImage: { alt } } } as unknown as Trip;
}

const rhodesDe = fake('de/sonne-und-abenteuer-rhodos', '2021-07-25', 'rhodes-2021');
const rhodesEn = fake('en/sun-and-adventure-on-rhodes', '2021-07-25', 'rhodes-2021');
const buchDe = fake('de/reisebericht-4-tage-bukarest', '2024-10-03', 'bucharest-2024');
const all = [rhodesDe, rhodesEn, buchDe];

describe('trips helpers', () => {
  it('derives locale and slug from the entry id', () => {
    expect(localeOf(rhodesDe)).toBe('de');
    expect(localeOf(rhodesEn)).toBe('en');
    expect(slugOf(rhodesEn)).toBe('sun-and-adventure-on-rhodes');
  });

  it('builds URLs matching the live WordPress structure', () => {
    expect(pathOf(rhodesDe)).toBe('/sonne-und-abenteuer-rhodos/');
    expect(pathOf(rhodesEn)).toBe('/en/sun-and-adventure-on-rhodes/');
  });

  /*
   * @ai-warning These pin a CROSS-TREE contract. `uploader/src/alt-audit.ts`
   * decides which photos the editor warns an author about using the same rule,
   * and the two trees have separate tsconfigs, so nothing but these tests and
   * the paired comments keeps them from drifting apart into "the admin nags
   * about a hero the site describes" or the reverse.
   */
  describe('heroAltOf', () => {
    it('drops an alt that only repeats the title, whatever its case or padding', () => {
      expect(heroAltOf(fakeWithAlt('Rhodos', 'Rhodos'))).toBe('');
      expect(heroAltOf(fakeWithAlt('Rhodos', '  Rhodos  '))).toBe('');
      // Every WordPress-imported post stores the title as its alt; the
      // importer does not normalise case, so "RHODOS" is the same duplicate.
      expect(heroAltOf(fakeWithAlt('Rhodos', 'RHODOS'))).toBe('');
      expect(heroAltOf(fakeWithAlt('  Rhodos', 'rhodos'))).toBe('');
    });

    it('keeps a real description of the photograph', () => {
      // `undefined` means "use the stored alt", not "no alt".
      expect(heroAltOf(fakeWithAlt('Rhodos', 'Fischerboote im Hafen von Lindos'))).toBeUndefined();
      // A superset of the title is still new information.
      expect(heroAltOf(fakeWithAlt('Rhodos', 'Rhodos bei Sonnenuntergang'))).toBeUndefined();
    });

    it('does not special-case a blank stored alt — the image simply has none', () => {
      // `undefined` here means "pass the stored alt through", and the stored
      // alt is ''. So the rendered image is still `alt=""`, and the place that
      // does something about it is the editor's audit, not this function.
      expect(heroAltOf(fakeWithAlt('Rhodos', ''))).toBeUndefined();
    });
  });

  it('filters by locale, newest first', () => {
    expect(byLocale(all, 'de').map((t) => t.id)).toEqual([
      'de/reisebericht-4-tage-bukarest',
      'de/sonne-und-abenteuer-rhodos',
    ]);
  });

  it('equal-date entries keep stable input order', () => {
    const a = fake('de/aaa', '2021-07-25', 'a');
    const b = fake('de/bbb', '2021-07-25', 'b');
    expect(byLocale([b, a], 'de').map((t) => t.id)).toEqual(['de/bbb', 'de/aaa']);
  });

  it('finds the translation pair via translationKey', () => {
    expect(translationOf(rhodesDe, all)?.id).toBe('en/sun-and-adventure-on-rhodes');
    expect(translationOf(buchDe, all)).toBeUndefined();
  });
});

describe('tripStats', () => {
  const trips = [
    fakeWithPlace('de/a', 'GR', 'europe'),
    fakeWithPlace('de/b', 'GR', 'europe'),
    fakeWithPlace('de/c', 'RO', 'europe'),
    fakeWithPlace('de/d', 'EC', 'south-america'),
  ];

  it('counts trips, distinct countries and distinct continents', () => {
    expect(tripStats(trips)).toEqual({ trips: 4, countries: 3, continents: 2 });
  });

  it('is all-zero for an empty set (no hardcoded floor)', () => {
    expect(tripStats([])).toEqual({ trips: 0, countries: 0, continents: 0 });
  });

  it('tracks published content instead of a frozen number', () => {
    const grown = [...trips, fakeWithPlace('de/e', 'US', 'north-america')];
    expect(tripStats(grown)).toEqual({ trips: 5, countries: 4, continents: 3 });
  });
});

describe('regionCounts', () => {
  const trips = [
    fakeWithPlace('de/a', 'GR', 'europe'),
    fakeWithPlace('de/b', 'RO', 'europe'),
    fakeWithPlace('de/c', 'EC', 'south-america'),
  ];

  it('counts stories per region, with a key for every region', () => {
    expect(regionCounts([...trips, fakeWithPlace('de/d', 'JP', 'asia')])).toEqual({
      europe: 2,
      asia: 1,
      africa: 0,
      'north-america': 0,
      'south-america': 1,
      oceania: 0,
      antarctica: 0,
    });
  });

  it('reports an honest 0 for a region with no stories rather than omitting it', () => {
    const counts = regionCounts([]);
    expect(Object.keys(counts)).toEqual([...regions]);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('ignores a region value outside the enum instead of inventing a bucket', () => {
    const stray = [...trips, fakeWithPlace('de/d', 'XX', 'atlantis')];
    expect(regionCounts(stray)).toEqual(regionCounts(trips));
    expect(regionCounts(stray)).not.toHaveProperty('atlantis');
  });
});

describe('liveRegions', () => {
  const trips = [
    fakeWithPlace('de/a', 'NZ', 'oceania'),
    fakeWithPlace('de/b', 'GR', 'europe'),
    fakeWithPlace('de/c', 'KE', 'africa'),
    fakeWithPlace('en/a', 'NZ', 'oceania'),
  ];

  it('returns only regions with a story in that locale, in display order', () => {
    expect(liveRegions(trips, 'de')).toEqual(['europe', 'africa', 'oceania']);
  });

  it('counts each locale on its own — a story in the other locale does not make a page', () => {
    expect(liveRegions(trips, 'en')).toEqual(['oceania']);
  });

  it('excludes every region when there are no stories', () => {
    expect(liveRegions([], 'de')).toEqual([]);
  });

  it('always includes the kept (active) region, in its display position', () => {
    expect(liveRegions(trips, 'en', 'antarctica')).toEqual(['oceania', 'antarctica']);
    expect(liveRegions(trips, 'en', 'europe')).toEqual(['europe', 'oceania']);
    expect(liveRegions(trips, 'de', 'europe')).toEqual(['europe', 'africa', 'oceania']);
  });
});

describe('statsLine', () => {
  const stats = { trips: 20, countries: 10, continents: 3 };

  it('joins the localized stat labels with the expedition separator', () => {
    expect(statsLine(stats, useTranslations('de'))).toBe('20 REISEN · 10 LÄNDER · 3 KONTINENTE');
    expect(statsLine(stats, useTranslations('en'))).toBe('20 TRIPS · 10 COUNTRIES · 3 CONTINENTS');
  });

  it.each([
    ['de', 0, '0 REISEN · 0 LÄNDER · 0 KONTINENTE'],
    ['de', 1, '1 REISE · 1 LAND · 1 KONTINENT'],
    ['de', 2, '2 REISEN · 2 LÄNDER · 2 KONTINENTE'],
    ['en', 0, '0 TRIPS · 0 COUNTRIES · 0 CONTINENTS'],
    ['en', 1, '1 TRIP · 1 COUNTRY · 1 CONTINENT'],
    ['en', 2, '2 TRIPS · 2 COUNTRIES · 2 CONTINENTS'],
  ] as const)('uses the correct grammar in %s for %d', (locale, count, expected) => {
    expect(statsLine({ trips: count, countries: count, continents: count }, useTranslations(locale)))
      .toBe(expected);
  });

  it('selects each count independently', () => {
    expect(statsLine({ trips: 2, countries: 1, continents: 1 }, useTranslations('en')))
      .toBe('2 TRIPS · 1 COUNTRY · 1 CONTINENT');
  });
});

describe('entryNumberOf', () => {
  it('numbers chronologically, oldest = 1, within the trip locale', () => {
    expect(entryNumberOf(rhodesDe, all)).toBe(1);
    expect(entryNumberOf(buchDe, all)).toBe(2);
    expect(entryNumberOf(rhodesEn, all)).toBe(1);
  });

  it('returns 0 when the trip is missing from the pool', () => {
    expect(entryNumberOf(rhodesDe, [buchDe])).toBe(0);
  });
});
