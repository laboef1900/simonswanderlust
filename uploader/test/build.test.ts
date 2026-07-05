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

// Manual gate for holding a fake build in-flight until the test opens it.
const makeGate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
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

  it('coalesces a build requested mid-flight and runs it after the first finishes', async () => {
    const releases = join(root, 'site');
    const events: string[] = [];
    let calls = 0;
    const gate = makeGate();
    const b = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: releases,
      runBuild: async (outDir) => {
        const n = ++calls;
        events.push(`start${n}`);
        if (n === 1) await gate.promise;
        await fakeBuild(`v${n}`)(outDir);
        events.push(`end${n}`);
      },
    });
    const first = b.build();
    const second = b.build();
    gate.open();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.release).not.toBe(r1.release);
    expect(calls).toBe(2);
    // builds never overlap: the queued run starts only after the first ends
    expect(events).toEqual(['start1', 'end1', 'start2', 'end2']);
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('v2');
    // state is fully reset afterwards: a fresh build() starts a new run
    expect((await b.build()).ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('multiple callers during one in-flight build share a single queued run', async () => {
    let calls = 0;
    const gate = makeGate();
    const b = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: join(root, 'site'),
      runBuild: async (outDir) => { const n = ++calls; if (n === 1) await gate.promise; await fakeBuild(`v${n}`)(outDir); },
    });
    const first = b.build();
    const second = b.build();
    const third = b.build();
    gate.open();
    const [r1, r2, r3] = await Promise.all([first, second, third]);
    expect(calls).toBe(2);
    expect(r2).toBe(r3); // identical queued outcome, not two extra builds
    expect(r2.ok).toBe(true);
    expect(r2.release).not.toBe(r1.release);
  });

  it('a caller arriving during the queued run queues a fresh follow-up run', async () => {
    let calls = 0;
    const gate1 = makeGate();
    const gate2 = makeGate();
    const run2Started = makeGate();
    const b = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: join(root, 'site'),
      runBuild: async (outDir) => {
        const n = ++calls;
        if (n === 1) await gate1.promise;
        if (n === 2) { run2Started.open(); await gate2.promise; }
        await fakeBuild(`v${n}`)(outDir);
      },
    });
    const first = b.build();
    const second = b.build(); // queued behind run 1
    gate1.open();
    await run2Started.promise; // run 2 (the queued one) is now executing
    const third = b.build(); // must queue a NEW run 3 whose SELECT happens-after this call
    gate2.open();
    const [r1, r2, r3] = await Promise.all([first, second, third]);
    expect(calls).toBe(3);
    expect(new Set([r1.release, r2.release, r3.release]).size).toBe(3);
    expect(r3.ok).toBe(true);
  });

  it('runs the queued build even when the in-flight build fails', async () => {
    const releases = join(root, 'site');
    let calls = 0;
    const gate = makeGate();
    const b = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: releases,
      runBuild: async (outDir) => {
        if (++calls === 1) { await gate.promise; throw new Error('astro build exited 1'); }
        await fakeBuild('v2')(outDir);
      },
    });
    const first = b.build();
    const second = b.build();
    gate.open();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('astro build exited 1');
    expect(r2).toEqual({ ok: true, release: r2.release });
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('v2');
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
