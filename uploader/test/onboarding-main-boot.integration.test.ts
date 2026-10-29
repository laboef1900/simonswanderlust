import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DbPool } from '../src/db.js';
import { readOnboardingState } from '../src/onboarding.js';
import { publishRestoreFence, restoreFencePath } from '../src/onboarding-fence.js';
import { acquireStorageOwner } from '../src/storage-owner.js';
import { pgUserStore } from '../src/users.js';

const url = process.env.TEST_DATABASE_URL;
async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); reject(new Error('Missing test listener address')); return; }
    server.close(() => resolve(address.port));
  });
  return promise;
}

describe.skipIf(!url)('production onboarding boot ordering and restart', () => {
  let admin: DbPool;
  let pool: DbPool;
  let schema: string;
  let root: string;
  let scopedUrl: string;
  let child: ChildProcess | undefined;
  let base: string;
  let output: string;
  beforeAll(() => { admin = new pg.Pool({ connectionString: url }); });
  beforeEach(async () => {
    schema = 'onboarding_boot_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(url!); connection.searchParams.set('options', `-c search_path=${schema}`); scopedUrl = connection.toString();
    pool = new pg.Pool({ connectionString: scopedUrl });
    root = await mkdtemp(join(await realpath(tmpdir()), 'onboarding-boot-'));
  });
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      // A teardown deadline bounds a real child that cannot use the test clock;
      // readiness and normal shutdown are awaited from process events, never sleeps.
      const timer = setTimeout(() => child?.kill('SIGKILL'), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    child = undefined;
  }
  afterEach(async () => {
    await stop(); await pool?.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => { await admin?.end(); });
  async function start(expectFailure = false) {
    const port = await freePort(); base = `http://127.0.0.1:${port}`; output = '';
    const env = { ...process.env }; delete env.ENCRYPTION_KEY;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: new URL('..', import.meta.url),
      env: { ...env, DATABASE_URL: scopedUrl, PORT: String(port), HOST: '127.0.0.1', PUBLIC_BASE_URL: base, IMG_HOST: `127.0.0.1:${port}`,
        STORAGE_DIR: join(root, 'images'), SETTINGS_PATH: join(root, 'settings.json'), SITE_DIR: join(root, 'site'), SITE_APP_DIR: join(root, 'no-build-toolchain'), BACKUP_DIR: join(root, 'backup'), MAP_DIR: join(root, 'map') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('error', reject);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(`app listening on :${port}`)) {
        if (expectFailure) reject(new Error('App listened despite invalid onboarding metadata.'));
        else resolve();
      }
    };
    child.stdout!.on('data', collect); child.stderr!.on('data', collect);
    child.once('exit', (code) => {
      if (expectFailure && code !== 0) resolve();
      else reject(new Error(`Onboarding boot exited ${code} before readiness.`));
    });
    await promise;
  }
  async function request(path: string, cookie?: string, body?: unknown) {
    return fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  it('initializes before first listen, preserves setup/session contracts and persists shared Hide across processes and browsers', async () => {
    await start();
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'eligible', reason: 'fresh' });
    expect(await (await request('/auth/status')).json()).toEqual({ authenticated: false, needsSetup: true });
    expect((await request('/onboarding')).status).toBe(401);
    const anonymousContext = await request('/auth/me');
    expect(anonymousContext.status).toBe(401);
    expect(anonymousContext.headers.get('cache-control')).toBe('no-store');
    const setup = await request('/setup', undefined, { username: 'first', password: 'password123456' });
    expect(setup.status).toBe(200);
    expect(await setup.json()).toEqual({ username: 'first', isAdmin: true });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    expect(setup.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(await (await request('/auth/status', cookie)).json()).toEqual({ authenticated: true, username: 'first', isAdmin: true, needsSetup: false });
    const firstUser = await pgUserStore(pool).findByUsername('first');
    const expectedContext = { authenticated: true, userId: firstUser!.id, username: 'first', isAdmin: true, needsSetup: false };
    const context = await request('/auth/me', cookie);
    expect(context.status).toBe(200);
    expect(context.headers.get('cache-control')).toBe('no-store');
    expect(context.headers.get('set-cookie')).toBeNull();
    expect(await context.json()).toEqual(expectedContext);
    expect((await request('/setup', undefined, { username: 'another', password: 'password123456' })).status).toBe(409);
    expect(await (await request('/onboarding', cookie, { action: 'dismiss' })).json()).toMatchObject({ status: 'dismissed' });
    expect((await pool.query('SELECT count(*)::int AS n FROM posts')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM media')).rows[0].n).toBe(0);
    await stop(); await start();
    expect(await (await request('/auth/me', cookie)).json()).toEqual(expectedContext);
    expect(await (await request('/onboarding', cookie)).json()).toMatchObject({ status: 'dismissed' });
    await pgUserStore(pool).create({ username: 'second', password: 'password123456', isAdmin: true });
    const login = await request('/login', undefined, { username: 'second', password: 'password123456' });
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ username: 'second', isAdmin: true });
    const second = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(await (await request('/onboarding', second)).json()).toMatchObject({ status: 'dismissed' });
    expect(await (await request('/onboarding', second, { action: 'resume' })).json()).toMatchObject({ status: 'open' });
    expect(await (await request('/onboarding', cookie)).json()).toMatchObject({ status: 'open' });
  }, 40_000);
  it('will not listen with a corrupt fence and never converts that error into fresh state', async () => {
    await writeFile(restoreFencePath(join(root, 'images')), 'corrupt');
    await start(true);
    expect(output).not.toContain('app listening on');
    expect(await readOnboardingState(pool)).toBeNull();
    expect((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
  }, 20_000);
  it('reconciles a fenced eligible row before serving the first request after recovery', async () => {
    await start(); await stop();
    const owner = await acquireStorageOwner(scopedUrl, { role: 'restore' });
    try {
      await publishRestoreFence(join(root, 'images'), async () => { owner.assertWritable(); await owner.assertNoAppSessions(); owner.assertWritable(); });
    } finally { await owner.close(); }
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'eligible' });
    await start();
    expect(await readOnboardingState(pool)).toMatchObject({ state: 'retired', reason: 'restored-content' });
    const setup = await request('/setup', undefined, { username: 'restored', password: 'password123456' });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    expect(await (await request('/onboarding', cookie)).json()).toEqual({ status: 'retired' });
  }, 40_000);
});
