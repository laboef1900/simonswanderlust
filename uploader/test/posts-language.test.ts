import { describe, expect, it } from 'vitest';
import { memoryLanguageStore, type LanguageConfig } from '../src/language.js';
import { memoryPostStore, type Locale, type PostLocale, type PostPair } from '../src/posts.js';
import { publishTokens } from './publish-tokens.js';

const modes: LanguageConfig[] = [
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
];
function story(): PostPair {
  const locale = (locale: Locale): PostLocale => ({ locale, slug: `story-${locale}`, title: `Title ${locale}`,
    country: 'Test', excerpt: 'Excerpt', bodyMarkdown: 'Body', images: {},
    heroImage: { src: 'https://images.test/hero', width: 800, height: 600, alt: 'View' } });
  return { translationKey: '', status: 'draft', shared: { date: '2026-10-27', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: locale('de'), en: locale('en') };
}

describe.each(modes)('post coverage in $primary / $locales', (mode) => {
  it('requires the primary title, publishes only requested rows and returns primary-led summaries', async () => {
    const language = memoryLanguageStore(mode);
    const posts = memoryPostStore({ language });
    const input = story();
    input[mode.primary].title = '';
    await expect(posts.upsertDraft(input)).rejects.toMatchObject({ code: 'invalid_post' });
    input[mode.primary].title = 'Primary';
    const saved = await posts.upsertDraft(input);
    const secondary = mode.primary === 'de' ? 'en' : 'de';
    if (mode.locales.length === 1) {
      expect(saved[secondary]).toMatchObject({ omitted: true, slug: '', title: '', bodyMarkdown: '', publishedAt: null });
    }
    const titles = await posts.list();
    expect(titles[0]).toMatchObject({ title: 'Primary', secondaryStatus: mode.locales.length === 1 ? 'none' : 'started' });
    await posts.publish(saved.translationKey, await publishTokens(posts, saved.translationKey));
    expect(await posts.getPublishedLocales(saved.translationKey)).toEqual(mode.locales);
    expect((await posts.getPublishedTrack(saved.translationKey)).locales).toEqual(expect.arrayContaining(mode.locales));
    expect((await posts.get(saved.translationKey))?.status).toBe('published');
    expect((await posts.get(saved.translationKey))?.publication).toEqual({
      availability: 'available', status: 'published',
      requestedLocales: [...mode.locales].sort(), committedLocales: [...mode.locales].sort(),
      draftDiffers: false, live: { de: 'unknown', en: 'unknown' },
    });
    expect((await posts.publicationFacts())[0]).toMatchObject({
      primaryLocale: mode.primary, requestedLocales: [...mode.locales].sort(),
      committedLocales: [...mode.locales].sort(), draftDiffers: false,
    });
    expect((await language.get()).lockedAt).toBeInstanceOf(Date);
    await posts.upsertDraft({ ...saved, [mode.primary]: { ...saved[mode.primary], title: 'Edited primary' } });
    expect((await posts.listRevisions(saved.translationKey))[0]?.title).toBe('Primary');
    expect(await posts.getCmsStats!()).toMatchObject({ totalPosts: 1, publishedPosts: 1, draftPosts: 0 });
  });

  it('rejects primary omission and ignores forged publication history', async () => {
    const posts = memoryPostStore({ language: memoryLanguageStore(mode) });
    const input = story();
    input[mode.primary].omitted = true;
    await expect(posts.upsertDraft(input)).rejects.toMatchObject({ code: 'invalid_post' });
    input[mode.primary].omitted = false;
    input[mode.primary].publishedAt = new Date();
    Object.assign(input[mode.primary], { track: { version: 1, type: 'MultiLineString', coordinates: [[[2, 1], [2.01, 1.01]]] } });
    const saved = await posts.upsertDraft(input);
    expect(saved[mode.primary].publishedAt).toBeNull();
    expect(saved[mode.primary]).not.toHaveProperty('track');
    await expect(posts.upsertDraft({ ...saved, [mode.primary]: { ...saved[mode.primary], slug: 'never-published-rename' } })).resolves.toBeTruthy();
    expect((await posts.language.get()).lockedAt).toBeNull();
  });
});

describe.each(['de', 'en'] as const)('%s primary coverage lifecycle', (primary) => {
  const secondary = primary === 'de' ? 'en' : 'de';
  it('keeps un-omit + Save private until successful Publish and freezes history after unpublish', async () => {
    const language = memoryLanguageStore({ primary, locales: [primary, secondary] });
    const posts = memoryPostStore({ language });
    const input = story(); input[secondary].omitted = true; input[secondary].slug = '';
    const saved = await posts.upsertDraft(input);
    const tk = saved.translationKey;
    await posts.publish(tk, await publishTokens(posts, tk));
    expect(await posts.getPublishedLocales(tk)).toEqual([primary]);
    expect((await posts.getPublishedTrack(tk)).locales).toEqual([primary]);
    expect((await posts.publicationFacts())[0]).toMatchObject({
      primaryLocale: primary, status: 'published', requestedLocales: [primary], committedLocales: [primary], draftDiffers: false,
    });
    const translated = await posts.upsertDraft({ ...saved, [secondary]: { ...saved[secondary], omitted: false, slug: 'new-translation', bodyMarkdown: '' } });
    expect(translated.publication).toMatchObject({ availability: 'available', draftDiffers: true });
    expect(translated[secondary].publishedAt).toBeNull();
    expect((await posts.list())[0]?.secondaryStatus).toBe('empty');
    expect(await posts.getPublishedLocales(tk)).toEqual([primary]);
    await expect(posts.publish(tk, await publishTokens(posts, tk))).rejects.toThrow(/body required/);
    expect(await posts.getPublishedLocales(tk)).toEqual([primary]);
    expect((await posts.publicationFacts())[0]).toMatchObject({
      status: 'published', requestedLocales: ['de', 'en'], committedLocales: [primary], draftDiffers: true,
      rowDigest: { [secondary]: null },
    });
    const omittedAgain = await posts.upsertDraft({ ...translated, [secondary]: { ...translated[secondary], omitted: true } });
    expect(omittedAgain.publication).toMatchObject({ requestedLocales: [primary], committedLocales: [primary], draftDiffers: false });
    const complete = await posts.upsertDraft({ ...translated, [secondary]: { ...translated[secondary], bodyMarkdown: 'Translation' } });
    await expect(posts.publish(tk, await publishTokens(posts, tk), async () => { throw new Error('photo not ready'); })).rejects.toThrow('photo not ready');
    expect(await posts.getPublishedLocales(tk)).toEqual([primary]);
    expect((await posts.getPublishedTrack(tk)).locales).toEqual([primary]);
    expect((await posts.publicationFacts())[0]?.draftDiffers).toBe(true);
    await posts.publish(tk, await publishTokens(posts, tk));
    expect(await posts.getPublishedLocales(tk)).toEqual([primary, secondary]);
    expect((await posts.get(tk))?.publication).toMatchObject({ availability: 'available', draftDiffers: false });
    expect((await posts.publicationFacts())[0]).toMatchObject({
      requestedLocales: ['de', 'en'], committedLocales: ['de', 'en'], draftDiffers: false,
    });
    const revisions = await posts.listRevisions(tk);
    const old = await posts.getRevision(tk, revisions[revisions.length - 1]!.id);
    await expect(posts.upsertDraft({ ...old!.snapshot, translationKey: tk })).rejects.toMatchObject({ code: 'locale_published' });
    await posts.unpublish(tk);
    expect(await posts.getPublishedLocales(tk)).toEqual([]);
    expect((await posts.getPublishedTrack(tk)).locales).toEqual(expect.arrayContaining([primary, secondary]));
    await expect(posts.upsertDraft({ ...complete, [secondary]: { ...complete[secondary], omitted: true } })).rejects.toMatchObject({ code: 'locale_published' });
    await expect(posts.upsertDraft({ ...complete, [secondary]: { ...complete[secondary], slug: 'renamed' } })).rejects.toMatchObject({ code: 'slug_locked' });
    expect((await posts.get(tk))?.[secondary].publishedAt).toBeInstanceOf(Date);
  });

  it('preserves draft text and slugs across disable/enable without silently requesting translation', async () => {
    const language = memoryLanguageStore({ primary, locales: [primary, secondary] });
    const posts = memoryPostStore({ language });
    const saved = await posts.upsertDraft(story());
    await language.update({ primary, locales: [primary] });
    const disabled = (await posts.get(saved.translationKey))!;
    expect(disabled[secondary]).toMatchObject({ omitted: true, slug: saved[secondary].slug, bodyMarkdown: saved[secondary].bodyMarkdown });
    await posts.upsertDraft({ ...disabled, [secondary]: { ...disabled[secondary], bodyMarkdown: '' } });
    await language.update({ primary, locales: [primary, secondary] });
    expect((await posts.get(saved.translationKey))?.[secondary]).toMatchObject({ omitted: true, bodyMarkdown: saved[secondary].bodyMarkdown });
    await posts.publish(saved.translationKey, await publishTokens(posts, saved.translationKey));
    expect(await posts.getPublishedLocales(saved.translationKey)).toEqual([primary]);
  });

  it('serializes publish before a primary mode change', async () => {
    const language = memoryLanguageStore({ primary, locales: [primary, secondary] });
    const posts = memoryPostStore({ language });
    const saved = await posts.upsertDraft(story());
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const publishing = posts.publish(saved.translationKey, await publishTokens(posts, saved.translationKey), async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const changing = language.update({ primary: secondary, locales: [secondary, primary] });
    const outcome = changing.catch((error: unknown) => error);
    release.resolve();
    await publishing;
    expect(await outcome).toMatchObject({ code: 'language_primary_locked' });
    expect(await posts.getPublishedLocales(saved.translationKey)).toEqual([primary, secondary]);
  });

  it('rejects reviewed mode tokens after a serialized change without locking the install', async () => {
    const language = memoryLanguageStore({ primary, locales: [primary] });
    const posts = memoryPostStore({ language });
    const saved = await posts.upsertDraft(story());
    const tokens = await publishTokens(posts, saved.translationKey);
    await language.update({ primary, locales: [primary, secondary] });
    await expect(posts.publish(saved.translationKey, tokens)).rejects.toMatchObject({ code: 'conflict' });
    expect(await posts.getPublishedLocales(saved.translationKey)).toEqual([]);
    expect((await language.get()).lockedAt).toBeNull();
    await expect(posts.publish(saved.translationKey, await publishTokens(posts, saved.translationKey), async () => { throw new Error('image gate'); })).rejects.toThrow('image gate');
    expect((await language.get()).lockedAt).toBeNull();
    expect((await posts.getPublishedTrack(saved.translationKey)).locales).toEqual([]);
  });

  it('uses the current primary title for historical revision summaries and invalidates saves when omission changes', async () => {
    const language = memoryLanguageStore({ primary, locales: [primary, secondary] });
    const posts = memoryPostStore({ language });
    const saved = await posts.upsertDraft(story());
    const edited = await posts.upsertDraft({ ...saved, [primary]: { ...saved[primary], title: 'Edited' } });
    await language.update({ primary: secondary, locales: [secondary] });
    const revisions = await posts.listRevisions(saved.translationKey);
    expect(revisions[0]?.title).toBe(saved[secondary].title);
    expect((await posts.getRevision(saved.translationKey, revisions[0]!.id))?.title).toBe(saved[secondary].title);
    await expect(posts.upsertDraft(edited, edited.updatedAt)).rejects.toMatchObject({ code: 'conflict' });
    expect((await posts.get(saved.translationKey))?.[primary]).toMatchObject({ omitted: true, title: 'Edited', slug: saved[primary].slug });
  });

  it('rejects newly reserved root slugs without reserving the other locale namespace', async () => {
    const posts = memoryPostStore({ language: memoryLanguageStore({ primary, locales: [primary, secondary] }) });
    for (const slug of ['posts', 'map', 'de', 'en', primary === 'de' ? 'karte' : 'travel-map']) {
      const input = story(); input[primary].slug = slug;
      await expect(posts.upsertDraft(input)).rejects.toMatchObject({
        code: 'reserved_slug',
        owner: { type: ['posts', 'map'].includes(slug) ? 'app' : ['de', 'en'].includes(slug) ? 'locale' : 'site', name: slug },
      });
    }
    const input = story(); input[secondary].slug = 'posts';
    const saved = await posts.upsertDraft(input);
    const before = await posts.language.get();
    await expect(posts.language.update({ primary: secondary, locales: [secondary, primary] })).rejects.toMatchObject({ code: 'reserved_slug' });
    expect(await posts.language.get()).toEqual(before);
    expect((await posts.get(saved.translationKey))?.[secondary].slug).toBe('posts');
    await expect(posts.language.update({ primary, locales: [primary, secondary] })).resolves.toEqual(before);
    await expect(posts.upsertDraft({ ...saved, [secondary]: { ...saved[secondary], title: 'Unchanged namespace' } })).resolves.toMatchObject({ [secondary]: { slug: 'posts' } });
  });
});
