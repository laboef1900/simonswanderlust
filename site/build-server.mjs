import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdir, rm, rename, symlink, readdir, stat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const RELEASES_DIR = process.env.RELEASES_DIR ?? '/srv/blog';
const PORT = Number(process.env.BUILD_PORT ?? 4000);
const SECRET = process.env.BUILD_SECRET ?? '';
const APP_DIR = process.cwd(); // the site project

export function isAuthorized(header, secret) {
  if (!secret || !header) return false;
  const a = Buffer.from(header), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

let building = false;

function runAstroBuild(outDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['astro', 'build', '--outDir', outDir], {
      cwd: APP_DIR, env: process.env, stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`astro build exited ${code}`))));
    child.on('error', reject);
  });
}

/** Build into a fresh release dir, then atomically flip the `current` symlink.
 *
 * @ai-note Astro's prerender step writes to a `.prerender/` tmp dir relative to
 * `getOutDirWithinCwd(outDir)`. When outDir is outside CWD (e.g. on a Docker
 * volume at /srv/blog), Astro falls back to `/app/.astro/.prerender/` and then
 * tries to `rename()` assets into the volume — failing with EXDEV (cross-device).
 * Fix: build into a CWD-local tmp dir first, then `cp -r` to the volume.
 */
export async function buildAndDeploy() {
  if (building) throw new Error('a build is already running');
  building = true;
  try {
    const releases = join(RELEASES_DIR, 'releases');
    await mkdir(releases, { recursive: true });
    const stamp = `${Date.now()}-${process.pid}`;
    // Build into a CWD-local tmp so Astro's prerender rename stays on-device.
    const buildTmp = join(APP_DIR, '.build-tmp', stamp);
    await runAstroBuild(buildTmp);
    // Copy the finished build to the volume release dir, then clean up the tmp.
    const dest = join(releases, stamp);
    await cp(buildTmp, dest, { recursive: true });
    await rm(buildTmp, { recursive: true, force: true });
    // atomic swap: write a temp symlink then rename over `current`
    const tmpLink = join(RELEASES_DIR, `.current.${stamp}`);
    await symlink(dest, tmpLink);
    await rename(tmpLink, join(RELEASES_DIR, 'current'));
    // prune old releases (keep last 3), never deleting the live release
    const all = (await readdir(releases)).sort();
    let live = '';
    try { live = (await readlink(join(RELEASES_DIR, 'current'))).split('/').pop() ?? ''; } catch { /* no current yet */ }
    for (const old of all.slice(0, -3)) {
      if (old === live) continue;
      await rm(join(releases, old), { recursive: true, force: true });
    }
    return stamp;
  } finally {
    building = false;
  }
}

function serve() {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      let ok = false;
      try { ok = (await stat(join(RELEASES_DIR, 'current'))).isDirectory(); } catch { ok = false; }
      res.writeHead(ok ? 200 : 503).end(ok ? 'ok' : 'no build yet');
      return;
    }
    if (req.method === 'POST' && req.url === '/build') {
      if (!isAuthorized(req.headers['x-build-secret'], SECRET)) { res.writeHead(401).end('unauthorized'); return; }
      try { const stamp = await buildAndDeploy(); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, release: stamp })); }
      catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(e) })); }
      return;
    }
    res.writeHead(404).end('not found');
  });
  server.listen(PORT, () => console.log(`build-server on :${PORT}, releases at ${RELEASES_DIR}`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Initial build on boot so the site is populated, then serve.
  buildAndDeploy().then((s) => console.log(`initial build ${s}`)).catch((e) => console.error('initial build failed', e)).finally(serve);
}
