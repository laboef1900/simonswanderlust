import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, rename, symlink, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface BuildOutcome { ok: boolean; release?: string; error?: string }

export interface SiteBuilder {
  build(): Promise<BuildOutcome>;
  hasRelease(): boolean;
}

export interface SiteBuilderOptions {
  siteAppDir: string;
  releasesRoot: string;
  keep?: number;
  runBuild?: (outDir: string) => Promise<void>;
}

/** Spawn `astro build` via plain node — no npx/npm/shell, so the runtime image
 * can stay minimal and non-root. Telemetry is disabled for headless runs. */
function runAstroBuild(siteAppDir: string, outDir: string): Promise<void> {
  return new Promise((resolveBuild, reject) => {
    const astroBin = join(siteAppDir, 'node_modules', 'astro', 'bin', 'astro.mjs');
    const child = spawn(process.execPath, [astroBin, 'build', '--outDir', outDir], {
      cwd: siteAppDir,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolveBuild() : reject(new Error(`astro build exited ${code}`))));
    child.on('error', reject);
  });
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
 */
async function buildAndDeploy(opts: Required<Omit<SiteBuilderOptions, 'runBuild'>> & { runBuild: (outDir: string) => Promise<void> }): Promise<string> {
  const releases = join(opts.releasesRoot, 'releases');
  await mkdir(releases, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}-${String(stampSeq++).padStart(4, '0')}`;
  const buildTmp = join(opts.siteAppDir, '.build-tmp', stamp);
  const dest = join(releases, stamp);
  try {
    await opts.runBuild(buildTmp);
    await cp(buildTmp, dest, { recursive: true });
  } finally {
    await rm(buildTmp, { recursive: true, force: true });
  }
  const tmpLink = join(opts.releasesRoot, `.current.${stamp}`);
  await symlink(dest, tmpLink);
  await rename(tmpLink, join(opts.releasesRoot, 'current'));
  const all = (await readdir(releases)).sort();
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
  const runBuild = opts.runBuild ?? ((outDir: string) => runAstroBuild(opts.siteAppDir, outDir));
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
      const release = await buildAndDeploy({ siteAppDir: opts.siteAppDir, releasesRoot: opts.releasesRoot, keep, runBuild });
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
