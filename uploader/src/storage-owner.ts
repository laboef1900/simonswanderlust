import { randomUUID } from 'node:crypto';
import pg from 'pg';

export const APP_SESSION_PREFIX = 'swl-app:';
// Two-int advisory locks occupy a different namespace from the bigint pair locks.
export const STORAGE_OWNER_LOCK_KEY = [0x53574c, 313] as const;
const HEARTBEAT_INTERVAL_MS = 5_000;
const QUERY_TIMEOUT_MS = 5_000;

export class StorageReadOnlyError extends Error {
  readonly code = 'storage_read_only';
  readonly statusCode = 503;

  constructor() {
    super('Storage is read-only. Restart the application after database recovery and after any restore has stopped.');
    this.name = 'StorageReadOnlyError';
  }
}

export interface StorageOwner {
  readonly applicationName: string;
  readonly signal: AbortSignal;
  isWritable(): boolean;
  assertWritable(): void;
  assertNoAppSessions(): Promise<void>;
  close(): Promise<void>;
}

/** A dedicated session, never a pool: ownership cannot migrate between connections. */
export async function acquireStorageOwner(
  databaseUrl: string,
  { role }: { role: 'app' | 'restore' },
): Promise<StorageOwner> {
  const applicationName = `${role === 'app' ? APP_SESSION_PREFIX : 'swl-restore:'}${randomUUID()}`;
  let client: pg.Client;
  try {
    const url = new URL(databaseUrl);
    // pg gives connection-string settings precedence over Client options. Override
    // these in the URL too, so caller settings cannot hide a draining app session
    // or turn the lease's query deadline off.
    url.searchParams.set('application_name', applicationName);
    url.searchParams.set('query_timeout', String(QUERY_TIMEOUT_MS));
    url.searchParams.set('statement_timeout', String(QUERY_TIMEOUT_MS));
    url.searchParams.set('connectionTimeoutMillis', String(QUERY_TIMEOUT_MS));
    client = new pg.Client({
      connectionString: url.toString(),
      application_name: applicationName,
      connectionTimeoutMillis: QUERY_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      statement_timeout: QUERY_TIMEOUT_MS,
      keepAlive: true,
    });
  } catch {
    throw new StorageReadOnlyError();
  }

  const controller = new AbortController();
  let state: 'acquiring' | 'writable' | 'readonly' | 'closing' | 'closed' = 'acquiring';
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let ending: Promise<void> | undefined;

  function stopHeartbeat(): void {
    clearTimeout(heartbeat);
    heartbeat = undefined;
  }

  function endClient(): Promise<void> {
    // Install the shared promise before end() can emit events synchronously.
    ending ??= Promise.resolve().then(() => client.end()).catch(() => {
      throw new StorageReadOnlyError();
    });
    return ending;
  }

  function latch(): void {
    if (state !== 'acquiring' && state !== 'writable') return;
    state = 'readonly';
    stopHeartbeat();
    controller.abort(new StorageReadOnlyError());
    // A query timeout need not close pg's socket. End the dedicated connection
    // explicitly, releasing any remaining lock; never attempt to reconnect.
    void endClient().catch(() => {});
  }

  // Retain the error listener through shutdown: late socket errors must neither
  // escape as unhandled events nor leak connection details through logs.
  client.on('error', latch);
  client.on('end', latch);

  function assertWritable(): void {
    if (state !== 'writable') throw new StorageReadOnlyError();
  }

  function scheduleHeartbeat(): void {
    if (state !== 'writable') return;
    heartbeat = setTimeout(async () => {
      heartbeat = undefined;
      if (state !== 'writable') return;
      try {
        await client.query('SELECT 1');
      } catch {
        latch();
      }
      // Schedule after completion, not on an interval: no overlapping probes or
      // ever-growing pg query queue when the database stalls.
      scheduleHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
  }

  try {
    await client.connect();
    if (state !== 'acquiring') throw new StorageReadOnlyError();
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired',
      [...STORAGE_OWNER_LOCK_KEY],
    );
    if (state !== 'acquiring' || result.rows[0]?.acquired !== true) throw new StorageReadOnlyError();
    state = 'writable';
  } catch {
    latch();
    await endClient().catch(() => {});
    throw new StorageReadOnlyError();
  }
  scheduleHeartbeat();

  return {
    applicationName,
    signal: controller.signal,
    isWritable: () => state === 'writable',
    assertWritable,
    async assertNoAppSessions() {
      assertWritable();
      let appSessions: boolean;
      try {
        const result = await client.query<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database()
               AND starts_with(application_name, $1)
           ) AS present`,
          [APP_SESSION_PREFIX],
        );
        // Fail closed if PostgreSQL ever returns an unexpected result shape.
        appSessions = result.rows[0]?.present !== false;
      } catch {
        latch();
        throw new StorageReadOnlyError();
      }
      assertWritable();
      if (appSessions) throw new StorageReadOnlyError();
    },
    async close() {
      if (state === 'closed') return;
      // Deliberate shutdown is not lease loss: callers drain work before close.
      if (state !== 'readonly') state = 'closing';
      stopHeartbeat();
      await endClient();
      state = 'closed';
    },
  };
}
