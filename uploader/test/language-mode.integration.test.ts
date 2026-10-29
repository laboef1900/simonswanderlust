import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { pgLanguageStore, type LanguageConfig } from '../src/language.js';
import { pgPostStore, type Locale, type PostLocale, type PostPair } from '../src/posts.js';
import { publicUrlSet } from '../src/public-paths.js';
import { pgGpxStore } from '../src/gpx-store.js';
import { createPublicTrackWorker, type PublicTrackWorker } from '../src/gpx-public-worker.js';
import { publishTokens } from './publish-tokens.js';

const url = process.env.TEST_DATABASE_URL;
const modes: LanguageConfig[] = [
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
];
function story(): PostPair {
  const id = randomUUID();
  const locale = (locale: Locale): PostLocale => ({ locale, slug: `story-${locale}-${id}`, title: `Title ${locale}`,
    country: 'Test', excerpt: 'Excerpt', bodyMarkdown: 'Body', images: {},
    heroImage: { src: 'https://images.test/hero', width: 800, height: 600, alt: 'View' } });
  return { translationKey: '', status: 'draft', shared: { date: '2026-10-27', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') };
}
interface Row { locale: Locale; slug: string; status: string; omitted: boolean; published_at: Date | null; published_snapshot: unknown | null }

(url ? describe : describe.skip)('language-mode storage and publication transactions', () => {
  let owner: DbPool; let pool: DbPool; let schema: string; let worker: PublicTrackWorker;
  beforeAll(async () => { owner = new pg.Pool({ connectionString: url }); worker = createPublicTrackWorker(); });
  beforeEach(async () => {
    schema = `language_mode_${randomUUID().replaceAll('-', '')}`;
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await ensureSchema(pool);
  });
  afterEach(async () => { await pool?.end(); if (schema) await owner.query(`DROP SCHEMA ${schema} CASCADE`); });
  afterAll(async () => { await worker?.close(); await owner?.end(); });
  async function rows(tk: string): Promise<Row[]> {
    return (await pool.query<Row>('SELECT locale,slug,status,omitted,published_at,published_snapshot FROM posts WHERE translation_key=$1 ORDER BY locale', [tk])).rows;
  }

  it('keeps no-op saves and reverted edits clean while preserving revisions and snapshot identity', async () => {
    const posts = pgPostStore(pool);
    const saved = await posts.upsertDraft(story()); const tk = saved.translationKey;
    await posts.publish(tk, await publishTokens(posts, tk));
    const original = (await posts.get(tk))!;
    const originalFacts = (await posts.publicationFacts())[0]!;
    const noOp = await posts.upsertDraft(original);
    expect(noOp.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
    expect(await posts.listRevisions(tk)).toHaveLength(1);
    expect(noOp.publication).toMatchObject({ availability: 'available', draftDiffers: false });
    expect(await posts.publicationFacts()).toEqual([originalFacts]);
    for (const edit of [
      { ...original, de: { ...original.de, bodyMarkdown: 'Changed body' } },
      { ...original, en: { ...original.en, title: 'Changed title' } },
      { ...original, shared: { ...original.shared, featured: true } },
      { ...original, shared: { ...original.shared, tags: ['changed'] } },
      { ...original, shared: { ...original.shared, categories: ['changed'] } },
      { ...original, shared: { ...original.shared, scheduledAt: '2027-01-01T00:00:00Z' } },
      { ...original, de: { ...original.de, titleImage: original.de.heroImage } },
    ]) {
      expect((await posts.upsertDraft(edit)).publication).toMatchObject({ draftDiffers: true });
      expect((await posts.list())[0]?.publication).toMatchObject({ draftDiffers: true });
      expect((await posts.publicationFacts())[0]).toMatchObject({ draftDiffers: true, rowDigest: originalFacts.rowDigest });
      expect((await posts.upsertDraft(original)).publication).toMatchObject({ draftDiffers: false });
      expect(await posts.publicationFacts()).toEqual([originalFacts]);
    }
    expect((await posts.upsertDraft({ ...original, shared: { ...original.shared, commentsEnabled: false } })).publication)
      .toMatchObject({ draftDiffers: false });
    expect(originalFacts.rowDigest).toEqual({ de: expect.stringMatching(/^[a-f0-9]{64}$/), en: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(noOp.publication).not.toHaveProperty('rowDigest');
  });

  it('compares legacy snapshots against absence defaults and excludes transformed track geometry', async () => {
    const posts = pgPostStore(pool);
    const saved = await posts.upsertDraft(story()); const tk = saved.translationKey;
    await posts.publish(tk, await publishTokens(posts, tk));
    await pool.query(`UPDATE posts SET published_snapshot =
      (published_snapshot - ARRAY['title_image','featured','categories','tags','scheduled_at']::text[])
      || '{"track":{"version":1}}'::jsonb WHERE translation_key=$1`, [tk]);
    const original = (await posts.get(tk))!;
    expect(original.publication).toMatchObject({ draftDiffers: false });
    expect((await posts.list())[0]?.publication).toMatchObject({ draftDiffers: false });
    for (const edit of [
      { ...original, shared: { ...original.shared, featured: true } },
      { ...original, shared: { ...original.shared, categories: ['changed'] } },
      { ...original, shared: { ...original.shared, tags: ['changed'] } },
      { ...original, shared: { ...original.shared, scheduledAt: '2027-01-01T00:00:00Z' } },
      { ...original, de: { ...original.de, titleImage: original.de.heroImage } },
    ]) {
      expect((await posts.upsertDraft(edit)).publication).toMatchObject({ draftDiffers: true });
      expect((await posts.upsertDraft(original)).publication).toMatchObject({ draftDiffers: false });
    }
  });

  it('marks replacing and removing a private route pending until publication', async () => {
    const posts = pgPostStore(pool, { publicTrackWorker: worker });
    const routes = pgGpxStore(pool);
    const saved = await posts.upsertDraft(story()); const tk = saved.translationKey;
    const geometry = { version: 1 as const, segments: [{ points: [{ lng: 2, lat: 1 }, { lng: 2.01, lat: 1.01 }] }] };
    const source = { translationKey: tk, sourceId: randomUUID(), sha256: 'a'.repeat(64), bytes: 100 };
    const first = await routes.attach(tk, { baseVersion: null, baseUpdatedAt: saved.updatedAt.toISOString() }, geometry, source, false);
    await posts.publish(tk, await publishTokens(posts, tk));
    expect((await posts.publicationFacts())[0]?.draftDiffers).toBe(false);
    const beforeReplace = (await posts.get(tk))!;
    const replaced = await routes.attach(tk, { baseVersion: first.version, baseUpdatedAt: beforeReplace.updatedAt.toISOString() },
      geometry, { ...source, sourceId: randomUUID() }, true);
    expect((await posts.get(tk))?.publication).toMatchObject({ draftDiffers: true });
    expect((await posts.list())[0]?.publication).toMatchObject({ draftDiffers: true });
    await posts.publish(tk, await publishTokens(posts, tk));
    expect((await posts.publicationFacts())[0]?.draftDiffers).toBe(false);
    const beforeRemove = (await posts.get(tk))!;
    await routes.detach(tk, { baseVersion: replaced.version, baseUpdatedAt: beforeRemove.updatedAt.toISOString() });
    expect((await posts.get(tk))?.publication).toMatchObject({ draftDiffers: true });
    expect((await posts.publicationFacts())[0]?.draftDiffers).toBe(true);
    await posts.publish(tk, await publishTokens(posts, tk));
    expect((await posts.publicationFacts())[0]?.draftDiffers).toBe(false);
  });

  it('does not report available publication when the published primary lacks a committed snapshot', async () => {
    const posts = pgPostStore(pool);
    const saved = await posts.upsertDraft(story()); const tk = saved.translationKey;
    await posts.publish(tk, await publishTokens(posts, tk));
    await pool.query("UPDATE posts SET published_snapshot=NULL WHERE translation_key=$1 AND locale='de'", [tk]);
    expect((await posts.get(tk))?.publication).toEqual({ availability: 'unavailable' });
    expect((await posts.list())[0]?.publication).toEqual({ availability: 'unavailable' });
    expect((await posts.publicationFacts())[0]).toMatchObject({
      primaryLocale: 'de', status: 'published', committedLocales: ['en'], rowDigest: { de: null },
    });
  });

  it.each(['de', 'en'] as const)('refuses reassignment of a %s-secondary draft into a reserved root namespace', async (secondary) => {
    const primary = secondary === 'de' ? 'en' : 'de';
    const language = pgLanguageStore(pool);
    await language.update({ primary, locales: [primary, secondary] });
    const posts = pgPostStore(pool);
    const input = story(); input[secondary].slug = 'posts';
    const saved = await posts.upsertDraft(input);
    const beforeMode = await language.get(); const beforeRows = await rows(saved.translationKey);
    await expect(language.update({ primary: secondary, locales: [secondary, primary] })).rejects.toMatchObject({ code: 'reserved_slug' });
    expect(await language.get()).toEqual(beforeMode);
    expect(await rows(saved.translationKey)).toEqual(beforeRows);
    await expect(language.update({ primary, locales: [primary, secondary] })).resolves.toEqual(beforeMode);
    // Same namespace, same existing slug: ordinary editing is not blocked.
    await expect(posts.upsertDraft({ ...saved, [secondary]: { ...saved[secondary], title: 'Edited translation' } })).resolves.toMatchObject({ [secondary]: { slug: 'posts' } });
  });

  it('grandfathers an unchanged root slug but does not allow another new collision', async () => {
    const posts = pgPostStore(pool); const saved = await posts.upsertDraft(story());
    await pool.query("UPDATE posts SET slug='posts' WHERE translation_key=$1 AND locale='de'", [saved.translationKey]);
    const existing = (await posts.get(saved.translationKey))!;
    await expect(posts.upsertDraft({ ...existing, de: { ...existing.de, title: 'Legacy story' } })).resolves.toMatchObject({ de: { slug: 'posts' } });
    const next = story(); next.de.slug = 'settings';
    await expect(posts.upsertDraft(next)).rejects.toMatchObject({ code: 'reserved_slug', owner: { type: 'app', name: 'settings' } });
  });

  it.each(modes)('publishes the requested set and preserves every slug across bootstrap in $primary / $locales', async (mode) => {
    const language = pgLanguageStore(pool); await language.update(mode);
    const posts = pgPostStore(pool); const input = story();
    await expect(posts.upsertDraft({ ...input, [mode.primary]: { ...input[mode.primary], omitted: true } })).rejects.toMatchObject({ code: 'invalid_post' });
    await expect(posts.upsertDraft({ ...input, [mode.primary]: { ...input[mode.primary], title: '' } })).rejects.toMatchObject({ code: 'invalid_post' });
    input[mode.primary].publishedAt = new Date();
    const saved = await posts.upsertDraft(input); const tk = saved.translationKey;
    expect(saved[mode.primary].publishedAt).toBeNull();
    await posts.publish(tk, await publishTokens(posts, tk));
    expect(await posts.getPublishedLocales(tk)).toEqual(mode.locales);
    expect((await posts.get(tk))?.publication).toEqual({
      availability: 'available', status: 'published',
      requestedLocales: [...mode.locales].sort(), committedLocales: [...mode.locales].sort(),
      draftDiffers: false, live: { de: 'unknown', en: 'unknown' },
    });
    expect((await posts.publicationFacts())[0]).toMatchObject({
      primaryLocale: mode.primary, requestedLocales: [...mode.locales].sort(),
      committedLocales: [...mode.locales].sort(), draftDiffers: false,
    });
    const committed = await rows(tk);
    for (const row of committed) {
      expect(row.status).toBe(mode.locales.includes(row.locale) ? 'published' : 'draft');
      expect(row.published_snapshot === null).toBe(!mode.locales.includes(row.locale));
      expect(row.published_at === null).toBe(!mode.locales.includes(row.locale));
      expect(row.omitted).toBe(!mode.locales.includes(row.locale));
    }
    const before = committed.map(({ locale, slug }) => ({ locale, slug }));
    await ensureSchema(pool);
    expect((await rows(tk)).map(({ locale, slug }) => ({ locale, slug }))).toEqual(before);
    expect((await language.get()).lockedAt).toBeInstanceOf(Date);
    expect((await posts.list())[0]?.title).toBe(input[mode.primary].title);
    expect(await posts.getCmsStats!()).toMatchObject({ totalPosts: 1, publishedPosts: 1, draftPosts: 0 });
    await posts.unpublish(tk);
    expect(await posts.getPublishedLocales(tk)).toEqual([]);
    expect((await posts.getPublishedTrack(tk)).locales).toEqual(expect.arrayContaining(mode.locales));
    await expect(posts.upsertDraft({ ...saved, [mode.primary]: { ...saved[mode.primary], slug: 'renamed' } })).rejects.toMatchObject({ code: 'slug_locked' });
  });

  it.each(['de', 'en'] as const)('keeps the %s-primary URL set unchanged on refused transitions, including after all posts are deleted', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const language = pgLanguageStore(pool); await language.update({ primary, locales: [primary, secondary] });
    const posts = pgPostStore(pool); const saved = await posts.upsertDraft(story());
    await posts.publish(saved.translationKey, await publishTokens(posts, saved.translationKey));
    const beforeMode = await language.get(); const beforeRows = await rows(saved.translationKey);
    const beforeUrls = publicUrlSet(beforeMode, beforeRows);
    for (const [next, code] of [
      [{ primary: secondary, locales: [secondary, primary] }, 'language_primary_locked'],
      [{ primary, locales: [primary] }, 'language_locale_published'],
    ] as const) {
      await expect(language.update({ primary: next.primary, locales: [...next.locales] })).rejects.toMatchObject({ code });
      expect(await language.get()).toEqual(beforeMode);
      expect(publicUrlSet(await language.get(), await rows(saved.translationKey))).toEqual(beforeUrls);
    }
    await posts.remove(saved.translationKey);
    await expect(language.update({ primary: secondary, locales: [secondary] })).rejects.toMatchObject({ code: 'language_primary_locked' });
  });

  it.each(['de', 'en'] as const)('adds only URLs when enabling the secondary of a locked %s-only install', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const language = pgLanguageStore(pool); await language.update({ primary, locales: [primary] });
    const posts = pgPostStore(pool); const saved = await posts.upsertDraft(story());
    await posts.publish(saved.translationKey, await publishTokens(posts, saved.translationKey));
    const before = publicUrlSet(await language.get(), await rows(saved.translationKey));
    await language.update({ primary, locales: [primary, secondary] });
    const after = publicUrlSet(await language.get(), await rows(saved.translationKey));
    expect(before.every((path) => after.includes(path))).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
    expect((await posts.get(saved.translationKey))?.[secondary].omitted).toBe(true);
    expect(await posts.getPublishedLocales(saved.translationKey)).toEqual([primary]);
  });

  it.each(['de', 'en'] as const)('keeps requested %s-secondary coverage private and atomically rolls back failed gates', async (secondary) => {
    const primary = secondary === 'de' ? 'en' : 'de';
    const language = pgLanguageStore(pool); await language.update({ primary, locales: [primary, secondary] });
    const posts = pgPostStore(pool); const input = story(); input[secondary].omitted = true; input[secondary].slug = '';
    const saved = await posts.upsertDraft(input); const tk = saved.translationKey;
    await posts.publish(tk, await publishTokens(posts, tk));
    const baseline = (await rows(tk)).find((row) => row.locale === primary)!.published_snapshot;
    expect((await posts.publicationFacts())[0]).toMatchObject({
      primaryLocale: primary, status: 'published', requestedLocales: [primary], committedLocales: [primary], draftDiffers: false,
    });
    const translated = await posts.upsertDraft({ ...saved, [secondary]: { ...saved[secondary], omitted: false, slug: `translated-${secondary}`, bodyMarkdown: '' } });
    expect(translated.publication).toMatchObject({ availability: 'available', draftDiffers: true });
    expect(translated[secondary].publishedAt).toBeNull();
    expect((await posts.list())[0]?.publication).toMatchObject({ availability: 'available', draftDiffers: true });
    expect(await posts.getPublishedLocales(tk)).toEqual([primary]);
    await expect(posts.publish(tk, await publishTokens(posts, tk))).rejects.toThrow(/body required/);
    expect((await posts.publicationFacts())[0]).toMatchObject({
      status: 'published', requestedLocales: ['de', 'en'], committedLocales: [primary], draftDiffers: true,
      rowDigest: { [secondary]: null },
    });
    const omittedAgain = await posts.upsertDraft({ ...translated, [secondary]: { ...translated[secondary], omitted: true } });
    expect(omittedAgain.publication).toMatchObject({ requestedLocales: [primary], committedLocales: [primary], draftDiffers: false });
    await posts.upsertDraft({ ...translated, [secondary]: { ...translated[secondary], bodyMarkdown: 'Translation' } });
    await expect(posts.publish(tk, await publishTokens(posts, tk), async () => { throw new Error('image gate'); })).rejects.toThrow('image gate');
    expect(await posts.getPublishedLocales(tk)).toEqual([primary]);
    expect((await rows(tk)).find((row) => row.locale === primary)!.published_snapshot).toEqual(baseline);
    expect((await posts.getPublishedTrack(tk)).locales).toEqual([primary]);
    expect((await posts.publicationFacts())[0]?.draftDiffers).toBe(true);
    await posts.publish(tk, await publishTokens(posts, tk));
    expect(await posts.getPublishedLocales(tk)).toEqual([primary, secondary]);
    const current = (await posts.get(tk))!;
    expect(current.publication).toMatchObject({ availability: 'available', draftDiffers: false });
    expect((await posts.publicationFacts())[0]).toMatchObject({
      requestedLocales: ['de', 'en'], committedLocales: ['de', 'en'], draftDiffers: false,
    });
    await expect(posts.upsertDraft({ ...current, [secondary]: { ...current[secondary], omitted: true } })).rejects.toMatchObject({ code: 'locale_published' });
    await posts.unpublish(tk);
    await expect(posts.upsertDraft({ ...current, [secondary]: { ...current[secondary], omitted: true } })).rejects.toMatchObject({ code: 'locale_published' });
    expect(await posts.getPublishedLocales(tk)).toEqual([]);
    await pool.query("UPDATE posts SET status='published' WHERE translation_key=$1 AND locale=$2", [tk, secondary]);
    expect(await posts.getPublishedLocales(tk)).toEqual([]); // no committed primary, even with a retained secondary
  });

  it('enforces omission at the database boundary for status, snapshots and publication history', async () => {
    const posts = pgPostStore(pool); const saved = await posts.upsertDraft(story());
    for (const assignment of ["status='published'", "published_snapshot='{}'::jsonb", 'published_at=now()']) {
      await expect(pool.query(`UPDATE posts SET omitted=true, ${assignment} WHERE translation_key=$1 AND locale='en'`, [saved.translationKey])).rejects.toMatchObject({ code: '23514' });
    }
    expect((await rows(saved.translationKey)).every((row) => !row.omitted && row.status === 'draft')).toBe(true);
    const tokens = await publishTokens(posts, saved.translationKey);
    await expect(posts.publish(saved.translationKey, tokens, async () => { throw new Error('blocked photo'); })).rejects.toThrow('blocked photo');
    expect((await posts.language.get()).lockedAt).toBeNull();
    expect((await rows(saved.translationKey)).every((row) => row.published_at === null && row.published_snapshot === null)).toBe(true);
  });

  it.each(['primary', 'disable', 'enable'] as const)('serializes a publish winning a concurrent %s mode transition', async (change) => {
    const language = pgLanguageStore(pool);
    await language.update({ primary: 'de', locales: change === 'enable' ? ['de'] : ['de', 'en'] });
    const posts = pgPostStore(pool); const saved = await posts.upsertDraft(story());
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const publishing = posts.publish(saved.translationKey, await publishTokens(posts, saved.translationKey), async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const next: LanguageConfig = change === 'primary' ? { primary: 'en', locales: ['en', 'de'] }
      : { primary: 'de', locales: change === 'disable' ? ['de'] : ['de', 'en'] };
    const changing = language.update(next).catch((error: unknown) => error);
    release.resolve(); await publishing;
    const outcome = await changing;
    if (change === 'enable') expect(outcome).toMatchObject(next);
    else expect(outcome).toMatchObject({ code: change === 'primary' ? 'language_primary_locked' : 'language_locale_published' });
    expect((await language.get()).lockedAt).toBeInstanceOf(Date);
    expect(await posts.getPublishedLocales(saved.translationKey)).toEqual(change === 'enable' ? ['de'] : ['de', 'en']);
  });

  it.each(['primary', 'disable', 'enable'] as const)('rejects exact reviewed tokens when a %s mode transition wins during GPX projection', async (change) => {
    const language = pgLanguageStore(pool);
    await language.update({ primary: 'de', locales: change === 'enable' ? ['de'] : ['de', 'en'] });
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const paused: PublicTrackWorker = { close: async () => {}, transform: async (...args) => {
      const result = await worker.transform(...args); entered.resolve(); await release.promise; return result;
    } };
    const posts = pgPostStore(pool, { publicTrackWorker: paused }); const saved = await posts.upsertDraft(story());
    const tk = saved.translationKey; const reviewed = await publishTokens(posts, tk);
    await pgGpxStore(pool).attach(tk, { baseUpdatedAt: reviewed.baseUpdatedAt.toISOString(), baseVersion: null },
      { version: 1, segments: [{ points: [{ lat: 1, lng: 2 }, { lat: 1.01, lng: 2.01 }] }] },
      { translationKey: tk, sourceId: randomUUID(), sha256: 'a'.repeat(64), bytes: 100 }, true);
    const publishing = posts.publish(tk, await publishTokens(posts, tk));
    const outcome = publishing.catch((error: unknown) => error);
    await Promise.race([entered.promise, publishing.then(() => { throw new Error('projection barrier missed'); })]);
    try {
      await language.update(change === 'primary' ? { primary: 'en', locales: ['en', 'de'] }
        : { primary: 'de', locales: change === 'disable' ? ['de'] : ['de', 'en'] });
    } finally { release.resolve(); }
    expect(await outcome).toMatchObject({ code: 'conflict' });
    expect((await language.get()).lockedAt).toBeNull();
    expect((await rows(tk)).every((row) => row.published_at === null && row.published_snapshot === null && row.status === 'draft')).toBe(true);
    expect(await posts.getPublishedLocales(tk)).toEqual([]);
  });
});
