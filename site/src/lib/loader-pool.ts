import pg from 'pg';

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
