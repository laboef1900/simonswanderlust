import { describe, expect, it } from 'vitest';
import { memoryPostStore, PostError, validateDraft, validateForPublish, type PostPair } from '../src/posts.js';

function pair(overrides: Partial<PostPair> = {}): PostPair {
  const loc = (locale: 'de' | 'en', slug: string, title: string) => ({
    locale, slug, title, excerpt: 'x',
    heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'a' },
    bodyMarkdown: '## Hi', images: {},
  });
  return {
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', country: 'Rumänien', countryCode: 'RO', region: 'europe', coordinates: { lat: 44.4, lng: 26.1 } },
    de: loc('de', 'bukarest', 'Bukarest'), en: loc('en', 'bucharest', 'Bucharest'),
    ...overrides,
  };
}

describe('memoryPostStore', () => {
  it('creates a pair with a generated translationKey and lists it', async () => {
    const s = memoryPostStore();
    const created = await s.upsertDraft(pair());
    expect(created.translationKey).toMatch(/.+/);
    const list = await s.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ titleDe: 'Bukarest', slugDe: 'bukarest', slugEn: 'bucharest', status: 'draft' });
  });

  it('get returns the full pair; update preserves the key', async () => {
    const s = memoryPostStore();
    const created = await s.upsertDraft(pair());
    const updated = await s.upsertDraft({ ...created, de: { ...created.de, title: 'Bukarest 2' } });
    expect(updated.translationKey).toBe(created.translationKey);
    expect((await s.get(created.translationKey))?.de.title).toBe('Bukarest 2');
  });

  it('publish flips both rows to published', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.publish(c.translationKey);
    expect((await s.get(c.translationKey))?.status).toBe('published');
  });

  it('rejects changing a slug once published', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.publish(c.translationKey);
    await expect(s.upsertDraft({ ...c, status: 'published', de: { ...c.de, slug: 'renamed' } }))
      .rejects.toBeInstanceOf(PostError);
  });

  it('rejects a duplicate (locale, slug) across posts', async () => {
    const s = memoryPostStore();
    await s.upsertDraft(pair());
    await expect(s.upsertDraft(pair({ de: { ...pair().de, slug: 'bukarest' }, en: { ...pair().en, slug: 'other' } })))
      .rejects.toBeInstanceOf(PostError);
  });
});

describe('post validation', () => {
  it('draft requires only a DE title and valid slugs', () => {
    expect(() => validateDraft(pair({ de: { ...pair().de, title: '' } }))).toThrow(PostError);
    expect(() => validateDraft(pair({ de: { ...pair().de, slug: 'Bad Slug' } }))).toThrow(PostError);
    expect(() => validateDraft(pair())).not.toThrow();
  });
  it('publish requires both locales complete and schema-valid', () => {
    expect(() => validateForPublish(pair())).not.toThrow();
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, countryCode: 'ROU' } }))).toThrow(PostError);
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, region: 'mars' as never } }))).toThrow(PostError);
    expect(() => validateForPublish(pair({ en: { ...pair().en, excerpt: '' } }))).toThrow(PostError);
    expect(() => validateForPublish(pair({ de: { ...pair().de, heroImage: { ...pair().de.heroImage, alt: '' } } }))).toThrow(PostError);
  });
  it('publish rejects out-of-range coordinates', () => {
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, coordinates: { lat: 91, lng: 0 } } }))).toThrow(/lat/);
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, coordinates: { lat: -91, lng: 0 } } }))).toThrow(/lat/);
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, coordinates: { lat: 0, lng: 181 } } }))).toThrow(/lng/);
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, coordinates: { lat: 0, lng: -181 } } }))).toThrow(/lng/);
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, coordinates: { lat: NaN, lng: 0 } } }))).toThrow(PostError);
    // boundary values are valid
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, coordinates: { lat: -90, lng: 180 } } }))).not.toThrow();
  });
  it('publish throws PostError (not TypeError) when heroImage is missing', () => {
    const noHero = pair({ de: { ...pair().de, heroImage: undefined as never } });
    expect(() => validateForPublish(noHero)).toThrow(PostError);
    expect(() => validateForPublish(noHero)).not.toThrow(TypeError);
  });
});

describe('upsertDraft fills NOT-NULL defaults on a partial draft', () => {
  it('defaults missing coordinates and heroImage so a partial save cannot NULL a column', async () => {
    const store = memoryPostStore();
    // A payload the editor can produce for an imported draft (coords blanked):
    // coordinates and heroImage omitted entirely.
    const partial = {
      translationKey: '',
      status: 'draft',
      shared: { date: '2024-09-29', country: '', countryCode: 'XX', region: 'europe' },
      de: { locale: 'de', slug: 'partial-de', title: 'X', excerpt: '', bodyMarkdown: '', images: {} },
      en: { locale: 'en', slug: 'partial-en', title: 'Y', excerpt: '', bodyMarkdown: '', images: {} },
    } as unknown as PostPair;
    const saved = await store.upsertDraft(partial);
    expect(saved.shared.coordinates).toEqual({ lat: 0, lng: 0 });
    expect(saved.de.heroImage).toEqual({ src: '', width: 0, height: 0, alt: '' });
    expect(saved.en.heroImage).toEqual({ src: '', width: 0, height: 0, alt: '' });
  });
});
