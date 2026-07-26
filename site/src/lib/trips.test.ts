import { describe, expect, it } from 'vitest';
import { useTranslations } from '../i18n/ui';
import {
  byLocale,
  entryNumberOf,
  localeOf,
  pathOf,
  slugOf,
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

describe('statsLine', () => {
  const stats = { trips: 20, countries: 10, continents: 3 };

  it('joins the localized stat labels with the expedition separator', () => {
    expect(statsLine(stats, useTranslations('de'))).toBe('20 REISEN · 10 LÄNDER · 3 KONTINENTE');
    expect(statsLine(stats, useTranslations('en'))).toBe('20 TRIPS · 10 COUNTRIES · 3 CONTINENTS');
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
