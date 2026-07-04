import { describe, expect, it } from 'vitest';
import { memoryPageStore, validatePagePair, isSafePageKey, PageError, type PagePair } from '../src/pages.js';

const pair = (key = 'about'): PagePair => ({
  key,
  de: { locale: 'de', title: 'Über mich', bodyMarkdown: 'Hallo', images: {} },
  en: { locale: 'en', title: 'About me', bodyMarkdown: 'Hi', images: {} },
});

describe('page key validation', () => {
  it('accepts safe keys, rejects unsafe', () => {
    expect(isSafePageKey('about')).toBe(true);
    expect(isSafePageKey('privacy-policy')).toBe(true);
    expect(isSafePageKey('../etc')).toBe(false);
    expect(isSafePageKey('About')).toBe(false);
  });
  it('validatePagePair throws PageError on a bad key', () => {
    expect(() => validatePagePair({ ...pair(), key: 'bad key' })).toThrow(PageError);
  });
});

describe('memoryPageStore', () => {
  it('returns an empty-but-valid pair before any save', async () => {
    const s = memoryPageStore();
    const p = await s.get('about');
    expect(p).toEqual({
      key: 'about',
      de: { locale: 'de', title: '', bodyMarkdown: '', images: {} },
      en: { locale: 'en', title: '', bodyMarkdown: '', images: {} },
    });
  });
  it('round-trips a saved pair', async () => {
    const s = memoryPageStore();
    await s.save(pair());
    const p = await s.get('about');
    expect(p.de.title).toBe('Über mich');
    expect(p.en.bodyMarkdown).toBe('Hi');
  });
});
