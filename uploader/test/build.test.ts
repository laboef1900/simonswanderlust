import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, readlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BuildChildError, BuildUnavailableError, BuildTimeoutError, STDERR_TAIL_BYTES, bootstrapRelease, createSiteBuilder, runChildBuild,
  type BuildOutcome, type SiteBuilder,
} from '../src/build.js';
import type * as FileSystem from 'node:fs/promises';
import { buildFailureMessage, projectBuildReport } from '../src/build-state.js';
import { StorageReadOnlyError } from '../src/storage-owner.js';
import { writeReleaseManifest } from '../../site/src/lib/publication-manifest.js';
import { createReleaseManifestReader } from '../src/release-manifest.js';

// Inject faults at the real filesystem boundaries, without relying on uid or
// permission semantics. All successful copies, promotions and removals stay real.
const pruneFaults = vi.hoisted(() => ({
  promoted: false,
  beforePromotion: undefined as (() => Promise<void> | void) | undefined,
  afterPromotion: undefined as (() => Promise<void> | void) | undefined,
  enumerate: undefined as (() => void) | undefined,
  current: undefined as (() => string | void) | undefined,
  remove: undefined as ((path: string) => Promise<void> | void) | undefined,
  recordWrite: undefined as (() => void) | undefined,
  manifestRemove: undefined as ((path: string) => Promise<void> | void) | undefined,
  manifestMkdir: undefined as (() => void) | undefined,
  manifestSourceRemove: undefined as ((path: string) => Promise<void> | void) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FileSystem>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (to.endsWith('/build-state.json')) pruneFaults.recordWrite?.();
      const promoting = to.endsWith('/current');
      if (promoting) await pruneFaults.beforePromotion?.();
      await fs.rename(from, to);
      if (promoting) {
        pruneFaults.promoted = true;
        await pruneFaults.afterPromotion?.();
      }
    },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      if (String(args[0]).endsWith('/manifests')) pruneFaults.manifestMkdir?.();
      return fs.mkdir(...args);
    },
    readdir: async (path: string) => {
      if (pruneFaults.promoted) pruneFaults.enumerate?.();
      return fs.readdir(path);
    },
    readlink: async (path: string) => {
      const replacement = pruneFaults.promoted ? pruneFaults.current?.() : undefined;
      return replacement ?? fs.readlink(path);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (/\.manifest\.json(?:\.partial)?$/.test(String(args[0]))) await pruneFaults.manifestSourceRemove?.(String(args[0]));
      if (pruneFaults.promoted) {
        if (String(args[0]).includes('/manifests/')) await pruneFaults.manifestRemove?.(String(args[0]));
        else await pruneFaults.remove?.(String(args[0]));
      }
      return fs.rm(...args);
    },
  };
});
const disk = await vi.importActual<typeof FileSystem>('node:fs/promises');

let root: string;
let siteApp: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'builder-'));
  siteApp = join(root, 'siteapp');
  await mkdir(siteApp, { recursive: true });
});
afterEach(() => {
  pruneFaults.promoted = false;
  pruneFaults.beforePromotion = undefined;
  pruneFaults.afterPromotion = undefined;
  pruneFaults.enumerate = undefined;
  pruneFaults.current = undefined;
  pruneFaults.remove = undefined;
  pruneFaults.recordWrite = undefined;
  pruneFaults.manifestRemove = undefined;
  pruneFaults.manifestMkdir = undefined;
  pruneFaults.manifestSourceRemove = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Fake astro build: writes a marker file into the requested outDir.
const fakeBuild = (marker: string) => async (outDir: string, manifestPath?: string) => {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'index.html'), marker);
  if (manifestPath) await writeReleaseManifest([], manifestPath);
};

// Manual gate for holding a fake build in-flight until the test opens it.
const makeGate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
};

describe('createSiteBuilder', () => {
  it('quiesces active and queued builds without changing the current release', async () => {
    const releases = join(root, 'site');
    const initial = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('live') });
    expect((await initial.build('rebuild')).ok).toBe(true);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const controller = new AbortController();
    let calls = 0;
    const builder = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: releases, signal: controller.signal,
      runBuild: async (outDir) => {
        calls++;
        await fakeBuild('unpublished')(outDir);
        entered.resolve();
        await finish.promise;
      },
    });
    const active = builder.build('rebuild');
    await entered.promise;
    const queued = builder.build('rebuild');
    controller.abort();
    let settled = false;
    const stopped = builder.quiesce().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish.resolve();
    await stopped;
    const failed = await active;
    expect(failed).toMatchObject({ ok: false, code: 'build_stopped' });
    expect(failed.attemptId).not.toBeNull();
    expect(await queued).toMatchObject({ ok: false, attemptId: null, code: 'build_stopped' });
    const status = await builder.status();
    expect(status).toMatchObject({ record: 'not_persisted', running: null, last: { result: 'failed', attemptId: failed.attemptId, failure: { code: 'build_stopped' } } });
    expect(await builder.build('rebuild')).toMatchObject({ ok: false, attemptId: null, code: 'build_stopped' });
    expect(await builder.status()).toEqual(status);
    expect(calls).toBe(1);
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('live');
    // Cancellation leaves scratch untouched; a fresh owner sweeps it and recovers.
    const recovered = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('recovered') });
    expect(await recovered.status()).toMatchObject({ last: { result: 'interrupted', attemptId: failed.attemptId } });
    expect((await recovered.build('rebuild')).ok).toBe(true);
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('recovered');
  });

  it('refuses a build while storage is read-only even without a signal', async () => {
    let calls = 0;
    const builder = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: join(root, 'readonly'), isWritable: () => false,
      runBuild: async () => { calls++; },
    });
    expect((await builder.build('rebuild')).ok).toBe(false);
    expect(calls).toBe(0);
    await expect(readdir(join(root, 'readonly'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('has no release before the first build', () => {
    const b = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: join(root, 'site'), runBuild: fakeBuild('v1') });
    expect(b.hasRelease()).toBe(false);
  });

  it('builds, flips the current symlink atomically, and serves the new content', async () => {
    const releases = join(root, 'site');
    const b = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('v1') });
    const r1 = await b.build('rebuild');
    expect(r1.ok).toBe(true);
    expect(b.hasRelease()).toBe(true);
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('v1');

    const b2 = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('v2') });
    await b2.build('rebuild');
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('v2');
    expect(await readlink(join(releases, 'current'))).toContain('releases/');
  });

  it('prunes to the last 3 releases, never the live one', async () => {
    const releases = join(root, 'site');
    for (let i = 1; i <= 5; i++) {
      const b = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild(`v${i}`) });
      expect((await b.build('rebuild')).ok).toBe(true);
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
    const first = b.build('rebuild');
    const second = b.build('rebuild');
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
    expect((await b.build('rebuild')).ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('multiple callers during one in-flight build share a single queued run', async () => {
    let calls = 0;
    const gate = makeGate();
    const b = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: join(root, 'site'),
      runBuild: async (outDir) => { const n = ++calls; if (n === 1) await gate.promise; await fakeBuild(`v${n}`)(outDir); },
    });
    const first = b.build('rebuild');
    const second = b.build('rebuild');
    const third = b.build('rebuild');
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
    const first = b.build('rebuild');
    const second = b.build('rebuild'); // queued behind run 1
    gate1.open();
    await run2Started.promise; // run 2 (the queued one) is now executing
    const third = b.build('rebuild'); // must queue a NEW run 3 whose SELECT happens-after this call
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
    const first = b.build('rebuild');
    const second = b.build('rebuild');
    gate.open();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ok).toBe(false);
    expect(r1.code).toBe('internal');
    expect(r1.error).not.toContain('astro build exited 1');
    expect(r2).toEqual({ ok: true, attemptId: r2.release, release: r2.release, liveRelease: r2.release });
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('v2');
  });

  it('reports failure, keeps the previous release, and cleans the tmp dir', async () => {
    const releases = join(root, 'site');
    const ok = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('v1') });
    await ok.build('rebuild');
    const bad = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: releases,
      runBuild: async () => { throw new Error('astro build exited 1'); },
    });
    const r = await bad.build('rebuild');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('internal');
    expect(r.error).not.toContain('astro build exited 1');
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('v1');
    expect(await readdir(join(siteApp, '.build-tmp')).catch(() => [])).toEqual([]);
  });

  it('a failed copy leaves no release entry and keeps serving the previous release', async () => {
    const releases = join(root, 'site');
    const ok = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('v1') });
    await ok.build('rebuild');
    // Read-only releases dir: the build itself succeeds, the cp into the
    // staging dir fails (the ENOSPC shape of #110).
    await chmod(join(releases, 'releases'), 0o555);
    try {
      const r = await createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('v2') }).build('rebuild');
      expect(r.ok).toBe(false);
    } finally {
      await chmod(join(releases, 'releases'), 0o755);
    }
    const entries = await readdir(join(releases, 'releases'));
    expect(entries.filter((n) => n.startsWith('.'))).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('v1');
    expect(await readdir(join(siteApp, '.build-tmp')).catch(() => [])).toEqual([]);
  });

  it('sweeps what a crashed run left behind and never counts it toward keep', async () => {
    const releases = join(root, 'site');
    // A SIGKILLed previous process: a build tmp and a half-copied staging dir.
    await mkdir(join(siteApp, '.build-tmp', 'stale'), { recursive: true });
    await writeFile(join(siteApp, '.build-tmp', 'stale', 'index.html'), 'x');
    await mkdir(join(releases, 'releases', '.0-0-0000.partial'), { recursive: true });
    await writeFile(join(releases, 'releases', '.0-0-0000.partial', 'index.html'), 'x');
    const b = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, keep: 1, runBuild: fakeBuild('v1') });
    expect((await b.build('rebuild')).ok).toBe(true);
    expect(await readdir(join(siteApp, '.build-tmp')).catch(() => [])).toEqual([]);
    const kept = await readdir(join(releases, 'releases'));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.startsWith('.')).toBe(false);
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('v1');
  });
});

describe('post-promotion pruning', () => {
  const old = ['1000000000000-1-0000', '1000000000000-1-0001', '1000000000000-1-0002'];
  const privateError = (code: string) => Object.assign(new Error('/private/path secret injected error'), { code });

  async function fixture(options: { signal?: AbortSignal; isWritable?: () => boolean } = {}) {
    const releasesRoot = join(root, 'site');
    const releases = join(releasesRoot, 'releases');
    await disk.mkdir(join(releasesRoot, 'manifests'), { recursive: true });
    for (const stamp of old) {
      await disk.mkdir(join(releases, stamp), { recursive: true });
      await disk.writeFile(join(releases, stamp, 'index.html'), 'previous');
      await disk.writeFile(join(releasesRoot, 'manifests', `${stamp}.json`), JSON.stringify({ schema: 1, stamp, posts: [] }));
    }
    await disk.symlink(join(releases, old[0]!), join(releasesRoot, 'current'));
    const removals: string[] = [];
    pruneFaults.remove = (path) => { removals.push(path); };
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const builder = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot, keep: 2, runBuild: fakeBuild('promoted'), ...options,
    });
    return { releasesRoot, releases, removals, warnings, builder };
  }

  async function expectPromoted(releasesRoot: string, result: BuildOutcome) {
    expect(result).toMatchObject({ ok: true, attemptId: result.release, release: expect.stringMatching(/^\d+-\d+-\d+$/) });
    expect(await disk.readlink(join(releasesRoot, 'current'))).toBe(join(releasesRoot, 'releases', result.release!));
    expect(await disk.readFile(join(releasesRoot, 'current', 'index.html'), 'utf8')).toBe('promoted');
  }

  it.each(['EACCES', 'EBUSY', '/private/path\nunbounded-code'])('continues after a removal failure with bounded %s diagnostics', async (code) => {
    const f = await fixture();
    pruneFaults.remove = (path) => {
      f.removals.push(path);
      if (path === join(f.releases, old[0]!)) throw privateError(code);
    };
    const result = await f.builder.build('rebuild');
    await expectPromoted(f.releasesRoot, result);
    expect(f.removals).toEqual(old.slice(0, 2).map((stamp) => join(f.releases, stamp)));
    expect((await disk.readdir(f.releases)).sort()).toEqual([old[0], old[2], result.release]);
    expect(f.warnings.mock.calls).toEqual([[
      `release promoted; old-release cleanup incomplete release=${result.release} stage=remove errno=${code === 'EACCES' || code === 'EBUSY' ? code : 'unknown'}`,
    ]]);
  });

  it.each(['enumerate', 'current'] as const)('skips all deletions when %s inspection fails', async (stage) => {
    const f = await fixture();
    pruneFaults[stage] = () => { throw privateError('EIO'); };
    const result = await f.builder.build('rebuild');
    await expectPromoted(f.releasesRoot, result);
    expect(f.removals).toEqual([]);
    expect((await disk.readdir(f.releases)).sort()).toEqual([...old, result.release]);
    expect(f.warnings.mock.calls).toEqual([[
      `release promoted; old-release cleanup incomplete release=${result.release} stage=${stage} errno=EIO`,
    ]]);
  });

  it.each(['another-release', 'same-basename-outside-releases'])('skips pruning when current unexpectedly targets %s', async (target) => {
    const f = await fixture();
    let promoted = '';
    pruneFaults.afterPromotion = async () => {
      promoted = await disk.readlink(join(f.releasesRoot, 'current'));
      const unexpected = target === 'another-release'
        ? join(f.releases, old[0]!)
        : join(root, 'other', promoted.split('/').pop()!);
      await disk.symlink(unexpected, join(f.releasesRoot, 'replacement'));
      await disk.rename(join(f.releasesRoot, 'replacement'), join(f.releasesRoot, 'current'));
    };
    const result = await f.builder.build('rebuild');
    expect(result).toMatchObject({ ok: true, attemptId: promoted.split('/').pop(), release: promoted.split('/').pop() });
    expect(await disk.readFile(join(promoted, 'index.html'), 'utf8')).toBe('promoted');
    expect(f.removals).toEqual([]);
    expect((await disk.readdir(f.releases)).sort()).toEqual([...old, result.release]);
    expect(f.warnings.mock.calls).toEqual([[
      `release promoted; old-release cleanup incomplete release=${result.release} stage=current errno=unknown`,
    ]]);
  });

  it.each(['signal', 'lease'] as const)('stops new mutations on immediate post-flip %s loss', async (kind) => {
    const controller = new AbortController();
    let writable = true;
    const f = await fixture({ signal: controller.signal, isWritable: () => writable });
    pruneFaults.afterPromotion = () => {
      if (kind === 'signal') controller.abort();
      else writable = false;
    };
    const result = await f.builder.build('rebuild');
    await expectPromoted(f.releasesRoot, result);
    expect(f.removals).toEqual([]);
    expect((await disk.readdir(f.releases)).sort()).toEqual([...old, result.release]);
    expect(f.warnings.mock.calls).toEqual([[
      `release promoted; old-release cleanup incomplete release=${result.release} stage=ownership errno=unknown`,
    ]]);
  });

  it.each([false, true])('stops after ownership loss during an admitted removal (fails: %s)', async (fails) => {
    let writable = true;
    const f = await fixture({ isWritable: () => writable });
    pruneFaults.remove = (path) => {
      f.removals.push(path);
      writable = false;
      if (fails) throw privateError('EACCES');
    };
    const result = await f.builder.build('rebuild');
    await expectPromoted(f.releasesRoot, result);
    expect(f.removals).toEqual([join(f.releases, old[0]!)]);
    expect((await disk.readdir(f.releases)).sort()).toEqual([...(fails ? old : old.slice(1)), result.release]);
    expect(f.warnings.mock.calls).toEqual([[
      `release promoted; old-release cleanup incomplete release=${result.release} stage=ownership errno=unknown`,
    ]]);
  });

  it('protects promoted/current and staging entries even when the clock moves backwards', async () => {
    const f = await fixture();
    vi.spyOn(Date, 'now').mockReturnValue(1);
    // Created after the pre-build sweep, so this exercises pruning, not sweeping.
    const staging = '.0000000000000.partial';
    pruneFaults.afterPromotion = async () => { await disk.mkdir(join(f.releases, staging)); };
    const result = await f.builder.build('rebuild');
    await expectPromoted(f.releasesRoot, result);
    expect(f.removals).toEqual([join(f.releases, old[0]!)]);
    expect((await disk.readdir(f.releases)).sort()).toEqual([staging, old[1], old[2], result.release].sort());
    expect(f.warnings).not.toHaveBeenCalled();
  });

  it('keeps promotion successful and continues pruning if the diagnostic sink throws', async () => {
    const f = await fixture();
    f.warnings.mockImplementation(() => { throw new Error('sink failed'); });
    pruneFaults.remove = (path) => {
      f.removals.push(path);
      if (path === join(f.releases, old[0]!)) throw privateError('EACCES');
    };
    const result = await f.builder.build('rebuild');
    await expectPromoted(f.releasesRoot, result);
    expect(f.removals).toEqual(old.slice(0, 2).map((stamp) => join(f.releases, stamp)));
    expect((await disk.readdir(f.releases)).sort()).toEqual([old[0], old[2], result.release]);
  });

  it('preserves pre-flip rename failure and serves the previous release', async () => {
    const f = await fixture();
    pruneFaults.beforePromotion = () => { throw privateError('EACCES'); };
    const result = await f.builder.build('rebuild');
    expect(result).toMatchObject({ ok: false, code: 'release_write_failed', liveRelease: old[0] });
    expect(result.error).not.toContain('/private/path');
    expect(await disk.readlink(join(f.releasesRoot, 'current'))).toBe(join(f.releases, old[0]!));
    expect(await disk.readFile(join(f.releasesRoot, 'current', 'index.html'), 'utf8')).toBe('previous');
    expect(f.removals).toEqual([]);
    expect(f.warnings).not.toHaveBeenCalled();
  });
});

describe('runChildBuild', () => {
  const node = process.execPath;

  it('kills and reaps the active child when storage ownership is lost', async () => {
    const controller = new AbortController();
    let pid: number | undefined;
    // A real child exercises process reaping; abort fires synchronously, without a timed wait.
    const run = runChildBuild(node, ['-e', 'setInterval(() => {}, 1000)'], root, 10_000,
      (child) => { pid = child.pid; controller.abort(); }, { signal: controller.signal });
    await expect(run).rejects.toMatchObject({ code: 'storage_read_only' });
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it('tags child database sessions even when DATABASE_URL contains another application_name', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/test?application_name=old');
    const applicationName = 'swl-app:test-instance:build';
    const script = `require('node:fs').writeFileSync('tag.json', JSON.stringify({
      url: new URL(process.env.DATABASE_URL).searchParams.get('application_name'),
      env: process.env.PGAPPNAME
    }));`;
    await runChildBuild(node, ['-e', script], root, 10_000, undefined, { applicationName });
    expect(JSON.parse(await readFile(join(root, 'tag.json'), 'utf8'))).toEqual({ url: applicationName, env: applicationName });
  });

  it('kills a child that outlives the deadline and rejects with BuildTimeoutError only once it is dead', async () => {
    // Real clock on purpose: the deadline is exercised against a real spawned
    // process, which fake timers cannot drive.
    //
    // The pid comes from `onSpawn`, which fires synchronously inside
    // `runChildBuild` before the timer is armed. It used to come from a file
    // the child wrote as its first statement, and that raced the deadline
    // under test: when Node's cold start overran the 300ms budget the child
    // was killed before running, and this died on `ENOENT … /pid` roughly one
    // run in four under load. The budget is back to 300ms because nothing
    // here depends on the child reaching any code at all.
    let pid: number | undefined;
    const hang = 'setInterval(() => {}, 1000);';
    await expect(
      runChildBuild(node, ['-e', hang], root, 300, (child) => { pid = child.pid; }),
    ).rejects.toBeInstanceOf(BuildTimeoutError);
    expect(pid).toBeGreaterThan(0);
    // Signal 0 probes for existence; the child must be gone (REAPED, not just
    // signalled) by the time the promise settles — that is what "only once it
    // is dead" means, and it is why the promise settles on `close`.
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it('carries the tail of stderr, bounded, in a non-zero exit rejection', async () => {
    const noisy = `process.stderr.write('HEAD-' + 'x'.repeat(${STDERR_TAIL_BYTES + 64}) + '\\x1b[31m-TAIL-END\\x1b[0m\\n'); process.exit(3);`;
    const err = await runChildBuild(node, ['-e', noisy], root, 10_000).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BuildChildError);
    const failure = err as BuildChildError;
    expect(failure.exitCode).toBe(3);
    expect(failure.stderrTail).toContain('-TAIL-END');
    expect(failure.stderrTail).not.toContain('\x1b[');
    expect(failure.stderrTail).not.toContain('HEAD-');
    expect(Buffer.byteLength(failure.stderrTail)).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
    expect(failure.message).not.toContain('-TAIL-END');
  });

  it('resolves on exit 0 and rejects when the command cannot be spawned', async () => {
    await expect(runChildBuild(node, ['-e', 'process.exit(0)'], root, 10_000)).resolves.toBeUndefined();
    await expect(runChildBuild(join(root, 'no-such-binary'), [], root, 10_000)).rejects.toMatchObject({ name: 'BuildUnavailableError', cause: { code: 'ENOENT' } });
  });
});

describe('bootstrapRelease', () => {
  it('cancels the retry wait without starting another build', async () => {
    const controller = new AbortController();
    const waiting = Promise.withResolvers<void>();
    const sleep = Promise.withResolvers<void>();
    let calls = 0;
    const run = bootstrapRelease({
      hasRelease: () => false,
      build: async () => { calls++; return { ok: false, attemptId: null, code: 'internal', error: 'temporary' }; },
    }, {
      log: () => {}, signal: controller.signal,
      sleep: () => { waiting.resolve(); return sleep.promise; },
    });
    await waiting.promise;
    controller.abort();
    await run;
    expect(calls).toBe(1);
    sleep.resolve();
  });
  // A builder scripted with per-call outcomes; `released` flips hasRelease().
  function scripted(outcomes: Array<Omit<BuildOutcome, 'attemptId'>>) {
    let calls = 0;
    const state = { released: false };
    const builder: SiteBuilder = {
      hasRelease: () => state.released,
      quiesce: async () => {},
      initialize: async () => {},
      status: async () => ({ live: null, running: null, last: null, record: 'missing' }),
      build: async () => {
        const r: Omit<BuildOutcome, 'attemptId'> = outcomes[calls++] ?? { ok: false, error: 'unscripted' };
        if (r.ok) state.released = true;
        return { ...r, attemptId: r.release ?? null };
      },
    };
    const sleeps: number[] = [];
    const logs: string[] = [];
    const run = (extra: { attempts?: number } = {}) => bootstrapRelease(builder, {
      log: (m) => logs.push(m), sleep: async (ms) => { sleeps.push(ms); }, baseDelayMs: 100, maxDelayMs: 300, ...extra,
    });
    return { run, state, sleeps, logs, calls: () => calls, build: builder.build };
  }

  it('retries a failed initial build with growing, capped delays and stops on the first success', async () => {
    const s = scripted([{ ok: false, error: 'e1' }, { ok: false, error: 'e2' }, { ok: false, error: 'e3' }, { ok: true, release: 'r' }]);
    await s.run();
    expect(s.calls()).toBe(4);
    expect(s.sleeps).toEqual([100, 200, 300]);
    expect(s.logs.at(-1)).toBe('initial build released r');
    expect(s.logs[0]).toContain('e1');
  });

  it('stops without building again once a release exists (an admin published meanwhile)', async () => {
    const s = scripted([{ ok: false, error: 'e1' }, { ok: false, error: 'never reached' }]);
    // The admin's publish lands while the retry is sleeping.
    await bootstrapRelease(
      { hasRelease: () => s.state.released, build: s.build },
      { log: (m) => s.logs.push(m), sleep: async () => { s.state.released = true; }, baseDelayMs: 1 },
    );
    expect(s.calls()).toBe(1);
    expect(s.logs.at(-1)).toBe('initial build no longer needed: a release exists');
  });

  it('gives up after the last attempt and says so', async () => {
    const s = scripted([{ ok: false, error: 'schema' }, { ok: false, error: 'schema' }]);
    await s.run({ attempts: 2 });
    expect(s.calls()).toBe(2);
    expect(s.sleeps).toEqual([100]);
    expect(s.logs.at(-1)).toMatch(/attempt 2\/2.*giving up.*schema/);
  });
});

describe('durable build reporting', () => {
  it('writes a fresh-volume start before the generator and distinguishes foreign ownership from interrupted recovery', async () => {
    const releasesRoot = join(root, 'new-site');
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const builder = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot,
      runBuild: async (outDir) => { entered.resolve(); await finish.promise; await fakeBuild('first')(outDir); },
    });
    const build = builder.build('boot');
    await entered.promise;
    const bytes = await disk.readFile(join(releasesRoot, 'build-state.json'), 'utf8');
    const recorded = JSON.parse(bytes);
    expect(recorded.running.triggers).toEqual(['boot']);
    expect(recorded.last).toBeNull();
    const observer = createSiteBuilder({ siteAppDir: siteApp, releasesRoot, isWritable: () => false, runBuild: fakeBuild('forbidden') });
    expect(await observer.status()).toMatchObject({ live: null, running: { owner: 'unverified', attemptId: recorded.running.attemptId }, last: null });
    expect(await observer.build('rebuild')).toMatchObject({ ok: false, attemptId: null, code: 'build_stopped' });
    expect(await disk.readFile(join(releasesRoot, 'build-state.json'), 'utf8')).toBe(bytes);
    // Read the same bytes as the next owner would after the original process dies.
    const recovered = createSiteBuilder({ siteAppDir: siteApp, releasesRoot, runBuild: fakeBuild('recovered') });
    expect(await recovered.status()).toMatchObject({ live: null, running: null, last: { attemptId: recorded.running.attemptId, result: 'interrupted', finishedAt: null, beforeBoot: true } });
    expect(await disk.readFile(join(releasesRoot, 'build-state.json'), 'utf8')).toBe(bytes);
    finish.resolve();
    const result = await build;
    expect(await builder.status()).toMatchObject({ live: { release: result.release }, running: null, last: { result: 'succeeded', beforeBoot: false }, record: 'ok' });
    const reboot = createSiteBuilder({ siteAppDir: siteApp, releasesRoot, runBuild: fakeBuild('later') });
    expect(await reboot.status()).toMatchObject({ last: { result: 'succeeded', beforeBoot: true, attemptId: result.attemptId } });
  });

  it('records the deduplicated triggers of exactly one queued run', async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    const builder = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: join(root, 'site'),
      runBuild: async (outDir) => { if (++calls === 1) { entered.resolve(); await finish.promise; } await fakeBuild('live')(outDir); },
    });
    const active = builder.build('publish');
    await entered.promise;
    const next = builder.build('page');
    const same = builder.build('bulk');
    const duplicate = builder.build('page');
    expect(await builder.status()).toMatchObject({ running: { queued: true, owner: 'this_process' } });
    finish.resolve();
    const [first, second, third, fourth] = await Promise.all([active, next, same, duplicate]);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(third).toBe(second);
    expect(fourth).toBe(second);
    expect(calls).toBe(2);
    expect(await builder.status()).toMatchObject({ running: null, last: { attemptId: second.attemptId, triggers: ['bulk', 'page'] } });
  });

  it.each([
    [new BuildTimeoutError(100), 'build_timeout'],
    [new BuildChildError(2, null, '/secret/password stderr'), 'build_failed'],
    [new BuildUnavailableError(Object.assign(new Error('/secret/spawn'), { code: 'ENOENT' })), 'build_unavailable'],
    [Object.assign(new Error('/secret/disk'), { code: 'ENOSPC' }), 'no_space'],
    [Object.assign(new Error('/secret/quota'), { code: 'EDQUOT' }), 'no_space'],
    [Object.assign(new Error('/secret/permission'), { code: 'EACCES' }), 'release_write_failed'],
    [new StorageReadOnlyError(), 'build_stopped'],
    [new Error('ENOSPC timeout /secret/not-an-errno'), 'internal'],
  ] as const)('classifies %s without parsing or disclosing diagnostics', async (cause, code) => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const releasesRoot = join(root, 'site');
    const builder = createSiteBuilder({ siteAppDir: siteApp, releasesRoot, runBuild: async () => { throw cause; } });
    const outcome = await builder.build('publish');
    expect(outcome).toMatchObject({ ok: false, code, liveRelease: null, cause });
    const report = projectBuildReport(outcome);
    expect(report.error).toBe(buildFailureMessage(code));
    expect(report).not.toHaveProperty('cause');
    expect(JSON.stringify(report)).not.toContain('/secret');
    expect(await builder.status()).toMatchObject({ last: { result: 'failed', failure: { code, message: buildFailureMessage(code) } } });
    expect(await disk.readFile(join(releasesRoot, 'build-state.json'), 'utf8')).not.toContain('/secret');
    expect(logs.mock.calls.some((call) => call.includes(cause))).toBe(true);
  });

  it('keeps promotion successful when its completion record fails, and recovers unknown after restart', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const releasesRoot = join(root, 'site');
    let writes = 0;
    pruneFaults.recordWrite = () => { if (++writes === 2) throw Object.assign(new Error('record failure'), { code: 'EIO' }); };
    const builder = createSiteBuilder({ siteAppDir: siteApp, releasesRoot, runBuild: fakeBuild('promoted') });
    const outcome = await builder.build('rebuild');
    expect(outcome.ok).toBe(true);
    expect(await builder.status()).toMatchObject({ record: 'not_persisted', last: { result: 'succeeded', release: outcome.release } });
    const reboot = createSiteBuilder({ siteAppDir: siteApp, releasesRoot, runBuild: fakeBuild('later') });
    expect(await reboot.status()).toMatchObject({ record: 'ok', live: { release: outcome.release }, last: { result: 'interrupted', attemptId: outcome.attemptId, beforeBoot: true } });
    // A crash before the completion record does not erase the promoted content.
    expect(await createReleaseManifestReader(releasesRoot).read()).toMatchObject({
      release: 'known', manifest: { stamp: outcome.release },
    });
  });

  it('invalidates stale history if start persistence fails, then restores durable history at completion', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const releasesRoot = join(root, 'site');
    const builder = createSiteBuilder({ siteAppDir: siteApp, releasesRoot, runBuild: fakeBuild('old') });
    await builder.build('rebuild');
    let writes = 0;
    pruneFaults.recordWrite = () => { if (++writes === 1) throw Object.assign(new Error('record failure'), { code: 'EIO' }); };
    const next = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot,
      runBuild: async (outDir) => {
        await expect(disk.readFile(join(releasesRoot, 'build-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await next.status()).toMatchObject({ record: 'not_persisted', running: { owner: 'this_process' } });
        await fakeBuild('new')(outDir);
      },
    });
    expect((await next.build('page')).ok).toBe(true);
    expect(await next.status()).toMatchObject({ record: 'ok', last: { result: 'succeeded', triggers: ['page'] } });
  });

  it('keeps absent and unreadable live observations distinct without downgrading promotion', async () => {
    const releasesRoot = join(root, 'site');
    const builder = createSiteBuilder({ siteAppDir: siteApp, releasesRoot, runBuild: fakeBuild('promoted') });
    expect(await builder.status()).toEqual({ live: null, running: null, last: null, record: 'missing' });
    pruneFaults.current = () => { throw Object.assign(new Error('link unavailable'), { code: 'EACCES' }); };
    const result = await builder.build('rebuild');
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('liveRelease');
    const status = await builder.status();
    expect(status).not.toHaveProperty('live');
    expect(status.last).not.toHaveProperty('liveReleaseAfter');
    expect(status.last?.result).toBe('succeeded');
  });

  it('retains committed success on ownership loss and refuses later requests without replacing history', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let writable = true;
    const releasesRoot = join(root, 'site');
    const builder = createSiteBuilder({ siteAppDir: siteApp, releasesRoot, isWritable: () => writable, runBuild: fakeBuild('promoted') });
    pruneFaults.afterPromotion = () => { writable = false; };
    const result = await builder.build('publish');
    expect(result.ok).toBe(true);
    const before = await builder.status();
    expect(before).toMatchObject({ record: 'not_persisted', last: { result: 'succeeded', attemptId: result.attemptId } });
    expect(await builder.build('delete')).toMatchObject({ attemptId: null, code: 'build_stopped' });
    expect(await builder.status()).toEqual(before);
    const stored = JSON.parse(await disk.readFile(join(releasesRoot, 'build-state.json'), 'utf8'));
    expect(stored.running.attemptId).toBe(result.attemptId);
    expect(stored.last).toBeNull();
  });
});

describe('publication manifest deployment boundaries', () => {
  it('publishes unserved manifest after release rename and before the irreversible flip', async () => {
    const site = join(root, 'site');
    let observed = false;
    pruneFaults.beforePromotion = async () => {
      const [stamp] = await disk.readdir(join(site, 'releases'));
      expect(await disk.readFile(join(site, 'releases', stamp!, 'index.html'), 'utf8')).toBe('new');
      expect(JSON.parse(await disk.readFile(join(site, 'manifests', `${stamp}.json`), 'utf8'))).toEqual({ schema: 1, stamp, posts: [] });
      expect(await createReleaseManifestReader(site).read()).toEqual({ release: 'none' });
      await expect(disk.readdir(join(site, 'releases', stamp!, 'manifests'))).rejects.toMatchObject({ code: 'ENOENT' });
      observed = true;
    };
    const result = await createSiteBuilder({ siteAppDir: siteApp, releasesRoot: site, runBuild: fakeBuild('new') }).build('rebuild');
    expect(observed).toBe(true);
    expect(result.ok).toBe(true);
    expect(await createReleaseManifestReader(site).read()).toEqual({ release: 'known', manifest: { schema: 1, stamp: result.release, posts: [] } });
  });

  it('keeps optional scratch cleanup failures nonfatal and sweeps the leftover on the next build', async () => {
    const site = join(root, 'site');
    let refused = '';
    pruneFaults.manifestSourceRemove = (path) => {
      if (!path.endsWith('.manifest.json')) return;
      refused = path;
      throw Object.assign(new Error('scratch cleanup failure'), { code: 'EACCES' });
    };
    const builder = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: site, runBuild: fakeBuild('new') });
    const first = await builder.build('rebuild');
    expect(first.ok).toBe(true);
    expect(await createReleaseManifestReader(site).read()).toMatchObject({ release: 'known', manifest: { stamp: first.release } });
    expect(await disk.readFile(refused, 'utf8')).toBeTruthy();
    pruneFaults.manifestSourceRemove = undefined;
    expect((await builder.build('rebuild')).ok).toBe(true);
    expect(await disk.readdir(join(siteApp, '.build-tmp'))).toEqual([]);
    await expect(disk.readFile(refused)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('admits no second scratch removal or flip after ownership is lost during the first removal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const site = join(root, 'site');
    let writable = true;
    const removals: string[] = [];
    pruneFaults.manifestSourceRemove = (path) => { removals.push(path); writable = false; };
    const result = await createSiteBuilder({ siteAppDir: siteApp, releasesRoot: site,
      isWritable: () => writable, runBuild: fakeBuild('new') }).build('rebuild');
    expect(result).toMatchObject({ ok: false, code: 'build_stopped' });
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatch(/\.manifest\.json$/);
    expect(await createReleaseManifestReader(site).read()).toEqual({ release: 'none' });
    await expect(disk.readlink(join(site, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains previous current manifest after a pre-flip failure', async () => {
    const site = join(root, 'site');
    const builder = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: site, runBuild: fakeBuild('new') });
    const first = await builder.build('rebuild');
    pruneFaults.beforePromotion = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    const failed = await builder.build('rebuild');
    expect(failed.ok).toBe(false);
    expect(await createReleaseManifestReader(site).read()).toMatchObject({ release: 'known', manifest: { stamp: first.release } });
    expect(await disk.readdir(join(site, 'manifests'))).toContain(`${failed.attemptId}.json`);
  });

  it('promotes with unknown publication when manifest directory is unwritable', async () => {
    const site = join(root, 'site');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pruneFaults.manifestMkdir = () => { throw Object.assign(new Error('/private/secret'), { code: 'EACCES' }); };
    const result = await createSiteBuilder({ siteAppDir: siteApp, releasesRoot: site, runBuild: fakeBuild('new') }).build('rebuild');
    expect(result.ok).toBe(true);
    expect(await createReleaseManifestReader(site).read()).toEqual({ release: 'unknown' });
    expect(warning).toHaveBeenCalledWith('Release publication manifest unavailable; publication status may be unknown.');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('/private/secret');
  });

  it.each(['failure', 'loss'] as const)('retains old manifest after release deletion %s without downgrading promotion', async (mode) => {
    const site = join(root, 'site');
    let writable = true;
    const builder = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: site, keep: 1, isWritable: () => writable, runBuild: fakeBuild('new') });
    const first = await builder.build('rebuild');
    const deletedManifests: string[] = [];
    pruneFaults.manifestRemove = (path) => { deletedManifests.push(path); };
    pruneFaults.remove = (path) => {
      if (path !== join(site, 'releases', first.release!)) return;
      if (mode === 'loss') writable = false;
      else throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    };
    const second = await builder.build('rebuild');
    expect(second.ok).toBe(true);
    expect(deletedManifests).toEqual([]);
    expect(await disk.readFile(join(site, 'manifests', `${first.release}.json`), 'utf8')).toBeTruthy();
    expect(await createReleaseManifestReader(site).read()).toMatchObject({ release: 'known', manifest: { stamp: second.release } });
  });

  it('sweeps orphan and temporary manifests, prunes release/manifest together, preserves build history', async () => {
    const site = join(root, 'site');
    const builder = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: site, keep: 1, runBuild: fakeBuild('new') });
    const first = await builder.build('rebuild');
    await disk.writeFile(join(site, 'manifests', '1-1-0000.json'), '{}');
    await disk.writeFile(join(site, 'manifests', '.1-1-0001.partial'), 'partial');
    const second = await builder.build('rebuild');
    expect(second.ok).toBe(true);
    expect(await disk.readdir(join(site, 'manifests'))).toEqual([`${second.release}.json`]);
    await expect(disk.readFile(join(site, 'manifests', `${first.release}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await disk.readFile(join(site, 'build-state.json'), 'utf8'))).toBeTruthy();
  });

  it.each([false, true])('observes only loader-read entries across coalescing (queued failure: %s)', async (failQueued) => {
    const site = join(root, 'site');
    const firstRead = Promise.withResolvers<void>();
    const finishFirst = Promise.withResolvers<void>();
    const secondRead = Promise.withResolvers<void>();
    const finishSecond = Promise.withResolvers<void>();
    let calls = 0;
    const builder = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: site,
      runBuild: async (outDir, manifestPath) => {
        const call = ++calls;
        await fakeBuild('new')(outDir);
        await writeReleaseManifest(call === 1 ? [] : [{ translationKey: 'later-commit', locale: 'de', slug: 'story', digest: 'a'.repeat(64), gallery: [] }], manifestPath);
        if (call === 1) { firstRead.resolve(); await finishFirst.promise; }
        else { secondRead.resolve(); await finishSecond.promise; if (failQueued) throw new Error('build failed'); }
      },
    });
    const first = builder.build('rebuild');
    await firstRead.promise;
    const queued = builder.build('publish');
    finishFirst.resolve();
    expect((await first).ok).toBe(true);
    await secondRead.promise;
    const reader = createReleaseManifestReader(site);
    expect(await reader.read()).toMatchObject({ release: 'known', manifest: { posts: [] } });
    finishSecond.resolve();
    expect((await queued).ok).toBe(!failQueued);
    const observation = await reader.read();
    expect(observation.release).toBe('known');
    if (observation.release === 'known') expect(observation.manifest.posts.map((post) => post.translationKey)).toEqual(failQueued ? [] : ['later-commit']);
  });

  it('passes only the per-build manifest path to children, never inherited operator state', async () => {
    vi.stubEnv('SITE_RELEASE_MANIFEST', '/private/operator-path');
    const script = "require('node:fs').writeFileSync('manifest-env.json', JSON.stringify({ path: process.env.SITE_RELEASE_MANIFEST ?? null }))";
    await runChildBuild(process.execPath, ['-e', script], root, 10_000);
    expect(JSON.parse(await disk.readFile(join(root, 'manifest-env.json'), 'utf8'))).toEqual({ path: null });
    await runChildBuild(process.execPath, ['-e', script], root, 10_000, undefined, { manifestPath: '/run/1-1-0000.manifest.json' });
    expect(JSON.parse(await disk.readFile(join(root, 'manifest-env.json'), 'utf8'))).toEqual({ path: '/run/1-1-0000.manifest.json' });
  });
  it('keeps promotion successful when old manifest cleanup fails', async () => {
    const site = join(root, 'site');
    const builder = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: site, keep: 1, runBuild: fakeBuild('new') });
    const first = await builder.build('rebuild');
    pruneFaults.manifestRemove = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    const second = await builder.build('rebuild');
    expect(second.ok).toBe(true);
    await expect(disk.readdir(join(site, 'releases', first.release!))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await disk.readFile(join(site, 'manifests', `${first.release}.json`), 'utf8')).toBeTruthy();
    expect(await createReleaseManifestReader(site).read()).toMatchObject({ release: 'known', manifest: { stamp: second.release } });
  });
});
