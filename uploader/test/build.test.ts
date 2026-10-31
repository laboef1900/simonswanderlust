import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, readlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BuildTimeoutError, STDERR_TAIL_BYTES, bootstrapRelease, createSiteBuilder, runChildBuild,
  type BuildOutcome, type SiteBuilder,
} from '../src/build.js';
import type * as FileSystem from 'node:fs/promises';

// Inject faults at the real filesystem boundaries, without relying on uid or
// permission semantics. All successful copies, promotions and removals stay real.
const pruneFaults = vi.hoisted(() => ({
  promoted: false,
  beforePromotion: undefined as (() => void) | undefined,
  afterPromotion: undefined as (() => Promise<void> | void) | undefined,
  enumerate: undefined as (() => void) | undefined,
  current: undefined as (() => string | void) | undefined,
  remove: undefined as ((path: string) => Promise<void> | void) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FileSystem>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      const promoting = to.endsWith('/current');
      if (promoting) pruneFaults.beforePromotion?.();
      await fs.rename(from, to);
      if (promoting) {
        pruneFaults.promoted = true;
        await pruneFaults.afterPromotion?.();
      }
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
      if (pruneFaults.promoted) await pruneFaults.remove?.(String(args[0]));
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  it('quiesces active and queued builds without changing the current release', async () => {
    const releases = join(root, 'site');
    const initial = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('live') });
    expect((await initial.build()).ok).toBe(true);
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
    const active = builder.build();
    await entered.promise;
    const queued = builder.build();
    controller.abort();
    let settled = false;
    const stopped = builder.quiesce().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish.resolve();
    await stopped;
    expect((await active).ok).toBe(false);
    expect((await queued).ok).toBe(false);
    expect((await builder.build()).ok).toBe(false);
    expect(calls).toBe(1);
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('live');
    // Cancellation leaves scratch untouched; a fresh owner sweeps it and recovers.
    const recovered = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('recovered') });
    expect((await recovered.build()).ok).toBe(true);
    expect(await readFile(join(releases, 'current', 'index.html'), 'utf8')).toBe('recovered');
  });

  it('refuses a build while storage is read-only even without a signal', async () => {
    let calls = 0;
    const builder = createSiteBuilder({
      siteAppDir: siteApp, releasesRoot: join(root, 'readonly'), isWritable: () => false,
      runBuild: async () => { calls++; },
    });
    expect((await builder.build()).ok).toBe(false);
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

  it('a failed copy leaves no release entry and keeps serving the previous release', async () => {
    const releases = join(root, 'site');
    const ok = createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('v1') });
    await ok.build();
    // Read-only releases dir: the build itself succeeds, the cp into the
    // staging dir fails (the ENOSPC shape of #110).
    await chmod(join(releases, 'releases'), 0o555);
    try {
      const r = await createSiteBuilder({ siteAppDir: siteApp, releasesRoot: releases, runBuild: fakeBuild('v2') }).build();
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
    expect((await b.build()).ok).toBe(true);
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
    for (const stamp of old) {
      await disk.mkdir(join(releases, stamp), { recursive: true });
      await disk.writeFile(join(releases, stamp, 'index.html'), 'previous');
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
    expect(result).toEqual({ ok: true, release: expect.stringMatching(/^\d+-\d+-\d+$/) });
    expect(await disk.readlink(join(releasesRoot, 'current'))).toBe(join(releasesRoot, 'releases', result.release!));
    expect(await disk.readFile(join(releasesRoot, 'current', 'index.html'), 'utf8')).toBe('promoted');
  }

  it.each(['EACCES', 'EBUSY', '/private/path\nunbounded-code'])('continues after a removal failure with bounded %s diagnostics', async (code) => {
    const f = await fixture();
    pruneFaults.remove = (path) => {
      f.removals.push(path);
      if (path === join(f.releases, old[0]!)) throw privateError(code);
    };
    const result = await f.builder.build();
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
    const result = await f.builder.build();
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
    const result = await f.builder.build();
    expect(result).toEqual({ ok: true, release: promoted.split('/').pop() });
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
    const result = await f.builder.build();
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
    const result = await f.builder.build();
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
    const result = await f.builder.build();
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
    const result = await f.builder.build();
    await expectPromoted(f.releasesRoot, result);
    expect(f.removals).toEqual(old.slice(0, 2).map((stamp) => join(f.releases, stamp)));
    expect((await disk.readdir(f.releases)).sort()).toEqual([old[0], old[2], result.release]);
  });

  it('preserves pre-flip rename failure and serves the previous release', async () => {
    const f = await fixture();
    pruneFaults.beforePromotion = () => { throw privateError('EACCES'); };
    const result = await f.builder.build();
    expect(result).toEqual({ ok: false, error: '/private/path secret injected error' });
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
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg.startsWith('astro build exited 3\n')).toBe(true);
    expect(msg).toContain('-TAIL-END');
    expect(msg).not.toContain('\x1b[');
    expect(msg).not.toContain('HEAD-');
    expect(msg.length).toBeLessThanOrEqual(STDERR_TAIL_BYTES + 'astro build exited 3\n'.length);
  });

  it('resolves on exit 0 and rejects when the command cannot be spawned', async () => {
    await expect(runChildBuild(node, ['-e', 'process.exit(0)'], root, 10_000)).resolves.toBeUndefined();
    await expect(runChildBuild(join(root, 'no-such-binary'), [], root, 10_000)).rejects.toThrow(/ENOENT/);
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
      build: async () => { calls++; return { ok: false, error: 'temporary' }; },
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
  function scripted(outcomes: BuildOutcome[]) {
    let calls = 0;
    const state = { released: false };
    const builder: SiteBuilder = {
      hasRelease: () => state.released,
      quiesce: async () => {},
      build: async () => {
        const r = outcomes[calls++] ?? { ok: false, error: 'unscripted' };
        if (r.ok) state.released = true;
        return r;
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
