import { describe, expect, it, vi } from 'vitest';
import { memoryPageStore, validatePagePair, isSafePageKey, PageError, type PagePair } from '../src/pages.js';
import { REVISION_CAP } from '../src/posts.js';
import * as bodyContent from '../src/body-content.js';

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

  it.each([false, true])('preserves malformed metadata in both locales with existing images=%s', async (existingImages) => {
    const store = memoryPageStore();
    const input = pair();
    const fields = [
      String.raw`caption="The \"Old\" Bridge"`, 'caption="Rom | Tag 2"',
      'capton="Tippfehler"', 'alt = "Blick mit Leerzeichen"', "alt='Blick'",
      'caption-override="broken',
    ];
    const lines = fields.map((field, index) => `> ${a}-${index} | 3000x2000 | alt="😀" | ${field}  `);
    for (const locale of ['de', 'en'] as const) {
      input[locale].bodyMarkdown = ['> ~~~gallery extra', ...lines, '> ~~~'].join('\r\n');
      input[locale].images = existingImages
        ? Object.fromEntries(fields.map((_, index) => [`${a}-${index}`, { width: 8, height: 6, caption: 'Keep' }]))
        : {};
    }
    const saved = await store.save(input);
    expect(saved.de).toEqual(input.de);
    expect(saved.en).toEqual(input.en);
    expect(saved.galleryWarnings).toHaveLength(fields.length * 2);
    for (const locale of ['de', 'en'] as const) {
      expect(saved.galleryWarnings.filter((warning) => warning.locale === locale).map((warning) => warning.line))
        .toEqual(fields.map((_, index) => index + 2));
    }
    expect(saved.galleryWarnings[0]).toEqual({
      code: 'invalid_gallery_metadata', locale: 'de', line: 2,
      column: lines[0]!.indexOf('caption=') + 1, field: 'caption', reason: 'malformed_field',
    });
    expect(await store.get(input.key)).not.toHaveProperty('galleryWarnings');
    const again = await store.save(saved);
    expect(again.galleryWarnings).toEqual(saved.galleryWarnings);
    const before = await store.get(input.key);
    expect(before).not.toHaveProperty('galleryWarnings');
    await expect(store.save(saved, new Date(0))).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.get(input.key)).toEqual(before);
    const [revision] = await store.listRevisions(input.key);
    expect((await store.getRevision(input.key, revision!.id))!.snapshot).not.toHaveProperty('galleryWarnings');
    const repaired = await store.save({ ...again, de: { ...again.de, bodyMarkdown: 'Fixed' }, en: { ...again.en, bodyMarkdown: 'Fixed' } });
    expect(repaired.galleryWarnings).toEqual([]);
  });

  it('normalizes nested and raw gallery nodes through direct saves in both locales', async () => {
    const store = memoryPageStore();
    const input = pair();
    input.de.bodyMarkdown = `- ~~~gallery extra\n  ${a} | 30x20 | alt="Blick"\n  ~~~`;
    input.en.bodyMarkdown = `<pre><code class="language-gallery">${a} | 30x20 | alt="View"\n</code></pre>`;
    const saved = await store.save(input);
    expect(saved.de.bodyMarkdown).toBe(`- ~~~gallery extra\n  ${a}\n  ~~~`);
    expect(saved.en.bodyMarkdown).toBe(`<pre><code class="language-gallery">${a}\n</code></pre>`);
    expect(saved.de.images[a]).toEqual({ width: 30, height: 20, alt: 'Blick' });
    expect(saved.en.images[a]).toEqual({ width: 30, height: 20, alt: 'View' });
  });

  it('leaves both locales, timestamp and revisions untouched after later locale analysis fails', async () => {
    const store = memoryPageStore();
    const saved = await store.save(pair());
    const input = { ...saved, de: { ...saved.de, bodyMarkdown: `~~~gallery\n${a} | 30x20\n~~~` }, en: { ...saved.en, bodyMarkdown: 'EN analysis failure' } };
    const normalize = bodyContent.normalizeGalleryFences;
    const analysis = vi.spyOn(bodyContent, 'normalizeGalleryFences').mockImplementation((body, images) => {
      if (body === input.en.bodyMarkdown) return Promise.reject(new Error('source mapping unavailable'));
      return normalize(body, images);
    });
    try {
      await expect(store.save(input)).rejects.toThrow('source mapping unavailable');
      const { galleryWarnings, ...stored } = saved;
      expect(galleryWarnings).toEqual([]);
      expect(await store.get(saved.key)).toEqual(stored);
      expect(await store.listRevisions(saved.key)).toEqual([]);
      expect(input.de.images).toEqual({});
    } finally { analysis.mockRestore(); }
  });

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
  it('returns an empty-but-valid pair with no updatedAt before any save', async () => {
    const s = memoryPageStore();
    const p = await s.get('about');
    expect(p).toEqual({
      key: 'about',
      de: { locale: 'de', title: '', bodyMarkdown: '', images: {} },
      en: { locale: 'en', title: '', bodyMarkdown: '', images: {} },
      updatedAt: null,
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

  it('refuses a save whose updatedAt echo predates the stored pair (conflict), and advances updatedAt on every save (#141)', async () => {
    const s = memoryPageStore();
    const v1 = await s.save(pair());
    expect(v1.updatedAt).toBeInstanceOf(Date);
    // No echo → no check (first save of a key, scripted callers).
    const v2 = await s.save({ ...pair(), de: { ...pair().de, title: 'v2' } });
    expect(v2.updatedAt!.getTime()).toBeGreaterThan(v1.updatedAt!.getTime());
    // Current echo → accepted; stale echo → conflict and nothing written.
    const v3 = await s.save({ ...pair(), de: { ...pair().de, title: 'v3' } }, v2.updatedAt!);
    await expect(s.save({ ...pair(), de: { ...pair().de, title: 'lost' } }, v1.updatedAt!)).rejects.toMatchObject({ code: 'conflict' });
    expect((await s.get('about')).de.title).toBe('v3');
    expect((await s.get('about')).updatedAt).toEqual(v3.updatedAt);
  });

  it('overlapping saves from one updatedAt: exactly one is accepted, the other conflicts and writes nothing (#344)', async () => {
    const s = memoryPageStore();
    const base = await s.save(pair());
    const edit = (title: string): PagePair => ({ ...pair(), de: { ...pair().de, title } });
    // Both calls start before either settles — two tabs saving at once.
    const [a, b] = await Promise.allSettled([s.save(edit('tab-a'), base.updatedAt!), s.save(edit('tab-b'), base.updatedAt!)]);
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } });
    if (a.status !== 'fulfilled') throw new Error('first save was refused');
    const stored = await s.get('about');
    expect(stored.de.title).toBe('tab-a');
    expect(a.value).toEqual({ ...stored, galleryWarnings: [] });
    expect(a.value.updatedAt!.getTime()).toBeGreaterThan(base.updatedAt!.getTime());
    // One revision: the true predecessor, taken once.
    expect((await s.listRevisions('about')).map((r) => r.titleDe)).toEqual(['Über mich']);
  });

  it('overlapping token-less saves are both accepted in order, and the overwritten one is a revision (#344)', async () => {
    const s = memoryPageStore();
    const edit = (title: string): PagePair => ({ ...pair('fresh'), de: { ...pair('fresh').de, title } });
    const [a, b] = await Promise.all([s.save(edit('first')), s.save(edit('second'))]);
    expect(a.de.title).toBe('first');
    expect(b.de.title).toBe('second');
    expect(b.updatedAt!.getTime()).toBeGreaterThan(a.updatedAt!.getTime());
    expect({ ...await s.get('fresh'), galleryWarnings: [] }).toEqual(b);
    const revs = await s.listRevisions('fresh');
    expect(revs.map((r) => r.titleDe)).toEqual(['first']);
    expect((await s.getRevision('fresh', revs[0]!.id))!.snapshot.de.title).toBe('first');
  });

  it('snapshots the pre-save pair as a revision, newest first, capped at REVISION_CAP (#141)', async () => {
    const s = memoryPageStore();
    await s.save(pair());
    expect(await s.listRevisions('about')).toEqual([]); // creating a key is not an overwrite
    for (let i = 1; i <= REVISION_CAP + 2; i++) {
      await s.save({ ...pair(), de: { ...pair().de, title: `v${i}`, bodyMarkdown: `body ${i}` } });
    }
    const revs = await s.listRevisions('about');
    expect(revs).toHaveLength(REVISION_CAP);
    // The newest revision is the state the LAST save overwrote (v21), the
    // oldest survivors dropped the seed and v1.
    expect(revs[0]!.titleDe).toBe(`v${REVISION_CAP + 1}`);
    expect(revs[REVISION_CAP - 1]!.titleDe).toBe('v2');
    const full = await s.getRevision('about', revs[0]!.id);
    expect(full!.snapshot).toEqual({ de: { ...pair().de, title: `v${REVISION_CAP + 1}`, bodyMarkdown: `body ${REVISION_CAP + 1}` }, en: pair().en });
    expect(await s.getRevision('about', 'nope')).toBeNull();
    expect(await s.getRevision('other', revs[0]!.id)).toBeNull();
  });
});
