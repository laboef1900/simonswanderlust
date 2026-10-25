// Shutdown sequencing for the app process. The caller's close hook stops HTTP
// admission and quiesces background work before backing resources are released.
// Completion is best-effort within the container's stop grace period; interrupted
// encodes remain recoverable on the next boot.
// @ai-context: docs/superpowers/specs/2026-10-23-gpx-route-import-design.md, storage ownership.

export interface ShutdownHooks {
  close: () => Promise<unknown>; // stop accepting connections, drain in-flight requests
  /**
   * Optional cleanup for callers that do not incorporate their work into close().
   * The app already quiesces its guarded workers in close(), so it does not use
   * this hook. If supplied, it completes before backing resources are released.
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
