import { describe, expect, it } from 'vitest';
import { parseLanguageSnapshot } from './site-language';

const modes = [
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
];
describe('build language validation', () => {
  it.each(modes)('accepts $primary / $locales', (mode) => {
    expect(parseLanguageSnapshot(JSON.stringify(mode))).toEqual(mode);
  });
  it('normalizes display order without changing membership', () => {
    expect(parseLanguageSnapshot('{"primary":"en","locales":["de","en"]}')).toEqual(modes[1]);
  });
  it('preserves the historical context for pure helpers without build input', () => {
    expect(parseLanguageSnapshot(undefined)).toEqual(modes[0]);
  });
  it.each(['', 'null', '{}', 'not-json', '{"primary":"fr","locales":["fr"]}',
    '{"primary":"de","locales":[]}', '{"primary":"en","locales":["de"]}',
    '{"primary":"de","locales":["de","de"]}', '{"primary":"de","locales":["de"],"extra":true}',
  ])('fails closed on invalid supplied input %s', (raw) => {
    expect(() => parseLanguageSnapshot(raw)).toThrow();
  });
});
