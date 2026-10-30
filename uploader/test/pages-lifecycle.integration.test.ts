import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { pgPageStore, type PagePair } from '../src/pages.js';
import { pgLanguageStore } from '../src/language.js';
import { pgPostStore, type PostLocale, type PostPair } from '../src/posts.js';
import { dumpDatabase, readDump, restoreDatabase, DUMP_VERSION, IDENTITY_DUMP_VERSION, LANGUAGE_DUMP_VERSION, type Dump } from '../src/backup.js';
import { seedSiteIdentity } from '../src/site-identity.js';
import { DEFAULT_NAVIGATION } from '../../site/src/lib/navigation.js';
import { reportNamespaceCollisions } from '../src/namespace-report.js';
import { publishTokens } from './publish-tokens.js';

const url = process.env.TEST_DATABASE_URL;
const content = (locale: 'de' | 'en', slug = `${locale}-contact`) => ({ locale, title: 'Contact', bodyMarkdown: 'Details', images: {}, slug });
const page = (): PagePair => ({ key: 'contact', de: content('de'), en: content('en') });
function story(slug = 'story'): PostPair {
  const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: locale === 'de' ? slug : 'en-' + slug, title: 'Story', excerpt: 'Excerpt', country: 'Test', bodyMarkdown: 'Body', images: {}, heroImage: { src: 'https://images.test/hero', width: 800, height: 600, alt: 'View' } });
  return { translationKey: '', status: 'draft', shared: { date: '2026-10-29', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') };
}
(url ? describe : describe.skip)('page transactions and recovery', () => {
  let owner: DbPool; let pool: DbPool; let schema: string; let dir: string;
  beforeAll(() => { owner = new pg.Pool({ connectionString: url }); });
  beforeEach(async () => {
    schema = 'pages_' + randomUUID().replaceAll('-', '');
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await ensureSchema(pool); await seedSiteIdentity(pool);
    dir = await mkdtemp(join(tmpdir(), 'pages-recovery-'));
  });
  afterEach(async () => { await pool?.end(); await owner.query(`DROP SCHEMA ${schema} CASCADE`); await rm(dir, { recursive: true, force: true }); });
  afterAll(async () => { await owner.end(); });

  it('keeps About content, history and identity through a second bootstrap; reports unknown rows without deleting them', async () => {
    const pages = pgPageStore(pool); const about = await pages.get('about');
    const saved = await pages.save({ key: 'about', de: { ...about.de, title: 'Author heading' } }, about.updatedAt!);
    const history = await pages.listRevisions('about');
    await pool.query("INSERT INTO pages(key,locale,title) VALUES('legacy-page','de','Legacy author text')");
    const messages: string[] = [];
    await ensureSchema(pool); await reportNamespaceCollisions(pool, (message) => messages.push(message));
    expect(await pages.get('about')).toEqual(saved); expect(await pages.listRevisions('about')).toEqual(history);
    expect((await pages.get('legacy-page')).de.title).toBe('Legacy author text');
    expect(messages.filter((message) => message.includes('legacy-page'))).toHaveLength(1);
    await expect(pages.remove('about')).rejects.toMatchObject({ code: 'page_fixed' });
    await expect(pages.unpublish('about')).rejects.toMatchObject({ code: 'page_fixed' });
  });

  it('serializes a page/story claim race and rejects both cross-content creation orders', async () => {
    const pages = pgPageStore(pool); const posts = pgPostStore(pool);
    const barrier = await pool.connect(); await barrier.query('BEGIN');
    await barrier.query('SELECT id FROM site_language WHERE id=true FOR UPDATE');
    const pageSave = pages.save(page()); const postSave = posts.upsertDraft(story('de-contact'));
    await barrier.query('COMMIT'); barrier.release();
    const outcomes = await Promise.allSettled([pageSave, postSave]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'reserved_slug' } });
    if ((await pages.get('contact')).updatedAt) {
      await expect(posts.upsertDraft(story('de-contact'))).rejects.toMatchObject({ code: 'reserved_slug', owner: { type: 'page', name: 'contact' } });
    } else {
      await expect(pages.save(page())).rejects.toMatchObject({ code: 'reserved_slug', owner: { type: 'story' } });
    }
  });

  it('protects retained snapshots as well as working slugs and grandfathers only the stored row', async () => {
    const pages = pgPageStore(pool); const posts = pgPostStore(pool);
    const saved = await posts.upsertDraft(story('old-url'));
    await posts.publish(saved.translationKey, await publishTokens(posts, saved.translationKey));
    await pool.query("UPDATE posts SET slug='working-url' WHERE translation_key=$1 AND locale='de'", [saved.translationKey]);
    await expect(pages.save({ ...page(), de: content('de', 'old-url') })).rejects.toMatchObject({ code: 'reserved_slug', owner: { type: 'story', name: saved.translationKey } });
    const legacy = await posts.upsertDraft(story('legacy'));
    await pool.query("UPDATE posts SET slug='settings' WHERE translation_key=$1 AND locale='de'", [legacy.translationKey]);
    const loaded = (await posts.get(legacy.translationKey))!;
    await posts.upsertDraft({ ...loaded, de: { ...loaded.de, title: 'Edited legacy' } });
    await posts.publish(loaded.translationKey, await publishTokens(posts, loaded.translationKey));
    expect((await posts.get(loaded.translationKey))!.de.slug).toBe('settings');
    const draftLegacy = await posts.upsertDraft(story('legacy-draft'));
    await pool.query("UPDATE posts SET slug='admin' WHERE translation_key=$1 AND locale='de'", [draftLegacy.translationKey]);
    const held = (await posts.get(draftLegacy.translationKey))!;
    const away = await posts.upsertDraft({ ...held, de: { ...held.de, slug: 'no-longer-reserved' } });
    await expect(posts.upsertDraft({ ...away, de: { ...away.de, slug: 'admin' } })).rejects.toMatchObject({ code: 'reserved_slug' });
    const messages: string[] = []; await reportNamespaceCollisions(pool, (message) => messages.push(message));
    expect(messages.some((message) => message.includes('root/settings') && message.includes('story'))).toBe(true);
  });

  it.each(['de', 'en'] as const)('atomically activates prepared %s-primary translations and rejects stale page edits', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de'; const language = pgLanguageStore(pool);
    await language.update({ primary, locales: [primary] });
    const pages = pgPageStore(pool, { imageOrigin: 'https://images.test' });
    const first = await pages.save({ key: 'contact', [primary]: content(primary) });
    const published = await pages.publish('contact', first.updatedAt!);
    const activate = () => language.update({ primary, locales: [primary, secondary] }, (mode, client) => pages.prepareActivation(mode, client));
    await expect(activate()).rejects.toMatchObject({ code: 'language_pages_incomplete' });
    const partial = await pages.save({ key: 'contact', [secondary]: { ...content(secondary, ''), bodyMarkdown: '' } }, published.updatedAt!, { prepareLocale: secondary });
    expect(partial[primary]).toEqual(published[primary]); expect(partial[secondary].publishedAt).toBeNull();
    await expect(activate()).rejects.toMatchObject({ code: 'language_pages_incomplete' });
    const prepared = await pages.save({ key: 'contact', [secondary]: content(secondary) }, partial.updatedAt!, { prepareLocale: secondary });
    await activate(); const active = await pages.get('contact');
    expect(active[secondary].publishedAt).toBeInstanceOf(Date); expect(active[primary]).toEqual(prepared[primary]);
    await expect(pages.save({ key: 'contact', [secondary]: content(secondary, 'changed') }, prepared.updatedAt!)).rejects.toMatchObject({ code: 'conflict' });
    await expect(pages.save({ key: 'contact', [secondary]: content(secondary, 'changed') }, active.updatedAt!)).rejects.toMatchObject({ code: 'page_slug_locked' });
  });

  it('deletes rows, histories and navigation atomically, leaving media and unrelated references alone', async () => {
    const pages = pgPageStore(pool); await pages.save(page()); await pages.save(page()); const published = await pages.publish('contact');
    const nav = structuredClone(DEFAULT_NAVIGATION); nav.footer.push({ kind: 'page', target: 'contact', label: { en: 'Write to me' } });
    await pool.query('UPDATE site_nav SET config=$1 WHERE id=1', [JSON.stringify(nav)]);
    const posts = pgPostStore(pool); const input = story(); input.de.bodyMarkdown = '[Contact](/de-contact/)'; await posts.upsertDraft(input);
    const info = await pages.removalInfo('contact'); expect(info.bodyReferences).toBe(1); expect(info.navigation).toHaveLength(1); expect(info.revisions).toBe(2);
    const rev = (await pages.listRevisions('contact'))[0]!;
    await pages.remove('contact', published.updatedAt!);
    expect(await pages.getRevision('contact', rev.id)).toBeNull(); expect(await pages.keys()).toEqual(['about']);
    expect((await pool.query('SELECT config FROM site_nav')).rows[0]!.config.footer).toEqual([{ kind: 'page', target: 'about' }]);
    expect((await posts.get((await posts.list())[0]!.translationKey))!.de.bodyMarkdown).toContain('/de-contact/');
  });

  it.each(['de', 'en'] as const)('retains deletion link warnings after unpublishing a %s-primary page', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const language = pgLanguageStore(pool);
    await language.update({ primary, locales: [primary, secondary] });
    const pages = pgPageStore(pool); await pages.save(page());
    const published = await pages.publish('contact');
    const draft = await pages.unpublish('contact', published.updatedAt!);
    const posts = pgPostStore(pool); const input = story();
    input[primary].bodyMarkdown = `[Contact](/${primary}-contact/) [Again](/${primary}-contact/)`;
    input[secondary].bodyMarkdown = `[Contact](/${secondary}/${secondary}-contact/)`;
    await posts.upsertDraft(input);
    const info = await pages.removalInfo('contact');
    expect(info).toMatchObject({ paths: [], published: false, bodyReferences: 2 });
    expect(await pages.remove('contact', draft.updatedAt!)).toEqual(info);
  });

  it.each(['save', 'publish', 'unpublish', 'remove'] as const)('serializes activation against page %s without a partially stamped locale', async (action) => {
    const language = pgLanguageStore(pool); await language.update({ primary: 'de', locales: ['de'] });
    const pages = pgPageStore(pool); const draft = await pages.save(page());
    const prepared = await pages.save({ key: 'contact', en: content('en') }, draft.updatedAt!, { prepareLocale: 'en' });
    const before = action === 'publish' ? prepared : await pages.publish('contact', prepared.updatedAt!);
    const lock = await pool.connect(); await lock.query('BEGIN'); await lock.query('SELECT id FROM site_language FOR UPDATE');
    const mutation = action === 'save' ? pages.save({ key: 'contact', de: { ...content('de'), title: 'Latest' } }, before.updatedAt!)
      : pages[action]('contact', before.updatedAt!);
    const activation = language.update({ primary: 'de', locales: ['de', 'en'] }, (mode, client) => pages.prepareActivation(mode, client));
    await lock.query('COMMIT'); lock.release();
    const [changed, activated] = await Promise.allSettled([mutation, activation]);
    expect(activated.status).toBe('fulfilled');
    if (changed.status === 'rejected') expect(changed.reason).toMatchObject({ code: 'conflict' });
    const final = await pages.get('contact');
    if (final.updatedAt) {
      expect(final.status === 'published' ? final.en.publishedAt : null).toEqual(final.status === 'published' ? expect.any(Date) : null);
      await expect(pages.save({ key: 'contact', de: content('de') }, before.updatedAt!)).rejects.toMatchObject({ code: 'conflict' });
    } else expect(action).toBe('remove');
  });

  it('rolls the complete deletion back when updating inbound navigation fails', async () => {
    const pages = pgPageStore(pool); await pages.save(page()); const saved = await pages.save(page());
    const before = await pages.listRevisions('contact'); const navigation = (await pool.query('SELECT * FROM site_nav')).rows;
    await pool.query(`CREATE FUNCTION reject_nav_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'nav write failed'; END $$`);
    await pool.query('CREATE TRIGGER reject_nav BEFORE UPDATE ON site_nav FOR EACH ROW EXECUTE FUNCTION reject_nav_update()');
    await expect(pages.remove('contact', saved.updatedAt!)).rejects.toThrow('nav write failed');
    expect(await pages.get('contact')).toEqual(saved); expect(await pages.listRevisions('contact')).toEqual(before);
    expect((await pool.query('SELECT * FROM site_nav')).rows).toEqual(navigation);
  });

  it('round-trips page status, slugs, history timestamps and navigation; malformed new metadata refuses before replacement', async () => {
    const pages = pgPageStore(pool); await pages.save(page()); const published = await pages.publish('contact');
    const nav = structuredClone(DEFAULT_NAVIGATION); nav.legal.push({ kind: 'page', target: 'contact' });
    await pool.query('UPDATE site_nav SET config=$1 WHERE id=1', [JSON.stringify(nav)]);
    const file = join(dir, await dumpDatabase(pool, dir)); const dump = readDump(file);
    expect(dump.version).toBe(DUMP_VERSION);
    await pages.remove('contact'); await restoreDatabase(pool, file);
    const restored = await pages.get('contact'); expect(restored.de).toEqual(published.de); expect(restored.en).toEqual(published.en); expect(restored.status).toBe('published');
    expect((await pool.query('SELECT config FROM site_nav')).rows[0]!.config).toEqual(nav);
    for (const field of ['slug', 'status', 'published_at'] as const) {
      const bad = structuredClone(dump); delete bad.tables.pages![0]![field];
      const path = join(dir, `bad-${field}.json.gz`); await writeFile(path, gzipSync(JSON.stringify(bad)));
      await expect(restoreDatabase(pool, path)).rejects.toThrow(/page metadata/);
      expect((await pages.get('contact')).de).toEqual(published.de);
    }
    const noNav = structuredClone(dump); delete noNav.tables.site_nav;
    const path = join(dir, 'missing-nav.json.gz'); await writeFile(path, gzipSync(JSON.stringify(noNav)));
    await expect(restoreDatabase(pool, path)).rejects.toThrow(/page\/navigation metadata/);
  });

  it.each([1, 10])('refuses a modern identity dump relabelled v%i without replacing pages or navigation', async (version) => {
    const pages = pgPageStore(pool); const saved = await pages.save(page());
    const file = join(dir, await dumpDatabase(pool, dir)); const dump = readDump(file);
    dump.version = version;
    // Reach the identity boundary rather than the earlier private-route version guard.
    if (version < 10) { delete dump.tables.post_routes; delete dump.routeArchive; }
    const mislabeled = join(dir, `mislabeled-${version}.json.gz`);
    await writeFile(mislabeled, gzipSync(JSON.stringify(dump)));
    const nav = (await pool.query('SELECT * FROM site_nav')).rows;
    await expect(restoreDatabase(pool, mislabeled)).rejects.toThrow('Invalid identity field in backup: version.');
    expect(await pages.get('contact')).toEqual(saved);
    expect((await pool.query('SELECT * FROM site_nav')).rows).toEqual(nav);
  });

  it.each([1, 10, 11, 12])('restores pre-navigation v%i with explicit version semantics and sweeps orphan revisions', async (version) => {
    const pages = pgPageStore(pool); await pages.save(page()); await pages.save(page());
    const file = join(dir, await dumpDatabase(pool, dir)); const dump = readDump(file);
    // Build the historical table set, not a modern payload with a lower version label.
    // There are no story rows in this fixture that would need older column projections.
    expect(dump.tables.posts).toEqual([]);
    const legacyDump: Dump = {
      version, createdAt: dump.createdAt,
      ...(version >= 10 ? { routeArchive: dump.routeArchive } : {}),
      tables: {
        users: dump.tables.users, posts: dump.tables.posts,
        ...(version >= 2 ? {
          pages: dump.tables.pages!.filter((row) => row.key === 'about')
            .map(({ key, locale, title, body_markdown, images }) => ({ key, locale, title, body_markdown, images })),
        } : {}),
        ...(version >= 3 ? { media: dump.tables.media, media_folders: dump.tables.media_folders } : {}),
        ...(version >= 6 ? { app_secrets: dump.tables.app_secrets } : {}),
        ...(version >= 8 ? { comments: dump.tables.comments } : {}),
        ...(version >= 10 ? { post_routes: dump.tables.post_routes } : {}),
        ...(version >= IDENTITY_DUMP_VERSION ? {
          site_identity: dump.tables.site_identity, site_identity_assets: dump.tables.site_identity_assets,
        } : {}),
        ...(version >= LANGUAGE_DUMP_VERSION ? { site_language: dump.tables.site_language } : {}),
      },
    };
    const legacy = join(dir, `legacy-${version}.json.gz`); await writeFile(legacy, gzipSync(JSON.stringify(legacyDump)));
    const nav = (await pool.query('SELECT * FROM site_nav')).rows;
    await restoreDatabase(pool, legacy);
    expect((await pool.query('SELECT * FROM site_nav')).rows).toEqual(nav);
    expect((await pages.get('about')).status).toBe('published');
    if (version === 1) expect((await pages.get('contact')).updatedAt).not.toBeNull();
    else { expect((await pages.get('contact')).updatedAt).toBeNull(); expect(await pages.listRevisions('contact')).toEqual([]); }
  });
});
