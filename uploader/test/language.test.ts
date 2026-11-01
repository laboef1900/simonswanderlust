import { describe, expect, it } from 'vitest';
import { languageFromRow, memoryLanguageStore, validateLanguage } from '../src/language.js';
import { memoryPageStore } from '../src/pages.js';
import { memorySiteIdentityStore } from '../src/site-identity.js';
import { neutralIdentity } from '../../site/src/lib/site-identity.js';

describe('language configuration integrity', () => {
  it.each([null, {}, { primary: 'fr', locales: ['fr'] }, { primary: 'en', locales: ['de'] },
    { primary: 'de', locales: ['de', 'de'] }, { primary: 'de', locales: [] }, { primary: 'de', locales: ['de', 'en', 'en'] }])('rejects malformed mode %j', (input) => {
    expect(() => validateLanguage(input)).toThrow();
  });
  it('canonicalizes bilingual order without changing membership', () => {
    expect(validateLanguage({ primary: 'en', locales: ['de', 'en'] })).toEqual({ primary: 'en', locales: ['en', 'de'] });
  });
  it('refuses invalid persisted timestamps instead of defaulting the mode', () => {
    expect(() => languageFromRow({ primary_locale: 'en', enabled_locales: ['en'], locked_at: null, updated_at: 'invalid' })).toThrow();
  });
  it('does not mutate mode on failed preflight, and a no-op does not invoke preflight', async () => {
    const store = memoryLanguageStore({ primary: 'de', locales: ['de'] });
    const original = await store.get();
    await expect(store.update({ primary: 'de', locales: ['de', 'en'] }, async () => { throw new Error('page images'); })).rejects.toThrow('page images');
    expect(await store.get()).toEqual(original);
    expect(await store.update({ primary: 'de', locales: ['de'] }, async () => { throw new Error('unexpected'); })).toEqual(original);
  });
  it('preserves inactive identity copy and refuses inactive-locale edits', async () => {
    const language = memoryLanguageStore({ primary: 'en', locales: ['en'] });
    const identity = memorySiteIdentityStore({ ...neutralIdentity(), tagline: { de: 'Retained', en: 'Active' } }, language);
    const edit = { siteName: 'Journal', authorName: 'Author', canonicalOrigin: null, tagline: { en: 'Edited' }, aboutRole: {}, aboutGear: {}, studioDescriptor: {}, socialLinks: [] };
    const saved = await identity.update(1, edit);
    expect(saved.identity.tagline).toEqual({ de: 'Retained', en: 'Edited' });
    await expect(identity.update(saved.revision, { ...edit, tagline: { de: 'Overwrite' } })).rejects.toMatchObject({ code: 'invalid_identity' });
    expect(identity.get()).toEqual(saved);
  });
  it('serializes publication and mode changes without changing the reviewed mode token on publication', async () => {
    const store = memoryLanguageStore({ primary: 'en', locales: ['en'] });
    const original = await store.get();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const publication = store.runExclusive(async () => {
      entered.resolve();
      await release.promise;
      await store.markPublished();
    });
    await entered.promise;
    const change = store.update({ primary: 'de', locales: ['de'] });
    release.resolve();
    await publication;
    await expect(change).rejects.toMatchObject({ code: 'language_primary_locked' });
    expect((await store.get()).updatedAt).toEqual(original.updatedAt);
    expect((await store.get()).lockedAt).toBeInstanceOf(Date);
    await store.update({ primary: 'en', locales: ['en', 'de'] });
    await expect(store.update({ primary: 'en', locales: ['en'] })).rejects.toMatchObject({ code: 'language_locale_published' });
  });
});

describe('About preparation preserves active content', () => {
  it.each(['de', 'en'] as const)('prepares inactive copy and projects revision titles after %s-primary', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const language = memoryLanguageStore({ primary, locales: [primary] });
    const pages = memoryPageStore(language);
    const saved = await pages.save({ key: 'about', [primary]: { locale: primary, title: 'Active', bodyMarkdown: 'Public text', images: {} } });
    const prepared = await pages.save({ key: 'about', [secondary]: { locale: secondary, title: 'Prepared', bodyMarkdown: 'Private translation', images: {} } }, saved.updatedAt!, { prepareLocale: secondary });
    expect(prepared[primary]).toEqual(saved[primary]);
    expect(prepared[secondary].bodyMarkdown).toBe('Private translation');
    await expect(pages.save({ key: 'about', [primary]: saved[primary] }, prepared.updatedAt!, { prepareLocale: secondary })).rejects.toMatchObject({ code: 'invalid_page' });
    await language.update({ primary: secondary, locales: [secondary, primary] });
    const latest = await pages.get('about');
    await pages.save({ key: 'about', [secondary]: { ...latest[secondary], title: 'Current' } }, latest.updatedAt!);
    expect((await pages.listRevisions('about'))[0]?.title).toBe('Prepared');
    const revision = (await pages.listRevisions('about'))[0]!;
    expect((await pages.getRevision('about', revision.id))?.title).toBe('Prepared');
  });
});
