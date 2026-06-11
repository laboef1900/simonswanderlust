import { describe, expect, it } from 'vitest';
import { byLocale, entryNumberOf, localeOf, pathOf, slugOf, translationOf, type Trip } from './trips';

function fake(id: string, date: string, translationKey: string): Trip {
  return { id, data: { date: new Date(date), translationKey } } as unknown as Trip;
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

describe('entryNumberOf', () => {
  it('numbers chronologically, oldest = 1, within the trip locale', () => {
    expect(entryNumberOf(rhodesDe, all)).toBe(1);
    expect(entryNumberOf(buchDe, all)).toBe(2);
    expect(entryNumberOf(rhodesEn, all)).toBe(1);
  });
});
