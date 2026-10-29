import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { captureBootEvidence, initializeApplicationSchema, initializeOnboarding, hasExistingOnboardingData, retireOnboarding, assertBootstrapOnlyTarget, type OnboardingPaths } from '../src/onboarding-bootstrap.js';
import { pgOnboardingStore, readOnboardingProgress, readOnboardingState } from '../src/onboarding.js';
import { readRestoreFence, publishRestoreFence, restoreFencePath } from '../src/onboarding-fence.js';
import { prepareNativeRestore } from '../src/onboarding-restore.js';
import { dumpDatabase, readDump, validateIdentityAssets } from '../src/backup.js';
import { verifyRouteArchive } from '../src/gpx-backup.js';
import { createGpxFiles } from '../src/gpx-files.js';
import { seedSiteIdentity } from '../src/site-identity.js';
import { StorageReadOnlyError } from '../src/storage-owner.js';
import { interceptOnboardingTransactions } from './onboarding-query-fixture.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('onboarding PostgreSQL boot and snapshot boundary', () => {
  let admin: DbPool;
  let pool: DbPool;
  let schema: string;
  let dir: string;
  let paths: OnboardingPaths;
  let writable: boolean;
  const guard = async () => { if (!writable) throw new StorageReadOnlyError(); };
  beforeAll(() => { admin = new pg.Pool({ connectionString: url }); });
  beforeEach(async () => {
    schema = 'onboarding_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    dir = await mkdtemp(join(await realpath(tmpdir()), 'onboarding-pg-'));
    paths = { storageDir: join(dir, 'images'), settingsPath: join(dir, 'settings.json'), siteDir: join(dir, 'site'), backupDir: join(dir, 'backup') };
    writable = true;
  });
  afterEach(async () => {
    await pool?.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await rm(dir, { recursive: true, force: true });
  });
  afterAll(async () => { await admin?.end(); });
  async function boot() {
    const before = await captureBootEvidence(pool, guard);
    await initializeApplicationSchema(pool, guard);
    await initializeOnboarding(pool, paths, before, guard);
    return pgOnboardingStore(pool, () => writable);
  }
  async function insertStory(key = 'story', status = 'draft', locale = 'de') {
    await pool.query(`INSERT INTO posts(id,translation_key,locale,slug,title,date,country,country_code,region,excerpt,hero_image,coordinates,body_markdown,status)
      VALUES($1,$2,$3,$2,'Title','2026-10-27','Country','RO','europe','Excerpt','{}','{}','Body',$4)`, [randomUUID(), key, locale, status]);
  }
  it('classifies a truly fresh database before setup, seeds exactly once and shares dismissal across new stores/restarts', async () => {
    const store = await boot();
    expect(await store.read()).toMatchObject({ status: 'open', complete: false });
    expect((await pool.query('SELECT saved_at, seed_source FROM site_identity')).rows).toEqual([{ saved_at: null, seed_source: 'neutral' }]);
    await store.act('dismiss');
    await pool.query("INSERT INTO users(id,username,password_hash,is_admin) VALUES($1,'admin','fixture',true)", [randomUUID()]);
    await insertStory();
    await mkdir(paths.siteDir); await writeFile(join(paths.siteDir, 'release'), 'built');
    const restart = await boot();
    expect(await restart.read()).toMatchObject({ status: 'dismissed' });
    expect(await pgOnboardingStore(pool, () => true).act('resume')).toMatchObject({ status: 'open' });
    expect(await restart.read()).toMatchObject({ status: 'open' });
  });
  it('inserts once under concurrent initialization and re-reads the committed winner', async () => {
    const before = await captureBootEvidence(pool, guard);
    await initializeApplicationSchema(pool, guard);
    await Promise.all([
      initializeOnboarding(pool, paths, before, guard),
      initializeOnboarding(pool, paths, before, guard),
    ]);
    expect((await pool.query('SELECT count(*)::int AS n FROM onboarding_state')).rows[0].n).toBe(1);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'eligible', reason: 'fresh' });
  });
  it('excludes an existing empty schema and a crashed partial initial migration', async () => {
    await pool.query('CREATE TABLE users (id uuid PRIMARY KEY, username text NOT NULL, password_hash text NOT NULL, is_admin boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())');
    expect(await (await boot()).read()).toEqual({ status: 'retired' });
    expect(await readOnboardingState(pool)).toMatchObject({ reason: 'existing-schema' });
  });
  it.each([
    ["INSERT INTO users(id,username,password_hash) VALUES(gen_random_uuid(),'owner','fixture')", 'existing-accounts'],
    ["INSERT INTO post_revisions(id,translation_key,snapshot) VALUES(gen_random_uuid(),'orphan','{}')", 'existing-content'],
    ["INSERT INTO post_routes(translation_key,version,source_id,source_sha256,source_bytes,updated_at) VALUES('old',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,now())", 'existing-content'],
    ["INSERT INTO route_cleanup(source_id,pair_hash) VALUES(gen_random_uuid(),repeat('a',64))", 'existing-content'],
    ["INSERT INTO media(key) VALUES('old')", 'existing-content'],
    ["INSERT INTO media_folders(path) VALUES('old')", 'existing-content'],
    ["INSERT INTO comments(id,translation_key,locale,name,body,status) VALUES(gen_random_uuid(),'orphan','de','Reader','Text','pending')", 'existing-content'],
    ["INSERT INTO import_jobs(id,status,started_by,progress) VALUES(gen_random_uuid(),'running','old','{}')", 'existing-content'],
    ["INSERT INTO app_secrets(key,ciphertext,iv,tag) VALUES('old','cipher','iv','tag')", 'existing-content'],
    ["INSERT INTO page_revisions(id,key,snapshot) VALUES(gen_random_uuid(),'about','{}')", 'existing-content'],
    ["UPDATE pages SET title='Owner title' WHERE locale='de'", 'existing-content'],
    ["UPDATE pages SET body_markdown='Owner body' WHERE locale='en'", 'existing-content'],
    ["UPDATE pages SET images='{\"x\":{}}' WHERE locale='de'", 'existing-content'],
    ["INSERT INTO pages(key,locale) VALUES('other','de')", 'existing-content'],
    ["UPDATE site_identity SET saved_at=now()", 'existing-content'],
  ])('retains pre-maintenance exclusion evidence for %s', async (sql, reason) => {
    await initializeApplicationSchema(pool, guard);
    await pool.query(sql);
    const before = await captureBootEvidence(pool, guard);
    await initializeApplicationSchema(pool, guard); // orphan revision/comment sweeps run here
    await initializeOnboarding(pool, paths, before, guard);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired', reason });
  });
  it('prioritizes accounts over content/data/schema without interpreting timestamps', async () => {
    await initializeApplicationSchema(pool, guard);
    await pool.query("INSERT INTO users(id,username,password_hash,created_at) VALUES($1,'owner','fixture','2099-01-01')", [randomUUID()]);
    await insertStory();
    await writeFile(paths.settingsPath, '{}');
    await boot();
    expect(await readOnboardingState(pool)).toMatchObject({ reason: 'existing-accounts' });
  });
  it.each(['settings', 'legacy-settings', 'image', 'backup', 'release', 'route-file', 'route-symlink', 'unexpected-route-directory'])('excludes zero-user existing data: %s', async (kind) => {
    if (kind === 'settings') await writeFile(paths.settingsPath, '{}');
    else if (kind === 'legacy-settings') await writeFile(paths.settingsPath + '.pre-ai-registry', '{}');
    else if (kind === 'image') { await mkdir(paths.storageDir); await writeFile(join(paths.storageDir, 'photo'), 'x'); }
    else if (kind === 'backup') { await mkdir(paths.backupDir); await mkdir(join(paths.backupDir, 'db')); }
    else if (kind === 'release') { await mkdir(paths.siteDir); await mkdir(join(paths.siteDir, '.partial')); }
    else {
      const root = join(dir, 'routes'); await mkdir(root);
      if (kind === 'route-file') await writeFile(join(root, 'source'), 'x');
      if (kind === 'route-symlink') await symlink(dir, join(root, 'originals'));
      if (kind === 'unexpected-route-directory') await mkdir(join(root, 'unknown'));
    }
    await boot();
    expect(await readOnboardingState(pool)).toMatchObject({ reason: 'existing-data' });
  });
  it('permits only empty private-route structural directories and treats access errors as errors', async () => {
    await mkdir(join(dir, 'routes', 'originals'), { recursive: true });
    await mkdir(join(dir, 'routes', 'pending'));
    expect(await hasExistingOnboardingData(paths)).toBe(false);
    await writeFile(join(dir, 'not-directory'), 'x');
    await expect(hasExistingOnboardingData({ ...paths, settingsPath: join(dir, 'not-directory', 'settings.json') })).rejects.toThrow();
    expect(await (await boot()).read()).toMatchObject({ status: 'open' });
  });
  it('fence beats SQL-restored eligibility or missing tables, preserving an existing retirement reason', async () => {
    await boot();
    await publishRestoreFence(paths.storageDir, guard);
    await boot();
    const retired = await readOnboardingState(pool);
    expect(retired).toMatchObject({ reason: 'restored-content' });
    await pool.query("UPDATE onboarding_state SET reason='finished'");
    const finished = await readOnboardingState(pool);
    await boot();
    expect(await readOnboardingState(pool)).toEqual(finished);
    await pool.query('DROP TABLE onboarding_state');
    await boot();
    expect(await readOnboardingState(pool)).toMatchObject({ reason: 'restored-content' });
    expect(await readRestoreFence(paths.storageDir)).toBe(true);
  });
  it('fails boot before classification on malformed fence, missing evidence shape, or owner loss', async () => {
    await writeFile(restoreFencePath(paths.storageDir), 'corrupt');
    await expect(boot()).rejects.toThrow();
    expect(await readOnboardingState(pool)).toBeNull();
    writable = false;
    await expect(captureBootEvidence(pool, guard)).rejects.toMatchObject({ code: 'storage_read_only' });
  });
  it('refuses an unacknowledged initial commit and retains malformed state for diagnosis', async () => {
    const before = await captureBootEvidence(pool, guard);
    await initializeApplicationSchema(pool, guard);
    await pool.query(`CREATE FUNCTION refuse_initial() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit rejected'; END $$`);
    await pool.query('CREATE CONSTRAINT TRIGGER refuse_initial AFTER INSERT ON onboarding_state DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_initial()');
    await expect(initializeOnboarding(pool, paths, before, guard)).rejects.toThrow();
    expect(await readOnboardingState(pool)).toBeNull();
    await pool.query('DROP TRIGGER refuse_initial ON onboarding_state');
    await initializeOnboarding(pool, paths, before, guard);
    await pool.query('ALTER TABLE onboarding_state DROP CONSTRAINT onboarding_state_schema_version_check');
    await pool.query('UPDATE onboarding_state SET schema_version=2');
    await expect(boot()).rejects.toThrow();
    expect((await pool.query('SELECT schema_version FROM onboarding_state')).rows[0].schema_version).toBe(2);
  });
  it('fails an unknown initial commit acknowledgement, then reconciles durable state on the next boot', async () => {
    const before = await captureBootEvidence(pool, guard);
    await initializeApplicationSchema(pool, guard);
    const uncertain = interceptOnboardingTransactions(pool, async (sql) => {
      if (sql === 'COMMIT') throw new Error('Synthetic connection loss after commit');
    });
    await expect(initializeOnboarding(uncertain, paths, before, guard)).rejects.toThrow();
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'eligible' });
    expect(await (await boot()).read()).toMatchObject({ status: 'open' });
  });
  it('reports lost action acknowledgement as failure without replaying, and GET reconciles it', async () => {
    await boot();
    let commits = 0;
    const uncertain = interceptOnboardingTransactions(pool, async (sql) => {
      if (sql === 'COMMIT') { commits++; throw new Error('Synthetic connection loss after commit'); }
    });
    await expect(pgOnboardingStore(uncertain, () => true).act('dismiss')).rejects.toThrow();
    expect(commits).toBe(1);
    expect(await pgOnboardingStore(pool, () => true).read()).toMatchObject({ status: 'dismissed' });
  });
  it('uses one actual store snapshot and intentionally permits a post-snapshot regression after Finish', async () => {
    await boot(); await insertStory('a', 'published');
    await pool.query("INSERT INTO media(key,status) VALUES('photo','ready')");
    let changed = false;
    const concurrent = interceptOnboardingTransactions(pool, async (sql) => {
      if (!changed && sql.includes('AS "newestDraft"')) {
        changed = true;
        await pool.query('DELETE FROM media');
        await pool.query("UPDATE posts SET status='draft'");
      }
    });
    expect(await pgOnboardingStore(concurrent, () => true).act('finish')).toEqual({ status: 'retired' });
    expect(changed).toBe(true);
    expect(await pgOnboardingStore(pool, () => true).read()).toEqual({ status: 'retired' });
  });
  it('rolls a pending action back when ownership disappears after its row update', async () => {
    await boot();
    const losing = interceptOnboardingTransactions(pool, async (sql) => {
      if (sql.startsWith('UPDATE onboarding_state')) writable = false;
    });
    await expect(pgOnboardingStore(losing, () => writable).act('dismiss')).rejects.toMatchObject({ code: 'storage_read_only' });
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'eligible', dismissedAt: null });
  });
  it('derives tie-broken links and progress within a single read-only repeatable snapshot', async () => {
    await boot();
    await insertStory('z'); await insertStory('a');
    await pool.query("UPDATE posts SET created_at='2026-10-27T00:00:00Z'");
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await readOnboardingState(client);
      await pool.query("INSERT INTO media(key,status) VALUES('photo','ready')");
      await pool.query("UPDATE posts SET status='published'");
      await pool.query('UPDATE site_identity SET saved_at=now()');
      const snapshot = await readOnboardingProgress(client);
      expect(snapshot).toMatchObject({ identity: false, ready: false, story: true, published: false, newest: 'a', newestDraft: 'a' });
      await client.query('COMMIT');
    } finally { client.release(); }
    expect(await pgOnboardingStore(pool, () => true).read()).toMatchObject({ complete: true });
  });
  it('serializes finish/resume, permanently retires despite later regressions and does not read absent runtime state as eligible', async () => {
    const store = await boot(); await insertStory('a', 'published');
    await pool.query("INSERT INTO media(key,status) VALUES('photo','ready')");
    await store.act('dismiss');
    const results = await Promise.allSettled([store.act('finish'), pgOnboardingStore(pool, () => true).act('resume')]);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: 'retired' } });
    expect(await store.read()).toEqual({ status: 'retired' });
    await pool.query('DELETE FROM media'); await pool.query('DELETE FROM posts');
    expect(await store.read()).toEqual({ status: 'retired' });
    await expect(store.act('resume')).rejects.toMatchObject({ code: 'onboarding_retired' });
    await pool.query('DELETE FROM onboarding_state');
    await expect(store.read()).rejects.toThrow();
    await expect(store.act('dismiss')).rejects.toThrow();
    expect(await readOnboardingState(pool)).toBeNull();
  });
  it('serializes duplicate dismiss/resume actions idempotently without reverting retirement', async () => {
    const first = await boot();
    const second = pgOnboardingStore(pool, () => true);
    const hidden = await Promise.all([first.act('dismiss'), second.act('dismiss')]);
    expect(hidden).toEqual([expect.objectContaining({ status: 'dismissed' }), expect.objectContaining({ status: 'dismissed' })]);
    const shown = await Promise.all([first.act('resume'), second.act('resume')]);
    expect(shown).toEqual([expect.objectContaining({ status: 'open' }), expect.objectContaining({ status: 'open' })]);
  });
  it('keeps progress truthful for processing/failed/missing/deleted media and unpublishing', async () => {
    const store = await boot(); await insertStory();
    for (const [status, state] of [['processing','in_progress'],['failed','attention'],['missing','attention'],['ready','done']]) {
      await pool.query("INSERT INTO media(key,status) VALUES('photo',$1) ON CONFLICT(key) DO UPDATE SET status=$1", [status]);
      expect(await store.read()).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ id: 'photo', state })]) });
    }
    await pool.query("UPDATE posts SET status='published'");
    expect(await store.read()).toMatchObject({ complete: true });
    await pool.query("UPDATE posts SET status='draft'");
    await expect(store.act('finish')).rejects.toMatchObject({ code: 'onboarding_incomplete' });
    await pool.query('DELETE FROM media'); await pool.query('DELETE FROM posts');
    expect(await store.read()).toMatchObject({ complete: false, steps: expect.arrayContaining([expect.objectContaining({ id: 'story', state: 'todo' }), expect.objectContaining({ id: 'photo', state: 'todo' })]) });
  });
  it('does not read progress for retired rows even when content tables are unavailable', async () => {
    await initializeApplicationSchema(pool, guard); await retireOnboarding(pool, guard);
    await pool.query('DROP TABLE media'); await pool.query('DROP TABLE site_identity');
    expect(await pgOnboardingStore(pool, () => true).read()).toEqual({ status: 'retired' });
  });
  it('prepares a real empty target with the required identity, validates its actual recovery set and excludes onboarding from native dumps', async () => {
    expect(await prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true })).toBe(true);
    expect(await readOnboardingState(pool)).toMatchObject({ reason: 'restored-content' });
    const files = createGpxFiles({ storageDir: paths.storageDir });
    await files.assertRoot();
    const file = join(paths.backupDir, await dumpDatabase(pool, paths.backupDir, new Date(), { routeFiles: files }));
    const dump = readDump(file);
    await validateIdentityAssets(dump);
    await verifyRouteArchive(file, dump.routeArchive, dump.tables.post_routes ?? []);
    expect(dump.tables.site_identity).toHaveLength(1);
    expect(dump.tables.site_identity![0]).toMatchObject({ saved_at: null, seed_source: 'neutral' });
    expect(dump.tables).not.toHaveProperty('onboarding_state');
    expect(await prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true })).toBe(true);
  });
  it('retries preparation after schema-only crashes and between singleton seeds without broadening dump validation', async () => {
    await publishRestoreFence(paths.storageDir, guard);
    await ensureSchema(pool);
    expect((await pool.query("SELECT column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='comments' AND column_name='status'")).rows)
      .toEqual([{ column_default: "'pending'::text" }]);
    await expect(dumpDatabase(pool, paths.backupDir)).rejects.toThrow();
    await assertBootstrapOnlyTarget(pool, guard);
    expect(await prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true })).toBe(true);
    await pool.query('DELETE FROM site_identity');
    expect(await prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true })).toBe(true);
  });
  it('admits a recognized partial schema before offline initialization completes it', async () => {
    await ensureSchema(pool);
    await pool.query('DROP TABLE onboarding_state; ALTER TABLE posts DROP COLUMN title_image');
    await assertBootstrapOnlyTarget(pool, guard);
    expect(await prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true })).toBe(true);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='posts' AND column_name='title_image'")).rows).toHaveLength(1);
    expect((await pool.query('SELECT seed_source,saved_at FROM site_identity')).rows).toEqual([{ seed_source: 'neutral', saved_at: null }]);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired', reason: 'restored-content' });
  });
  it('admits every installed index and recreates genuinely absent standalone indexes before accepting a prepared target', async () => {
    await ensureSchema(pool);
    await assertBootstrapOnlyTarget(pool, guard);
    const indexQuery = `SELECT idx.relname AS name, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=idx.relnamespace
      WHERE n.nspname=current_schema() AND NOT i.indisprimary ORDER BY idx.relname`;
    const installed = (await pool.query<{ name: string; definition: string }>(indexQuery)).rows;
    expect(installed.length).toBeGreaterThan(0);
    // Exercise the whole real initializer's inventory, not a fixture-only subset.
    for (const index of installed) await pool.query(`DROP INDEX "${index.name.replaceAll('"', '""')}"`);
    await assertBootstrapOnlyTarget(pool, guard);
    expect(await prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true })).toBe(true);
    expect((await pool.query(indexQuery)).rows).toEqual(installed);
    await assertBootstrapOnlyTarget(pool, guard);
    expect(await readRestoreFence(paths.storageDir)).toBe(true);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired', reason: 'restored-content' });
    await pool.query("INSERT INTO users(id,username,password_hash) VALUES($1,'Owner','fixture')", [randomUUID()]);
    await expect(pool.query("INSERT INTO users(id,username,password_hash) VALUES($1,'owner','fixture')", [randomUUID()])).rejects.toMatchObject({ code: '23505' });
    await insertStory();
    await insertStory('other');
    await expect(pool.query("UPDATE posts SET slug='story' WHERE translation_key='other'")).rejects.toMatchObject({ code: '23505' });
    // Different slug still cannot create a second locale in the same pair.
    await pool.query("UPDATE posts SET slug='first-story' WHERE translation_key='story'");
    await expect(insertStory()).rejects.toMatchObject({ code: '23505' });
    // The restored partial slug index continues to admit unset slugs.
    await insertStory('unset-one'); await insertStory('unset-two');
    await pool.query("UPDATE posts SET slug='' WHERE translation_key IN ('unset-one','unset-two')");
  });
  it.each([false, true])('refuses a sequence occupying a required index name before bootstrap (partial=%s)', async partial => {
    if (partial) {
      await ensureSchema(pool);
      await pool.query('DROP INDEX users_username_lower_idx');
    }
    await pool.query('CREATE SEQUENCE users_username_lower_idx');
    const inventory = () => pool.query(`SELECT c.relname, c.relkind FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() ORDER BY c.relname`);
    const before = (await inventory()).rows;
    await expect(prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true }))
      .rejects.toThrow(/bootstrap index/);
    expect((await inventory()).rows).toEqual(before);
    expect(await readRestoreFence(paths.storageDir)).toBe(false);
    if (partial) {
      expect((await pool.query('SELECT * FROM site_identity')).rows).toEqual([]);
      expect((await pool.query('SELECT * FROM onboarding_state')).rows).toEqual([]);
    }
  });
  it.each([
    'DROP INDEX users_username_lower_idx; CREATE INDEX users_username_lower_idx ON users (lower(username))',
    "DROP INDEX posts_locale_slug_idx; CREATE INDEX posts_locale_slug_idx ON posts (locale, slug) WHERE slug <> ''",
    'DROP INDEX posts_tk_locale_idx; CREATE INDEX posts_tk_locale_idx ON posts (translation_key, locale)',
    'DROP INDEX users_username_lower_idx; CREATE UNIQUE INDEX users_username_lower_idx ON users (username)',
    "DROP INDEX users_username_lower_idx; CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username)) WHERE is_admin",
    'DROP INDEX users_username_lower_idx; CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username)) NULLS NOT DISTINCT',
    'DROP INDEX users_username_lower_idx; CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username)) INCLUDE (is_admin)',
    'DROP INDEX users_username_lower_idx; CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username) text_pattern_ops)',
    'DROP INDEX users_username_lower_idx; CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username) COLLATE "C")',
    'DROP INDEX posts_locale_slug_idx; CREATE UNIQUE INDEX posts_locale_slug_idx ON posts (locale, slug)',
    "DROP INDEX posts_locale_slug_idx; CREATE UNIQUE INDEX posts_locale_slug_idx ON posts (locale, slug) WHERE slug <> 'owner'",
    'DROP INDEX posts_tk_locale_idx; CREATE UNIQUE INDEX posts_tk_locale_idx ON posts (locale, translation_key)',
    'DROP INDEX sessions_user_id_idx; CREATE INDEX sessions_user_id_idx ON sessions USING hash (user_id)',
    'DROP INDEX media_taken_at_idx; CREATE INDEX media_taken_at_idx ON media (taken_at DESC)',
    'DROP INDEX posts_tags_idx; CREATE INDEX posts_tags_idx ON posts USING btree (tags)',
    'DROP INDEX comments_status_idx; CREATE UNIQUE INDEX comments_status_idx ON comments (status, created_at)',
    'CREATE UNIQUE INDEX owner_only_title ON pages (title)',
    'DROP INDEX users_username_lower_idx; CREATE UNIQUE INDEX users_username_lower_idx ON pages (title)',
    'DROP INDEX users_username_lower_idx; ALTER INDEX users_pkey RENAME TO users_username_lower_idx',
    'ALTER TABLE pages DROP CONSTRAINT pages_pkey; ALTER TABLE pages ADD PRIMARY KEY (key,locale) INCLUDE (title)',
  ])('refuses altered installed indexes before fencing, migration or seeding: %s', async sql => {
    await ensureSchema(pool);
    await pool.query('ALTER TABLE posts DROP COLUMN title_image');
    await assertBootstrapOnlyTarget(pool, guard);
    await pool.query(sql);
    const indexQuery = `SELECT idx.oid, pg_get_indexdef(idx.oid) AS definition, row_to_json(i) AS state
      FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=idx.relnamespace
      WHERE n.nspname=current_schema() ORDER BY idx.oid`;
    const before = (await pool.query(indexQuery)).rows;
    await expect(prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true }))
      .rejects.toThrow(/bootstrap indexes/);
    expect((await pool.query(indexQuery)).rows).toEqual(before);
    expect((await pool.query('SELECT * FROM site_identity')).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM onboarding_state')).rows).toEqual([]);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='posts' AND column_name='title_image'")).rows).toEqual([]);
    expect(await readRestoreFence(paths.storageDir)).toBe(false);
  });
  it('refuses an invalid same-definition unique index left by interrupted concurrent creation', async () => {
    await ensureSchema(pool);
    await pool.query('DROP INDEX users_username_lower_idx');
    await pool.query("INSERT INTO users(id,username,password_hash) VALUES($1,'Owner','fixture'),($2,'owner','fixture')", [randomUUID(), randomUUID()]);
    await expect(pool.query('CREATE UNIQUE INDEX CONCURRENTLY users_username_lower_idx ON users (lower(username))')).rejects.toMatchObject({ code: '23505' });
    await pool.query('DELETE FROM users');
    expect((await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid='users_username_lower_idx'::regclass")).rows).toEqual([{ indisvalid: false }]);
    await expect(prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true }))
      .rejects.toThrow(/bootstrap indexes/);
    expect(await readRestoreFence(paths.storageDir)).toBe(false);
    expect((await pool.query('SELECT * FROM site_identity')).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM onboarding_state')).rows).toEqual([]);
  });
  it.each([
    'ALTER TABLE pages DROP CONSTRAINT pages_locale_check',
    "ALTER TABLE pages DROP CONSTRAINT pages_locale_check; ALTER TABLE pages ADD CONSTRAINT pages_locale_check CHECK (locale IN ('de','en','fr'))",
    "ALTER TABLE pages ADD CONSTRAINT owner_title CHECK (title <> 'Owner')",
    "ALTER TABLE pages ADD CONSTRAINT duplicate_locale CHECK (locale IN ('de','en'))",
    "ALTER TABLE pages DROP CONSTRAINT pages_locale_check; ALTER TABLE pages ADD CONSTRAINT pages_locale_check CHECK (locale IN ('de','en')) NOT VALID",
    "ALTER TABLE pages DROP CONSTRAINT pages_locale_check; ALTER TABLE pages ADD CONSTRAINT pages_locale_check CHECK (locale IN ('de','en')) NO INHERIT",
    "ALTER TABLE pages DROP CONSTRAINT pages_locale_check; ALTER TABLE pages ADD CONSTRAINT pages_locale_check CHECK (locale IN ('de','en')) NOT ENFORCED",
    'ALTER TABLE sessions DROP CONSTRAINT sessions_user_id_fkey',
    'ALTER TABLE sessions DROP CONSTRAINT sessions_user_id_fkey; ALTER TABLE sessions ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT',
    'ALTER TABLE sessions DROP CONSTRAINT sessions_user_id_fkey; ALTER TABLE sessions ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE',
    'ALTER TABLE sessions DROP CONSTRAINT sessions_user_id_fkey; ALTER TABLE sessions ADD FOREIGN KEY (user_id) REFERENCES users(id) MATCH FULL ON DELETE CASCADE',
    'ALTER TABLE sessions DROP CONSTRAINT sessions_user_id_fkey; ALTER TABLE sessions ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID',
    'ALTER TABLE sessions ALTER CONSTRAINT sessions_user_id_fkey DEFERRABLE',
    'ALTER TABLE sessions ALTER CONSTRAINT sessions_user_id_fkey DEFERRABLE INITIALLY DEFERRED',
    'ALTER TABLE sessions DROP CONSTRAINT sessions_user_id_fkey; ALTER TABLE sessions ADD FOREIGN KEY (user_id) REFERENCES posts(id) ON DELETE CASCADE',
    'ALTER TABLE media DROP CONSTRAINT media_uploaded_by_fkey; ALTER TABLE media ADD FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE',
    'ALTER TABLE media DROP CONSTRAINT media_uploaded_by_fkey; ALTER TABLE media ADD FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL (uploaded_by)',
    'ALTER TABLE sessions ADD FOREIGN KEY (user_id) REFERENCES posts(id)',
    'ALTER TABLE pages ADD UNIQUE (title)',
    'ALTER TABLE pages DROP CONSTRAINT pages_pkey; ALTER TABLE pages ADD PRIMARY KEY (key,locale) DEFERRABLE',
  ])('refuses altered constraints without migration, singleton seeding or fencing: %s', async (sql) => {
    await ensureSchema(pool);
    // A refusal must not repair missing bootstrap values on an unsafe target.
    await pool.query('ALTER TABLE posts DROP COLUMN title_image');
    await assertBootstrapOnlyTarget(pool, guard);
    await pool.query(sql);
    const constraintQuery = `SELECT c.oid, row_to_json(c) AS definition FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=current_schema() ORDER BY c.oid`;
    const before = (await pool.query(constraintQuery)).rows;
    await expect(prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true })).rejects.toThrow();
    expect((await pool.query(constraintQuery)).rows).toEqual(before);
    expect((await pool.query('SELECT * FROM site_identity')).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM onboarding_state')).rows).toEqual([]);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='posts' AND column_name='title_image'")).rows).toEqual([]);
    expect(await readRestoreFence(paths.storageDir)).toBe(false);
  });
  it('refuses an otherwise identical foreign key referencing users in another schema', async () => {
    await ensureSchema(pool);
    await assertBootstrapOnlyTarget(pool, guard);
    const foreignSchema = schema + '_foreign';
    await admin.query(`CREATE SCHEMA ${foreignSchema}`);
    try {
      await admin.query(`CREATE TABLE ${foreignSchema}.users (id uuid PRIMARY KEY)`);
      await pool.query(`ALTER TABLE sessions DROP CONSTRAINT sessions_user_id_fkey;
        ALTER TABLE sessions ADD FOREIGN KEY (user_id) REFERENCES ${foreignSchema}.users(id) ON DELETE CASCADE`);
      await expect(prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true })).rejects.toThrow();
      expect((await pool.query(`SELECT c.confrelid=$1::regclass AS foreign_target FROM pg_constraint c
        WHERE c.conrelid='sessions'::regclass AND c.contype='f'`, [foreignSchema + '.users'])).rows).toEqual([{ foreign_target: true }]);
      expect((await pool.query('SELECT * FROM site_identity')).rows).toEqual([]);
      expect((await pool.query('SELECT * FROM onboarding_state')).rows).toEqual([]);
      expect(await readRestoreFence(paths.storageDir)).toBe(false);
    } finally { await admin.query(`DROP SCHEMA ${foreignSchema} CASCADE`); }
  });
  it.each([
    "UPDATE site_identity SET saved_at=now()", "UPDATE site_identity SET site_name='Owner'",
    "UPDATE site_identity SET revision=2", "UPDATE pages SET title='Owner'",
    "INSERT INTO site_identity_assets(role,sha256,width,height,bytes) VALUES('logo',repeat('a',64),1,1,decode('ff','hex'))",
    "INSERT INTO onboarding_state(singleton,state,reason,evaluated_at) VALUES(true,'eligible','fresh',now())",
    "CREATE TABLE unknown_owner_state(id text)", "ALTER TABLE users ADD COLUMN surprise text",
    "ALTER TABLE users ALTER COLUMN username TYPE varchar(100)", "ALTER TABLE users ALTER COLUMN username DROP NOT NULL",
    "ALTER TABLE pages ALTER COLUMN title SET DEFAULT 'Owner'", "ALTER TABLE users DROP CONSTRAINT users_pkey CASCADE",
    "ALTER TABLE comments ALTER COLUMN status SET DEFAULT 'approved'",
    "ALTER TABLE comments ALTER COLUMN status DROP DEFAULT",
    "CREATE RULE ignore_pages AS ON INSERT TO pages DO INSTEAD NOTHING",
    "ALTER TABLE users ENABLE ROW LEVEL SECURITY",
    "INSERT INTO sessions(id,user_id,expires_at) SELECT 'session',id,now() FROM users",
  ])('refuses populated or unknown preparation targets without seeding: %s', async (sql) => {
    await initializeApplicationSchema(pool, guard);
    if (sql.includes('INSERT INTO sessions')) await pool.query("INSERT INTO users(id,username,password_hash) VALUES($1,'owner','fixture')", [randomUUID()]);
    await pool.query(sql);
    const identity = (await pool.query('SELECT * FROM site_identity')).rows;
    await expect(prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true })).rejects.toThrow();
    expect((await pool.query('SELECT * FROM site_identity')).rows).toEqual(identity);
    expect(await readRestoreFence(paths.storageDir)).toBe(false);
  });
  it('cancels offline preparation before fence/schema mutation and preserves retirement after a crash between schema and seed', async () => {
    expect(await prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => false })).toBe(false);
    expect(await readRestoreFence(paths.storageDir)).toBe(false);
    expect((await pool.query("SELECT to_regclass('users') AS t")).rows[0].t).toBeNull();
    const crashAfterSchema = async () => {
      await guard();
      if ((await pool.query("SELECT to_regclass('site_identity') AS t")).rows[0].t) throw new Error('Synthetic crash after schema');
    };
    await expect(prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: crashAfterSchema, confirm: async () => true })).rejects.toThrow();
    expect(await readRestoreFence(paths.storageDir)).toBe(true);
    expect((await pool.query('SELECT * FROM site_identity')).rows).toEqual([]);
    expect(await prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true })).toBe(true);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired' });
  });
  it('refuses unknown triggers without publishing a fence or running migrations', async () => {
    await ensureSchema(pool); await seedSiteIdentity(pool);
    await pool.query(`CREATE FUNCTION refuse_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retirement refused'; END $$`);
    await pool.query('CREATE TRIGGER refuse_retirement BEFORE INSERT ON onboarding_state FOR EACH ROW EXECUTE FUNCTION refuse_retirement()');
    // A schema with a user trigger is rejected before publication; uncertain inspection is not a repair bypass.
    await expect(prepareNativeRestore(pool, { storageDir: paths.storageDir, assertOwner: guard, confirm: async () => true })).rejects.toThrow();
    expect(await readRestoreFence(paths.storageDir)).toBe(false);
  });
});
