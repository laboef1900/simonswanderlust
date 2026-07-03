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

/** Build into a fresh release dir, then atomically flip the `current` symlink.
 *
 * @ai-note Astro's prerender step writes to a tmp dir relative to CWD; when
 * outDir sits on another device (a Docker volume) its rename() fails with
 * EXDEV. So: build into a CWD-local tmp first, then `cp` to the release dir.
 */
async function buildAndDeploy(opts: Required<Omit<SiteBuilderOptions, 'runBuild'>> & { runBuild: (outDir: string) => Promise<void> }): Promise<string> {
  const releases = join(opts.releasesRoot, 'releases');
  await mkdir(releases, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}`;
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
  let building = false;
  return {
    hasRelease: () => existsSync(join(opts.releasesRoot, 'current')),
    async build() {
      if (building) return { ok: false, error: 'a build is already running' };
      building = true;
      try {
        const release = await buildAndDeploy({ siteAppDir: opts.siteAppDir, releasesRoot: opts.releasesRoot, keep, runBuild });
        return { ok: true, release };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      } finally {
        building = false;
      }
    },
  };
}
