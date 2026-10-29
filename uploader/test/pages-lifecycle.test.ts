import { describe, expect, it } from 'vitest';
import { memoryLanguageStore } from '../src/language.js';
import { memoryPostStore, type PostLocale, type PostPair } from '../src/posts.js';
import { memoryPageStore, type PagePair } from '../src/pages.js';
import { DEFAULT_NAVIGATION } from '../../site/src/lib/navigation.js';

const content = (locale: 'de' | 'en', slug = `${locale}-contact`) => ({ locale, title: 'Contact', bodyMarkdown: 'Contact details.', images: {}, slug });
const page = (key = 'contact'): PagePair => ({ key, de: content('de'), en: content('en') });
function story(slug: string): PostPair {
  const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: locale === 'de' ? slug : 'en-' + slug, title: 'Story', excerpt: 'An excerpt', country: 'Test', bodyMarkdown: 'A story', images: {}, heroImage: { src: 'https://images.test/hero', width: 800, height: 600, alt: 'View' } });
  return { translationKey: '', status: 'draft', shared: { date: '2026-10-29', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') };
}
function fixture() {
  const language = memoryLanguageStore(); const posts = memoryPostStore({ language });
  const navigation = { config: structuredClone(DEFAULT_NAVIGATION), updatedAt: new Date(0) };
  const pages = memoryPageStore(language, { imageOrigin: 'https://images.test', navigation });
  return { language, posts, pages, navigation };
}

describe('closed page lifecycle', () => {
  it('keeps About fixed, rejects unknown kinds, and allows a draft without complete content', async () => {
    const { pages } = fixture();
    await expect(pages.save(page('anything'))).rejects.toMatchObject({ code: 'unknown_page_kind' });
    await expect(pages.save(page('about'))).rejects.toMatchObject({ code: 'page_slug_locked' });
    const about = await pages.save({ key: 'about', de: { ...content('de', ''), title: '', bodyMarkdown: '' }, en: { ...content('en', ''), title: '', bodyMarkdown: '' } });
    expect(about.status).toBe('published');
    for (const action of ['remove', 'unpublish'] as const) await expect(pages[action]('about')).rejects.toMatchObject({ code: 'page_fixed' });
    expect(await pages.get('about')).toEqual(about);
    const draft = await pages.save({ key: 'contact', de: { ...content('de', ''), bodyMarkdown: '' } });
    expect(draft.status).toBe('draft');
    await expect(pages.publish('contact')).rejects.toMatchObject({ code: 'invalid_page' });
    expect(await pages.get('contact')).toEqual(draft);
    expect(await pages.listRevisions('contact')).toEqual([]);
  });

  it.each(['admin', 'settings', 'karte', 'uber-mich', 'en', 'de', 'feed'])('refuses page reservation %s with owner identity', async (slug) => {
    const { pages } = fixture();
    await expect(pages.save({ ...page(), de: content('de', slug) })).rejects.toMatchObject({ code: 'reserved_slug', owner: { name: expect.any(String) } });
    expect(await pages.keys()).toEqual([]);
  });

  it('enforces both creation orders without disclosing draft titles', async () => {
    const { pages, posts } = fixture();
    const existing = await posts.upsertDraft(story('taken'));
    await expect(pages.save({ ...page(), de: content('de', 'taken') })).rejects.toMatchObject({ code: 'reserved_slug', owner: { type: 'story', name: existing.translationKey } });
    await pages.save(page());
    await expect(posts.upsertDraft(story('de-contact'))).rejects.toMatchObject({ code: 'reserved_slug', owner: { type: 'page', name: 'contact' } });
    await expect(pages.save({ ...page('privacy'), en: content('en', 'another') })).rejects.toMatchObject({ code: 'reserved_slug', owner: { type: 'page', name: 'contact' } });
    const allowed = await posts.upsertDraft({ ...story('different'), en: { ...story('different').en, slug: 'de-contact' } });
    expect(allowed.en.slug).toBe('de-contact');
  });

  it('locks per-locale publication history through unpublish and cleans revisions/nav on delete', async () => {
    const { pages, navigation, posts } = fixture();
    const initial = await pages.save(page());
    const published = await pages.publish('contact', initial.updatedAt!);
    expect(published.de.publishedAt).toBeInstanceOf(Date);
    await expect(pages.save({ key: 'contact', de: content('de') }, new Date(initial.updatedAt!.getTime() + 60_000))).rejects.toMatchObject({ code: 'conflict' });
    const draft = await pages.unpublish('contact', published.updatedAt!);
    await expect(pages.save({ key: 'contact', de: content('de', 'renamed') }, draft.updatedAt!)).rejects.toMatchObject({ code: 'page_slug_locked' });
    const revision = (await pages.listRevisions('contact'))[0]!;
    navigation.config.footer.push({ kind: 'page', target: 'contact', label: { en: 'Contact author' } });
    const referring = story('reader'); referring.de.bodyMarkdown = '[Contact](/de-contact/)'; await posts.upsertDraft(referring);
    const info = await pages.removalInfo('contact');
    expect(info.navigation).toEqual([{ slot: 'footer', index: 1, label: { en: 'Contact author' } }]);
    expect(info.revisions).toBe(2);
    expect(info.bodyReferences).toBe(1);
    await pages.remove('contact', draft.updatedAt!);
    expect(await pages.getRevision('contact', revision.id)).toBeNull();
    expect(await pages.listRevisions('contact')).toEqual([]);
    expect(navigation.config.footer).toEqual([{ kind: 'page', target: 'about' }]);
    await expect(pages.save(page(), draft.updatedAt!)).rejects.toMatchObject({ code: 'not_found' });
    expect((await posts.upsertDraft(story('de-contact'))).de.slug).toBe('de-contact');
  });

  it.each(['![x](https://foreign.test/a.jpg)', '```gallery\nhttps://foreign.test/a | 800x600 | alt="A"\n```'])('rejects foreign rendered images on publish and every live/revision save (%s)', async (bodyMarkdown) => {
    const { pages } = fixture(); const input = page(); input.de.bodyMarkdown = bodyMarkdown;
    const draft = await pages.save(input);
    await expect(pages.publish('contact')).rejects.toMatchObject({ code: 'foreign_images', locale: 'de', foreignImages: ['https://foreign.test/a' + (bodyMarkdown.startsWith('!') ? '.jpg' : '')] });
    expect(await pages.get('contact')).toEqual(draft);
    const clean = await pages.save(page()); await pages.publish('contact', clean.updatedAt!);
    const before = await pages.get('contact'); const revisions = await pages.listRevisions('contact');
    await expect(pages.save(input, before.updatedAt!)).rejects.toMatchObject({ code: 'foreign_images' });
    expect(await pages.get('contact')).toEqual(before); expect(await pages.listRevisions('contact')).toEqual(revisions);
    const unsafe = (await pages.getRevision('contact', revisions.at(-1)!.id))!;
    expect(unsafe.snapshot.de.bodyMarkdown).toContain('foreign.test');
    await expect(pages.save({ key: 'contact', ...unsafe.snapshot })).rejects.toMatchObject({ code: 'foreign_images' });
  });

  it.each(['de', 'en'] as const)('prepares inactive %s-primary pages in stages, stamps only on activation and preserves primary URLs', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const language = memoryLanguageStore({ primary, locales: [primary] });
    const pages = memoryPageStore(language, { imageOrigin: 'https://images.test' });
    const draft = await pages.save({ key: 'contact', [primary]: content(primary) });
    const published = await pages.publish('contact', draft.updatedAt!);
    expect(published[secondary].publishedAt).toBeNull();
    const before = await language.get();
    const activate = () => language.update({ primary, locales: [primary, secondary] }, (mode) => pages.prepareActivation(mode));
    await expect(activate()).rejects.toMatchObject({ code: 'language_pages_incomplete' });
    expect(await language.get()).toEqual(before);
    const partial = await pages.save({ key: 'contact', [secondary]: { ...content(secondary, ''), bodyMarkdown: '' } }, published.updatedAt!, { prepareLocale: secondary });
    expect(partial[primary]).toEqual(published[primary]); expect(partial[secondary].publishedAt).toBeNull();
    await expect(activate()).rejects.toMatchObject({ code: 'language_pages_incomplete' });
    await pages.save({ key: 'contact', [secondary]: content(secondary) }, partial.updatedAt!, { prepareLocale: secondary });
    await activate();
    const active = await pages.get('contact'); expect(active[secondary].publishedAt).toBeInstanceOf(Date);
    expect(active[primary]).toEqual(published[primary]);
    await expect(pages.save({ key: 'contact', [secondary]: content(secondary, 'changed') })).rejects.toMatchObject({ code: 'page_slug_locked' });
  });
});
