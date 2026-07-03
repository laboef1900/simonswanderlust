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
