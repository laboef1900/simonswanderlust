import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, rename, symlink, readdir, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createWorkLock, type WorkLock } from './work-lock.js';
import { assertWorkWritable, cancellableSleep, createWorkCancellation, isWorkWritable, type WorkCancellationOptions } from './work-cancellation.js';
import type pg from 'pg';
import { parseIdentitySnapshot } from '../../site/src/lib/site-identity.js';
import { BuildSnapshotTimeoutError, withBuildSnapshot, writeBuildAssets, type BuildSnapshot } from './build-snapshot.js';
import { DEFAULT_LANGUAGE } from './language.js';
import { StorageReadOnlyError } from './storage-owner.js';
import { buildFailureMessage, createBuildState, observeLiveRelease, type BuildFailureCode, type BuildReport, type BuildStatusResponse, type BuildTrigger } from './build-state.js';
import { publishReleaseManifest, removeReleaseManifest, sweepReleaseManifests } from './release-manifest.js';

export interface BuildOutcome extends BuildReport { cause?: unknown }

export interface SiteBuilder {
  build(trigger: BuildTrigger): Promise<BuildOutcome>;
  initialize(): Promise<void>;
  status(): Promise<BuildStatusResponse>;
  hasRelease(): boolean;
  quiesce(): Promise<void>;
}

/** Bounds a spawned `astro build`. Measured builds finish well under a minute
 * (19 pages, ~0.47 GB RSS — see docker-compose.yml); this leaves an order of
 * magnitude for a large corpus while still bounding the wedge of issue #110. */
export const BUILD_TIMEOUT_MS = 15 * 60_000;
/** Bytes of the child's stderr kept for server-only failure diagnostics. */
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

/** Child diagnostics are server-only, never part of the public build report. */
export class BuildChildError extends Error {
  constructor(readonly exitCode: number | null, readonly signal: NodeJS.Signals | null, readonly stderrTail: string) {
    super('Site generator failed');
    this.name = 'BuildChildError';
  }
}

export class BuildUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Site generator could not start', { cause });
    this.name = 'BuildUnavailableError';
  }
}

function failureCode(error: unknown, deploymentStarted: boolean): BuildFailureCode {
  if (error instanceof StorageReadOnlyError) return 'build_stopped';
  if (error instanceof BuildTimeoutError || error instanceof BuildSnapshotTimeoutError) return 'build_timeout';
  if (error instanceof BuildChildError) return 'build_failed';
  if (error instanceof BuildUnavailableError) return 'build_unavailable';
  if (deploymentStarted && error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    if (error.code === 'ENOSPC' || error.code === 'EDQUOT') return 'no_space';
    // Snapshot connection errors before deployment are not release-write errors.
    if (/^E[A-Z]+$/.test(error.code)) return 'release_write_failed';
  }
  return 'internal';
}

export interface SiteBuilderOptions extends WorkCancellationOptions {
  applicationName?: string;
  /** Required for real builds; test-only runBuild callbacks may omit the DB. */
  pool?: pg.Pool;
  siteAppDir: string;
  releasesRoot: string;
  keep?: number;
  /** Deadline for one `astro build` child; default `BUILD_TIMEOUT_MS`. */
  timeoutMs?: number;
  runBuild?: (outDir: string, manifestPath: string) => Promise<void>;
  /**
   * Shared with the encode queue so a build and image encoding never run at
   * the same time — both are memory-hungry and share one container. The build
   * takes the lock EXCLUSIVELY and preempts the encode backlog; see
   * `work-lock.ts`. Omit and the builder gets a private lock, which is the
   * right default for tests and for any deployment with no encode queue.
   */
  lock?: WorkLock;
}

// Keep terminal control sequences out of the bounded, server-only diagnostic tail.
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
 * stderr is tee'd to the container log and a bounded server-only diagnostic
 * tail. Routes project fixed dictionary copy, never this diagnostic.
 * Settled on `close`, not `exit`, so that tail is complete; in the timeout
 * path the pipe is destroyed after the kill so a grandchild that inherited the
 * fd (esbuild's service) cannot hold `close` open.
 *
 * Exported for tests; `runAstroBuild` is the astro-specific caller.
 *
 * @ai-warning `onSpawn` fires SYNCHRONOUSLY, before the deadline timer is
 * armed, and that ordering is the whole point of it. The timeout test needs
 * the child's pid to prove the process was reaped rather than merely
 * abandoned. It used to get that from a pid file the child wrote as its first
 * statement — which races the very deadline under test: when Node's cold
 * start (~75ms idle here, unbounded on a loaded machine) overran the budget,
 * the child was SIGKILLed before it ran at all and the test died on
 * `ENOENT … /pid`, about one run in four under load. `child.pid` is set the
 * moment `spawn` returns, so there is no window left to lose. Never move this
 * call below the timer, and never reintroduce a side channel the child has to
 * be alive to write.
 */
export function runChildBuild(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onSpawn?: (child: ChildProcess) => void,
  opts: WorkCancellationOptions & { applicationName?: string; snapshot?: BuildSnapshot; manifestPath?: string } = {},
): Promise<void> {
  assertWorkWritable(opts);
  const env: NodeJS.ProcessEnv = {
    ...process.env, ASTRO_TELEMETRY_DISABLED: '1',
    SITE_IDENTITY_JSON: JSON.stringify(opts.snapshot?.identity ?? parseIdentitySnapshot(undefined)),
    SITE_LANGUAGE_JSON: JSON.stringify(opts.snapshot?.language ?? DEFAULT_LANGUAGE),
  };
  // Never inherit operator-supplied snapshot identifiers, including empty ones.
  delete env.SITE_DATABASE_SNAPSHOT;
  if (opts.snapshot) env.SITE_DATABASE_SNAPSHOT = opts.snapshot.databaseSnapshot;
  delete env.SITE_RELEASE_MANIFEST;
  if (opts.manifestPath) env.SITE_RELEASE_MANIFEST = opts.manifestPath;
  if (opts.applicationName) {
    env.PGAPPNAME = opts.applicationName;
    if (env.DATABASE_URL) {
      const url = new URL(env.DATABASE_URL);
      url.searchParams.set('application_name', opts.applicationName);
      env.DATABASE_URL = url.href;
    }
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  onSpawn?.(child);
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
  const abort = () => { child.kill('SIGKILL'); child.stderr?.destroy(); };
  opts.signal?.addEventListener('abort', abort, { once: true });
  if (!isWorkWritable(opts)) abort();
  child.on('error', (err) => { clearTimeout(timer); opts.signal?.removeEventListener('abort', abort); reject(new BuildUnavailableError(err)); });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
    if (!isWorkWritable(opts)) {
      try { assertWorkWritable(opts); } catch (err) { reject(err); }
      return;
    }
    if (timedOut) return reject(new BuildTimeoutError(timeoutMs));
    if (code === 0) return resolve();
    reject(new BuildChildError(code, signal, tail.toString('utf8').replace(ANSI_RE, '').trim()));
  });
  return promise;
}

/** Spawn `astro build` via plain node — no npx/npm/shell, so the runtime image
 * can stay minimal and non-root. Telemetry is disabled for headless runs. */
function runAstroBuild(siteAppDir: string, outDir: string, timeoutMs: number, opts: WorkCancellationOptions & { applicationName?: string; snapshot?: BuildSnapshot; manifestPath: string }): Promise<void> {
  const astroBin = join(siteAppDir, 'node_modules', 'astro', 'bin', 'astro.mjs');
  return runChildBuild(process.execPath, [astroBin, 'build', '--outDir', outDir], siteAppDir, timeoutMs, undefined, opts);
}

/** Remove what a crashed (SIGKILLed) earlier run left behind: the CWD-local
 * build tmp and any dot-prefixed staging dir under `releases/`. Runs inside
 * the exclusive lock, so nothing else is mid-build. */
async function sweepLeftovers(siteAppDir: string, releases: string, opts: WorkCancellationOptions): Promise<void> {
  assertWorkWritable(opts);
  await rm(join(siteAppDir, '.build-tmp'), { recursive: true, force: true });
  for (const name of await readdir(releases)) {
    assertWorkWritable(opts);
    if (name.startsWith('.')) await rm(join(releases, name), { recursive: true, force: true });
  }
}

type PruneStage = 'enumerate' | 'current' | 'remove' | 'ownership';
const PRUNE_ERRNOS: Readonly<Record<string, true>> = {
  EACCES: true, EPERM: true, EBUSY: true, ENOENT: true, ENOTDIR: true,
  ENOTEMPTY: true, EIO: true, EMFILE: true, ENFILE: true, ENOSPC: true,
  EROFS: true, ELOOP: true, EINVAL: true,
};

/** Cleanup diagnostics must neither disclose filesystem paths nor reject a
 * promotion that has already committed, even if the log sink itself fails. */
function warnPrune(stamp: string, stage: PruneStage, error?: unknown): void {
  try {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const errno = typeof code === 'string' && Object.hasOwn(PRUNE_ERRNOS, code) ? code : 'unknown';
    console.warn(`release promoted; old-release cleanup incomplete release=${stamp} stage=${stage} errno=${errno}`);
  } catch { /* A diagnostic cannot undo promotion. */ }
}

/** Keep the existing retention selection, but fail closed when its inputs or
 * storage ownership are uncertain. This phase never changes promotion success. */
async function prunePromotedRelease(releases: string, stamp: string, opts: WorkCancellationOptions & { releasesRoot: string; keep: number }): Promise<void> {
  let stage: PruneStage = 'enumerate';
  try {
    const all = (await readdir(releases)).filter((name) => !name.startsWith('.')).sort();
    stage = 'current';
    const live = resolve(opts.releasesRoot, await readlink(join(opts.releasesRoot, 'current')));
    if (live !== resolve(releases, stamp)) {
      warnPrune(stamp, stage);
      return;
    }
    for (const old of all.slice(0, -opts.keep)) {
      if (old === stamp || resolve(releases, old) === live) continue;
      stage = 'ownership';
      assertWorkWritable(opts);
      try {
        await rm(join(releases, old), { recursive: true, force: true });
      } catch (error) {
        // A failed removal may coincide with lease loss: do not admit a
        // further mutation merely because the filesystem error was ordinary.
        assertWorkWritable(opts);
        warnPrune(stamp, 'remove', error);
        continue;
      }
      stage = 'ownership';
      await removeReleaseManifest(opts.releasesRoot, old, opts);
    }
  } catch (error) {
    warnPrune(stamp, stage, error);
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
async function buildAndDeploy(opts: Pick<SiteBuilderOptions, 'siteAppDir' | 'releasesRoot' | 'signal' | 'isWritable'> & { stamp: string; promoted: () => void; keep: number; runBuild: (outDir: string, manifestPath: string) => Promise<void> }): Promise<string> {
  const releases = join(opts.releasesRoot, 'releases');
  assertWorkWritable(opts);
  await mkdir(releases, { recursive: true });
  await sweepLeftovers(opts.siteAppDir, releases, opts);
  await sweepReleaseManifests(opts.releasesRoot, opts);
  const stamp = opts.stamp;
  const buildTmp = join(opts.siteAppDir, '.build-tmp', stamp);
  const manifestPath = join(opts.siteAppDir, '.build-tmp', `${stamp}.manifest.json`);
  const staging = join(releases, `.${stamp}.partial`);
  const dest = join(releases, stamp);
  try {
    assertWorkWritable(opts);
    await opts.runBuild(buildTmp, manifestPath);
    assertWorkWritable(opts);
    await cp(buildTmp, staging, { recursive: true, filter: () => { assertWorkWritable(opts); return true; } });
    assertWorkWritable(opts);
    await rename(staging, dest);
    await publishReleaseManifest(manifestPath, opts.releasesRoot, stamp, opts);
  } catch (e) {
    if (isWorkWritable(opts)) await rm(staging, { recursive: true, force: true }).catch(() => { /* best-effort; swept next run */ });
    throw e;
  } finally {
    if (isWorkWritable(opts)) await rm(buildTmp, { recursive: true, force: true });
  }
  const tmpLink = join(opts.releasesRoot, `.current.${stamp}`);
  assertWorkWritable(opts);
  await symlink(dest, tmpLink);
  assertWorkWritable(opts);
  await rename(tmpLink, join(opts.releasesRoot, 'current'));
  opts.promoted();
  // @ai-note The current-link rename is the commit point (#397). Housekeeping
  // cannot report a failed build after readers already see this release.
  await prunePromotedRelease(releases, stamp, opts);
  return stamp;
}

export function createSiteBuilder(opts: SiteBuilderOptions): SiteBuilder {
  const work = createWorkCancellation(opts);
  const keep = opts.keep ?? 3;
  const timeoutMs = opts.timeoutMs ?? BUILD_TIMEOUT_MS;
  const lock = opts.lock ?? createWorkLock();
  const state = createBuildState(opts.releasesRoot, work);
  let inFlight: Promise<BuildOutcome> | null = null;
  let queued: { promise: Promise<BuildOutcome>; triggers: Set<BuildTrigger> } | null = null;

  const refused = async (cause: unknown): Promise<BuildOutcome> => {
    const live = await observeLiveRelease(opts.releasesRoot);
    return {
      ok: false, attemptId: null, code: 'build_stopped', error: buildFailureMessage('build_stopped'), cause,
      ...(live !== undefined ? { liveRelease: live?.release ?? null } : {}),
    };
  };
  const runOnce = async (triggers: Set<BuildTrigger>): Promise<BuildOutcome> => {
    try {
      work.assertWritable();
      return await lock.runExclusive(async () => {
        work.assertWritable();
        await state.initialize();
        work.assertWritable();
        const ms = Date.now();
        const attemptId = `${ms}-${process.pid}-${String(stampSeq++).padStart(4, '0')}`;
        const startedAt = new Date(ms).toISOString();
        const servedTriggers = [...triggers].sort();
        await state.start({ attemptId, startedAt, triggers: servedTriggers });
        // This flag is set at the actual successful rename, not after snapshot
        // settlement or cleanup: those may fail after promotion has committed.
        let promoted = false;
        let deploymentStarted = false;
        let cause: unknown;
        try {
          const deploy = (snapshot?: BuildSnapshot) => {
            deploymentStarted = true;
            const buildWork = snapshot ? { ...work, signal: snapshot.signal } : work;
            const runBuild = async (outDir: string, manifestPath: string) => {
              if (opts.runBuild) await opts.runBuild(outDir, manifestPath);
              else await runAstroBuild(opts.siteAppDir, outDir, timeoutMs, { ...buildWork, applicationName: opts.applicationName, snapshot, manifestPath });
              if (snapshot) await writeBuildAssets(outDir, snapshot);
            };
            return buildAndDeploy({
              siteAppDir: opts.siteAppDir, releasesRoot: opts.releasesRoot, keep, runBuild, ...buildWork,
              stamp: attemptId, promoted: () => { promoted = true; },
            });
          };
          if (opts.pool) await withBuildSnapshot(opts.pool, { timeoutMs, signal: work.signal }, deploy);
          else {
            if (!opts.runBuild) throw new Error('A database pool is required for site builds');
            await deploy();
          }
        } catch (error) { cause = error; }
        const code = promoted ? undefined : !work.isWritable() ? 'build_stopped' : failureCode(cause, deploymentStarted);
        if (cause !== undefined) {
          try { console.error(`site build ${attemptId} ${promoted ? 'post-promotion settlement warning' : `failed (${code})`}`, cause); }
          catch { /* Diagnostic sinks cannot undo a committed release. */ }
        }
        const live = await observeLiveRelease(opts.releasesRoot);
        const liveRelease = live === undefined ? undefined : live?.release ?? null;
        const outcome: BuildOutcome = {
          ok: promoted, attemptId,
          ...(promoted ? { release: attemptId } : { code: code!, error: buildFailureMessage(code!), cause }),
          ...(liveRelease !== undefined ? { liveRelease } : {}),
        };
        await state.finish({
          attemptId, startedAt, finishedAt: new Date(Math.max(ms, Date.now())).toISOString(),
          result: promoted ? 'succeeded' : 'failed', release: promoted ? attemptId : null,
          failure: promoted ? null : { code: code!, message: buildFailureMessage(code!) },
          triggers: servedTriggers,
          ...(liveRelease !== undefined ? { liveReleaseAfter: liveRelease } : {}),
        });
        return outcome;
      });
    } catch (cause) {
      // No attempt was admitted. Preserve history (including a previous failure).
      return refused(cause);
    }
  };
  const startRun = (triggers: Set<BuildTrigger>): Promise<BuildOutcome> => {
    const run = runOnce(triggers);
    inFlight = run;
    void run.finally(() => { if (inFlight === run) inFlight = null; });
    return run;
  };
  return {
    initialize: state.initialize,
    status: () => state.status(queued !== null),
    hasRelease: () => existsSync(join(opts.releasesRoot, 'current')),
    async quiesce() {
      work.stop();
      await Promise.all([inFlight, queued?.promise]);
    },
    async build(trigger) {
      if (!work.isWritable()) return refused(new StorageReadOnlyError());
      if (queued) {
        queued.triggers.add(trigger);
        return queued.promise;
      }
      const triggers = new Set([trigger]);
      if (inFlight) {
        const promise = inFlight.then(() => {
          // A later caller must queue after this run's snapshot, never attach
          // to a SELECT that could precede its committed mutation.
          queued = null;
          return startRun(triggers);
        });
        queued = { promise, triggers };
        return promise;
      }
      return startRun(triggers);
    },
  };
}

export interface BootstrapOptions extends WorkCancellationOptions {
  log: (message: string) => void;
  /** Total build attempts, including the first; default 6. */
  attempts?: number;
  /** First retry delay; doubles per attempt up to `maxDelayMs`. Defaults 30 s → 8 min. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests; the default is an unref'd `timers/promises` sleep. */
  sleep?: (ms: number) => Promise<void>;
}


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
export async function bootstrapRelease(builder: Pick<SiteBuilder, 'build' | 'hasRelease'>, opts: BootstrapOptions): Promise<void> {
  const attempts = opts.attempts ?? 6;
  const maxDelayMs = opts.maxDelayMs ?? 8 * 60_000;
  const sleep = opts.sleep;
  let delayMs = opts.baseDelayMs ?? 30_000;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!isWorkWritable(opts)) return;
    if (builder.hasRelease()) {
      if (attempt > 1) opts.log('initial build no longer needed: a release exists');
      return;
    }
    const r = await builder.build('boot');
    if (!isWorkWritable(opts)) return;
    if (r.ok) { opts.log(`initial build released ${r.release}`); return; }
    if (attempt === attempts) {
      opts.log(`initial build failed (attempt ${attempt}/${attempts}), giving up; publish or rebuild from the admin to retry: ${r.error}`);
      return;
    }
    opts.log(`initial build failed (attempt ${attempt}/${attempts}), retrying in ${Math.round(delayMs / 1000)}s: ${r.error}`);
    try { await cancellableSleep(delayMs, opts, sleep); }
    catch (err) { if (!isWorkWritable(opts)) return; throw err; }
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}
