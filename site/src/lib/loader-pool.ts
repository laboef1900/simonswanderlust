import pg from 'pg';
import { assertDatabaseSnapshot } from './database-snapshot.js';

/**
 * The pool both Content Layer loaders read from during `astro build`.
 *
 * @ai-warning Bounded on purpose (#110). The build child runs under the
 * uploader's exclusive work-lock; before these timeouts a silently hung
 * Postgres (dropped packets, not a refused connection) made the loader's
 * SELECT wait forever, the child never exited, and every later publish,
 * rebuild and image encode queued behind it until someone restarted the
 * container. `connectionTimeoutMillis` bounds the handshake; `query_timeout`
 * is client-side, so it fires even when the server never answers at all;
 * `statement_timeout` is the server-side counterpart for a query that is
 * merely slow. A loader SELECT is a few hundred rows, so these are generous.
 * The uploader's `build.ts` deadline is the backstop for anything a pool
 * timeout cannot see.
 */
export interface LoaderPoolTimeouts {
  connectTimeoutMs: number;
  queryTimeoutMs: number;
}

export const LOADER_POOL_TIMEOUTS: LoaderPoolTimeouts = {
  connectTimeoutMs: 10_000,
  queryTimeoutMs: 60_000,
};

export function loaderPool(connectionString: string, timeouts: LoaderPoolTimeouts = LOADER_POOL_TIMEOUTS): pg.Pool {
  return new pg.Pool({
    connectionString,
    connectionTimeoutMillis: timeouts.connectTimeoutMs,
    query_timeout: timeouts.queryTimeoutMs,
    statement_timeout: timeouts.queryTimeoutMs,
  });
}

/**
 * All reads for one content loader share this checked-out connection. Supplied
 * snapshots are imported before any SELECT; invalid/expired IDs never fall
 * back to a fresh view. Standalone development has no exported snapshot.
 */
export async function withLoaderSnapshot<T>(
  pool: pg.Pool,
  read: (client: pg.PoolClient) => Promise<T>,
  snapshot: string | undefined = process.env.SITE_DATABASE_SNAPSHOT,
): Promise<T> {
  if (snapshot !== undefined) assertDatabaseSnapshot(snapshot);
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (snapshot !== undefined) {
      await client.query(`SET TRANSACTION SNAPSHOT '${snapshot}'`);
    }
    const result = await read(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}
