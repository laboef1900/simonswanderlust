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

describe('page images-map validation', () => {
  // PUT /pages/:key casts the request body's `images` straight to a typed
  // record, so this is the only thing standing between author JSON and the
  // gallery render boundary — same control posts get in draftWithDefaults.
  const withImages = (images: unknown): PagePair => {
    const p = pair();
    p.de.images = images as PagePair['de']['images'];
    return p;
  };

  it('rejects a node-shaped caption', () => {
    expect(() => validatePagePair(withImages({ 'https://img/x': { width: 8, height: 6, caption: { type: 'raw', value: '<script>' } } })))
      .toThrow(/de: images.*caption must be a string/);
  });

  it('rejects non-positive-integer dimensions', () => {
    expect(() => validatePagePair(withImages({ 'https://img/x': { width: 0, height: 6 } })))
      .toThrow(/positive integer/);
  });

  it('accepts a well-formed map', () => {
    expect(() => validatePagePair(withImages({ 'https://img/x': { width: 8, height: 6, alt: 'a' } }))).not.toThrow();
  });
});

describe('page gallery normalization', () => {
  const a = 'https://img/g/a-1a2b3c4d';

  it('lifts per-line gallery metadata into the images map on save', async () => {
    const s = memoryPageStore();
    const p = pair();
    p.de.bodyMarkdown = `\`\`\`gallery\n${a} | 3000x2000 | alt="Blick" | caption="Tag 1"\n\`\`\``;
    await s.save(p);
    const saved = await s.get('about');
    expect(saved.de.bodyMarkdown).toBe(`\`\`\`gallery\n${a}\n\`\`\``);
    expect(saved.de.images[a]).toEqual({ width: 3000, height: 2000, alt: 'Blick', caption: 'Tag 1' });
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
  it('keys() lists saved page keys once each, sorted', async () => {
    const s = memoryPageStore();
    expect(await s.keys()).toEqual([]);
    await s.save(pair('imprint'));
    await s.save(pair('about'));
    await s.save(pair('about'));
    expect(await s.keys()).toEqual(['about', 'imprint']);
  });
});
