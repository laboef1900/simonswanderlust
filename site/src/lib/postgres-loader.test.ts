import { describe, expect, it } from 'vitest';
import { rowToEntryInput } from '../src/lib/postgres-loader';

const row = {
  translation_key: 'bucharest-2024', locale: 'de', slug: 'reisebericht-4-tage-bukarest',
  title: 'T', date: new Date('2024-10-03'), country: 'Rumänien', country_code: 'RO', region: 'europe',
  excerpt: 'E', hero_image: { src: 'https://img/h', width: 768, height: 512, alt: 'a' },
  coordinates: { lat: 44.4, lng: 26.1 }, stops: null, route: null, key_facts: { K: 'V' },
  body_markdown: '## Hi', images: {},
};

describe('rowToEntryInput', () => {
  it('builds id as `${locale}/${slug}` and camelCase data matching the schema', () => {
    const e = rowToEntryInput(row as never);
    expect(e.id).toBe('de/reisebericht-4-tage-bukarest');
    expect(e.data.translationKey).toBe('bucharest-2024');
    expect(e.data.countryCode).toBe('RO');
    expect(e.data.heroImage).toEqual({ src: 'https://img/h', width: 768, height: 512, alt: 'a' });
    expect(e.data.keyFacts).toEqual({ K: 'V' });
    expect(e.body).toBe('## Hi');
  });
});
