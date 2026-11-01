import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { initializeApplicationSchema, assertBootstrapOnlyTarget } from '../src/onboarding-bootstrap.js';
import { dumpDatabase, readDump, restoreDatabase, SUPPORTED_DUMP_VERSIONS, JOURNEYS_DUMP_VERSION, type Dump } from '../src/backup.js';
import { pgPostStore } from '../src/posts.js';
import { repairJourneyOrphans } from '../src/journey-cleanup.js';
import { interceptOnboardingTransactions } from './onboarding-query-fixture.js';
import type { JourneySnapshot } from '../../site/src/lib/journey-snapshot.js';
import { runCli } from './run-cli.js';
import { acquireStorageOwner } from '../src/storage-owner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const stamp = '2026-10-29T12:00:00.000Z';
const hero = { src: 'https://images.example/photos/hero', width: 1000, height: 600, alt: 'Mountain', focus: { x: 25, y: 75 } };
describe.skipIf(!databaseUrl)('journey-aware schema and offline recovery transaction', () => {
  let admin: DbPool; let pool: DbPool; let schema: string; let dir: string;
  beforeAll(() => { admin = new pg.Pool({ connectionString: databaseUrl }); });
  beforeEach(async () => {
    schema = 'journey_recovery_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    dir = await realpath(await mkdtemp(join(tmpdir(), 'journey-recovery-')));
    await initializeApplicationSchema(pool, () => {});
  });
  afterEach(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await rm(dir, { recursive: true, force: true }); });
  afterAll(async () => { await admin.end(); });
  async function capture() { const path = join(dir, await dumpDatabase(pool, dir)); return { path, dump: readDump(path) }; }
  async function save(dump: Dump) { const path = join(dir, 'db-20000101-000000.json.gz'); await writeFile(path, gzipSync(JSON.stringify(dump))); return path; }
  async function mode(primary: 'de' | 'en', bilingual = false) {
    await pool.query('UPDATE site_language SET primary_locale=$1,enabled_locales=$2,locked_at=$3', [primary, bilingual ? [primary, primary === 'de' ? 'en' : 'de'] : [primary], stamp]);
    await pool.query('UPDATE posts SET omitted=(locale<>$1)', [primary]);
  }
  async function stories() {
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    for (const key of keys) for (const locale of ['de', 'en']) {
      await pool.query(`INSERT INTO posts(id,translation_key,locale,slug,title,date,country,country_code,region,excerpt,hero_image,coordinates,body_markdown,omitted)
        VALUES($1,$2,$3,$2,'Story','2026-01-01','Test','DE','europe','Excerpt',$4,'{"lat":1,"lng":2}','Body',$5)`,
      [randomUUID(), key, locale, JSON.stringify(hero), locale !== 'de']);
    }
    return keys;
  }
  async function journey(keys: string[], primary: 'de' | 'en' = 'de', status = 'published') {
    const id = randomUUID();
    const snapshot: JourneySnapshot = { version: 1, members: keys, locales: {
      [primary]: { slug: 'journey-' + id, title: 'Committed journey', intro: 'Committed introduction.', heroImage: hero },
    } };
    await pool.query('INSERT INTO journeys(id,status,published_snapshot,published_at,created_at,updated_at) VALUES($1,$2,$3,$4,$4,$4)', [id, status, JSON.stringify(snapshot), stamp]);
    for (const locale of ['de', 'en']) await pool.query(`INSERT INTO journey_locales(journey_id,locale,slug,title,intro,hero_image,omitted,published_at)
      VALUES($1,$2,$3,'Edited working title','',$4,$5,$6)`, [id, locale, 'journey-' + id, JSON.stringify(hero), locale !== primary, locale === primary ? stamp : null]);
    for (const [position, key] of keys.entries()) await pool.query('INSERT INTO journey_members VALUES($1,$2,$3)', [id, key, position]);
    return id;
  }
  function journeyTables(dump: Dump) {
    return { journeys: dump.tables.journeys, journey_locales: dump.tables.journey_locales, journey_members: dump.tables.journey_members, site_language: dump.tables.site_language };
  }

  it('creates an exact idempotent additive schema, and admits it only while bootstrap-empty', async () => {
    await assertBootstrapOnlyTarget(pool, () => {});
    await ensureSchema(pool);
    await assertBootstrapOnlyTarget(pool, () => {});
    const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='posts' ORDER BY ordinal_position")).rows;
    expect(columns.some(row => String(row.column_name).startsWith('journey'))).toBe(false);
    await pool.query('INSERT INTO journeys(id) VALUES($1)', [randomUUID()]);
    await expect(assertBootstrapOnlyTarget(pool, () => {})).rejects.toThrow(/empty bootstrap-only|owner content/);
  });
  it.each([
    'ALTER TABLE journey_members DROP CONSTRAINT journey_members_position_check',
    'ALTER TABLE journey_members DROP CONSTRAINT journey_members_journey_id_position_key',
    'ALTER TABLE journey_locales DROP CONSTRAINT journey_locales_journey_id_fkey',
    'ALTER TABLE journey_locales ALTER COLUMN omitted SET DEFAULT true',
    'DROP INDEX journey_members_tk_idx; CREATE INDEX journey_members_tk_idx ON journey_members(translation_key)',
    'ALTER TABLE journeys ADD COLUMN unknown text',
  ])('refuses modified journey bootstrap semantics: %s', async sql => {
    await pool.query(sql);
    await expect(assertBootstrapOnlyTarget(pool, () => {})).rejects.toThrow(/Preparation refuses/);
  });
  it.each(['pre-journey', 'pre-pages'])('admits the exact %s catalog without weakening unknown-schema refusal', async previous => {
    await pool.query('DROP TABLE journey_members,journey_locales,journeys');
    if (previous === 'pre-pages') await pool.query('DROP TABLE site_nav; ALTER TABLE pages DROP COLUMN slug, DROP COLUMN status, DROP COLUMN published_at');
    await assertBootstrapOnlyTarget(pool, () => {});
    await initializeApplicationSchema(pool, () => {});
    expect((await capture()).dump.tables.journeys).toEqual([]);
    await pool.query('CREATE TABLE unexpected_owner_data(id integer)');
    await expect(assertBootstrapOnlyTarget(pool, () => {})).rejects.toThrow(/unknown application tables/);
  });

  it('round-trips working copies, exact snapshots, history, ordering and hero focus in one repeatable-read capture', async () => {
    const keys = await stories(); await mode('de', true); await journey(keys);
    const queries: string[] = [];
    const traced = interceptOnboardingTransactions(pool, async sql => { queries.push(sql); });
    const path = join(dir, await dumpDatabase(traced, dir)); const before = readDump(path);
    expect(queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const table of ['journeys', 'journey_locales', 'journey_members']) {
      const selects = queries.filter(sql => sql.includes(`FROM ${table} ORDER`));
      expect(selects).toHaveLength(1); expect(selects[0]).not.toContain('SELECT *');
    }
    await pool.query('DELETE FROM journeys');
    const counts = await restoreDatabase(pool, path);
    expect(counts.journeys).toBe(1);
    expect(journeyTables((await capture()).dump)).toEqual(journeyTables(before));
  });

  it.each(SUPPORTED_DUMP_VERSIONS.filter(version => version < JOURNEYS_DUMP_VERSION))('restores v%i into journey schema with no surviving destination journeys', async version => {
    const keys = await stories(); await mode('de', true);
    const source = (await capture()).dump;
    source.version = version;
    delete source.tables.journeys; delete source.tables.journey_locales; delete source.tables.journey_members;
    if (version < 13) { delete source.tables.site_nav; source.tables.pages = []; }
    if (version < 12) delete source.tables.site_language;
    if (version < 11) { delete source.tables.site_identity; delete source.tables.site_identity_assets; }
    if (version < 10) delete source.tables.post_routes;
    await mode('en'); await journey(keys, 'en');
    expect((await restoreDatabase(pool, await save(source))).journeys).toBe(0);
    const restored = await capture();
    expect(restored.dump.tables.journeys).toEqual([]); expect(restored.dump.tables.journey_locales).toEqual([]); expect(restored.dump.tables.journey_members).toEqual([]);
    expect(restored.dump.tables.site_language![0]!.primary_locale).toBe('de');
    await restoreDatabase(pool, restored.path); // immediately valid, without another boot
  });

  it.each(['de', 'en'] as const)('atomically replaces opposite-primary journeys for pre14 %s input and keeps a verified undo', async primary => {
    const keys = await stories(); await mode(primary);
    const source = (await capture()).dump; source.version = 13;
    delete source.tables.journeys; delete source.tables.journey_locales; delete source.tables.journey_members;
    const opposite = primary === 'de' ? 'en' : 'de';
    await mode(opposite); await journey(keys, opposite);
    const undo = await capture(); const input = await save(source);
    const failing = interceptOnboardingTransactions(pool, async sql => {
      if (sql.startsWith('INSERT INTO site_language')) throw new Error('injected recovery failure');
    });
    await expect(restoreDatabase(failing, input)).rejects.toThrow('injected recovery failure');
    expect(journeyTables((await capture()).dump)).toEqual(journeyTables(undo.dump));
    await restoreDatabase(pool, input);
    const restored = await capture();
    expect(restored.dump.tables.journeys).toEqual([]);
    expect(restored.dump.tables.site_language![0]!.primary_locale).toBe(primary);
    await restoreDatabase(pool, restored.path);
    await restoreDatabase(pool, undo.path);
    expect(journeyTables((await capture()).dump)).toEqual(journeyTables(undo.dump));
  });

  it('CLI retains exclusive-owner and cross-mode admission, reports all journey counts and verifies a usable undo', async () => {
    const keys = await stories(); await mode('de');
    const source = (await capture()).dump; source.version = 13;
    delete source.tables.journeys; delete source.tables.journey_locales; delete source.tables.journey_members;
    const input = await save(source);
    await mode('en'); await journey(keys, 'en');
    const before = (await capture()).dump;
    const scoped = new URL(databaseUrl!); scoped.searchParams.set('options', `-c search_path=${schema}`);
    const backupDir = join(dir, 'undo');
    const env = { ...process.env, DATABASE_URL: scoped.toString(), BACKUP_DIR: backupDir,
      STORAGE_DIR: join(dir, 'data', 'images'), SETTINGS_PATH: join(dir, 'data', 'settings.json'), SITE_DIR: join(dir, 'data', 'site') };
    const owner = await acquireStorageOwner(scoped.toString(), { role: 'restore' });
    try {
      expect((await runCli(['restore', '--yes', '--accept-language-change', input], env)).code).not.toBe(0);
      expect(journeyTables((await capture()).dump)).toEqual(journeyTables(before));
    } finally { await owner.close(); }
    const refused = await runCli(['restore', '--yes', input], env);
    expect(refused.code).not.toBe(0); expect(refused.stderr).toContain('--accept-language-change');
    expect(journeyTables((await capture()).dump)).toEqual(journeyTables(before));
    const result = await runCli(['restore', '--yes', '--accept-language-change', input], env);
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('journeys 1, journey_locales 2, journey_members 3');
    expect(result.stdout).toContain('0 journeys (0 journey_locales, 0 journey_members)');
    const names = await readdir(join(backupDir, 'db'));
    const undo = join(backupDir, 'db', names.find(name => name.endsWith('.json.gz'))!);
    expect(journeyTables(readDump(undo))).toEqual(journeyTables(before));
    expect((await runCli(['restore', '--yes', '--accept-language-change', undo], env)).code).toBe(0);
    expect(journeyTables((await capture()).dump)).toEqual(journeyTables(before));
  }, 60_000);

  it('refuses to publish a native dump containing an orphan or incoherent mode', async () => {
    const keys = await stories(); await mode('de'); await journey(keys);
    await pool.query('DELETE FROM posts WHERE translation_key=$1', [keys[1]]);
    await expect(dumpDatabase(pool, dir)).rejects.toThrow('Invalid journeys in backup.');
    expect(await readdir(dir)).toEqual([]);
    await repairJourneyOrphans(pool);
    await mode('en');
    await expect(dumpDatabase(pool, dir)).rejects.toThrow('Invalid journeys in backup.');
    expect(await readdir(dir)).toEqual([]);
  });

  it.each(['delete', 'bulk', 'boot'] as const)('scrubs all retained references and compacts interior membership before immediate backup: %s', async action => {
    const keys = await stories(); await mode('de');
    const first = await journey(keys, 'de', 'draft');
    await pool.query('DELETE FROM journey_members WHERE journey_id=$1', [first]);
    const second = await journey(keys);
    const before = await capture();
    if (action === 'boot') {
      await pool.query('DELETE FROM posts WHERE translation_key=$1', [keys[1]]);
      await repairJourneyOrphans(pool);
    } else {
      await pgPostStore(pool).remove(keys[1]!);
      if (action === 'bulk') await pgPostStore(pool).remove(keys[0]!);
    }
    const after = await capture();
    expect(after.dump.tables.journey_members!.filter(row => row.journey_id === second).map(row => row.position)).toEqual(action === 'bulk' ? [0] : [0, 1]);
    for (const row of after.dump.tables.journeys!) {
      expect((row.published_snapshot as JourneySnapshot).members).toEqual(action === 'bulk' ? [keys[2]] : [keys[0], keys[2]]);
      expect(Date.parse(row.updated_at as string)).toBeGreaterThan(Date.parse(before.dump.tables.journeys!.find(old => old.id === row.id)!.updated_at as string));
    }
    await restoreDatabase(pool, after.path);
    expect(journeyTables((await capture()).dump)).toEqual(journeyTables(after.dump));
  });
});
