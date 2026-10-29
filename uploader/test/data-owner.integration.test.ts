import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, lstat, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDataOwner } from '../src/data-owner.js';
import type { StorageOwner } from '../src/storage-owner.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'native-owner-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function retain(owner: StorageOwner) { cleanups.push(() => owner.close()); return owner; }
async function child(storageDir: string) {
  const ready = Promise.withResolvers<string>();
  const readOnly = Promise.withResolvers<void>();
  void readOnly.promise.catch(() => {});
  const proc = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { acquireDataOwner } from './src/data-owner.ts';
    const owner = await acquireDataOwner(process.env.TEST_DATABASE_URL, { role: 'app', storageDir: process.env.TEST_STORAGE_DIR });
    owner.signal.addEventListener('abort', () => process.stdout.write('READ_ONLY\\n'), { once: true });
    process.stdout.write(owner.applicationName + '\\n');
    process.stdin.resume();
    process.stdin.on('data', async () => { await owner.close(); process.exit(0); });
  `], { env: { ...process.env, TEST_STORAGE_DIR: storageDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', bytes => {
    out += bytes.toString();
    if (out.includes('\n')) ready.resolve(out.split('\n')[0]!);
    if (out.includes('\nREAD_ONLY\n')) readOnly.resolve();
  });
  proc.once('error', ready.reject);
  proc.once('error', readOnly.reject);
  proc.once('exit', () => ready.reject(new Error('Native owner exited before admission')));
  proc.once('exit', () => readOnly.reject(new Error('Native owner exited before containment')));
  cleanups.push(async () => { if (proc.exitCode === null && proc.signalCode === null) { const exited = once(proc, 'exit'); proc.kill('SIGKILL'); await exited; } });
  const name = await ready.promise;
  return { proc, name, readOnly: readOnly.promise };
}
async function kill(proc: ChildProcess) { const exited = once(proc, 'exit'); proc.kill('SIGKILL'); await exited; }

suite('product native filesystem + PostgreSQL ownership', () => {
  it.each(['app', 'restore'] as const)('takes native ownership before PG admission and preserves its inode for %s', async role => {
    const dir = await directory(); const storageDir = join(dir, 'images');
    const first = retain(await acquireDataOwner(databaseUrl!, { role, storageDir }));
    const inode = await lstat(join(dir, '.storage-owner.lock'));
    for (const competitor of ['app', 'restore'] as const) await expect(acquireDataOwner(databaseUrl!, { role: competitor, storageDir })).rejects.toMatchObject({ code: 'storage_read_only' });
    await first.close();
    const next = retain(await acquireDataOwner(databaseUrl!, { role: role === 'app' ? 'restore' : 'app', storageDir }));
    expect(next.isWritable()).toBe(true);
    expect((await lstat(join(dir, '.storage-owner.lock'))).ino).toBe(inode.ino);
  });
  it.each(['close', 'process death'] as const)('keeps excluding replacement after actual PG backend loss until %s', async release => {
    const dir = await directory(); const storageDir = join(dir, 'images');
    const live = await child(storageDir);
    const observer = new pg.Client({ connectionString: databaseUrl }); await observer.connect();
    cleanups.push(() => observer.end());
    const killed = await observer.query<{ terminated: boolean }>(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
      WHERE datname=current_database() AND application_name=$1 AND pid<>pg_backend_pid()`, [live.name]);
    expect(killed.rows).toEqual([{ terminated: true }]);
    await live.readOnly;
    await expect(acquireDataOwner(databaseUrl!, { role: 'restore', storageDir })).rejects.toMatchObject({ code: 'storage_read_only' });
    if (release === 'close') {
      const exited = once(live.proc, 'exit');
      live.proc.stdin.end('close\n');
      const [code, signal] = await exited;
      expect(code).toBe(0);
      expect(signal).toBeNull();
    } else {
      await kill(live.proc);
    }
    const restore = retain(await acquireDataOwner(databaseUrl!, { role: 'restore', storageDir }));
    await restore.assertNoAppSessions(); expect(restore.isWritable()).toBe(true);
  }, 15000);
  it('fails closed on a symlink lock rather than unlinking it', async () => {
    const dir = await directory(); const target = join(dir, 'not-a-lock'); await writeFile(target, 'keep');
    const path = join(dir, '.storage-owner.lock'); await symlink(target, path);
    await expect(acquireDataOwner(databaseUrl!, { role: 'app', storageDir: join(dir, 'images') })).rejects.toMatchObject({ code: 'storage_read_only' });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });
});
