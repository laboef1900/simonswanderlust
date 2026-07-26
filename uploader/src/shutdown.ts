// Clean shutdown sequencing for the app process. `docker stop` sends SIGTERM
// (forwarded to node by tini via `init: true` in docker-compose.yml); we close
// the HTTP server (waits for in-flight requests), end the pg pool, then exit 0
// so stops are sub-second instead of hitting the 10s grace-period SIGKILL.
// @ai-context: docs/superpowers — issue #31 (container operability).

export interface ShutdownHooks {
  close: () => Promise<unknown>; // stop accepting connections, drain in-flight requests
  /**
   * Let background work finish before the backing resources go away.
   *
   * @ai-warning This must run BETWEEN close and end. The encode queue keeps
   * working after the HTTP server stops accepting connections, and its final
   * `setStatus` write needs the pg pool. Without the drain step, `pool.end()`
   * fires while jobs are in flight, every `docker stop` logs a rejection, and
   * rows are left stuck in `processing` — which the next boot then has to
   * recover. Optional so callers with no background work can omit it.
   */
  drain?: () => Promise<unknown>;
  end: () => Promise<unknown>;   // release backing resources (pg pool)
  exit: (code: number) => void;
  log: (msg: string) => void;
  error: (msg: string, err: unknown) => void;
}

/**
 * Returns a signal handler that runs close → drain → end → exit(0) exactly
 * once; repeat signals while (or after) shutting down are ignored. Any
 * rejection is error-logged and exits 1.
 */
export function createShutdown(hooks: ShutdownHooks): (signal: string) => void {
  let started = false;
  return (signal: string) => {
    if (started) return;
    started = true;
    hooks.log(`received ${signal}, shutting down`);
    hooks
      .close()
      .then(() => (hooks.drain ? hooks.drain() : undefined))
      .then(() => hooks.end())
      .then(() => hooks.exit(0))
      .catch((err: unknown) => {
        hooks.error('shutdown failed:', err);
        hooks.exit(1);
      });
  };
}
