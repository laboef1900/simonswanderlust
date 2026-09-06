/**
 * Background variant encoding.
 *
 * `POST /upload` returns as soon as the untouched original is on disk; the
 * expensive part — a measured ~19 s and ~1.94 GB peak RSS per 24 MP frame,
 * ~80% of it the full-resolution AVIF — happens here. Without this the request
 * would hold the connection for 40–90 s at concurrency 2 on a VPS, against a
 * reverse proxy whose default read timeout is 60 s.
 *
 * @ai-warning `status` is a correctness invariant spanning a Postgres row,
 * files on disk, publish validation and an already-built static release, with
 * NO shared transaction. Its failure mode is silent: if a job is lost, the URL
 * is already in the post body and the original is on disk, so `astro build`
 * succeeds and the site goes live with broken <img> elements. The publish gate
 * in server.ts is the only real check — keep it, and keep it tested.
 *
 * @ai-context docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md
 *   §Encode worker — issue #64.
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { processImage } from './pipeline.js';
import { assertSafeKey, storeVariantFiles } from './storage.js';
import { deleteMedia } from './media-files.js';
import type { MediaError, MediaStore } from './media-store.js';
import type { WorkLock } from './work-lock.js';

/**
 * The measured throughput plateau: N=6 bought +12% throughput for +47% memory.
 * MUST be enforced server-side — a client-side limit is advisory, and a second
 * tab or a `curl` loop bypasses it.
 */
export const ENCODE_CONCURRENCY = 2;
/** Refuse to enqueue beyond this, so disk and memory stay bounded (429). */
export const MAX_BACKLOG = 200;

export interface EncodeQueue {
  /** Enqueue a stored key for encoding. Throws when the backlog is full. */
  enqueue(key: string): void;
  /**
   * True while `key` is queued or encoding. `DELETE /media/items/*` refuses
   * such a key: the job holds the original in memory and would write its
   * variants under the just-deleted key, which the next rescan then backfills
   * as a zombie `ready` row with no retained original (#116).
   */
  isActive(key: string): boolean;
  /**
   * Re-seed from `media WHERE status = 'processing'`. Only `createReconciler`
   * (media-sync.ts) calls this — boot and POST /media/rescan — and it MUST run
   * after the disk sync, which is what inserts the rows it looks for.
   */
  recover(): Promise<number>;
  /**
   * The shutdown hook: stop dequeuing and resolve once the in-flight jobs have
   * finished. The backlog is left for `recover()` on the next boot — starting
   * more ~19 s jobs while Docker's grace period runs out would only manufacture
   * the partial writes the drain exists to avoid. One-way: the queue never
   * pumps again afterwards.
   */
  drain(): Promise<void>;
  /** Resolves when nothing is queued or in flight. Test seam — production only drains. */
  idle(): Promise<void>;
  stats(): { pending: number; running: number };
}

export class BacklogFullError extends Error {
  constructor() { super('the encode queue is full — wait for the current batch to finish'); }
}

export interface EncodeQueueOptions {
  store: MediaStore;
  storageDir: string;
  /** Shared with the site builder so a build and encoding never overlap. */
  lock: WorkLock;
  concurrency?: number;
  maxBacklog?: number;
  /** Injected for tests; defaults to reading the stored original and encoding it. */
  encodeOne?: (key: string) => Promise<{ bytes: number }>;
  log?: (msg: string) => void;
  error?: (msg: string, err: unknown) => void;
}

/**
 * Locate the retained original for a key, whatever extension it was stored with.
 *
 * @ai-warning Re-asserts the key even though it came out of the `media` table.
 * Every write path validates before storing, so a stored key is trustworthy
 * today — but this is the one filesystem read that builds a path from database
 * content rather than from a request, and `storeVariantFiles` (which the caller
 * runs on the same key straight afterwards) asserts too. Keeping the read side
 * symmetric means a future write path that forgets the guard fails here rather
 * than reading outside STORAGE_DIR.
 */
async function readOriginal(storageDir: string, key: string): Promise<Buffer> {
  assertSafeKey(key);
  const dir = join(storageDir, dirname(key));
  const base = basename(key);
  const entries = await readdir(dir, { withFileTypes: true });
  const match = entries.find((d) => d.isFile() && new RegExp(`^${escapeRe(base)}-orig\\.[a-z0-9]+$`, 'i').test(d.name));
  if (!match) throw new Error('no retained original');
  return readFile(join(dir, match.name));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createEncodeQueue(opts: EncodeQueueOptions): EncodeQueue {
  const concurrency = opts.concurrency ?? ENCODE_CONCURRENCY;
  const maxBacklog = opts.maxBacklog ?? MAX_BACKLOG;
  const log = opts.log ?? ((m: string) => console.log(m));
  const logError = opts.error ?? ((m: string, e: unknown) => console.error(m, e));

  const pending: string[] = [];
  const inFlight = new Set<string>();
  let idleWaiters: (() => void)[] = [];
  /** Set by drain(): pump() stops dequeuing; only in-flight jobs finish. */
  let draining = false;

  const encodeOne = opts.encodeOne ?? (async (key: string) => {
    const buf = await readOriginal(opts.storageDir, key);
    const result = await processImage(buf);
    const { bytes } = await storeVariantFiles(key, result.variants, { storageDir: opts.storageDir });
    return { bytes };
  });

  // Once draining, the backlog is not going to shrink — it is `recover()`'s
  // on the next boot — so "idle" means only that nothing is in flight.
  const isIdle = () => inFlight.size === 0 && (draining || pending.length === 0);

  function settleIfIdle(): void {
    if (isIdle() && idleWaiters.length > 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  /**
   * Classify a failure into the fixed MediaError enum.
   * @ai-warning Never store the raw message — libvips embeds filesystem paths
   * and the library UI displays this field. The real error goes to stdout only,
   * matching the global handler's contract.
   */
  function classify(err: unknown): MediaError {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOSPC|no space/i.test(msg)) return 'no_space';
    if (/no retained original|ENOENT/i.test(msg)) return 'decode_failed';
    if (/EACCES|EPERM|EROFS/i.test(msg)) return 'write_failed';
    if (/unsupported image format|Input buffer|VipsJpeg|premature end/i.test(msg)) return 'decode_failed';
    return 'encode_failed';
  }

  async function runJob(key: string): Promise<void> {
    try {
      // Shared: several encodes may run together, but never during a build.
      const { bytes } = await opts.lock.runShared(() => encodeOne(key));
      // The row can vanish during the ~19 s encode — a delete that slipped
      // past the `processing` gate, or a rescan-inserted row removed out of
      // band. Anything written for a deleted key is a time bomb: media-sync
      // backfills every key with a variant as `ready` on the next pass, so
      // the delete would silently undo itself (#116). Unlink and walk away;
      // the bare UPDATEs below would affect 0 rows and hide that.
      if (!(await opts.store.get(key))) {
        const removed = await deleteMedia(opts.storageDir, key);
        log(`encode discarded for ${key}: row deleted mid-encode (${removed} file(s) removed)`);
        return;
      }
      await opts.store.setVariantBytes(key, bytes);
      await opts.store.setStatus(key, 'ready');
    } catch (err) {
      const code = classify(err);
      logError(`encode failed for ${key} (${code}):`, err);
      // An encode failure must NEVER crash the app — a bad photo is a normal
      // input. Even recording the failure is best-effort: if the database is
      // the thing that is down, media-sync's next pass will pick the row up.
      await opts.store.setStatus(key, 'failed', code).catch((e) => logError(`could not record encode failure for ${key}:`, e));
    } finally {
      inFlight.delete(key);
      pump();
    }
  }

  function pump(): void {
    while (!draining && inFlight.size < concurrency && pending.length > 0) {
      const key = pending.shift();
      if (key === undefined) break;
      if (inFlight.has(key)) continue; // already encoding — drop the duplicate
      inFlight.add(key);
      void runJob(key);
    }
    settleIfIdle();
  }

  return {
    enqueue(key) {
      if (inFlight.has(key) || pending.includes(key)) return; // idempotent
      if (pending.length >= maxBacklog) throw new BacklogFullError();
      pending.push(key);
      pump();
    },
    async recover() {
      // Re-seed everything a crash left `processing`. Re-encoding is
      // idempotent — it overwrites the same deterministic filenames — so a job
      // interrupted mid-write self-heals rather than needing cleanup.
      const { items, total } = await opts.store.list({
        status: 'processing', sort: 'uploaded', order: 'asc', page: 1, pageSize: maxBacklog,
      });
      const queued = new Set<string>([...pending, ...inFlight]);
      let n = 0;
      for (const item of items) {
        if (queued.has(item.key) || pending.length >= maxBacklog) continue;
        pending.push(item.key);
        queued.add(item.key);
        n++;
      }
      if (n > 0) log(`encode queue: recovered ${n} unfinished upload(s)`);
      // No silent truncation: say so when the cap left work behind. The rest
      // is picked up by the next reconcile pass (POST /media/rescan or a
      // restart) — NOT by POST /media/retry, which skips `processing` rows.
      if (total > n) log(`encode queue: ${total - n} more still pending — re-run recovery after this batch`);
      pump();
      return n;
    },
    async drain() {
      // Stop pulling from the backlog: every job started DURING the drain is
      // exactly the mid-write case the drain exists to avoid (#134). What is
      // still pending stays `processing` in the database and recover()
      // re-seeds it on the next boot.
      draining = true;
      if (isIdle()) return;
      await new Promise<void>((resolve) => { idleWaiters.push(resolve); });
    },
    async idle() {
      if (isIdle()) return;
      await new Promise<void>((resolve) => { idleWaiters.push(resolve); });
    },
    stats: () => ({ pending: pending.length, running: inFlight.size }),
    isActive: (key) => inFlight.has(key) || pending.includes(key),
  };
}
