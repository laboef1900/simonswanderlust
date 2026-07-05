// Bounds the GET /health database probe. A silently-hung Postgres — dropped
// packets on a network partition rather than a refused connection — makes
// pool.query('SELECT 1') never settle, so /health (polled every 10s by the
// compose healthcheck) would await forever and pile up pending requests, each
// holding a checked-out pool client. Racing the probe against a timeout makes
// dbCheck reject promptly; the /health handler turns any rejection into a 503,
// correctly flipping the container unhealthy. A per-probe timeout is used
// rather than a pool-wide statement_timeout so it can't truncate a legitimate
// long-running query elsewhere.
// @ai-context: docs/superpowers — issue #31 (container operability).

/** Default DB-probe budget; well under the compose healthcheck's 5s timeout. */
export const DB_PROBE_TIMEOUT_MS = 3_000;

/**
 * Wraps a DB probe (e.g. `() => pool.query('SELECT 1')`) so the returned
 * check resolves iff the probe resolves within `timeoutMs`, and otherwise
 * rejects — never awaits indefinitely. The pending timer is always cleared so
 * a fast probe leaves nothing behind.
 */
export function makeDbCheck(
  probe: () => Promise<unknown>,
  timeoutMs: number = DB_PROBE_TIMEOUT_MS,
): () => Promise<void> {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('db health probe timed out')), timeoutMs);
    });
    try {
      await Promise.race([probe(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
