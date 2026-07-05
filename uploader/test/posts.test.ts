import { describe, expect, it } from 'vitest';
import { memoryPostStore, normalizeBodyImages, PostError, validateDraft, validateForPublish, type PostPair } from '../src/posts.js';
import { renderPostToMdx } from '../src/export.js';

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

  it('a new draft and a fresh publish report no unpublished changes', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    expect(c.hasUnpublishedChanges).toBe(false);
    expect((await s.list())[0]?.hasUnpublishedChanges).toBe(false);
    await s.publish(c.translationKey);
    expect((await s.get(c.translationKey))?.hasUnpublishedChanges).toBe(false);
    expect((await s.list())[0]?.hasUnpublishedChanges).toBe(false);
  });

  it('a draft save over a published post keeps it published but flags unpublished changes', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.publish(c.translationKey);
    const saved = await s.upsertDraft({ ...c, de: { ...c.de, bodyMarkdown: '## edited' } });
    expect(saved.status).toBe('published');
    expect(saved.hasUnpublishedChanges).toBe(true);
    const got = await s.get(c.translationKey);
    expect(got?.de.bodyMarkdown).toBe('## edited'); // editor sees the working copy
    expect(got?.hasUnpublishedChanges).toBe(true);
    expect((await s.list())[0]?.hasUnpublishedChanges).toBe(true);
  });

  it('re-publish picks up the newest working copy and clears the flag', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.publish(c.translationKey);
    await s.upsertDraft({ ...c, de: { ...c.de, bodyMarkdown: '## edited' } });
    await s.publish(c.translationKey);
    const got = await s.get(c.translationKey);
    expect(got?.de.bodyMarkdown).toBe('## edited');
    expect(got?.hasUnpublishedChanges).toBe(false);
    expect((await s.list())[0]?.hasUnpublishedChanges).toBe(false);
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

describe('normalizeBodyImages', () => {
  it('converts a JSX-attr <BodyImage> tag to a markdown image and records its dims', () => {
    const body = 'Intro\n\n<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Gasse" />\n\nMore';
    const out = normalizeBodyImages(body, {});
    expect(out.bodyMarkdown).toBe('Intro\n\n![Gasse](https://img/x/y)\n\nMore');
    expect(out.images).toEqual({ 'https://img/x/y': { width: 1600, height: 1067 } });
  });

  it('accepts quoted numeric attrs and decodes &quot; in alt (inverse of export escaping)', () => {
    const body = '<BodyImage src="https://img/a/b" width="1600" height="1067" alt="Die &quot;Gasse&quot;" />';
    const out = normalizeBodyImages(body, {});
    expect(out.bodyMarkdown).toBe('![Die "Gasse"](https://img/a/b)');
    expect(out.images).toEqual({ 'https://img/a/b': { width: 1600, height: 1067 } });
  });

  it('converts a tag without parsable dims but records no images entry', () => {
    const out = normalizeBodyImages('<BodyImage src="https://img/no/dims" alt="x" />', {});
    expect(out.bodyMarkdown).toBe('![x](https://img/no/dims)');
    expect(out.images).toEqual({});
  });

  it('leaves a src-less tag untouched', () => {
    const body = 'a <BodyImage alt="broken" /> b';
    const out = normalizeBodyImages(body, {});
    expect(out.bodyMarkdown).toBe(body);
    expect(out.images).toEqual({});
  });

  it('is idempotent: plain/already-normalized markdown passes through byte-identical, existing dims preserved', () => {
    const existing = { 'https://img/x/y': { width: 800, height: 600 } };
    const body = '## Hi\n\n![Gasse](https://img/x/y)\n';
    const once = normalizeBodyImages(body, existing);
    expect(once.bodyMarkdown).toBe(body);
    expect(once.images).toEqual(existing);
    const twice = normalizeBodyImages(once.bodyMarkdown, once.images);
    expect(twice).toEqual(once);
  });

  it('normalizes on upsertDraft (store chokepoint) and merges into existing images', async () => {
    const s = memoryPostStore();
    const p = pair();
    p.de.images = { 'https://img/pre/existing': { width: 100, height: 50 } };
    p.de.bodyMarkdown = 'Vorher\n\n<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Gasse" />';
    const saved = await s.upsertDraft(p);
    expect(saved.de.bodyMarkdown).not.toContain('<BodyImage');
    expect(saved.de.bodyMarkdown).toContain('![Gasse](https://img/x/y)');
    expect(saved.de.images).toEqual({
      'https://img/pre/existing': { width: 100, height: 50 },
      'https://img/x/y': { width: 1600, height: 1067 },
    });
    // en body had no tags — untouched
    expect(saved.en.bodyMarkdown).toBe('## Hi');
  });

  it('round-trips: MDX export reconstructs the <BodyImage> tag from the normalized pair', async () => {
    const s = memoryPostStore();
    const p = pair();
    p.de.bodyMarkdown = '<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Gasse" />';
    const saved = await s.upsertDraft(p);
    const mdx = renderPostToMdx(saved, 'de');
    expect(mdx).toContain('<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Gasse" />');
  });

  it('converts a tag whose quoted alt contains ">" (legacy exports escaped only quotes)', () => {
    const body = '<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Blick > Westen" />';
    const out = normalizeBodyImages(body, {});
    expect(out.bodyMarkdown).toBe('![Blick > Westen](https://img/x/y)');
    expect(out.images).toEqual({ 'https://img/x/y': { width: 1600, height: 1067 } });
  });

  it('does not truncate the tag on "/>" inside a quoted alt', () => {
    const body = 'a <BodyImage src="https://img/x/y" width={16} height={10} alt="x/>y" /> b';
    const out = normalizeBodyImages(body, {});
    expect(out.bodyMarkdown).toBe('a ![x/>y](https://img/x/y) b');
    expect(out.images).toEqual({ 'https://img/x/y': { width: 16, height: 10 } });
  });

  it('decodes &lt; &gt; &amp; in alt and round-trips through the MDX export escaping', async () => {
    const s = memoryPostStore();
    const p = pair();
    const alt = 'Blick <über> das "Tor" & zurück';
    p.de.bodyMarkdown = `![${alt}](https://img/x/y)`;
    p.de.images = { 'https://img/x/y': { width: 1600, height: 1067 } };
    const saved = await s.upsertDraft(p);
    const mdx = renderPostToMdx(saved, 'de');
    expect(mdx).toContain('alt="Blick &lt;über&gt; das &quot;Tor&quot; &amp; zurück"');
    const tag = mdx.match(/<BodyImage[^\n]*\/>/)?.[0] ?? '';
    const back = normalizeBodyImages(tag, {});
    expect(back.bodyMarkdown).toBe(`![${alt}](https://img/x/y)`);
    expect(back.images).toEqual({ 'https://img/x/y': { width: 1600, height: 1067 } });
  });

  it('accepts a multiline tag and the braced src={…} attribute form', () => {
    const multi = normalizeBodyImages('<BodyImage\n  src="https://img/m/l"\n  width={10}\n  height={20}\n  alt="ml"\n/>', {});
    expect(multi.bodyMarkdown).toBe('![ml](https://img/m/l)');
    expect(multi.images).toEqual({ 'https://img/m/l': { width: 10, height: 20 } });
    const braced = normalizeBodyImages('<BodyImage src={https://img/b/r} width={10} height={20} alt="b" />', {});
    expect(braced.bodyMarkdown).toBe('![b](https://img/b/r)');
    expect(braced.images).toEqual({ 'https://img/b/r': { width: 10, height: 20 } });
  });

  it('leaves malformed tags untouched rather than truncating (pinned rejected shapes)', () => {
    const nonSelfClosing = 'a <BodyImage src="https://img/x/y"></BodyImage> b';
    expect(normalizeBodyImages(nonSelfClosing, {}).bodyMarkdown).toBe(nonSelfClosing);
    const unclosedQuote = 'a <BodyImage src="https://img/x/y" alt="oops /> b';
    expect(normalizeBodyImages(unclosedQuote, {}).bodyMarkdown).toBe(unclosedQuote);
  });

  it('normalizes the EN locale through the store chokepoint too', async () => {
    const s = memoryPostStore();
    const p = pair();
    p.en.bodyMarkdown = 'Before\n\n<BodyImage src="https://img/e/n" width={10} height={20} alt="en alt" />';
    const saved = await s.upsertDraft(p);
    expect(saved.en.bodyMarkdown).toBe('Before\n\n![en alt](https://img/e/n)');
    expect(saved.en.images).toEqual({ 'https://img/e/n': { width: 10, height: 20 } });
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
