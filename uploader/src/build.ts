import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, rename, symlink, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as setTimeoutP } from 'node:timers/promises';
import { createWorkLock, type WorkLock } from './work-lock.js';

export interface BuildOutcome { ok: boolean; release?: string; error?: string }

export interface SiteBuilder {
  build(): Promise<BuildOutcome>;
  hasRelease(): boolean;
}

/** Bounds a spawned `astro build`. Measured builds finish well under a minute
 * (19 pages, ~0.47 GB RSS — see docker-compose.yml); this leaves an order of
 * magnitude for a large corpus while still bounding the wedge of issue #110. */
export const BUILD_TIMEOUT_MS = 15 * 60_000;
/** Bytes of the child's stderr kept for the failure message. */
export const STDERR_TAIL_BYTES = 4096;

/** The build child did not exit within its deadline and was killed. Distinct
 * so a caller (or the admin reading `BuildOutcome.error`) can tell a hang from
 * a failing build. */
export class BuildTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    const after = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${Math.round(timeoutMs / 1000)} s`;
    super(`astro build timed out after ${after} and was killed`);
    this.name = 'BuildTimeoutError';
  }
}

export interface SiteBuilderOptions {
  siteAppDir: string;
  releasesRoot: string;
  keep?: number;
  /** Deadline for one `astro build` child; default `BUILD_TIMEOUT_MS`. */
  timeoutMs?: number;
  runBuild?: (outDir: string) => Promise<void>;
  /**
   * Shared with the encode queue so a build and image encoding never run at
   * the same time — both are memory-hungry and share one container. The build
   * takes the lock EXCLUSIVELY and preempts the encode backlog; see
   * `work-lock.ts`. Omit and the builder gets a private lock, which is the
   * right default for tests and for any deployment with no encode queue.
   */
  lock?: WorkLock;
}

// astro colours its logger output when it thinks it has a TTY; the tail lands
// in a <p>, where escape codes are noise.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Spawn a build child and settle when it has exited AND its stdio drained.
 *
 * @ai-warning The child runs under the exclusive work-lock (see runOnce), so
 * a child that never exits holds every later publish, rebuild and encode
 * hostage (#110). The deadline is the only thing that bounds it: on expiry the
 * child is SIGKILLed (it is by definition not responding — nothing to flush)
 * and the run rejects with `BuildTimeoutError`. `init: true` in compose reaps
 * anything the child leaves behind.
 *
 * stderr is tee'd: streamed to our own stderr so the container log is
 * unchanged, and the last `STDERR_TAIL_BYTES` are appended to the rejection
 * so the admin learns WHICH post failed the schema instead of `exited 1`.
 * Settled on `close`, not `exit`, so that tail is complete; in the timeout
 * path the pipe is destroyed after the kill so a grandchild that inherited the
 * fd (esbuild's service) cannot hold `close` open.
 *
 * Exported for tests; `runAstroBuild` is the astro-specific caller.
 */
export function runChildBuild(command: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  // Executor form: the uploader compiles against ES2022 (no Promise.withResolvers).
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    let tail = Buffer.alloc(0);
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      child.stderr?.destroy();
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new BuildTimeoutError(timeoutMs));
      if (code === 0) return resolve();
      const why = code === null ? `astro build killed by ${signal}` : `astro build exited ${code}`;
      const detail = tail.toString('utf8').replace(ANSI_RE, '').trim();
      reject(new Error(detail ? `${why}\n${detail}` : why));
    });
  });
}

/** Spawn `astro build` via plain node — no npx/npm/shell, so the runtime image
 * can stay minimal and non-root. Telemetry is disabled for headless runs. */
function runAstroBuild(siteAppDir: string, outDir: string, timeoutMs: number): Promise<void> {
  const astroBin = join(siteAppDir, 'node_modules', 'astro', 'bin', 'astro.mjs');
  return runChildBuild(process.execPath, [astroBin, 'build', '--outDir', outDir], siteAppDir, timeoutMs);
}

/** Remove what a crashed (SIGKILLed) earlier run left behind: the CWD-local
 * build tmp and any dot-prefixed staging dir under `releases/`. Runs inside
 * the exclusive lock, so nothing else is mid-build. */
async function sweepLeftovers(siteAppDir: string, releases: string): Promise<void> {
  await rm(join(siteAppDir, '.build-tmp'), { recursive: true, force: true });
  for (const name of await readdir(releases)) {
    if (name.startsWith('.')) await rm(join(releases, name), { recursive: true, force: true });
  }
}

// Monotonic stamp suffix: a queued run can start within the same millisecond
// the previous one finished, so Date.now() alone could collide. Zero-padded so
// the lexicographic sort used by release pruning orders same-millisecond
// stamps correctly (e.g. `-0010` after `-0009`).
let stampSeq = 0;

/** Build into a fresh release dir, then atomically flip the `current` symlink.
 *
 * @ai-note Astro's prerender step writes to a tmp dir relative to CWD; when
 * outDir sits on another device (a Docker volume) its rename() fails with
 * EXDEV. So: build into a CWD-local tmp first, then `cp` to the release dir.
 *
 * @ai-note A release dir is either complete or absent: the copy lands in a
 * dot-prefixed staging dir and is renamed into place (same fs, atomic). A
 * failed or killed copy (ENOSPC, SIGKILL) can therefore never leave a
 * half-populated `releases/<stamp>` that is never symlinked yet counts toward
 * `keep` and displaces a real rollback candidate (#110). Staging dirs are
 * removed on failure, swept at the next run, and ignored by pruning.
 */
async function buildAndDeploy(opts: Required<Omit<SiteBuilderOptions, 'runBuild' | 'lock' | 'timeoutMs'>> & { runBuild: (outDir: string) => Promise<void> }): Promise<string> {
  const releases = join(opts.releasesRoot, 'releases');
  await mkdir(releases, { recursive: true });
  await sweepLeftovers(opts.siteAppDir, releases);
  const stamp = `${Date.now()}-${process.pid}-${String(stampSeq++).padStart(4, '0')}`;
  const buildTmp = join(opts.siteAppDir, '.build-tmp', stamp);
  const staging = join(releases, `.${stamp}.partial`);
  const dest = join(releases, stamp);
  try {
    await opts.runBuild(buildTmp);
    await cp(buildTmp, staging, { recursive: true });
    await rename(staging, dest);
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => { /* best-effort; swept next run */ });
    throw e;
  } finally {
    await rm(buildTmp, { recursive: true, force: true });
  }
  const tmpLink = join(opts.releasesRoot, `.current.${stamp}`);
  await symlink(dest, tmpLink);
  await rename(tmpLink, join(opts.releasesRoot, 'current'));
  const all = (await readdir(releases)).filter((name) => !name.startsWith('.')).sort();
  let live = '';
  try { live = (await readlink(join(opts.releasesRoot, 'current'))).split('/').pop() ?? ''; } catch { /* no current yet */ }
  for (const old of all.slice(0, -opts.keep)) {
    if (old === live) continue;
    await rm(join(releases, old), { recursive: true, force: true });
  }
  return stamp;
}

export function createSiteBuilder(opts: SiteBuilderOptions): SiteBuilder {
  const keep = opts.keep ?? 3;
  const timeoutMs = opts.timeoutMs ?? BUILD_TIMEOUT_MS;
  const runBuild = opts.runBuild ?? ((outDir: string) => runAstroBuild(opts.siteAppDir, outDir, timeoutMs));
  const lock = opts.lock ?? createWorkLock();
  // @ai-note One-deep coalescing instead of rejecting concurrent builds. The
  // publish route flips the Postgres row BEFORE calling build(), so rejecting
  // used to surface a false "a build is already running" error for a post that
  // WAS published (and would silently go live on the next unrelated build).
  // A build() arriving mid-flight now attaches to a single queued run that
  // starts after the in-flight one finishes — so its loader SELECT
  // happens-after the caller's DB write — and resolves with that run's real
  // outcome. Callers simply await a little longer; no route/UI changes needed.
  let inFlight: Promise<BuildOutcome> | null = null;
  let queued: Promise<BuildOutcome> | null = null;
  // Always resolves (never rejects), so chaining a queued run off a failed
  // in-flight build is safe.
  const runOnce = async (): Promise<BuildOutcome> => {
    try {
      // Exclusive: pauses the encode queue for the duration (see work-lock.ts).
      // Taken INSIDE runOnce so the coalescing above is unaffected — a queued
      // build still waits for the in-flight one, then competes for the lock.
      const release = await lock.runExclusive(() =>
        buildAndDeploy({ siteAppDir: opts.siteAppDir, releasesRoot: opts.releasesRoot, keep, runBuild }));
      return { ok: true, release };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };
  const startRun = (): Promise<BuildOutcome> => {
    const run = runOnce();
    inFlight = run;
    void run.finally(() => { if (inFlight === run) inFlight = null; });
    return run;
  };
  return {
    hasRelease: () => existsSync(join(opts.releasesRoot, 'current')),
    async build() {
      if (queued) return queued; // coalesce: share the one already-queued run
      if (inFlight) {
        const next = inFlight.then(() => {
          // Clear `queued` BEFORE the promoted run starts: a caller arriving
          // while it executes must queue a fresh run, not attach to this one
          // (its DB write could postdate this run's SELECT).
          queued = null;
          return startRun();
        });
        queued = next;
        return next;
      }
      return startRun();
    },
  };
}

export interface BootstrapOptions {
  log: (message: string) => void;
  /** Total build attempts, including the first; default 6. */
  attempts?: number;
  /** First retry delay; doubles per attempt up to `maxDelayMs`. Defaults 30 s → 8 min. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests; the default is an unref'd `timers/promises` sleep. */
  sleep?: (ms: number) => Promise<void>;
}

// `ref: false`: a pending retry never keeps a shutting-down process alive.
const defaultSleep = (ms: number) => setTimeoutP(ms, undefined, { ref: false });

/**
 * First boot on a fresh volume: produce the initial release, retrying a failed
 * build with exponential backoff. Before #110 the initial build fired once and
 * a failure was only logged, after which every blog URL served 503 until an
 * admin happened to publish something.
 *
 * Stops as soon as a release exists — including one an admin's publish
 * produced meanwhile, which `hasRelease()` reflects — and gives up after
 * `attempts`: a build that fails the content schema is not healed by time, and
 * a loop of exclusive-lock builds would starve the encode queue on every boot.
 * Never rejects; every outcome is logged. Each attempt goes through the
 * builder's coalescing and lock, so a retry never runs beside another build.
 */
export async function bootstrapRelease(builder: SiteBuilder, opts: BootstrapOptions): Promise<void> {
  const attempts = opts.attempts ?? 6;
  const maxDelayMs = opts.maxDelayMs ?? 8 * 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  let delayMs = opts.baseDelayMs ?? 30_000;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (builder.hasRelease()) {
      if (attempt > 1) opts.log('initial build no longer needed: a release exists');
      return;
    }
    const r = await builder.build();
    if (r.ok) { opts.log(`initial build released ${r.release}`); return; }
    if (attempt === attempts) {
      opts.log(`initial build failed (attempt ${attempt}/${attempts}), giving up; publish or rebuild from the admin to retry: ${r.error}`);
      return;
    }
    opts.log(`initial build failed (attempt ${attempt}/${attempts}), retrying in ${Math.round(delayMs / 1000)}s: ${r.error}`);
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}
