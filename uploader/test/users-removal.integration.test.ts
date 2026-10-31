import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbBackup } from '../src/backup.js';
import { ensureSchema, type DbPool } from '../src/db.js';
import { createEncodeQueue, type EncodeQueue } from '../src/encode-queue.js';
import { memoryMediaStore } from '../src/media-store.js';
import { memoryPageStore } from '../src/pages.js';
import { memoryPostStore } from '../src/posts.js';
import { memorySecretsStore } from '../src/secrets.js';
import { buildServer, type AppServer } from '../src/server.js';
import { pgSessionStore, type SessionStore } from '../src/sessions.js';
import { createSettingsStore, defaultSettings } from '../src/settings.js';
import { pgUserStore } from '../src/users.js';
import { createWorkLock } from '../src/work-lock.js';
import { TEST_TRUST } from './trusted-proxy-fixture.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('atomic last-administrator removal (#368, real Postgres)', () => {
  let observer: DbPool;
  let poolA: DbPool;
  let poolB: DbPool;
  let schema: string;
  let root: string;
  const apps: AppServer[] = [];
  const queues: EncodeQueue[] = [];

  beforeEach(async () => {
    schema = 'users_removal_' + randomUUID().replaceAll('-', '');
    observer = new pg.Pool({ connectionString: url });
    await observer.query(`CREATE SCHEMA ${schema}`);
    // Independent connections also make a leaked transaction/client observable:
    // every later operation on either store needs its sole connection back.
    const config = { connectionString: url, options: `-c search_path=${schema} -c statement_timeout=10000`, max: 1 };
    poolA = new pg.Pool(config);
    poolB = new pg.Pool(config);
    await ensureSchema(poolA);
    root = await mkdtemp(join(tmpdir(), 'users-removal-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const app of apps.splice(0)) await app.close();
    for (const queue of queues.splice(0)) await queue.quiesce();
    await poolA?.end();
    await poolB?.end();
    if (observer) {
      await observer.query(`DROP SCHEMA ${schema} CASCADE`);
      await observer.end();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function seed(extraAuthors = 0) {
    const users = pgUserStore(poolA);
    const sessions = pgSessionStore(poolA);
    const a = await users.create({ username: 'admin-a', password: 'synthetic-password', isAdmin: true });
    const b = await users.create({ username: 'admin-b', password: 'synthetic-password', isAdmin: true });
    const accounts = [];
    for (const user of [a, b]) {
      accounts.push({ user, tokens: [await sessions.create(user.id, 60_000), await sessions.create(user.id, 60_000)] });
    }
    for (let i = 0; i < extraAuthors; i++) {
      await users.create({ username: `author-${i}`, password: 'synthetic-password', isAdmin: false });
    }
    return { users, sessions, accounts };
  }

  function start(pool: DbPool, sessions: SessionStore = pgSessionStore(pool)) {
    const media = memoryMediaStore({ baseUrl: 'https://images.test' });
    const queue = createEncodeQueue({ store: media, storageDir: root, lock: createWorkLock() });
    queues.push(queue);
    const app = buildServer({
      storageDir: root, baseUrl: 'https://images.test', imgHost: 'images.test', siteDir: join(root, 'site'), trustProxy: TEST_TRUST,
      users: pgUserStore(pool), sessions, posts: memoryPostStore(), pages: memoryPageStore(),
      media, encodeQueue: queue, secrets: memorySecretsStore(),
      settings: createSettingsStore({ path: join(root, 'settings.json'), defaults: defaultSettings() }),
      builder: { build: async () => ({ ok: true, release: 'synthetic' }), hasRelease: () => true, quiesce: async () => {} },
      backupDir: join(root, 'backup'), dbCheck: async () => { await pool.query('SELECT 1'); },
      dbBackup: createDbBackup({ db: pool, dir: join(root, 'backup'), retention: () => 10 }),
    });
    apps.push(app);
    return app;
  }

  async function holdRemovals() {
    const barrier = await observer.connect();
    await barrier.query('BEGIN');
    await barrier.query(`LOCK TABLE ${schema}.users IN SHARE MODE`);
    return barrier;
  }

  async function waitForBothRemovals() {
    // Waiting on the *new lock*, not DELETE: this also proves both route
    // preHandlers completed before either request is allowed to commit.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { rows } = await observer.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks
         WHERE relation = $1::regclass AND mode = 'ShareRowExclusiveLock' AND NOT granted`,
        [`${schema}.users`],
      );
      if (Number(rows[0]?.n) === 2) return;
      await delay(10);
    }
    throw new Error('both guarded removals did not reach the users-table lock');
  }

  it('serializes two independent stores and cascades sessions only for the removed admin', async () => {
    const { users, sessions, accounts } = await seed();
    const [a, b] = accounts;
    const barrier = await holdRemovals();
    const pending = [users.remove(a!.user.id), pgUserStore(poolB).remove(b!.user.id)];
    const settled = Promise.allSettled(pending);
    try { await waitForBothRemovals(); }
    finally { await barrier.query('COMMIT'); barrier.release(); await settled; }
    const results = await Promise.all(pending);
    expect([...results].sort()).toEqual(['last_admin', 'removed']);
    expect(await users.countAdmins()).toBe(1);
    expect(await users.count()).toBe(1);
    for (const [index, account] of accounts.entries()) {
      const removed = results[index] === 'removed';
      expect(await users.findById(account.user.id)).toEqual(removed ? null : account.user);
      for (const token of account.tokens) {
        expect((await sessions.find(token))?.userId ?? null).toBe(removed ? null : account.user.id);
      }
    }
  });

  it('returns all guarded store outcomes without changing the last admin or its sessions', async () => {
    const users = pgUserStore(poolA);
    const sessions = pgSessionStore(poolA);
    const admin = await users.create({ username: 'admin', password: 'synthetic-password', isAdmin: true });
    const author = await users.create({ username: 'author', password: 'synthetic-password', isAdmin: false });
    const adminToken = await sessions.create(admin.id, 60_000);
    const authorToken = await sessions.create(author.id, 60_000);
    await expect(users.remove(admin.id)).resolves.toBe('last_admin');
    expect(await users.findById(admin.id)).toEqual(admin);
    expect((await sessions.find(adminToken))?.userId).toBe(admin.id);
    await expect(users.remove(author.id)).resolves.toBe('removed');
    expect(await sessions.find(authorToken)).toBeNull();
    for (const id of [author.id, randomUUID(), 'not-a-uuid']) {
      await expect(users.remove(id)).resolves.toBe('not_found');
    }
    expect(await users.list()).toEqual([admin]);
  });

  it.each([0, 2])('cross-delete routes retain setup protection with %i extra authors', async (extraAuthors) => {
    const { users, sessions, accounts } = await seed(extraAuthors);
    const [a, b] = accounts;
    const appA = start(poolA);
    const appB = start(poolB);
    await Promise.all([appA.ready(), appB.ready()]);
    const barrier = await holdRemovals();
    // Attach .then immediately: light-my-request is lazy until consumed.
    const pending = [
      appA.inject({ method: 'DELETE', url: `/users/${b!.user.id}`, cookies: { sid: a!.tokens[0]! } }).then((res) => res),
      appB.inject({ method: 'DELETE', url: `/users/${a!.user.id}`, cookies: { sid: b!.tokens[0]! } }).then((res) => res),
    ];
    const settled = Promise.allSettled(pending);
    try { await waitForBothRemovals(); }
    finally { await barrier.query('COMMIT'); barrier.release(); await settled; }
    const results = await Promise.all(pending);
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((res) => res.statusCode === 200)!.json()).toEqual({ ok: true });
    expect(results.find((res) => res.statusCode === 409)!.json()).toEqual({ error: 'cannot remove the last admin' });
    expect(await users.countAdmins()).toBe(1);
    expect(await users.count()).toBe(1 + extraAuthors);
    const survivor = (await users.list()).find((user) => user.isAdmin)!;
    for (const account of accounts) {
      const survives = account.user.id === survivor.id;
      for (const token of account.tokens) {
        expect((await sessions.find(token))?.userId ?? null).toBe(survives ? survivor.id : null);
      }
      const authenticated = await appA.inject({ method: 'GET', url: '/users', cookies: { sid: account.tokens[0]! } });
      expect(authenticated.statusCode).toBe(survives ? 200 : 401);
      if (!survives) {
        expect((await appA.inject({ method: 'DELETE', url: `/users/${survivor.id}`, cookies: { sid: account.tokens[0]! } })).statusCode).toBe(401);
      }
    }
    const login = await appA.inject({ method: 'POST', url: '/login', payload: { username: survivor.username, password: 'synthetic-password' } });
    expect(login.statusCode).toBe(200);
    expect((await appA.inject({ method: 'GET', url: '/auth/status' })).json()).toEqual({ authenticated: false, needsSetup: false });
    expect((await appA.inject({ method: 'POST', url: '/setup', payload: { username: 'new', password: 'synthetic-password' } })).statusCode).toBe(409);
  });

  it('rolls back a failed DELETE, releases the lock/client and never invalidates sessions on failure', async () => {
    const { users, sessions, accounts } = await seed();
    const [a, b] = accounts;
    await poolA.query(`
      CREATE FUNCTION refuse_removal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic private deletion failure'; END $$;
      CREATE TRIGGER refuse_removal AFTER DELETE ON users FOR EACH ROW EXECUTE FUNCTION refuse_removal();
    `);
    await expect(users.remove(b!.user.id)).rejects.toThrow('synthetic private deletion failure');
    const invalidate = vi.spyOn(sessions, 'destroyAllForUser');
    const app = start(poolA, sessions);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await app.inject({ method: 'DELETE', url: `/users/${b!.user.id}`, cookies: { sid: a!.tokens[0]! } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'internal server error' });
      expect(invalidate).not.toHaveBeenCalled();
      expect(await users.countAdmins()).toBe(2);
      for (const account of accounts) {
        expect(await users.findById(account.user.id)).toEqual(account.user);
        for (const token of account.tokens) expect((await sessions.find(token))?.userId).toBe(account.user.id);
      }
      // A different connection can take the write lock; the failed store's sole
      // connection is usable again, and a later permitted removal can commit.
      await poolB.query('DROP TRIGGER refuse_removal ON users');
      const success = await app.inject({ method: 'DELETE', url: `/users/${b!.user.id}`, cookies: { sid: a!.tokens[0]! } });
      expect(success.statusCode).toBe(200);
      expect(invalidate.mock.calls).toEqual([[b!.user.id]]);
      expect(await users.countAdmins()).toBe(1);
      for (const token of b!.tokens) expect(await sessions.find(token)).toBeNull();
      for (const token of a!.tokens) expect((await sessions.find(token))?.userId).toBe(a!.user.id);
    } finally { log.mockRestore(); }
  });
});
