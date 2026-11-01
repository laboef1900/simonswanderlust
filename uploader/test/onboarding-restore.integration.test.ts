import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DbPool } from '../src/db.js';
import { captureBootEvidence, initializeApplicationSchema, initializeOnboarding, type OnboardingPaths } from '../src/onboarding-bootstrap.js';
import { readOnboardingState } from '../src/onboarding.js';
import { publishRestoreFence, readRestoreFence, restoreFencePath } from '../src/onboarding-fence.js';
import { restoreWithOnboarding } from '../src/onboarding-restore.js';
import { dumpDatabase, readDump, validateIdentityAssets, type Dump } from '../src/backup.js';
import { createGpxFiles, sourceDigest, type GpxFiles } from '../src/gpx-files.js';
import { verifyRouteArchive } from '../src/gpx-backup.js';
import { acquireStorageOwner, APP_SESSION_PREFIX, type StorageOwner } from '../src/storage-owner.js';
import { runCli } from './run-cli.js';

import { interceptOnboardingTransactions } from './onboarding-query-fixture.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
/** Real SQL tools use environment credentials, never a password-bearing argv or error. */
async function sqlTool(binary: 'pg_dump' | 'psql', args: string[], url: string, input = ''): Promise<string> {
  const connection = new URL(url);
  const env = { ...process.env, PGHOST: connection.hostname, PGPORT: connection.port || '5432', PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password), PGDATABASE: decodeURIComponent(connection.pathname.slice(1)) };
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', () => {});
  child.once('error', () => reject(new Error(`${binary} is required for managed SQL recovery integration tests.`)));
  child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${binary} failed (${code}).`)));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  return promise;
}

describe.skipIf(!databaseUrl)('managed native, SQL and filesystem recovery onboarding retirement', () => {
  let admin: DbPool;
  let pool: DbPool;
  let schema: string;
  let root: string;
  let paths: OnboardingPaths;
  let files: GpxFiles;
  let url: string;
  let lease: StorageOwner | undefined;
  const guard = async () => {
    if (!lease) throw new Error('Restore lease absent.');
    lease.assertWritable(); await lease.assertNoAppSessions(); lease.assertWritable();
  };
  beforeAll(() => { admin = new pg.Pool({ connectionString: databaseUrl }); });
  beforeEach(async () => {
    schema = 'onboarding_restore_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(databaseUrl!); scoped.searchParams.set('options', `-c search_path=${schema}`); url = scoped.toString();
    pool = new pg.Pool({ connectionString: url });
    root = await mkdtemp(join(await realpath(tmpdir()), 'onboarding-restore-'));
    paths = { storageDir: join(root, 'images'), settingsPath: join(root, 'settings.json'), backupDir: join(root, 'backup'), siteDir: join(root, 'site') };
    files = createGpxFiles({ storageDir: paths.storageDir });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await pool?.end(); await lease?.close(); lease = undefined;
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => { await admin?.end(); });
  async function fresh() {
    lease = await acquireStorageOwner(url, { role: 'restore' });
    const evidence = await captureBootEvidence(pool, guard);
    await initializeApplicationSchema(pool, guard);
    await initializeOnboarding(pool, paths, evidence, guard);
  }
  async function capture() {
    const dir = join(paths.backupDir, 'db');
    const file = join(dir, await dumpDatabase(pool, dir, new Date(), { routeFiles: files }));
    const dump = readDump(file);
    await validateIdentityAssets(dump); await verifyRouteArchive(file, dump.routeArchive, dump.tables.post_routes ?? []);
    return file;
  }
  function cliEnv() {
    return { ...process.env, DATABASE_URL: url, STORAGE_DIR: paths.storageDir, SETTINGS_PATH: paths.settingsPath, SITE_DIR: paths.siteDir, BACKUP_DIR: paths.backupDir };
  }
  async function seedOriginal() {
    const tk = randomUUID();
    for (const locale of ['de', 'en']) {
      await pool.query(`INSERT INTO posts(id,translation_key,locale,slug,title,date,country,country_code,region,excerpt,hero_image,coordinates,body_markdown)
        VALUES($1,$2,$3,$2,'Fixture','2026-01-01','Test','DE','europe','e','{}','{}','b')`, [randomUUID(), tk, locale]);
    }
    const bytes = Buffer.from('<gpx version="1.1"><trk/></gpx>');
    const source = { translationKey: tk, sourceId: randomUUID(), sha256: sourceDigest(bytes), bytes: bytes.length };
    await files.writeOriginal(source, bytes);
    await pool.query(`INSERT INTO post_routes(translation_key,version,geometry,source_id,source_sha256,source_bytes,updated_at)
      VALUES($1,$2,NULL,$3,$4,$5,now())`, [tk, randomUUID(), source.sourceId, source.sha256, source.bytes]);
    return { source, bytes };
  }
  it.each([1, 10, 'self'] as const)('retires native %s restore regardless of empty content or foreign timestamps', async (version) => {
    await fresh();
    let file = await capture();
    if (version !== 'self') {
      const dump: Dump = { version, createdAt: '2099-01-01T00:00:00Z', tables: { users: [], posts: [], ...(version === 10 ? { post_routes: [] } : {}) } };
      file = join(root, 'db-20990101-000000.json.gz');
      await writeFile(file, gzipSync(JSON.stringify(dump)));
    }
    const before = await readFile(file);
    await restoreWithOnboarding(pool, file, { storageDir: paths.storageDir, routeFiles: files, assertOwner: guard });
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired', reason: 'restored-content' });
    expect(await readRestoreFence(paths.storageDir)).toBe(true);
    expect(await readFile(file)).toEqual(before);
    await restoreWithOnboarding(pool, file, { storageDir: paths.storageDir, routeFiles: files, assertOwner: guard });
    expect(await readRestoreFence(paths.storageDir)).toBe(true);
  });
  it('runs the actual fresh-cluster preparation/native CLI sequence and verifies the prepared identity undo set', async () => {
    const source: Dump = { version: 1, createdAt: '2001-01-01T00:00:00Z', tables: { users: [], posts: [] } };
    const file = join(root, 'db-20010101-000000.json.gz'); await writeFile(file, gzipSync(JSON.stringify(source)));
    const prepared = await runCli(['prepare-native-restore', '--yes'], cliEnv());
    expect(prepared.code).toBe(0);
    expect(await readOnboardingState(pool)).toMatchObject({ reason: 'restored-content' });
    const restored = await runCli(['restore', '--yes', file], cliEnv());
    expect(restored.code).toBe(0);
    const undoNames = (await readdir(join(paths.backupDir, 'db'))).filter((name) => /^db-.*\.json\.gz$/.test(name));
    expect(undoNames).toHaveLength(1);
    const undoPath = join(paths.backupDir, 'db', undoNames[0]!);
    const undo = readDump(undoPath);
    await validateIdentityAssets(undo); await verifyRouteArchive(undoPath, undo.routeArchive, undo.tables.post_routes ?? []);
    expect(undo.tables.site_identity![0]).toMatchObject({ seed_source: 'neutral', saved_at: null });
    expect(undo.tables).not.toHaveProperty('onboarding_state');
    const undone = await runCli(['restore', '--yes', undoPath], cliEnv());
    expect(undone.code).toBe(0);
    expect(await readRestoreFence(paths.storageDir)).toBe(true);
    expect(readDump(undoPath)).toEqual(undo);
  }, 30_000);
  it('does not retire before ordinary restore confirmation or input/undo validation succeeds', async () => {
    await fresh(); const file = await capture();
    await lease!.close(); lease = undefined;
    expect((await runCli(['restore', file], cliEnv(), 'no\n')).code).toBe(1);
    expect(await readRestoreFence(paths.storageDir)).toBe(false);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'eligible' });
    const invalid = join(root, 'db-20000101-000000.json.gz'); await writeFile(invalid, 'not a dump');
    expect((await runCli(['restore', '--yes', invalid], cliEnv())).code).not.toBe(0);
    expect(await readRestoreFence(paths.storageDir)).toBe(false);
    await pool.query('DELETE FROM site_identity');
    expect((await runCli(['restore', '--yes', file], cliEnv())).code).toBe(1);
    expect(await readRestoreFence(paths.storageDir)).toBe(false);
  }, 30_000);
  it('prevents every staging/replacement call when fence publication or retirement commit fails', async () => {
    await fresh(); await seedOriginal(); const file = await capture();
    const staging = vi.spyOn(files, 'writeArchivedOriginal');
    await writeFile(restoreFencePath(paths.storageDir), 'corrupt');
    await expect(restoreWithOnboarding(pool, file, { storageDir: paths.storageDir, routeFiles: files, assertOwner: guard })).rejects.toThrow();
    expect(staging).not.toHaveBeenCalled();
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'eligible' });
    // Only this synthetic corrupt fixture is removed, never a valid retirement fence.
    await rm(restoreFencePath(paths.storageDir));
    await pool.query(`CREATE FUNCTION reject_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retirement commit refused'; END $$`);
    await pool.query('CREATE CONSTRAINT TRIGGER reject_retirement AFTER UPDATE ON onboarding_state DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_retirement()');
    await expect(restoreWithOnboarding(pool, file, { storageDir: paths.storageDir, routeFiles: files, assertOwner: guard })).rejects.toThrow();
    expect(await readRestoreFence(paths.storageDir)).toBe(true);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'eligible' });
    expect(staging).not.toHaveBeenCalled();
    await pool.query('DROP TRIGGER reject_retirement ON onboarding_state');
    await restoreWithOnboarding(pool, file, { storageDir: paths.storageDir, routeFiles: files, assertOwner: guard });
    expect(staging).toHaveBeenCalled();
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired' });
  });
  it('retains retirement, original sources and verified recovery material after content rollback', async () => {
    await fresh();
    const { source, bytes } = await seedOriginal();
    const file = await capture(); const before = await readFile(file);
    await pool.query(`CREATE FUNCTION reject_content() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'content commit refused'; END $$`);
    await pool.query('CREATE CONSTRAINT TRIGGER reject_content AFTER INSERT ON posts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_content()');
    await expect(restoreWithOnboarding(pool, file, { storageDir: paths.storageDir, routeFiles: files, assertOwner: guard })).rejects.toThrow();
    expect(await readRestoreFence(paths.storageDir)).toBe(true);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired' });
    expect((await files.inspectOriginal(source)).bytes).toEqual(bytes);
    expect(await readFile(file)).toEqual(before);
    const dump = readDump(file); await verifyRouteArchive(file, dump.routeArchive, dump.tables.post_routes ?? []);
  });
  it.each([
    { stage: 'retirement', commitNumber: 1, readback: true, completed: false },
    { stage: 'content with positive identity readback', commitNumber: 2, readback: true, completed: true },
    { stage: 'content without readback', commitNumber: 2, readback: false, completed: false },
  ])('retains retirement and sources after lost $stage acknowledgement', async ({ commitNumber, readback, completed }) => {
    await fresh(); const { source, bytes } = await seedOriginal(); const file = await capture();
    const staging = vi.spyOn(files, 'writeArchivedOriginal');
    let commits = 0;
    const transactions = interceptOnboardingTransactions(pool, async (sql) => {
      if (sql === 'COMMIT' && ++commits === commitNumber) throw new Error('Synthetic lost commit acknowledgement');
    });
    const uncertain = new Proxy(transactions, {
      get(target, property) {
        if (property === 'query') return async (sql: string, values?: unknown[]) => {
          if (!readback && commits >= commitNumber) throw new Error('Synthetic unavailable readback');
          return target.query(sql, values);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = restoreWithOnboarding(uncertain, file, { storageDir: paths.storageDir, routeFiles: files, assertOwner: guard });
    if (completed) await expect(result).resolves.toMatchObject({ posts: 2, routes: 1 });
    else await expect(result).rejects.toThrow();
    expect(await readRestoreFence(paths.storageDir)).toBe(true);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired' });
    expect((await files.inspectOriginal(source)).bytes).toEqual(bytes);
    if (commitNumber === 1) expect(staging).not.toHaveBeenCalled();
    else {
      expect(staging).toHaveBeenCalled();
      const restored = (await pool.query('SELECT * FROM post_routes')).rows[0];
      expect(restored.source_id).not.toBe(source.sourceId);
      expect((await files.inspectOriginal({ translationKey: restored.translation_key, sourceId: restored.source_id, sha256: restored.source_sha256, bytes: restored.source_bytes })).bytes).toEqual(bytes);
    }
    const dump = readDump(file); await verifyRouteArchive(file, dump.routeArchive, dump.tables.post_routes ?? []);
  });
  it('stops before staging if ownership is lost after durable retirement', async () => {
    await fresh(); await seedOriginal(); const file = await capture();
    const staging = vi.spyOn(files, 'writeArchivedOriginal');
    const losingGuard = async () => {
      await guard();
      if ((await readOnboardingState(pool))?.state === 'retired') {
        await lease!.close(); lease = undefined;
        throw new Error('Synthetic owner loss after retirement');
      }
    };
    await expect(restoreWithOnboarding(pool, file, { storageDir: paths.storageDir, routeFiles: files, assertOwner: losingGuard })).rejects.toThrow();
    expect(staging).not.toHaveBeenCalled();
    expect(await readRestoreFence(paths.storageDir)).toBe(true);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired' });
  });
  it('refuses live owners and still-draining app sessions, then releases the fence-only lease on exit', async () => {
    const live = await acquireStorageOwner(url, { role: 'app' });
    try { expect((await runCli(['onboarding-retire'], cliEnv())).code).not.toBe(0); }
    finally { await live.close(); }
    expect(await readRestoreFence(paths.storageDir)).toBe(false);
    const draining = new pg.Pool({ connectionString: url, application_name: APP_SESSION_PREFIX + randomUUID() });
    try {
      await draining.query('SELECT 1');
      expect((await runCli(['onboarding-retire'], cliEnv())).code).not.toBe(0);
      expect(await readRestoreFence(paths.storageDir)).toBe(false);
    } finally { await draining.end(); }
    expect((await runCli(['onboarding-retire'], cliEnv())).code).toBe(0);
    expect((await pool.query("SELECT to_regclass('users') AS table_name")).rows[0].table_name).toBeNull();
    lease = await acquireStorageOwner(url, { role: 'restore' });
    await guard();
    expect(await readRestoreFence(paths.storageDir)).toBe(true);
  }, 30_000);
  it('reconciles a real pg_dump containing eligible state after stopped SQL replacement, including table drop and partial/empty input', async () => {
    await fresh();
    const sql = await sqlTool('pg_dump', ['--schema', schema, '--clean', '--if-exists', '--no-owner', '--no-privileges'], url);
    await lease!.close(); lease = undefined;
    expect((await runCli(['onboarding-retire'], cliEnv())).code).toBe(0);
    // This process represents the stopped-writer interval. The separate CLI lease is gone.
    await sqlTool('psql', ['-X', '--set', 'ON_ERROR_STOP=1'], url, sql);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'eligible' });
    expect(await readRestoreFence(paths.storageDir)).toBe(true);
    lease = await acquireStorageOwner(url, { role: 'restore' });
    const evidence = await captureBootEvidence(pool, guard);
    await initializeApplicationSchema(pool, guard); await initializeOnboarding(pool, paths, evidence, guard);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired' });
    await lease.close(); lease = undefined;
    for (const replacement of ['', `SET search_path=${schema}; DROP TABLE onboarding_state;`, `SET search_path=${schema}; UPDATE pages SET title='Partial recovery'; SELECT missing_table FROM absent_relation;`]) {
      expect((await runCli(['onboarding-retire'], cliEnv())).code).toBe(0);
      if (replacement.includes('absent_relation')) await expect(sqlTool('psql', ['-X', '--set', 'ON_ERROR_STOP=1'], url, replacement)).rejects.toThrow();
      else await sqlTool('psql', ['-X', '--set', 'ON_ERROR_STOP=1'], url, replacement);
      lease = await acquireStorageOwner(url, { role: 'restore' });
      const prior = await captureBootEvidence(pool, guard);
      await initializeApplicationSchema(pool, guard); await initializeOnboarding(pool, paths, prior, guard);
      expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired' });
      expect(await readRestoreFence(paths.storageDir)).toBe(true);
      await lease.close(); lease = undefined;
    }
  }, 60_000);
  it('preserves an in-place fence and fences a staged cold-clone root before activation, retaining the original root', async () => {
    await fresh();
    const snapshot = join(root, 'offline-snapshot'); await mkdir(snapshot);
    await writeFile(join(snapshot, 'settings.json'), '{"fixture":true}');
    await writeFile(join(snapshot, 'onboarding.restore-retired'), 'old untrusted snapshot marker');
    await publishRestoreFence(paths.storageDir, guard);
    const before = await readFile(restoreFencePath(paths.storageDir));
    await cp(snapshot, root, { recursive: true, filter: (source) => basename(source) !== 'onboarding.restore-retired' });
    expect(await readFile(restoreFencePath(paths.storageDir))).toEqual(before);
    const staged = join(root, 'offline-staged'); await mkdir(staged);
    const stagedStorage = join(staged, 'images');
    await publishRestoreFence(stagedStorage, guard);
    await cp(snapshot, staged, { recursive: true, filter: (source) => basename(source) !== 'onboarding.restore-retired' });
    expect(await readRestoreFence(stagedStorage, true)).toBe(true);
    // Selecting the staged root is the activation boundary; it is never booted unfenced.
    const selected = { ...paths, storageDir: stagedStorage, settingsPath: join(staged, 'settings.json') };
    await initializeOnboarding(pool, selected, await captureBootEvidence(pool, guard), guard);
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired' });
    expect(await readFile(restoreFencePath(paths.storageDir))).toEqual(before);
    expect(await readFile(join(snapshot, 'settings.json'), 'utf8')).toBe('{"fixture":true}');
  });
});
