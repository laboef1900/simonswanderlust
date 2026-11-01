import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createSiteBuilder } from '../src/build.js';

/** Kill a separate process, not merely an in-memory imitation of restart. The
 * post-flip case holds at the actual filesystem rename before completion can
 * be recorded; release bytes and the retained running record both survive. */
describe('build crash boundaries', () => {
  it.each(['generator', 'promoted'] as const)('recovers an actual SIGKILL at %s as interrupted independently of live evidence', async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'build-crash-'));
    const siteAppDir = join(root, 'app');
    const releasesRoot = join(root, 'site');
    await mkdir(siteAppDir);
    const moduleUrl = new URL('../src/build.ts', import.meta.url).href;
    const script = `
      import fs from 'node:fs/promises';
      import { join } from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const phase = ${JSON.stringify(phase)};
      const hold = async () => {
        process.send({ phase });
        // Keep the real child alive until the parent kills it; no elapsed wait is used as evidence.
        setInterval(() => {}, 1000);
        await Promise.withResolvers().promise;
      };
      const rename = fs.rename;
      fs.rename = async (from, to) => {
        await rename(from, to);
        if (phase === 'promoted' && to.endsWith('/current')) await hold();
      };
      syncBuiltinESMExports();
      // Import only after replacing the builtin export: this test exercises a process crash at rename.
      const { createSiteBuilder } = await import(${JSON.stringify(moduleUrl)});
      const builder = createSiteBuilder({
        siteAppDir: ${JSON.stringify(siteAppDir)}, releasesRoot: ${JSON.stringify(releasesRoot)},
        runBuild: async (outDir) => {
          if (phase === 'generator') await hold();
          await fs.mkdir(outDir, { recursive: true });
          await fs.writeFile(join(outDir, 'index.html'), 'committed before crash');
        },
      });
      await builder.initialize();
      await builder.build('boot');
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let diagnostics = '';
    child.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
    const closed = once(child, 'close');
    try {
      const reached = Promise.withResolvers<void>();
      // A real child cannot use the parent's fake clock. This is only a failure
      // deadline; IPC, not elapsed time, establishes that the boundary was reached.
      const timer = setTimeout(() => { cleanup(); reached.reject(new Error(`Child did not reach ${phase}: ${diagnostics}`)); }, 30_000);
      const message = () => { cleanup(); reached.resolve(); };
      const failed = () => { cleanup(); reached.reject(new Error(`Child exited before ${phase}: ${diagnostics}`)); };
      const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', failed); child.off('error', failed); };
      child.once('message', message);
      child.once('exit', failed);
      child.once('error', failed);
      await reached.promise;
      const bytes = await readFile(join(releasesRoot, 'build-state.json'), 'utf8');
      const running = JSON.parse(bytes).running;
      expect(running.triggers).toEqual(['boot']);
      child.kill('SIGKILL');
      await closed;
      const recovered = createSiteBuilder({
        siteAppDir, releasesRoot,
        runBuild: async (outDir) => { await mkdir(outDir, { recursive: true }); await writeFile(join(outDir, 'index.html'), 'recovered'); },
      });
      await recovered.initialize();
      const status = await recovered.status();
      expect(status.last).toMatchObject({ result: 'interrupted', attemptId: running.attemptId, finishedAt: null, release: null, failure: null, beforeBoot: true });
      expect(status.last).not.toHaveProperty('liveReleaseAfter');
      if (phase === 'promoted') {
        expect(status.live?.release).toBe(running.attemptId);
        expect(await readFile(join(releasesRoot, 'current', 'index.html'), 'utf8')).toBe('committed before crash');
      } else expect(status.live).toBeNull();
      expect(await readFile(join(releasesRoot, 'build-state.json'), 'utf8')).toBe(bytes);
      const result = await recovered.build('rebuild');
      expect(result.ok).toBe(true);
      expect(await recovered.status()).toMatchObject({ last: { result: 'succeeded', beforeBoot: false, attemptId: result.attemptId }, record: 'ok' });
      expect(await readFile(join(releasesRoot, 'current', 'index.html'), 'utf8')).toBe('recovered');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  }, 40_000);
});
