import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { acquireStorageOwner, APP_SESSION_PREFIX, StorageReadOnlyError, type StorageOwner } from '../src/storage-owner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const maybe = databaseUrl ? describe : describe.skip;

// No schema/content changes. Every client belongs to this suite; only an exact
// uniquely generated lease tag may be terminated, never a prefix-wide selection.
maybe('PostgreSQL storage ownership and draining sessions', () => {
  const observerName = `swl-test:${randomUUID()}`;
  let observer: pg.Client;
  const owners: StorageOwner[] = [];
  const clients: pg.Client[] = [];

  function taggedClient(applicationName: string): pg.Client {
    const url = new URL(databaseUrl!);
    url.searchParams.set('application_name', applicationName);
    return new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
  }

  async function acquire(role: 'app' | 'restore'): Promise<StorageOwner> {
    // A malicious/bootstrap application_name must never defeat the session scan.
    const url = new URL(databaseUrl!);
    url.searchParams.set('application_name', 'must-be-overridden');
    const owner = await acquireStorageOwner(url.toString(), { role });
    owners.push(owner);
    return owner;
  }

  beforeAll(async () => {
    observer = taggedClient(observerName);
    await observer.connect();
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.end();
    for (const owner of owners.splice(0)) await owner.close();
  });
  afterAll(async () => { await observer?.end(); });

  it.each(['app', 'restore'] as const)('excludes both competing roles while %s owns storage, and releases on deliberate close', async (role) => {
    const first = await acquire(role);
    const sessions = await observer.query<{ application_name: string }>(
      'SELECT application_name FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1',
      [first.applicationName],
    );
    expect(sessions.rows).toEqual([{ application_name: first.applicationName }]);
    expect(first.applicationName.startsWith(APP_SESSION_PREFIX)).toBe(role === 'app');
    for (const competingRole of ['app', 'restore'] as const) {
      await expect(acquireStorageOwner(databaseUrl!, { role: competingRole })).rejects.toMatchObject({
        code: 'storage_read_only', statusCode: 503,
      });
    }
    const aborts: unknown[] = [];
    first.signal.addEventListener('abort', () => aborts.push(first.signal.reason));
    await first.close();
    expect(first.isWritable()).toBe(false);
    expect(first.signal.aborted).toBe(false);
    expect(aborts).toHaveLength(0);
    const next = await acquire(role === 'app' ? 'restore' : 'app');
    expect(next.applicationName).not.toBe(first.applicationName);
    expect(next.isWritable()).toBe(true);
    if (role === 'app') await next.assertNoAppSessions();
  });

  it('latches a lost lease once, refuses draining app transactions, and never reacquires', async () => {
    const app = await acquire('app');
    const draining = taggedClient(app.applicationName + ':pool');
    clients.push(draining);
    await draining.connect();
    await draining.query('BEGIN');
    await draining.query('SELECT 1');
    const aborts: unknown[] = [];
    app.signal.addEventListener('abort', () => aborts.push(app.signal.reason));
    const lost = Promise.withResolvers<void>();
    app.signal.addEventListener('abort', () => lost.resolve(), { once: true });

    const terminated = await observer.query<{ terminated: boolean }>(
      `SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()`,
      [app.applicationName],
    );
    expect(terminated.rows).toEqual([{ terminated: true }]);
    await lost.promise;
    expect(app.isWritable()).toBe(false);
    expect(() => app.assertWritable()).toThrow(StorageReadOnlyError);
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toBeInstanceOf(StorageReadOnlyError);

    const restore = await acquire('restore');
    await expect(restore.assertNoAppSessions()).rejects.toMatchObject({ code: 'storage_read_only', statusCode: 503 });
    // Refusal does not terminate or cancel even an idle-in-transaction client.
    expect((await draining.query<{ intact: number }>('SELECT 42 AS intact')).rows).toEqual([{ intact: 42 }]);
    expect(restore.isWritable()).toBe(true);
    await draining.query('ROLLBACK');
    // An idle app connection is also draining until physically disconnected.
    await expect(restore.assertNoAppSessions()).rejects.toBeInstanceOf(StorageReadOnlyError);
    await draining.end();
    clients.splice(clients.indexOf(draining), 1);
    await restore.assertNoAppSessions();

    await restore.close();
    const nextApp = await acquire('app');
    expect(nextApp.isWritable()).toBe(true);
    expect(app.isWritable()).toBe(false);
    expect(aborts).toHaveLength(1);
    await app.close();
    expect(aborts).toHaveLength(1);
    // Closing the dead owner must not release the replacement owner's lock.
    await expect(acquireStorageOwner(databaseUrl!, { role: 'restore' })).rejects.toBeInstanceOf(StorageReadOnlyError);
  }, 15_000);

  it('rechecks sessions admitted after an earlier restore scan', async () => {
    const restore = await acquire('restore');
    await restore.assertNoAppSessions();
    const lateApp = taggedClient(`${APP_SESSION_PREFIX}${randomUUID()}:build`);
    clients.push(lateApp);
    await lateApp.connect();
    await expect(restore.assertNoAppSessions()).rejects.toBeInstanceOf(StorageReadOnlyError);
    expect((await lateApp.query<{ intact: number }>('SELECT 7 AS intact')).rows).toEqual([{ intact: 7 }]);
    await lateApp.end();
    clients.splice(clients.indexOf(lateApp), 1);
    await restore.assertNoAppSessions();
  });
});
