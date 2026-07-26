/**
 * The shared build/encode mutex.
 *
 * `astro build` and the sharp encode workers run in the SAME container and
 * both are memory-hungry (a measured ~1.94 GB peak RSS per 24 MP frame). The
 * workflow the media library creates — "drop 100 photos, close the tab, write
 * the post, hit Publish" — would otherwise put a build and two encoders in one
 * container competing for memory, where an OOM kills the blog, the admin and
 * the image host together. So: **a build and any encode are mutually
 * exclusive.**
 *
 * @ai-warning The priority direction is not symmetric, and getting it wrong is
 * a user-visible regression rather than a bug: the editor's Publish button
 * AWAITS the rebuild synchronously, so a build must never queue behind a
 * backlog of 50 pending encodes (~19 s each ⇒ minutes of a spinner). A waiting
 * build therefore BLOCKS NEW ENCODES from starting, and takes the lock as soon
 * as the currently-running ones finish — i.e. it preempts the backlog at the
 * next job boundary, worst case one frame. Encodes are never cancelled
 * mid-flight; a half-written variant set is worse than a slow build.
 *
 * Shared (encode) acquisitions may run concurrently with each other — the
 * queue's own semaphore caps how many. This lock only separates builds from
 * encodes.
 *
 * @ai-context docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md
 *   §Encode worker — issue #64.
 */
export interface WorkLock {
  /** Run `fn` with nothing else holding the lock (the site build). */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Run `fn` alongside other shared holders, but never during a build. */
  runShared<T>(fn: () => Promise<T>): Promise<T>;
  /** Observability for tests and `GET /media/queue`. */
  stats(): { exclusiveRunning: boolean; exclusiveWaiting: number; sharedRunning: number };
}

export function createWorkLock(): WorkLock {
  let sharedRunning = 0;
  let exclusiveRunning = false;
  const sharedWaiters: (() => void)[] = [];
  const exclusiveWaiters: (() => void)[] = [];

  /** Hand the lock to whoever may have it, exclusive-first (the priority rule). */
  function pump(): void {
    if (!exclusiveRunning && sharedRunning === 0 && exclusiveWaiters.length > 0) {
      exclusiveRunning = true;
      exclusiveWaiters.shift()?.();
      return;
    }
    // A waiting build starves new shared work on purpose — without this an
    // endless trickle of uploads could hold the build off indefinitely.
    if (exclusiveRunning || exclusiveWaiters.length > 0) return;
    while (sharedWaiters.length > 0) {
      sharedRunning++;
      sharedWaiters.shift()?.();
    }
  }

  return {
    async runExclusive(fn) {
      if (exclusiveRunning || sharedRunning > 0 || exclusiveWaiters.length > 0) {
        await new Promise<void>((resolve) => { exclusiveWaiters.push(resolve); });
      } else {
        exclusiveRunning = true;
      }
      try {
        return await fn();
      } finally {
        exclusiveRunning = false;
        pump();
      }
    },
    async runShared(fn) {
      if (exclusiveRunning || exclusiveWaiters.length > 0) {
        await new Promise<void>((resolve) => { sharedWaiters.push(resolve); });
      } else {
        sharedRunning++;
      }
      try {
        return await fn();
      } finally {
        sharedRunning--;
        pump();
      }
    },
    stats: () => ({ exclusiveRunning, exclusiveWaiting: exclusiveWaiters.length, sharedRunning }),
  };
}
