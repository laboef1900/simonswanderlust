import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, lstat, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDataOwner } from '../src/data-owner.js';
import { acquireStorageOwner, type StorageOwner } from '../src/storage-owner.js';

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

// Exercise the shipped addon directly at its untrusted descriptor boundary.
// Keep these cases in the serial native integration suite, even without Postgres.
const addonPath = fileURLToPath(new URL('../native/owned-flock.node', import.meta.url));
const native: { tryLock(...args: unknown[]): boolean } = createRequire(import.meta.url)(addonPath);
function descriptor(path: string) {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let closed = false;
  const close = () => { if (!closed) { closeSync(fd); closed = true; } };
  cleanups.push(async () => close());
  return { fd, close };
}
// Real child processes/kernel stop and last-close state cannot use fake clocks.
// Poll observable state only; deadlines bound failed fixtures, never permit takeover.
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Native descriptor fixture did not reach expected state');
    await delay(20);
  }
}
async function nativeHolder(path: string, inheritance: 'none' | 'ordinary' | 'explicit' = 'none') {
  const ready = Promise.withResolvers<{ inode: string; childPid?: number; childInode?: string }>();
  const closed = Promise.withResolvers<void>();
  void closed.promise.catch(() => {});
  let childPid: number | undefined;
  const proc = spawn(process.execPath, ['--input-type=commonjs', '-e', `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const addon = require(process.argv[1]);
    const fd = fs.openSync(process.argv[2], fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    if (!addon.tryLock(fd)) process.exit(2);
    const st = fs.fstatSync(fd);
    const ready = { type: 'ready', inode: st.dev + ':' + st.ino };
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const mode = process.argv[3];
    if (mode !== 'none') {
      const witness = spawn(process.execPath, ['--input-type=commonjs', '-e', ${JSON.stringify(`
        const fs = require('node:fs');
        const inherited = process.argv[1] === 'explicit';
        const st = inherited ? fs.fstatSync(3) : null;
        process.send({ pid: process.pid, inode: st ? st.dev + ':' + st.ino : undefined });
        process.on('disconnect', () => {});
        setInterval(() => {}, 1000);
        setTimeout(() => process.exit(0), 60000);
      `)}, mode], { stdio: ['ignore', 'ignore', 'ignore', mode === 'explicit' ? fd : 'ignore', 'ipc'] });
      witness.once('error', () => process.exit(3));
      witness.once('message', message => send({ ...ready, childPid: message.pid, childInode: message.inode }));
    } else send(ready);
    process.stdin.resume();
    process.stdin.once('data', () => { fs.closeSync(fd); send({ type: 'closed' }); });
    setTimeout(() => process.exit(4), 60000);
  `, addonPath, path, inheritance], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', bytes => {
    output += bytes.toString();
    let newline: number;
    while ((newline = output.indexOf('\n')) >= 0) {
      const message = JSON.parse(output.slice(0, newline)) as { type: string; inode: string; childPid?: number; childInode?: string };
      output = output.slice(newline + 1);
      if (message.type === 'ready') { childPid = message.childPid; ready.resolve(message); }
      if (message.type === 'closed') closed.resolve();
    }
  });
  proc.once('error', ready.reject);
  proc.once('error', closed.reject);
  proc.once('exit', () => {
    ready.reject(new Error('Native descriptor holder exited before readiness'));
    closed.reject(new Error('Native descriptor holder exited before close'));
  });
  cleanups.push(async () => {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    if (proc.exitCode === null && proc.signalCode === null) await kill(proc);
  });
  return {
    proc, ready: await ready.promise,
    async close() { proc.stdin.write('close\n'); await closed.promise; },
    killWitness() {
      if (childPid === undefined) throw new Error('Native holder has no witness');
      process.kill(childPid, 'SIGKILL');
      childPid = undefined;
    },
  };
}

describe('owned native descriptor lifetime', () => {
  it('rejects invalid arguments and descriptors instead of reporting contention', async () => {
    for (const value of [undefined, null, '1', {}, true, 1n, NaN, Infinity, -1, 0.5, 2147483648]) {
      expect(() => native.tryLock(value)).toThrow(expect.objectContaining({ code: 'ERR_LOCK_FD' }));
    }
    expect(() => native.tryLock()).toThrow(expect.objectContaining({ code: 'ERR_LOCK_FD' }));
    expect(() => native.tryLock(1, 2)).toThrow(expect.objectContaining({ code: 'ERR_LOCK_FD' }));
    const dir = await directory();
    const handle = descriptor(join(dir, '.storage-owner.lock'));
    handle.close();
    expect(() => native.tryLock(handle.fd)).toThrow(expect.objectContaining({ code: 'ERR_LOCK_SYSCALL', syscall: 'fcntl(F_GETFD)', errno: expect.any(Number) }));
    const directoryFd = openSync(dir, 'r');
    try { expect(() => native.tryLock(directoryFd)).toThrow(expect.objectContaining({ code: 'ERR_LOCK_FILE' })); }
    finally { closeSync(directoryFd); }
  });
  it.each(['close', 'SIGKILL'] as const)('excludes a live and stopped owner until %s, retaining the inode', async release => {
    const path = join(await directory(), '.storage-owner.lock');
    const owner = await nativeHolder(path);
    const contender = descriptor(path);
    const inode = fstatSync(contender.fd);
    expect(owner.ready.inode).toBe(`${inode.dev}:${inode.ino}`);
    expect(native.tryLock(contender.fd)).toBe(false);
    owner.proc.kill('SIGSTOP');
    await until(() => process.platform === 'linux'
      ? /^State:\s+T/m.test(readFileSync(`/proc/${owner.proc.pid}/status`, 'utf8'))
      : execFileSync('/bin/ps', ['-o', 'state=', '-p', String(owner.proc.pid)], { encoding: 'utf8' }).trim().startsWith('T'));
    expect(native.tryLock(contender.fd)).toBe(false);
    owner.proc.kill('SIGCONT');
    if (release === 'close') {
      await owner.close();
      expect(owner.proc.exitCode).toBeNull();
      expect(owner.proc.signalCode).toBeNull();
    } else await kill(owner.proc);
    expect(native.tryLock(contender.fd)).toBe(true);
    expect((await lstat(path)).ino).toBe(inode.ino);
  }, 15000);
  it.each(['ordinary', 'explicit'] as const)('%s child proves close-on-exec and last-descriptor lifetime', async mode => {
    const path = join(await directory(), '.storage-owner.lock');
    const owner = await nativeHolder(path, mode);
    const pid = owner.ready.childPid!;
    const contender = descriptor(path);
    if (mode === 'explicit') expect(owner.ready.childInode).toBe(owner.ready.inode);
    expect(native.tryLock(contender.fd)).toBe(false);
    await kill(owner.proc);
    process.kill(pid, 0); // Witness really outlives the killed owner.
    expect(native.tryLock(contender.fd)).toBe(mode === 'ordinary');
    process.kill(pid, 0);
    owner.killWitness();
    if (mode === 'explicit') await until(() => native.tryLock(contender.fd));
    const inode = fstatSync(contender.fd);
    expect(`${inode.dev}:${inode.ino}`).toBe(owner.ready.inode);
    expect((await lstat(path)).ino).toBe(inode.ino);
  }, 15000);
});

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
  it('closes an unadmitted native descriptor when PostgreSQL ownership refuses admission', async () => {
    const dir = await directory(); const storageDir = join(dir, 'images');
    const blocker = retain(await acquireStorageOwner(databaseUrl!, { role: 'app' }));
    await expect(acquireDataOwner(databaseUrl!, { role: 'restore', storageDir })).rejects.toMatchObject({ code: 'storage_read_only' });
    const handle = descriptor(join(dir, '.storage-owner.lock'));
    expect(native.tryLock(handle.fd)).toBe(true);
    handle.close();
    await blocker.close();
    const replacement = retain(await acquireDataOwner(databaseUrl!, { role: 'restore', storageDir }));
    await replacement.assertNoAppSessions();
  });
});
