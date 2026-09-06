import { describe, expect, it, beforeEach } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, readlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BuildTimeoutError, STDERR_TAIL_BYTES, bootstrapRelease, createSiteBuilder, runChildBuild,
  type BuildOutcome, type SiteBuilder,
} from '../src/build.js';

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

describe('runChildBuild', () => {
  const node = process.execPath;

  it('kills a child that outlives the deadline and rejects with BuildTimeoutError only once it is dead', async () => {
    const pidFile = join(root, 'pid');
    const hang = `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
    // Real clock on purpose: the deadline is exercised against a real spawned
    // process, which fake timers cannot drive.
    await expect(runChildBuild(node, ['-e', hang, pidFile], root, 300)).rejects.toBeInstanceOf(BuildTimeoutError);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    // Signal 0 probes for existence; the child must be gone (reaped), not lingering.
    expect(() => process.kill(pid, 0)).toThrow();
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
  // A builder scripted with per-call outcomes; `released` flips hasRelease().
  function scripted(outcomes: BuildOutcome[]) {
    let calls = 0;
    const state = { released: false };
    const builder: SiteBuilder = {
      hasRelease: () => state.released,
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
