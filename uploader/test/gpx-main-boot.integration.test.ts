import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { pgPostStore, type PostLocale, type StoredPostPair } from '../src/posts.js';
import { pgUserStore } from '../src/users.js';
import { lockPostPair } from '../src/post-pair-lock.js';
import { pgGpxStore } from '../src/gpx-store.js';
import { safePairHash } from '../src/gpx-files.js';
import { acquireStorageOwner, APP_SESSION_PREFIX, STORAGE_OWNER_LOCK_KEY } from '../src/storage-owner.js';
import type { ImportPreview, RouteMutation } from '../src/gpx-service.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const uploaderDir = fileURLToPath(new URL('..', import.meta.url));
const xml = '<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><metadata><name>PRIVATE_BOOT_SOURCE</name></metadata><trk><trkseg><trkpt lat="12.345678" lon="23.456789"/><trkpt lat="12.346678" lon="23.457789"/></trkseg></trk></gpx>';
interface ProcessExit { code: number | null; signal: NodeJS.Signals | null }
interface RunningChild { child: ChildProcess; exited: Promise<ProcessExit>; log: () => string }

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('No loopback TCP address');
  return address.port;
}
// PostgreSQL and spawned Node processes cannot be driven by Vitest fake clocks.
// Poll observable readiness/lock state; timers only bound failure and cleanup.
async function until(check: () => Promise<boolean>, detail: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Production fixture did not reach expected state: ${detail()}`);
    await delay(20);
  }
}
async function exitedWithin(process: RunningChild): Promise<ProcessExit> {
  const timeout = setTimeout(() => process.child.kill('SIGKILL'), 15_000);
  try {
    const result = await process.exited;
    if (result.signal === 'SIGKILL') throw new Error(`Child did not exit voluntarily: ${process.log()}`);
    return result;
  } finally { clearTimeout(timeout); }
}

// Ownership is database-wide, not schema-wide. Like storage-owner.integration,
// this suite must run in the serial integration project, never parallel workers.
maybe('private GPX production composition and lease-loss containment', () => {
  const schema = `gpx_boot_${randomUUID().replaceAll('-', '')}`;
  const password = 'synthetic-gpx-boot-password';
  const children: RunningChild[] = [];
  let observer: DbPool;
  let pool: DbPool;
  let root: string;
  let base: string;
  let databaseUrl: string;
  let env: NodeJS.ProcessEnv;
  let app: RunningChild;
  let pair: StoredPostPair;
  let cookie: string;
  let restoreInput: string;

  function launch(script: 'main.ts' | 'cli.ts', args: string[] = [], overrides: NodeJS.ProcessEnv = {}): RunningChild {
    const child = spawn(process.execPath, ['--import', 'tsx', join(uploaderDir, 'src', script), ...args], {
      cwd: uploaderDir, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout!.on('data', (bytes: Buffer) => { log += bytes.toString(); });
    child.stderr!.on('data', (bytes: Buffer) => { log += bytes.toString(); });
    const exited = new Promise<ProcessExit>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    // Attach a rejection handler immediately, including when setup fails early.
    void exited.catch(() => {});
    const running = { child, exited, log: () => log };
    children.push(running);
    return running;
  }

  beforeAll(async () => {
    observer = new pg.Pool({ connectionString: url });
    await observer.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    scoped.searchParams.set('application_name', `gpx-boot-fixture:${randomUUID()}`);
    databaseUrl = scoped.toString();
    pool = new pg.Pool({ connectionString: databaseUrl });
    await ensureSchema(pool);
    await pgUserStore(pool).create({ username: 'gpx-author', password, isAdmin: false });
    const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: `boot-${locale}`, title: 'Synthetic boot story', excerpt: '', country: 'Test', heroImage: { src: '', width: 1, height: 1, alt: '' }, bodyMarkdown: 'Synthetic boot text', images: {} });
    pair = await pgPostStore(pool).upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') });
    root = await mkdtemp(join(await realpath(tmpdir()), 'gpx-main-boot-'));
    for (const path of ['images', 'map', 'backup/db', 'site/releases/synthetic']) await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, 'site/releases/synthetic/index.html'), '<!doctype html><title>Synthetic release</title><p>STATIC_BOOT_RELEASE</p>');
    await symlink(join(root, 'site/releases/synthetic'), join(root, 'site/current'));
    await writeFile(join(root, 'settings.json'), JSON.stringify({ backupSchedule: 'off' }));
    restoreInput = join(root, 'db-20260101-000000.json.gz');
    // Valid legacy input with no private archive: refusal must be ownership, not
    // an unreadable/malformed dump. Were a guard broken, only this schema is at risk.
    await writeFile(restoreInput, gzipSync(JSON.stringify({ version: 9, createdAt: '2026-01-01T00:00:00.000Z', tables: { users: [], posts: [] } })));
    const port = await freePort(); base = `http://127.0.0.1:${port}`;
    const { ENCRYPTION_KEY: _unused, ...inherited } = process.env;
    env = {
      ...inherited, DATABASE_URL: databaseUrl, HOST: '127.0.0.1', PORT: String(port), PUBLIC_BASE_URL: base,
      IMG_HOST: `images.gpx.test:${port}`, STORAGE_DIR: join(root, 'images'), SETTINGS_PATH: join(root, 'settings.json'),
      SITE_DIR: join(root, 'site'), SITE_APP_DIR: join(root, 'deliberately-unavailable-site-app'),
      BACKUP_DIR: join(root, 'backup'), MAP_DIR: join(root, 'map'), PGOPTIONS: '',
    };
    app = launch('main.ts');
    await until(async () => {
      if (app.child.exitCode !== null || app.child.signalCode !== null) throw new Error(`Production boot exited: ${app.log()}`);
      if (!app.log().includes(`app listening on :${port}`)) return false;
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
      return response.status === 200;
    }, app.log);
    const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: 'gpx-author', password }) });
    expect(login.status).toBe(200);
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(cookie).toMatch(/^sid=.+/);
  }, 30_000);

  afterAll(async () => {
    // Await every child: a fire-and-forget kill can leave its lease racing the
    // next serial suite. Never select or terminate any owner/user process.
    for (const running of children.reverse()) {
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGTERM');
      const force = setTimeout(() => running.child.kill('SIGKILL'), 5_000);
      try { await running.exited; } finally { clearTimeout(force); }
    }
    await pool?.end();
    if (observer) { await observer.query(`DROP SCHEMA ${schema} CASCADE`); await observer.end(); }
    if (root) await rm(root, { recursive: true, force: true });
  }, 30_000);

  it('serves real private imports, refuses rival owners, and stays static-only after losing its lease with a save draining', async () => {
    const tk = pair.translationKey;
    const multipart = new FormData(); multipart.set('file', new Blob([xml], { type: 'application/gpx+xml' }), 'synthetic.gpx');
    const imported = await fetch(`${base}/gpx/imports`, { method: 'POST', headers: { cookie, origin: base }, body: multipart });
    expect(imported.status).toBe(201); expect(imported.headers.get('cache-control')).toBe('no-store');
    const preview = await imported.json() as ImportPreview;
    expect(preview.geometry.segments[0]?.points).toHaveLength(2);
    for (const headers of [new Headers(), new Headers({ host: env.IMG_HOST! })]) {
      const pending = await fetch(`${base}/routes/pending/${preview.importId}.gpx`, { headers });
      expect(pending.status).toBe(404);
      expect(await pending.text()).not.toContain('PRIVATE_BOOT_SOURCE');
    }
    const attached = await fetch(`${base}/posts/${tk}/route`, {
      method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ importId: preview.importId, baseVersion: null, baseUpdatedAt: pair.updatedAt.toISOString(), selection: { startPoints: 0, endPoints: 0, removedSegments: [] }, confirmReplace: false }),
    });
    expect(attached.status).toBe(200);
    const saved = await attached.json() as RouteMutation;
    const privateRead = await fetch(`${base}/posts/${tk}/route`, { headers: { cookie } });
    expect(privateRead.status).toBe(200); expect(privateRead.headers.get('cache-control')).toBe('no-store');
    expect(await privateRead.json()).toMatchObject({ version: saved.version, geometry: preview.geometry, originalAvailable: true });
    const original = await fetch(`${base}/posts/${tk}/route/original`, { headers: { cookie } });
    expect(original.status).toBe(200); expect(original.headers.get('cache-control')).toBe('no-store');
    expect(original.headers.get('content-disposition')).toBe('attachment; filename="route.gpx"');
    expect(await original.text()).toBe(xml);
    for (const suffix of ['', '/original']) {
      const anonymous = await fetch(`${base}/posts/${tk}/route${suffix}`);
      expect(anonymous.status).toBe(401); expect(anonymous.headers.get('cache-control')).toBe('no-store');
    }
    const record = (await pgGpxStore(pool).get(tk))!;
    const privateFile = `originals/${safePairHash(tk)}/${record.source.sourceId}.gpx`;
    for (const path of [`/routes/${privateFile}`, `/${privateFile}`, `/admin/routes/${privateFile}`, `/map/routes/${privateFile}`]) {
      for (const headers of [new Headers(), new Headers({ host: env.IMG_HOST! })]) {
        const response = await fetch(base + path, { headers });
        expect(response.status, path).toBe(404);
        expect(await response.text()).not.toContain('PRIVATE_BOOT_SOURCE');
      }
    }
    const before = (await pgPostStore(pool).get(tk))!;
    const backupBefore = await readdir(join(root, 'backup/db'));
    const otherPort = await freePort();
    const rival = launch('main.ts', [], { PORT: String(otherPort) });
    expect((await exitedWithin(rival)).code).not.toBe(0);
    expect(rival.log()).toContain('StorageReadOnlyError');
    expect(rival.log()).not.toContain(`app listening on :${otherPort}`);
    const restoreWhileOwned = launch('cli.ts', ['restore', '--yes', restoreInput]);
    expect((await exitedWithin(restoreWhileOwned)).code).not.toBe(0);
    expect(restoreWhileOwned.log()).toContain('StorageReadOnlyError');
    expect(await readdir(join(root, 'backup/db'))).toEqual(backupBefore);
    expect(await pgPostStore(pool).get(tk)).toEqual(before);

    // Identify only this successfully booted child's dedicated two-int lease.
    // Its pool has the same tag, so application_name alone is NOT a safe target.
    const leaseRows = await observer.query<{ pid: number; application_name: string }>(`SELECT a.pid, a.application_name FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.granted AND l.classid=$1 AND l.objid=$2 AND l.objsubid=2 AND a.datname=current_database()`, [...STORAGE_OWNER_LOCK_KEY]);
    expect(leaseRows.rows).toHaveLength(1);
    const lease = leaseRows.rows[0]!;
    expect(lease.application_name.startsWith(APP_SESSION_PREFIX)).toBe(true);
    const blocker = await pool.connect();
    let pendingSave: Promise<Response> | undefined;
    try {
      await blocker.query('BEGIN'); await lockPostPair(blocker, tk);
      pendingSave = fetch(`${base}/posts/${tk}`, {
        method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({ ...before, de: { ...before.de, title: 'MUST ROLL BACK AFTER LEASE LOSS' } }),
      });
      void pendingSave.catch(() => {});
      await until(async () => {
        const blocked = await observer.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND pid<>$2 AND wait_event_type='Lock' AND wait_event='advisory'`, [lease.application_name, lease.pid]);
        return blocked.rowCount === 1;
      }, app.log);
      const killed = await observer.query<{ terminated: boolean }>('SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE pid=$1 AND application_name=$2 AND datname=current_database()', [lease.pid, lease.application_name]);
      expect(killed.rows).toEqual([{ terminated: true }]);
      await until(async () => {
        const response = await fetch(`${base}/health`);
        if (response.status !== 503) return false;
        expect(await response.json()).toMatchObject({ storageWritable: false, release: true });
        return true;
      }, app.log);
      const restoreWhileDraining = launch('cli.ts', ['restore', '--yes', restoreInput]);
      expect((await exitedWithin(restoreWhileDraining)).code).not.toBe(0);
      expect(restoreWhileDraining.log()).toContain('StorageReadOnlyError');
      expect(restoreWhileDraining.log()).not.toContain('pre-restore recovery set verified');
      expect(await readdir(join(root, 'backup/db'))).toEqual(backupBefore);
      expect(await pgPostStore(pool).get(tk)).toEqual(before);
      // Restore did not terminate the app's still-draining transaction.
      expect((await observer.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event=\'advisory\'', [lease.application_name])).rowCount).toBe(1);
      await blocker.query('ROLLBACK');
      const aborted = await pendingSave;
      expect(aborted.status).toBe(503);
      expect(await aborted.json()).toMatchObject({ error: 'storage_read_only' });
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      await pendingSave?.catch(() => {});
    }
    await until(async () => (await observer.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1', [lease.application_name])).rowCount === 0, app.log);
    expect(await pgPostStore(pool).get(tk)).toEqual(before);
    expect(await pgGpxStore(pool).get(tk)).toEqual(record);
    expect(await pgPostStore(pool).listRevisions(tk)).toEqual([]);
    // Ownership can be acquired after drain, but the old HTTP process never
    // resumes writes, even after the replacement owner deliberately releases it.
    const replacement = await acquireStorageOwner(databaseUrl, { role: 'restore' });
    try { await replacement.assertNoAppSessions(); } finally { await replacement.close(); }
    for (const path of ['/gpx/imports', '/login', `/posts/${tk}`, '/rebuild']) {
      const response = await fetch(base + path, { method: path === `/posts/${tk}` ? 'PUT' : 'POST', headers: { cookie } });
      expect(response.status, path).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ error: 'storage_read_only' });
    }
    for (const headers of [new Headers(), new Headers({ cookie })]) {
      const health = await fetch(`${base}/health`, { headers });
      expect(health.status).toBe(503); expect(await health.json()).toMatchObject({ storageWritable: false });
      const blog = await fetch(base + '/', { headers });
      expect(blog.status).toBe(200); expect(await blog.text()).toContain('STATIC_BOOT_RELEASE');
      const admin = await fetch(`${base}/admin/editor.html`, { headers });
      expect(admin.status).toBe(200); expect(admin.headers.get('content-type')).toContain('text/html');
    }
    expect(app.child.exitCode).toBeNull(); expect(app.child.signalCode).toBeNull();
    expect(app.log()).not.toContain('PRIVATE_BOOT_SOURCE');
    expect(app.log()).not.toContain('12.345678');
  }, 90_000);
});
