# Single App Container + Configurable DB Backup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the 4-container stack into `app` (Fastify: CMS + images + static blog + in-process Astro builds) + `db`, and add a schedulable DB backup managed from the admin settings page.

**Architecture:** The uploader absorbs the builder (Astro spawned via plain `node`, no npx/shell/root) and the nginx role (host-constrained Fastify static serving: img subdomain → variants, main domain → blog from `/data/site/current` with nginx-parity semantics). Backups are app-native gzipped JSON dumps of `users`+`posts` with an in-process scheduler; restore is CLI-only.

**Tech Stack:** Node 22, Fastify 5, `@fastify/static` 8.3 (host `constraints`, `redirect: true` → **301**, byte ranges), pg 8, sharp, Astro 6 (spawned), Vitest, Docker (DHI bases in CI).

**Spec:** `docs/superpowers/specs/2026-07-03-single-app-container-design.md` — read it first.

## Global Constraints

- Branch: `feature/single-app-container` (exists). Conventional commits `type(scope): desc`. Commits stay local.
- Strict TS: no `any`, no `@ts-ignore` (Golden Rule 6). Uploader tests: `cd uploader && npm test`; typecheck: `npm run typecheck`.
- SEO slug contract untouched (Golden Rule 2): no changes under `site/src/` at all in this plan.
- No secrets, no binaries in git.
- Settings fields (spec): `backupSchedule: 'off' | 'daily' | 'weekly'` default `'off'`; `backupRetention` integer 1–100 default `14`. Backup dir fixed: `/data/backup/db`. Dump file: `db-<YYYYMMDD-HHmmss>.json.gz`, `version: 1`, tables `users` + `posts` (never `sessions`).
- Trailing-slash redirect must be **301** (SEO). `.pmtiles` → `application/octet-stream`, `.pbf` → `application/x-protobuf`, byte ranges required on `/map/`.
- `requireAuth` → 401; `requireAdmin` → 401 unauthenticated / 403 non-admin (see `uploader/src/authn.ts:49-54`).
- All backup/rebuild routes are admin-only.

## File Structure

| File | Responsibility |
| :-- | :-- |
| `uploader/src/build.ts` (new) | `SiteBuilder`: spawn Astro build, atomic release (tmp → cp → symlink flip), prune, in-flight guard |
| `uploader/src/backup.ts` (new) | Dump/restore/list/prune/state + `isBackupDue` + `createDbBackup` |
| `uploader/src/settings.ts` | +2 backup fields with validation |
| `uploader/src/server.ts` | Host-constrained routing, blog/map static, 404/503, header scoping, `/rebuild`, `/health`, `/backups*`; publish calls builder in-process |
| `uploader/src/main.ts` | Wire builder + backup + scheduler + boot build |
| `uploader/src/cli.ts` | + `restore` subcommand |
| `uploader/public/settings.html` | + Backup & Rebuild admin section |
| `Dockerfile` (new, repo root), `.dockerignore` (new) | Single merged image, non-root uid 1000 |
| `docker-compose.yml`, `uploader/docker-compose.yml`, `uploader/.env.example` | 2-service topology |
| `.github/workflows/release.yml` | Single image `simonswanderlust-app` |
| Deleted | `uploader/src/publish.ts`, `uploader/test/publish.test.ts`, `site/build-server.mjs`, `site/test/build-server.test.ts`, `site/nginx.conf`, `site/Dockerfile` |

All uploader commands below run from `uploader/`; repo-level commands from the repo root.

---

### Task 1: Backup settings fields

**Files:**
- Modify: `uploader/src/settings.ts`
- Test: `uploader/test/settings.test.ts` (extend)
- Modify: `uploader/test/server.test.ts:22-25` (fixture only)

**Interfaces:**
- Produces: `type BackupSchedule = 'off' | 'daily' | 'weekly'`; `Settings` gains `backupSchedule: BackupSchedule; backupRetention: number`. Consumed by Tasks 6, 8, 9, 10.

- [ ] **Step 1: Write failing tests** — append to `uploader/test/settings.test.ts` (match its existing style; it builds a full `Settings` object — add the two new fields to any existing fixture object in that file so it still compiles):

```ts
describe('backup settings', () => {
  const base: Settings = {
    lmBaseUrl: 'http://lm:1234/v1', lmModel: 'm', captionTimeoutMs: 60000,
    captionMaxEdge: 768, captionPrompt: 'P', backupSchedule: 'off', backupRetention: 14,
  };

  it('defaults to off / 14', () => {
    const d = defaultsFromEnv({});
    expect(d.backupSchedule).toBe('off');
    expect(d.backupRetention).toBe(14);
  });

  it('accepts daily and weekly', () => {
    expect(validate({ ...base, backupSchedule: 'daily' }).backupSchedule).toBe('daily');
    expect(validate({ ...base, backupSchedule: 'weekly' }).backupSchedule).toBe('weekly');
  });

  it('rejects an unknown schedule', () => {
    expect(() => validate({ ...base, backupSchedule: 'hourly' as BackupSchedule })).toThrow(SettingsError);
  });

  it('rejects retention out of range or non-integer', () => {
    expect(() => validate({ ...base, backupRetention: 0 })).toThrow(SettingsError);
    expect(() => validate({ ...base, backupRetention: 101 })).toThrow(SettingsError);
    expect(() => validate({ ...base, backupRetention: 1.5 })).toThrow(SettingsError);
  });
});
```

Add imports as needed: `import { defaultsFromEnv, validate, SettingsError, type Settings, type BackupSchedule } from '../src/settings.js';`

- [ ] **Step 2: Run to verify failure** — `npm test -- settings` → FAIL (`BackupSchedule` not exported / fields missing).

- [ ] **Step 3: Implement** in `uploader/src/settings.ts`:

```ts
export type BackupSchedule = 'off' | 'daily' | 'weekly';

export interface Settings {
  lmBaseUrl: string;
  lmModel: string;
  captionTimeoutMs: number;
  captionMaxEdge: number;
  captionPrompt: string;
  backupSchedule: BackupSchedule;
  backupRetention: number;
}
```

In `defaultsFromEnv`, add to the returned object: `backupSchedule: 'off', backupRetention: 14,`.
In `validate`, before `return s;`:

```ts
  if (!['off', 'daily', 'weekly'].includes(s.backupSchedule)) {
    throw new SettingsError('Backup schedule must be off, daily, or weekly.');
  }
  if (!Number.isInteger(s.backupRetention) || s.backupRetention < 1 || s.backupRetention > 100) {
    throw new SettingsError('Backup retention must be a whole number between 1 and 100.');
  }
```

Fix the `SETTINGS` fixture in `uploader/test/server.test.ts:22-25`: add `backupSchedule: 'off', backupRetention: 14,`.

- [ ] **Step 4: Verify** — `npm test -- settings` → PASS; `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add uploader/src/settings.ts uploader/test/settings.test.ts uploader/test/server.test.ts && git commit -m "feat(uploader): backup schedule + retention settings"`

---

### Task 2: `SiteBuilder` (port of build-server.mjs)

**Files:**
- Create: `uploader/src/build.ts`
- Test: `uploader/test/build.test.ts` (new)

**Interfaces:**
- Produces (consumed by Tasks 3, 4, 10):

```ts
export interface BuildOutcome { ok: boolean; release?: string; error?: string }
export interface SiteBuilder { build(): Promise<BuildOutcome>; hasRelease(): boolean }
export function createSiteBuilder(opts: {
  siteAppDir: string;    // Astro project dir (has node_modules/astro)
  releasesRoot: string;  // e.g. /data/site → releases/ + current symlink
  keep?: number;         // default 3
  runBuild?: (outDir: string) => Promise<void>;  // DI for tests
}): SiteBuilder
```

- [ ] **Step 1: Write failing tests** — `uploader/test/build.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSiteBuilder } from '../src/build.js';

let root: string;
let siteApp: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'builder-'));
  siteApp = join(root, 'siteapp');
  await mkdir(siteApp, { recursive: true });
});

// Fake astro build: writes a marker file into the requested outDir.
const fakeBuild = (marker: string) => async (outDir: string) => {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), marker);
};

describe('createSiteBuilder', () => {
  it('has no release before the first build', () => {
    const b = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: join(root, 'site'), runBuild: fakeBuild('v1') });
    expect(b.hasRelease()).toBe(false);
  });

  it('builds, flips the current symlink atomically, and serves the new content', async () => {
    const releases = join(root, 'site');
    const b = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('v1') });
    const r1 = await b.build();
    expect(r1.ok).toBe(true);
    expect(b.hasRelease()).toBe(true);
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('v1');

    const b2 = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('v2') });
    await b2.build();
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('v2');
    expect(await readlink(join(releases, 'current'))).toContain('releases/');
  });

  it('prunes to the last 3 releases, never the live one', async () => {
    const releases = join(root, 'site');
    for (let i = 1; i <= 5; i++) {
      const b = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild(`v${i}`) });
      expect((await b.build()).ok).toBe(true);
      // release stamps use Date.now(); space them out so sort order is stable
      await new Promise((r) => setTimeout(r, 5));
    }
    const kept = await readdir(join(releases, 'releases'));
    expect(kept.length).toBe(3);
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('v5');
  });

  it('rejects a concurrent build without queueing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const b = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: join(root, 'site'),
      runBuild: async (outDir) => { await gate; await fakeBuild('v1')(outDir); },
    });
    const first = b.build();
    const second = await b.build();
    expect(second).toEqual({ ok: false, error: 'a build is already running' });
    release();
    expect((await first).ok).toBe(true);
  });

  it('reports failure, keeps the previous release, and cleans the tmp dir', async () => {
    const releases = join(root, 'site');
    const ok = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('v1') });
    await ok.build();
    const bad = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: releases,
      runBuild: async () => { throw new Error('astro build exited 1'); },
    });
    const r = await bad.build();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('astro build exited 1');
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('v1');
    expect(await readdir(join(siteApp, '.build-tmp')).catch(() => [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- build` → FAIL (module not found).

- [ ] **Step 3: Implement** `uploader/src/build.ts` (mechanics ported from `site/build-server.mjs` — keep the EXDEV comment):

```ts
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
```

- [ ] **Step 4: Verify** — `npm test -- build` → PASS (5 tests); `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add uploader/src/build.ts uploader/test/build.test.ts && git commit -m "feat(uploader): in-process site builder with atomic releases"`

---

### Task 3: Publish builds in-process; add `/rebuild` + `/health`; delete the HTTP build client

**Files:**
- Modify: `uploader/src/server.ts` (config + publish route + 2 new routes)
- Delete: `uploader/src/publish.ts`, `uploader/test/publish.test.ts`
- Test: `uploader/test/server.test.ts` (extend + adjust)

**Interfaces:**
- Consumes: `SiteBuilder`, `BuildOutcome` from Task 2.
- Produces: `ServerConfig` drops `builderUrl`, `buildSecret`, `triggerImpl`; gains `builder: SiteBuilder`, `imgHost: string`, `siteDir: string`, `mapDir?: string`, `dbBackup: DbBackup`. To keep this task compilable before Task 6 exists, add the `dbBackup` field **in Task 8**, not here. Routes: `POST /rebuild` (admin) → `BuildOutcome` JSON; `GET /health` → `{ ok: true }`. Tasks 4, 8, 10 build on this config shape.

- [ ] **Step 1: Update the test helper and write failing tests.** In `uploader/test/server.test.ts`, replace the `build()` helper's builder-related config: delete `builderUrl`, `buildSecret`, `triggerImpl` lines and add a stub builder + host/site fields:

```ts
function stubBuilder(outcome: BuildOutcome = { ok: true, release: 'r1' }) {
  const calls: number[] = [];
  return {
    calls,
    builder: {
      build: async () => { calls.push(1); return outcome; },
      hasRelease: () => true,
    } satisfies SiteBuilder,
  };
}
```

and in `build()`: `imgHost: 'img.simonswanderlust.com', siteDir: join(dir, 'site'), builder: (extra.builder as SiteBuilder) ?? stubBuilder().builder,` (import `type { SiteBuilder, BuildOutcome } from '../src/build.js'`). Any existing publish test that passed `triggerImpl` now passes `builder: stubBuilder({...}).builder` instead. Add new tests:

```ts
describe('POST /rebuild and GET /health', () => {
  it('health is public', async () => {
    const res = await build().app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rebuild is admin-only', async () => {
    const b = build();
    expect((await b.app.inject({ method: 'POST', url: '/rebuild' })).statusCode).toBe(401);
    const { cookie } = await authed(b, { isAdmin: false });
    expect((await b.app.inject({ method: 'POST', url: '/rebuild', cookies: cookie })).statusCode).toBe(403);
  });

  it('rebuild triggers the builder and returns its outcome', async () => {
    const s = stubBuilder({ ok: true, release: 'r9' });
    const b = build({ builder: s.builder });
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'POST', url: '/rebuild', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, release: 'r9' });
    expect(s.calls.length).toBe(1);
  });

  it('publish reports a failed build without unpublishing', async () => {
    const s = stubBuilder({ ok: false, error: 'a build is already running' });
    const b = build({ builder: s.builder });
    // reuse the existing helper/fixture this file already has for creating a publishable post pair
    // (same setup as the existing publish tests), then:
    // const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    // expect(res.statusCode).toBe(200);
    // expect(res.json().build).toEqual({ ok: false, error: 'a build is already running' });
  });
});
```

For the last test, copy the exact post-pair fixture already used by this file's existing `publish` describe block (it exists — the route is covered today) and fill in the three commented lines with that fixture's variable names.

- [ ] **Step 2: Run to verify failure** — `npm test -- server` → FAIL (config type errors + 404 on new routes).

- [ ] **Step 3: Implement in `uploader/src/server.ts`:**
  1. Remove `import { triggerBuild, type BuildResult } from './publish.js';` → add `import type { SiteBuilder } from './build.js';`
  2. `ServerConfig`: remove `builderUrl: string; buildSecret: string; triggerImpl?: ...`. Add:

```ts
  imgHost: string;   // Host header that serves image variants (img subdomain)
  siteDir: string;   // release root; the blog is served from `${siteDir}/current`
  mapDir?: string;   // PMTiles/glyph assets; omit to disable /map/
  builder: SiteBuilder;
```

  3. Delete the line `const doBuild = cfg.triggerImpl ?? ((u, s) => triggerBuild(u, s));` (server.ts:308). In the publish route replace `const build = await doBuild(cfg.builderUrl, cfg.buildSecret);` with `const build = await cfg.builder.build();`
  4. Add routes (next to the publish route):

```ts
  app.get('/health', async () => ({ ok: true }));

  // Replaces the old secret-gated POST /build on the builder container.
  app.post('/rebuild', { preHandler: requireAdmin }, async () => cfg.builder.build());
```

  5. `git rm uploader/src/publish.ts uploader/test/publish.test.ts`

- [ ] **Step 4: Verify** — `npm test` (full suite) → PASS; `npm run typecheck` → clean. (`imgHost`/`siteDir` are accepted-but-unused until Task 4 — that is fine for one commit.)

- [ ] **Step 5: Commit** — `git add -A uploader && git commit -m "feat(uploader): in-process publish build, /rebuild and /health; drop HTTP build client"`

---

### Task 4: Host-constrained routing — img subdomain, blog static, 301/404/503, header scoping

**Files:**
- Modify: `uploader/src/server.ts`
- Test: `uploader/test/routing.test.ts` (new), `uploader/test/server.test.ts` (host header on variant tests)

**Interfaces:**
- Consumes: `ServerConfig.imgHost/siteDir/builder` (Task 3).
- Produces: main-domain blog serving semantics all later tasks and docs rely on. No new exports.

- [ ] **Step 1: Write failing tests** — `uploader/test/routing.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer, type ServerConfig } from '../src/server.js';
import { validate, type Settings, type SettingsStore } from '../src/settings.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryPostStore } from '../src/posts.js';
import type { SiteBuilder } from '../src/build.js';

const IMG = 'img.simonswanderlust.com';
const MAIN = 'simonswanderlust.com';

const SETTINGS: Settings = {
  lmBaseUrl: 'http://lm:1234/v1', lmModel: 'm', captionTimeoutMs: 60000,
  captionMaxEdge: 768, captionPrompt: 'P', backupSchedule: 'off', backupRetention: 14,
};
const fakeStore = (): SettingsStore => {
  let cur = { ...SETTINGS };
  return { get: () => ({ ...cur }), update: (p) => { cur = validate({ ...cur, ...p }); return { ...cur }; } };
};

let dir: string;
let siteDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routing-'));
  siteDir = join(dir, 'site');
});

/** Lay down a fake release and point current at it. */
async function release(name: string, files: Record<string, string>) {
  const releaseDir = join(siteDir, 'releases', name);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(releaseDir, rel, '..'), { recursive: true });
    await writeFile(join(releaseDir, rel), content);
  }
  await rm(join(siteDir, 'current'), { force: true });
  await symlink(releaseDir, join(siteDir, 'current'));
}

function build(extra: Partial<ServerConfig> = {}) {
  const hasRelease = () => { try { return require('node:fs').existsSync(join(siteDir, 'current')); } catch { return false; } };
  const builder: SiteBuilder = { build: async () => ({ ok: true, release: 'r' }), hasRelease };
  return buildServer({
    storageDir: join(dir, 'images'), baseUrl: `https://${IMG}`, imgHost: IMG,
    siteDir, mapDir: join(dir, 'map'),
    users: memoryUserStore(), sessions: memorySessionStore(), posts: memoryPostStore(),
    settings: fakeStore(), builder, backupDir: join(dir, 'backup'),
    ...extra,
  });
}

describe('host routing', () => {
  it('serves an image variant on the img host, 404s it on the main host', async () => {
    await mkdir(join(dir, 'images'), { recursive: true });
    await writeFile(join(dir, 'images', 'k-640.webp'), 'img-bytes');
    await release('r1', { 'index.html': '<h1>blog</h1>', '404.html': 'not here' });
    const app = build();
    const onImg = await app.inject({ method: 'GET', url: '/k-640.webp', headers: { host: IMG } });
    expect(onImg.statusCode).toBe(200);
    expect(onImg.headers['cache-control']).toContain('immutable');
    const onMain = await app.inject({ method: 'GET', url: '/k-640.webp', headers: { host: MAIN } });
    expect(onMain.statusCode).toBe(404);
  });

  it('serves the blog homepage at / on the main host (no /admin/ redirect)', async () => {
    await release('r1', { 'index.html': '<h1>blog</h1>', '404.html': 'nf' });
    const res = await build().inject({ method: 'GET', url: '/', headers: { host: MAIN } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('blog');
  });

  it('301-redirects a directory URL missing its trailing slash', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'nf', 'rumaenien/index.html': 'trip' });
    const app = build();
    const r = await app.inject({ method: 'GET', url: '/rumaenien', headers: { host: MAIN } });
    expect(r.statusCode).toBe(301);
    expect(r.headers.location).toBe('/rumaenien/');
    const ok = await app.inject({ method: 'GET', url: '/rumaenien/', headers: { host: MAIN } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('trip');
  });

  it('serves 404.html with status 404 for unknown blog paths', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'custom not found' });
    const res = await build().inject({ method: 'GET', url: '/nope/', headers: { host: MAIN } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('custom not found');
  });

  it('returns 503 with Retry-After before the first release exists', async () => {
    const res = await build().inject({ method: 'GET', url: '/', headers: { host: MAIN } });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
  });

  it('serves new content after the current symlink flips (atomic release)', async () => {
    await release('r1', { 'index.html': 'v1', '404.html': 'nf' });
    const app = build();
    expect((await app.inject({ method: 'GET', url: '/', headers: { host: MAIN } })).body).toBe('v1');
    await release('r2', { 'index.html': 'v2', '404.html': 'nf' });
    expect((await app.inject({ method: 'GET', url: '/', headers: { host: MAIN } })).body).toBe('v2');
  });

  it('scopes admin headers: /health gets X-Frame-Options, blog pages do not', async () => {
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const app = build();
    const admin = await app.inject({ method: 'GET', url: '/health', headers: { host: MAIN } });
    expect(admin.headers['x-frame-options']).toBe('DENY');
    const blog = await app.inject({ method: 'GET', url: '/', headers: { host: MAIN } });
    expect(blog.headers['x-frame-options']).toBeUndefined();
    expect(blog.headers['x-content-type-options']).toBe('nosniff');
  });
});
```

(Replace the `require('node:fs')` line with a top-level `import { existsSync } from 'node:fs';` and `hasRelease: () => existsSync(join(siteDir, 'current'))` — no CJS require in this codebase.)

- [ ] **Step 2: Run to verify failure** — `npm test -- routing` → FAIL (blog 404s everywhere, `/` still redirects, headers global).

- [ ] **Step 3: Implement in `uploader/src/server.ts`:**
  1. **img host constraint** — extend the existing variants mount (server.ts:91-97) with `constraints: { host: cfg.imgHost },`.
  2. **Blog mount** — after the variants mount:

```ts
  // The public blog: static output of the last release. `current` is a symlink
  // flipped atomically by the builder; paths are joined per request, so a flip
  // takes effect immediately without re-registering.
  const currentDir = join(cfg.siteDir, 'current');
  app.register(fastifyStatic, {
    root: currentDir,
    prefix: '/',
    decorateReply: false,
    redirect: true,          // /foo -> 301 /foo/ (trailingSlash: 'always' contract)
    index: 'index.html',
  });
```

  3. **Remove** `app.get('/', (_req, reply) => reply.redirect('/admin/'));` (server.ts:99).
  4. **Header scoping** — replace the global `onSend` hook (server.ts:70-74):

```ts
  // nosniff everywhere; clickjacking/referrer policies only on the admin/API
  // surface (blog pages keep parity with the old nginx: no admin headers).
  const ADMIN_PREFIXES = [
    '/admin', '/login', '/logout', '/auth', '/setup', '/settings', '/users',
    '/posts', '/upload', '/suggest', '/import', '/export', '/backups', '/rebuild', '/health',
  ];
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    const url = req.raw.url ?? '';
    const admin = ADMIN_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`));
    if (admin) {
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Referrer-Policy', 'no-referrer');
    }
  });
```

  5. **Not-found handler** (end of `buildServer`, before `return app;`) — imports: `import { createReadStream, existsSync } from 'node:fs'; import { readFile } from 'node:fs/promises';`

```ts
  // 404/503 for the blog; plain 404 for the img host and non-GET methods.
  app.setNotFoundHandler(async (req, reply) => {
    const host = req.headers.host ?? '';
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(404).send({ error: 'not found' });
    if (host === cfg.imgHost) return reply.code(404).send('Not found');
    if (!cfg.builder.hasRelease()) {
      return reply
        .code(503)
        .header('retry-after', '30')
        .type('text/html')
        .send('<!doctype html><meta charset="utf-8"><title>Building…</title><h1>Site is building</h1><p>The first build is in progress — try again in a moment.</p>');
    }
    try {
      const html = await readFile(join(currentDir, '404.html'), 'utf8');
      return reply.code(404).type('text/html').send(html);
    } catch {
      return reply.code(404).send('Not found');
    }
  });
```

  6. **Fix existing variant tests** in `server.test.ts` — any inject that fetches a stored variant URL (e.g. the "immutable cache header" test at ~line 98) must now pass `headers: { host: 'img.simonswanderlust.com' }` (merge with existing form headers where present).

- [ ] **Step 4: Verify** — `npm test` → all suites PASS; `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add uploader/src/server.ts uploader/test/routing.test.ts uploader/test/server.test.ts && git commit -m "feat(uploader): host-routed blog serving with nginx-parity semantics"`

---

### Task 5: `/map/` PMTiles serving (MIME + byte ranges)

**Files:**
- Modify: `uploader/src/server.ts`
- Test: `uploader/test/routing.test.ts` (extend)

**Interfaces:**
- Consumes: `ServerConfig.mapDir` (Task 3). Produces: `/map/` static behavior; no exports.

- [ ] **Step 1: Write failing tests** — append to `routing.test.ts`:

```ts
describe('/map/ assets', () => {
  it('serves .pmtiles with octet-stream MIME and supports range requests', async () => {
    await mkdir(join(dir, 'map'), { recursive: true });
    await writeFile(join(dir, 'map', 'basemap.pmtiles'), 'PMTILESDATA');
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const app = build();
    const full = await app.inject({ method: 'GET', url: '/map/basemap.pmtiles', headers: { host: MAIN } });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('application/octet-stream');
    expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await app.inject({
      method: 'GET', url: '/map/basemap.pmtiles',
      headers: { host: MAIN, range: 'bytes=0-3' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('PMTI');
  });

  it('serves glyph .pbf with the protobuf MIME type', async () => {
    await mkdir(join(dir, 'map', 'fonts'), { recursive: true });
    await writeFile(join(dir, 'map', 'fonts', '0-255.pbf'), 'PBF');
    await release('r1', { 'index.html': 'home', '404.html': 'nf' });
    const res = await build().inject({ method: 'GET', url: '/map/fonts/0-255.pbf', headers: { host: MAIN } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-protobuf');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- routing` → FAIL (404 on /map/).

- [ ] **Step 3: Implement** — in `buildServer`, after the blog mount:

```ts
  // Self-hosted basemap + glyphs (was nginx's /map/ block). PMTiles needs HTTP
  // range reads; @fastify/send provides them. MIME types are set explicitly —
  // the mime db knows neither .pmtiles nor .pbf.
  if (cfg.mapDir) {
    app.register(fastifyStatic, {
      root: resolve(cfg.mapDir),
      prefix: '/map/',
      decorateReply: false,
      setHeaders: (res, filepath) => {
        if (filepath.endsWith('.pmtiles')) res.setHeader('content-type', 'application/octet-stream');
        else if (filepath.endsWith('.pbf')) res.setHeader('content-type', 'application/x-protobuf');
      },
    });
  }
```

(`resolve` is already imported at server.ts:2.)

- [ ] **Step 4: Verify** — `npm test -- routing` → PASS. If the 206 assertion fails because `setHeaders` runs only on 200s, move the MIME logic into an `onSend` hook checking `req.raw.url?.startsWith('/map/')` — but try `setHeaders` first; `@fastify/send` sets Content-Type only when unset.

- [ ] **Step 5: Commit** — `git add uploader/src/server.ts uploader/test/routing.test.ts && git commit -m "feat(uploader): serve /map/ PMTiles + glyphs with ranges"`

---

### Task 6: Backup core — dump, list, prune, state, due-logic, `createDbBackup`

**Files:**
- Create: `uploader/src/backup.ts`
- Test: `uploader/test/backup.test.ts` (new)

**Interfaces:**
- Consumes: `BackupSchedule` (Task 1), `DbPool` type (`uploader/src/db.ts`).
- Produces (consumed by Tasks 7, 8, 10):

```ts
export const DUMP_VERSION = 1;
export const BACKUP_FILE_RE: RegExp;                     // /^db-\d{8}-\d{6}\.json\.gz$/
export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export interface BackupState { lastAttemptAt?: string; lastSuccessAt?: string; lastError?: string }
export interface BackupFileInfo { name: string; size: number }
export class BackupError extends Error {}
export function dumpDatabase(db: Queryable, dir: string, now?: Date): Promise<string>  // returns filename
export function listBackups(dir: string): BackupFileInfo[]                             // newest first
export function pruneBackups(dir: string, keep: number): string[]                      // deleted names
export function readState(dir: string): BackupState
export function writeState(dir: string, state: BackupState): void
export function isBackupDue(state: BackupState, schedule: BackupSchedule, nowMs: number): boolean
export interface DbBackup { dir: string; runNow(): Promise<BackupState>; list(): BackupFileInfo[]; state(): BackupState }
export function createDbBackup(opts: { db: Queryable; dir: string; retention: () => number }): DbBackup
```

- [ ] **Step 1: Write failing tests** — `uploader/test/backup.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dumpDatabase, listBackups, pruneBackups, readState, writeState, isBackupDue,
  createDbBackup, BACKUP_FILE_RE, DUMP_VERSION, type Queryable,
} from '../src/backup.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'backup-')); });

const fakeDb = (users: Record<string, unknown>[] = [], posts: Record<string, unknown>[] = []): Queryable => ({
  query: async (sql: string) => ({ rows: sql.includes('FROM users') ? users : posts }),
});

describe('dumpDatabase', () => {
  it('writes a versioned gzipped JSON dump named after the timestamp', async () => {
    const now = new Date('2026-07-03T14:30:05Z');
    const name = await dumpDatabase(fakeDb([{ id: 'u1', username: 'simon' }], [{ id: 'p1', slug: 's' }]), dir, now);
    expect(name).toBe('db-20260703-143005.json.gz');
    expect(BACKUP_FILE_RE.test(name)).toBe(true);
    const dump = JSON.parse(gunzipSync(await readFile(join(dir, name))).toString('utf8'));
    expect(dump.version).toBe(DUMP_VERSION);
    expect(dump.tables.users).toEqual([{ id: 'u1', username: 'simon' }]);
    expect(dump.tables.posts).toEqual([{ id: 'p1', slug: 's' }]);
    expect(dump.tables.sessions).toBeUndefined();
  });
});

describe('list + prune + state', () => {
  it('lists newest first, ignoring foreign files, and prunes beyond keep', async () => {
    for (const stamp of ['20260101-000000', '20260102-000000', '20260103-000000']) {
      await writeFile(join(dir, `db-${stamp}.json.gz`), 'x');
    }
    await writeFile(join(dir, 'state.json'), '{}');
    await writeFile(join(dir, 'evil.sh'), 'x');
    expect(listBackups(dir).map((f) => f.name)).toEqual([
      'db-20260103-000000.json.gz', 'db-20260102-000000.json.gz', 'db-20260101-000000.json.gz',
    ]);
    expect(pruneBackups(dir, 2)).toEqual(['db-20260101-000000.json.gz']);
    expect(listBackups(dir).length).toBe(2);
  });

  it('returns empty for a missing dir and round-trips state', () => {
    expect(listBackups(join(dir, 'missing'))).toEqual([]);
    expect(readState(dir)).toEqual({});
    writeState(dir, { lastSuccessAt: 't', lastAttemptAt: 't' });
    expect(readState(dir).lastSuccessAt).toBe('t');
  });
});

describe('isBackupDue', () => {
  const now = Date.parse('2026-07-03T12:00:00Z');
  it('is never due when off', () => {
    expect(isBackupDue({}, 'off', now)).toBe(false);
  });
  it('is due immediately when never succeeded', () => {
    expect(isBackupDue({}, 'daily', now)).toBe(true);
  });
  it('respects the daily and weekly windows', () => {
    const h23 = { lastSuccessAt: new Date(now - 23 * 3600_000).toISOString() };
    const h25 = { lastSuccessAt: new Date(now - 25 * 3600_000).toISOString() };
    expect(isBackupDue(h23, 'daily', now)).toBe(false);
    expect(isBackupDue(h25, 'daily', now)).toBe(true);
    expect(isBackupDue(h25, 'weekly', now)).toBe(false);
    const d8 = { lastSuccessAt: new Date(now - 8 * 24 * 3600_000).toISOString() };
    expect(isBackupDue(d8, 'weekly', now)).toBe(true);
  });
});

describe('createDbBackup.runNow', () => {
  it('dumps, prunes to retention, and records success', async () => {
    const b = createDbBackup({ db: fakeDb(), dir, retention: () => 1 });
    const s1 = await b.runNow();
    expect(s1.lastSuccessAt).toBeTruthy();
    expect(s1.lastError).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1100)); // distinct per-second filename
    await b.runNow();
    expect(b.list().length).toBe(1);
  });

  it('records the error and keeps lastSuccessAt on failure', async () => {
    const bad: Queryable = { query: async () => { throw new Error('db down'); } };
    const b = createDbBackup({ db: bad, dir, retention: () => 5 });
    const s = await b.runNow();
    expect(s.lastError).toBe('db down');
    expect(s.lastAttemptAt).toBeTruthy();
    expect(s.lastSuccessAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- backup` → FAIL (module not found).

- [ ] **Step 3: Implement** `uploader/src/backup.ts`:

```ts
import { gzipSync } from 'node:zlib';
import {
  mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BackupSchedule } from './settings.js';

export const DUMP_VERSION = 1;
export const BACKUP_FILE_RE = /^db-\d{8}-\d{6}\.json\.gz$/;

export class BackupError extends Error {}

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface BackupState { lastAttemptAt?: string; lastSuccessAt?: string; lastError?: string }
export interface BackupFileInfo { name: string; size: number }

function atomicWrite(path: string, data: Buffer | string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Dump users + posts (never sessions — disposable, and token hashes don't
 * belong in backups) as one gzipped, versioned JSON file. Returns the filename. */
export async function dumpDatabase(db: Queryable, dir: string, now: Date = new Date()): Promise<string> {
  const users = (await db.query('SELECT * FROM users ORDER BY created_at')).rows;
  const posts = (await db.query('SELECT * FROM posts ORDER BY created_at')).rows;
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  const name = `db-${stamp}.json.gz`;
  mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ version: DUMP_VERSION, createdAt: iso, tables: { users, posts } });
  atomicWrite(join(dir, name), gzipSync(payload));
  return name;
}

export function listBackups(dir: string): BackupFileInfo[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => BACKUP_FILE_RE.test(n))
    .sort()
    .reverse()
    .map((name) => ({ name, size: statSync(join(dir, name)).size }));
}

export function pruneBackups(dir: string, keep: number): string[] {
  const doomed = listBackups(dir).slice(keep).map((f) => f.name);
  for (const name of doomed) rmSync(join(dir, name), { force: true });
  return doomed;
}

const STATE_FILE = 'state.json';

export function readState(dir: string): BackupState {
  try { return JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as BackupState; } catch { return {}; }
}

export function writeState(dir: string, state: BackupState): void {
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, STATE_FILE), JSON.stringify(state, null, 2));
}

const INTERVALS: Record<Exclude<BackupSchedule, 'off'>, number> = {
  daily: 24 * 3600_000,
  weekly: 7 * 24 * 3600_000,
};

export function isBackupDue(state: BackupState, schedule: BackupSchedule, nowMs: number): boolean {
  if (schedule === 'off') return false;
  if (!state.lastSuccessAt) return true;
  return nowMs - Date.parse(state.lastSuccessAt) >= INTERVALS[schedule];
}

export interface DbBackup {
  dir: string;
  runNow(): Promise<BackupState>;
  list(): BackupFileInfo[];
  state(): BackupState;
}

export function createDbBackup(opts: { db: Queryable; dir: string; retention: () => number }): DbBackup {
  let running = false;
  return {
    dir: opts.dir,
    list: () => listBackups(opts.dir),
    state: () => readState(opts.dir),
    async runNow() {
      if (running) return readState(opts.dir);
      running = true;
      const state = readState(opts.dir);
      state.lastAttemptAt = new Date().toISOString();
      try {
        await dumpDatabase(opts.db, opts.dir);
        pruneBackups(opts.dir, opts.retention());
        state.lastSuccessAt = new Date().toISOString();
        delete state.lastError;
      } catch (e) {
        state.lastError = (e as Error).message;
      } finally {
        writeState(opts.dir, state);
        running = false;
      }
      return { ...state };
    },
  };
}
```

- [ ] **Step 4: Verify** — `npm test -- backup` → PASS; `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add uploader/src/backup.ts uploader/test/backup.test.ts && git commit -m "feat(uploader): db backup core (dump, prune, state, schedule logic)"`

---

### Task 7: Restore (transactional) + CLI command + Postgres round-trip test

**Files:**
- Modify: `uploader/src/backup.ts` (add `restoreDatabase`), `uploader/src/cli.ts`
- Test: `uploader/test/backup.integration.test.ts` (new, gated like `pg.integration.test.ts:7-8`)

**Interfaces:**
- Consumes: `DbPool` (`createPool` from `db.ts`), dump format (Task 6).
- Produces: `restoreDatabase(pool: DbPool, filePath: string): Promise<{ users: number; posts: number }>`; CLI: `npm run cli -- restore <file>` — wait, the script is `upload`; usage is `tsx src/cli.ts restore <file>` (also reachable as `npm run upload -- restore <file>`; document the direct `tsx` form).

- [ ] **Step 1: Write failing integration test** — `uploader/test/backup.integration.test.ts` (mirror the gating of `pg.integration.test.ts`; that file shows the setup/teardown conventions — reuse them):

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgUserStore } from '../src/users.js';
import { pgPostStore } from '../src/posts.js';
import { pgSessionStore } from '../src/sessions.js';
import { dumpDatabase, restoreDatabase } from '../src/backup.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('backup round-trip (Postgres)', () => {
  let pool: DbPool;
  let dir: string;
  beforeAll(async () => {
    pool = createPool(url as string);
    await ensureSchema(pool);
    await pool.query('DELETE FROM posts');
    await pool.query('DELETE FROM users');
    dir = await mkdtemp(join(tmpdir(), 'bk-int-'));
  });
  afterAll(async () => { await pool.end(); });

  it('dump -> wipe -> restore reproduces users and posts and kills sessions', async () => {
    const users = pgUserStore(pool);
    const posts = pgPostStore(pool);
    const sessions = pgSessionStore(pool);
    const u = await users.create({ username: 'simon', password: 'pw', isAdmin: true });
    await sessions.create(u.id, 60_000);
    // Minimal valid draft pair — copy the post fixture shape used in pg.integration.test.ts.
    await posts.upsertDraft({
      translationKey: '', de: {
        slug: 'test-reise', title: 'Test', date: '2026-01-01', country: 'Rumänien', countryCode: 'ro',
        region: 'europe', excerpt: 'x', heroImage: { src: 'https://img.example/x', width: 100, height: 50, alt: 'a' },
        coordinates: { lat: 45, lng: 25 }, bodyMarkdown: 'Hallo', images: {},
      },
    } as never);

    const file = join(dir, await dumpDatabase(pool, dir));
    await pool.query('DELETE FROM posts');
    await pool.query('DELETE FROM users');

    const counts = await restoreDatabase(pool, file);
    expect(counts.users).toBe(1);
    expect(counts.posts).toBe(1);
    const back = await users.findByUsername('simon');
    expect(back?.isAdmin).toBe(true);
    expect((await pool.query('SELECT count(*) AS n FROM sessions')).rows[0].n).toBe('0');
    const list = await posts.list();
    expect(list.length).toBe(1);
  });

  it('rejects an unsupported dump version without touching data', async () => {
    // hand-craft a version-2 dump
    const { gzipSync } = await import('node:zlib');
    const { writeFileSync } = await import('node:fs');
    const bad = join(dir, 'db-20260101-000000.json.gz');
    writeFileSync(bad, gzipSync(JSON.stringify({ version: 2, tables: { users: [], posts: [] } })));
    await expect(restoreDatabase(pool, bad)).rejects.toThrow(/unsupported dump version/);
    expect((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n).toBe('1');
  });
});
```

> The `upsertDraft` fixture above is indicative — **open `uploader/test/pg.integration.test.ts` and reuse its exact post fixture** (field names/types must match `PostPair`); drop the `as never` once the shape is right.

- [ ] **Step 2: Run** — without `TEST_DATABASE_URL` the suite skips (OK for CI); to exercise it: `TEST_DATABASE_URL=postgres://images:<pw>@127.0.0.1:5432/images_test npm test -- backup.integration` → FAIL (`restoreDatabase` missing).

- [ ] **Step 3: Implement `restoreDatabase`** — append to `uploader/src/backup.ts` (new imports: `import { gunzipSync } from 'node:zlib';` — merge with the existing zlib import — and `import type { DbPool } from './db.js';`):

```ts
interface Dump {
  version: number;
  createdAt: string;
  tables: { users: Record<string, unknown>[]; posts: Record<string, unknown>[] };
}

const asJsonb = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/** Restore a dump inside one transaction. Deleting users cascades to sessions
 * (FK ON DELETE CASCADE), so every login is invalidated. */
export async function restoreDatabase(pool: DbPool, filePath: string): Promise<{ users: number; posts: number }> {
  const dump = JSON.parse(gunzipSync(readFileSync(filePath)).toString('utf8')) as Dump;
  if (dump.version !== DUMP_VERSION) throw new BackupError(`unsupported dump version ${dump.version}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM posts');
    await client.query('DELETE FROM users');
    for (const u of dump.tables.users) {
      await client.query(
        'INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES ($1,$2,$3,$4,$5)',
        [u.id, u.username, u.password_hash, u.is_admin, u.created_at],
      );
    }
    for (const p of dump.tables.posts) {
      await client.query(
        `INSERT INTO posts (id, translation_key, locale, slug, title, date, country, country_code, region,
           excerpt, hero_image, coordinates, stops, route, key_facts, body_markdown, images, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15::jsonb,$16,$17::jsonb,$18,$19,$20)`,
        [p.id, p.translation_key, p.locale, p.slug, p.title, p.date, p.country, p.country_code, p.region,
         p.excerpt, asJsonb(p.hero_image), asJsonb(p.coordinates), asJsonb(p.stops), p.route,
         asJsonb(p.key_facts), p.body_markdown, asJsonb(p.images), p.status, p.created_at, p.updated_at],
      );
    }
    await client.query('COMMIT');
    return { users: dump.tables.users.length, posts: dump.tables.posts.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Add the CLI command** — in `uploader/src/cli.ts`, replace `main()`:

```ts
async function restoreMain(file: string | undefined): Promise<void> {
  if (!file) {
    console.error('usage: tsx src/cli.ts restore <db-YYYYMMDD-HHmmss.json.gz>');
    process.exit(1);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required for restore.');
    process.exit(1);
  }
  const { createPool } = await import('./db.js');
  const { restoreDatabase } = await import('./backup.js');
  const pool = createPool(databaseUrl);
  try {
    const counts = await restoreDatabase(pool, file);
    console.log(`restored ${counts.users} users and ${counts.posts} posts (all sessions invalidated).`);
    console.log('now rebuild the site: /admin/settings.html → "Rebuild site now" (or POST /rebuild).');
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'restore') return restoreMain(process.argv[3]);
  const [, , file, key, alt = ''] = process.argv;
  if (!file || !key) {
    console.error('usage: npm run upload -- <imageFile> <key> [alt]   |   tsx src/cli.ts restore <file>');
    process.exit(1);
  }
  const opts: StorageOptions = {
    storageDir: process.env.STORAGE_DIR ?? './data/images',
    baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com',
  };
  const stored = await uploadFile(await readFile(file), key, alt, opts);
  console.log(stored.snippet);
}
```

- [ ] **Step 5: Verify** — `npm test` → PASS (integration suite runs only with `TEST_DATABASE_URL`; run it against a local scratch DB if one is available — do NOT point it at the real `images` database, it deletes rows); `npm run typecheck` → clean.

- [ ] **Step 6: Commit** — `git add uploader/src/backup.ts uploader/src/cli.ts uploader/test/backup.integration.test.ts && git commit -m "feat(uploader): transactional restore + cli restore command"`

---

### Task 8: Backup admin routes

**Files:**
- Modify: `uploader/src/server.ts`
- Test: `uploader/test/server.test.ts` (extend)

**Interfaces:**
- Consumes: `DbBackup`, `BACKUP_FILE_RE` (Task 6).
- Produces: `ServerConfig` gains `dbBackup: DbBackup`. Routes (all admin-only): `GET /backups` → `{ state: BackupState, files: BackupFileInfo[] }`; `POST /backups` → `BackupState`; `GET /backups/:name` → gzip download. Task 9's UI and Task 10's wiring depend on these exact shapes.

- [ ] **Step 1: Write failing tests** — append to `server.test.ts` (extend the `build()` helper first: add `dbBackup: (extra.dbBackup as DbBackup) ?? stubBackup().backup,` with):

```ts
import type { BackupState, DbBackup } from '../src/backup.js';

function stubBackup(dir = '/tmp/none') {
  let state: BackupState = {};
  const backup: DbBackup = {
    dir,
    runNow: async () => { state = { lastAttemptAt: 'a', lastSuccessAt: 's' }; return { ...state }; },
    list: () => [{ name: 'db-20260703-120000.json.gz', size: 3 }],
    state: () => ({ ...state }),
  };
  return { backup };
}

describe('backup routes', () => {
  it('are admin-only', async () => {
    const b = build();
    const { cookie } = await authed(b, { isAdmin: false });
    for (const [method, url] of [['GET', '/backups'], ['POST', '/backups'], ['GET', '/backups/db-20260703-120000.json.gz']] as const) {
      expect((await b.app.inject({ method, url })).statusCode).toBe(401);
      expect((await b.app.inject({ method, url, cookies: cookie })).statusCode).toBe(403);
    }
  });

  it('lists state + files and runs a backup on demand', async () => {
    const b = build({ dbBackup: stubBackup().backup });
    const { cookie } = await authed(b);
    const run = await b.app.inject({ method: 'POST', url: '/backups', cookies: cookie });
    expect(run.statusCode).toBe(200);
    expect(run.json().lastSuccessAt).toBe('s');
    const list = await b.app.inject({ method: 'GET', url: '/backups', cookies: cookie });
    expect(list.json().files[0].name).toBe('db-20260703-120000.json.gz');
  });

  it('downloads only well-formed backup filenames from the backup dir', async () => {
    const backupDir = join(dir, 'dbbackups');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'db-20260703-120000.json.gz'), 'gzbytes');
    const b = build({ dbBackup: { ...stubBackup(backupDir).backup, dir: backupDir } });
    const { cookie } = await authed(b);
    const ok = await b.app.inject({ method: 'GET', url: '/backups/db-20260703-120000.json.gz', cookies: cookie });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('application/gzip');
    expect(ok.headers['content-disposition']).toContain('attachment');
    for (const evil of ['..%2Fsettings.json', 'state.json', 'db-1.json.gz']) {
      const res = await b.app.inject({ method: 'GET', url: `/backups/${evil}`, cookies: cookie });
      expect([400, 404]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(200);
    }
    const missing = await b.app.inject({ method: 'GET', url: '/backups/db-20990101-000000.json.gz', cookies: cookie });
    expect(missing.statusCode).toBe(404);
  });
});
```

(Add `mkdir`, `writeFile` to the fs imports of `server.test.ts` if absent.)

- [ ] **Step 2: Run to verify failure** — `npm test -- server` → FAIL (missing config field / 404s).

- [ ] **Step 3: Implement** — in `server.ts`: add `dbBackup: DbBackup;` to `ServerConfig` (`import { BACKUP_FILE_RE, type DbBackup } from './backup.js';`), then routes next to `/rebuild`:

```ts
  app.get('/backups', { preHandler: requireAdmin }, async () => ({
    state: cfg.dbBackup.state(),
    files: cfg.dbBackup.list(),
  }));

  app.post('/backups', { preHandler: requireAdmin }, async () => cfg.dbBackup.runNow());

  // Filename is validated against the strict backup pattern — nothing else in
  // the directory (state.json!) and no traversal can be fetched.
  app.get('/backups/:name', { preHandler: requireAdmin }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!BACKUP_FILE_RE.test(name)) return reply.code(400).send({ error: 'invalid backup filename' });
    const file = join(cfg.dbBackup.dir, name);
    if (!existsSync(file)) return reply.code(404).send({ error: 'backup not found' });
    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return reply.send(createReadStream(file));
  });
```

- [ ] **Step 4: Verify** — `npm test` → PASS; `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add uploader/src/server.ts uploader/test/server.test.ts && git commit -m "feat(uploader): admin backup routes (list, run, download)"`

---

### Task 9: Settings page UI — backup section + rebuild button

**Files:**
- Modify: `uploader/public/settings.html`

**Interfaces:**
- Consumes: `GET/POST /settings` (now includes `backupSchedule`/`backupRetention`), `GET/POST /backups`, `GET /backups/:name`, `POST /rebuild` (Tasks 1, 3, 8). `Auth.ensureAuthed()` returns `{ isAdmin: boolean, ... }`.

- [ ] **Step 1: Extend the server passthrough** — in `server.ts` `POST /settings` (lines ~186-192 pattern), add:

```ts
    if (b.backupSchedule !== undefined) partial.backupSchedule = String(b.backupSchedule);
    if (b.backupRetention !== undefined) partial.backupRetention = Number(b.backupRetention);
```

- [ ] **Step 2: Add the UI** — in `settings.html`, after the existing LLM `<section class="card">`, insert:

```html
      <section class="card" id="backupCard" hidden>
        <h2>Site &amp; database</h2>

        <label for="backupSchedule">Database backup schedule</label>
        <select id="backupSchedule">
          <option value="off">Off</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>

        <label for="backupRetention">Backups to keep</label>
        <input id="backupRetention" type="number" min="1" max="100" />

        <button id="backupNow">Back up now</button>
        <button id="rebuild">Rebuild site now</button>

        <p class="section-label">Last backup</p>
        <pre id="backupStatus">—</pre>
        <p class="section-label">Backup files</p>
        <ul id="backupFiles"></ul>
      </section>
```

and extend the inline script: in `fill(s)` add

```js
        $('backupSchedule').value = s.backupSchedule || 'off';
        $('backupRetention').value = s.backupRetention ?? 14;
```

in the save payload add

```js
          backupSchedule: $('backupSchedule').value,
          backupRetention: Number($('backupRetention').value),
```

and add below the existing handlers:

```js
      function renderBackups(data) {
        const st = data.state || {};
        $('backupStatus').textContent = st.lastError
          ? 'FAILED at ' + st.lastAttemptAt + ': ' + st.lastError
          : st.lastSuccessAt ? 'OK at ' + st.lastSuccessAt : 'No backup yet.';
        const ul = $('backupFiles');
        ul.innerHTML = '';
        for (const f of data.files || []) {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = '/backups/' + encodeURIComponent(f.name);
          a.textContent = f.name + ' (' + Math.round(f.size / 1024) + ' kB)';
          li.appendChild(a);
          ul.appendChild(li);
        }
      }

      async function loadBackups() {
        const res = await fetch('/backups');
        if (res.ok) renderBackups(await res.json());
      }

      $('backupNow').addEventListener('click', async () => {
        $('backupStatus').textContent = 'Backing up…';
        const res = await fetch('/backups', { method: 'POST' });
        if (!res.ok) { $('backupStatus').textContent = 'Backup failed: HTTP ' + res.status; return; }
        await loadBackups();
      });

      $('rebuild').addEventListener('click', async () => {
        $('out').textContent = 'Rebuilding the site — this takes a minute…';
        const res = await fetch('/rebuild', { method: 'POST' });
        const r = await res.json().catch(() => ({}));
        $('out').textContent = r.ok ? 'Rebuilt: release ' + r.release : 'Rebuild failed: ' + (r.error || res.status);
      });
```

and in the boot IIFE, after `Auth.renderHeader(s);`:

```js
        if (s.isAdmin) { $('backupCard').hidden = false; await loadBackups(); }
```

- [ ] **Step 3: Manual verification** — `cd uploader && DATABASE_URL=<local> npm run dev`, open `http://localhost:3000/admin/settings.html`, log in as admin: backup card visible, schedule/retention save + survive reload, "Back up now" creates a file under `uploader/data/backup/db/` and lists it, the link downloads, "Rebuild site now" reports an error (no site app dir locally — expected) rather than crashing. As a non-admin the card stays hidden.

- [ ] **Step 4: Commit** — `git add uploader/public/settings.html uploader/src/server.ts && git commit -m "feat(admin): backup + rebuild controls on the settings page"`

---

### Task 10: Wire it all in `main.ts`

**Files:**
- Modify: `uploader/src/main.ts`

**Interfaces:**
- Consumes: `createSiteBuilder` (Task 2), `createDbBackup`/`isBackupDue` (Task 6), new `ServerConfig` fields (Tasks 3, 4, 8).
- Produces: env contract used by Docker (Tasks 12–13): `SITE_APP_DIR` (default `/app/site`), `SITE_DIR` (default `/data/site`), `MAP_DIR` (default `/map-assets`), `IMG_HOST` (default: hostname of `PUBLIC_BASE_URL`). `BUILDER_URL`/`BUILD_SECRET` no longer read.

- [ ] **Step 1: Rewrite `uploader/src/main.ts`:**

```ts
import { dirname, join } from 'node:path';
import { buildServer } from './server.js';
import { createSettingsStore, defaultsFromEnv } from './settings.js';
import { createPool, ensureSchema } from './db.js';
import { pgUserStore } from './users.js';
import { pgSessionStore } from './sessions.js';
import { pgPostStore } from './posts.js';
import { createSiteBuilder } from './build.js';
import { createDbBackup, isBackupDue } from './backup.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required; refusing to start without it.');
  process.exit(1);
}

const storageDir = process.env.STORAGE_DIR ?? '/data/images';
const settingsPath = process.env.SETTINGS_PATH ?? join(dirname(storageDir), 'settings.json');
const settings = createSettingsStore({ path: settingsPath, defaults: defaultsFromEnv(process.env) });

const pool = createPool(databaseUrl);
await ensureSchema(pool);
const users = pgUserStore(pool);
const sessions = pgSessionStore(pool);
const posts = pgPostStore(pool);

const baseUrl = process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com';
const builder = createSiteBuilder({
  siteAppDir: process.env.SITE_APP_DIR ?? '/app/site',
  releasesRoot: process.env.SITE_DIR ?? '/data/site',
});
const backupDir = process.env.BACKUP_DIR ?? '/data/backup';
const dbBackup = createDbBackup({
  db: pool,
  dir: join(backupDir, 'db'),
  retention: () => settings.get().backupRetention,
});

// Hourly housekeeping: sweep expired sessions and run a due scheduled backup.
const housekeeping = () => {
  void sessions.sweepExpired().catch(() => {});
  if (isBackupDue(dbBackup.state(), settings.get().backupSchedule, Date.now())) {
    void dbBackup.runNow();
  }
};
setInterval(housekeeping, 3_600_000).unref();

const app = buildServer({
  storageDir,
  baseUrl,
  imgHost: process.env.IMG_HOST ?? new URL(baseUrl).host,
  siteDir: process.env.SITE_DIR ?? '/data/site',
  mapDir: process.env.MAP_DIR ?? '/map-assets',
  users,
  sessions,
  settings,
  posts,
  builder,
  dbBackup,
  backupDir,
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    console.log(`app listening on :${port}`);
    // First boot on a fresh volume: populate the site in the background
    // (blog routes 503 until the release lands). Restarts skip this.
    if (!builder.hasRelease()) {
      void builder.build().then((r) =>
        console.log(r.ok ? `initial build released ${r.release}` : `initial build failed: ${r.error}`));
    }
    housekeeping();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
```

Note: `pool` (a `pg.Pool`) satisfies `Queryable` structurally — pass it directly.

- [ ] **Step 2: Verify** — `npm run typecheck` → clean; `npm test` → PASS; boot smoke: `DATABASE_URL=<local> SITE_DIR=./data/site SITE_APP_DIR=../site npm run start` → logs `app listening on :3000`, then either an initial build (with `../site` present + reachable DB) or `initial build failed: ...` without crashing. Ctrl-C.

- [ ] **Step 3: Commit** — `git add uploader/src/main.ts && git commit -m "feat(uploader): wire builder, backup scheduler and host routing config"`

---

### Task 11: Delete the retired components

**Files:**
- Delete: `site/build-server.mjs`, `site/test/build-server.test.ts`, `site/nginx.conf`, `site/Dockerfile`

- [ ] **Step 1:** `git rm site/build-server.mjs site/test/build-server.test.ts site/nginx.conf site/Dockerfile`
- [ ] **Step 2: Check for stragglers** — `grep -rn "build-server\|nginx.conf" site/ --include="*.mjs" --include="*.ts" --include="*.json" | grep -v node_modules` → no hits. `cd site && npm test` → PASS (build-server suite gone, everything else green).
- [ ] **Step 3: Commit** — `git commit -m "chore: remove nginx config and standalone build server"`

---

### Task 12: Root Dockerfile + .dockerignore

**Files:**
- Create: `Dockerfile` (repo root), `.dockerignore` (repo root)

**Interfaces:**
- Consumes: env contract from Task 10. Produces: image `simonswanderlust-app` used by Tasks 13–14. Runtime user **1000, non-root**; no npm/shell needed at runtime.

- [ ] **Step 1: Create `.dockerignore`:**

```
.git
**/node_modules
**/dist
**/.astro
**/.build-tmp
uploader/data
map-assets
docs
*.md
```

- [ ] **Step 2: Create `Dockerfile`:**

```dockerfile
# syntax=docker/dockerfile:1

# Single app image: Fastify CMS + image service + static blog serving + the
# Astro toolchain for runtime rebuilds (spawned via plain node — no npx/shell,
# so the runtime stays the minimal non-root DHI variant).
#
# CI overrides the bases with Docker Hardened Images:
#   --build-arg NODE_BUILD=dhi.io/node:22-dev     (npm for the installs)
#   --build-arg NODE_RUNTIME=dhi.io/node:22       (minimal, non-root uid 1000)
# @ai-warning: NODE_BUILD and NODE_RUNTIME must share an OS/libc family —
# sharp's and Astro's native binaries are installed in build stages and copied
# into the runtime.
ARG NODE_BUILD=node:22-slim
ARG NODE_RUNTIME=node:22-slim

# --- uploader deps + vendored admin assets ---
FROM ${NODE_BUILD} AS uploader-build
WORKDIR /app/uploader
COPY uploader/package.json uploader/package-lock.json ./
RUN npm ci --omit=dev
COPY uploader/ .
RUN node scripts/copy-fonts.mjs && node scripts/copy-easymde.mjs

# --- site deps (full install: Astro build needs devDependencies at runtime) ---
FROM ${NODE_BUILD} AS site-build
WORKDIR /app/site
COPY site/package.json site/package-lock.json ./
RUN npm ci
COPY site/ .

# --- runtime: both trees, non-root, no build tooling ---
FROM ${NODE_RUNTIME}
ENV NODE_ENV=production \
    STORAGE_DIR=/data/images \
    SITE_APP_DIR=/app/site \
    SITE_DIR=/data/site \
    MAP_DIR=/map-assets \
    PORT=3000
# uid 1000 = the DHI default user / `node` in node:22-slim. The site tree must
# be writable: astro writes .build-tmp/ and .astro/ during runtime builds.
COPY --from=uploader-build --chown=1000:1000 /app/uploader /app/uploader
COPY --from=site-build --chown=1000:1000 /app/site /app/site
WORKDIR /app/uploader
VOLUME ["/data"]
EXPOSE 3000
USER 1000
CMD ["node", "--import", "tsx", "src/main.ts"]
```

- [ ] **Step 3: Verify locally** — from the repo root: `docker build -t sw-app-test .` → succeeds. `docker run --rm sw-app-test node -e "console.log(process.getuid())"` → `1000`.
- [ ] **Step 4: Commit** — `git add Dockerfile .dockerignore && git commit -m "feat(docker): single app image, non-root runtime"`

---

### Task 13: Compose files + .env.example

**Files:**
- Modify: `docker-compose.yml` (root), `uploader/docker-compose.yml`, `uploader/.env.example`

- [ ] **Step 1: Replace the root `docker-compose.yml`:**

```yaml
# Self-hosted stack, WordPress-style: one app container + Postgres.
# Copy uploader/.env.example to .env (set POSTGRES_PASSWORD). On the server:
#   docker compose pull && docker compose up -d     # run the released GHCR image
# For local development, build from source instead:
#   docker compose up -d --build
# Pin the published image version with IMAGE_TAG in .env (default below).
services:
  app:
    image: ghcr.io/laboef1900/simonswanderlust-app:${IMAGE_TAG:-0.4.0}
    build: .
    ports:
      - "3000:3000"
    environment:
      PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-https://img.simonswanderlust.com}
      DATABASE_URL: ${DATABASE_URL:-postgres://${POSTGRES_USER:-images}:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@db:5432/${POSTGRES_DB:-images}}
      LMSTUDIO_BASE_URL: ${LMSTUDIO_BASE_URL:-http://localhost:1234/v1}
      LMSTUDIO_MODEL: ${LMSTUDIO_MODEL:-qwen/qwen3-vl-4b}
      IMG_HOST: ${IMG_HOST:-img.simonswanderlust.com}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./uploader/data:/data
      - ${MAP_ASSETS_DIR:-./map-assets}:/map-assets:ro
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      # exec form: the hardened runtime has no shell
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 30s
    restart: unless-stopped

  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-images}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: ${POSTGRES_DB:-images}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-images} -d ${POSTGRES_DB:-images}"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

volumes:
  pgdata:
```

- [ ] **Step 2: `uploader/docker-compose.yml`** — this standalone file duplicates the old 4-service stack; replace its entire contents with a one-line pointer comment plus nothing else, or delete it and update any README reference. Do the simplest consistent thing: `git rm uploader/docker-compose.yml` and fix references (`grep -rn "uploader/docker-compose" README.md uploader/README.md docs/` → update hits to point at the root compose).
- [ ] **Step 3: `uploader/.env.example`** — remove the `BUILD_SECRET`, `BUILDER_URL`, and `NGINX_TAG` entries (and their comments); add:

```
# Host header that serves image variants (hostname of PUBLIC_BASE_URL).
# For local dev where variants load from localhost, set IMG_HOST=localhost:3000.
IMG_HOST=img.simonswanderlust.com
# Host dir with the PMTiles basemap + glyphs, mounted read-only at /map-assets.
MAP_ASSETS_DIR=./map-assets
```

and bump `IMAGE_TAG=0.4.0`.

- [ ] **Step 4: Smoke test** — from the repo root with a `.env` containing at least `POSTGRES_PASSWORD`: `docker compose up -d --build`, then:
  - `curl -fsS http://localhost:3000/health` → `{"ok":true}`
  - `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/` → `503` at first, `200` after the initial build finishes (`docker compose logs -f app` shows `initial build released ...`; needs the DB reachable and content present — on a fresh dev DB with zero posts the build still succeeds with empty collections)
  - `curl -s -H 'Host: img.simonswanderlust.com' -o /dev/null -w '%{http_code}' http://localhost:3000/` → `404`
  - `docker compose down`
- [ ] **Step 5: Commit** — `git add docker-compose.yml uploader/.env.example && git rm uploader/docker-compose.yml && git commit -m "feat(compose): two-service topology (app + db)"` (adjust the `git rm` if Step 2 already staged it).

---

### Task 14: Release workflow — single image

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1:** Remove the matrix: delete the `strategy:` block and both matrix entries; rename the job title to `build & push app`. Set:
  - metadata `images: ghcr.io/${{ github.repository_owner }}/simonswanderlust-app`
  - build-push `context: .` and `build-args:` exactly `NODE_BUILD=dhi.io/node:22-dev` and `NODE_RUNTIME=dhi.io/node:22` (multi-line string as today)
  - update the header comment ("Build and publish the app image…"). Everything else (GHCR + dhi.io logins, tags, platforms, the release job) stays.
- [ ] **Step 2: Verify** — `docker run --rm -v "$PWD":/repo rhysd/actionlint:latest -color /repo/.github/workflows/release.yml` (or `actionlint` if installed locally; if neither is available, `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))"`) → no errors.
- [ ] **Step 3: Commit** — `git add .github/workflows/release.yml && git commit -m "ci(release): build single simonswanderlust-app image"`

---

### Task 15: Documentation

**Files:**
- Modify: `ARCHITECTURE.md`, `SECURITY.md`, `README.md`, `CLAUDE.md`, `uploader/README.md`

- [ ] **Step 1: `ARCHITECTURE.md`** — rewrite to the 2-service topology, per the spec:
  - Components table → two rows (`app`, `db`); update the ASCII diagram (browser → app; app → Postgres; app spawns `astro build` → `/data/site/releases` → serves `current`).
  - Content pipeline step 3–5: publish awaits the in-process build; release dir now `/data/site`.
  - Packaging: one image, bases `dhi.io/node:22-dev` (build) / `dhi.io/node:22` (runtime, **non-root 1000** — Astro is spawned via plain node, which is why no `-dev` runtime is needed anymore); libc warning stays.
  - Configuration table: drop `BUILD_SECRET`/`BUILDER_URL`/`RELEASES_DIR`/`BUILD_PORT`/`NGINX_TAG`/`BLOG_PORT`; add `SITE_APP_DIR`/`SITE_DIR`/`MAP_DIR`/`IMG_HOST`.
  - Trust boundaries: replace the builder/nginx rows with the accepted-deltas wording from the spec's "Security posture" section (app can write the web root; public availability coupled to app+db; mitigations listed). Add the DB backup subsection (schedule/retention/dir `/data/backup/db`, restore CLI).
- [ ] **Step 2: `SECURITY.md`** — update: remove `BUILD_SECRET`/builder paragraphs; add "Single app container" paragraph with the same accepted deltas + preserved controls; note backup downloads are admin-only and filename-validated, dumps contain scrypt password hashes (treat backup files as sensitive), sessions are never dumped.
- [ ] **Step 3: `README.md` + `uploader/README.md`** — server setup: both domains → port 3000, `chown -R 1000` guidance now also covers `/data/site`; remove nginx/builder sections and the `docker login dhi.io` note for the nginx pull (the app image is pulled from GHCR; dhi.io login is CI-only now).
- [ ] **Step 4: `CLAUDE.md`** — Project Overview: describe the single-app topology (uploader serves the blog + builds in-process); Repository Structure: drop `build-server.mjs`/`nginx.conf` entries, add `uploader/src/build.ts`, `backup.ts`, root `Dockerfile`; Status: add "Done: single-app-container merge + DB backup".
- [ ] **Step 5: Sanity grep** — `grep -rn "blog-builder\|BUILD_SECRET\|BUILDER_URL\|nginx" README.md CLAUDE.md ARCHITECTURE.md SECURITY.md uploader/README.md uploader/.env.example` → only historical/spec references remain (specs/plans dirs are fine).
- [ ] **Step 6: Commit** — `git add ARCHITECTURE.md SECURITY.md README.md CLAUDE.md uploader/README.md && git commit -m "docs: single app container topology + backup feature"`

---

### Task 16: Full verification sweep

- [ ] **Step 1: Uploader** — `cd uploader && npm test && npm run typecheck` → all green.
- [ ] **Step 2: Site** — `cd site && npm test` → green; `DATABASE_URL=<reachable> npx astro check` → no errors (site code untouched; this guards against accidental drift).
- [ ] **Step 3: Stack smoke** (repeat Task 13 Step 4, plus): log into `/admin/`, publish an existing draft or hit "Rebuild site now" → release flips (`docker compose exec app node -e "console.log(require('node:fs').readlinkSync('/data/site/current'))"` shows a new stamp); "Back up now" → file appears under `uploader/data/backup/db/` on the host; download link works.
- [ ] **Step 4: Restore drill (scratch DB only)** — with a copied backup file and a scratch `DATABASE_URL`: `cd uploader && DATABASE_URL=<scratch> npx tsx src/cli.ts restore <file>` → prints restored counts.
- [ ] **Step 5:** Commit any fixes as `fix(scope): ...`; then hand the branch to review (superpowers:requesting-code-review / finishing-a-development-branch).

---

## Plan Self-Review (done at authoring time)

- **Spec coverage:** topology (T12–13), routing incl. 301/404/503/map/headers (T4–5), in-process build + rebuild + health (T2–3), backup settings/core/restore/routes/UI/scheduler (T1, 6–9, 10), deletions (T3, 11, 13), CI (T14), docs (T15), migration smoke (T13, 16). Spec's "boot build in background" → T10.
- **Type consistency:** `SiteBuilder`/`BuildOutcome` (T2) consumed in T3/T4/T10; `DbBackup`/`BackupState`/`BACKUP_FILE_RE` (T6) consumed in T7/T8/T10; `BackupSchedule` (T1) consumed in T6. Route shapes in T8 match the UI in T9.
- **Known judgment calls for the implementer:** (1) If `setHeaders` doesn't fire for 206 responses in T5, fall back to the documented `onSend` variant. (2) T7's post fixture must be copied from `pg.integration.test.ts` verbatim. (3) `uploader/docker-compose.yml` removal (T13) — if the user prefers keeping a standalone file, mirror the root compose instead.
