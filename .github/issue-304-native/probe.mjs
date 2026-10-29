import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, mkdirSync, readFileSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { addon, root, fixtureRoot, openLock, connectControl, databaseConfig, storageModule, until, delay } from './proof-common.mjs';

assert.equal(process.versions.node.split('.')[0], '26');
const filesystemOnly = process.argv.includes('--filesystem-only');
assert(process.argv.slice(2).every(a => a === '--filesystem-only'), 'Unknown probe argument');
const runDir = join(fixtureRoot, `run-${Date.now()}-${randomUUID()}`);
mkdirSync(runDir, { mode: 0o700 });
const children = new Set();
const descendants = new Set();
const assertions = [];
let control;
let blocker;
let step = 'environment';
const build = JSON.parse(readFileSync(join(root, 'build/build.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(build.binarySha256, hash(readFileSync(join(root, 'build/owned-flock.node'))));
assert.equal(build.platform, process.platform);
assert.equal(build.arch, process.arch);
const header = process.report.getReport().header;
if (process.platform === 'linux') assert(header.glibcVersionRuntime && build.libc, 'This packaging recipe qualifies glibc only');
const report = {
  status: 'running', runDir, startedAt: new Date().toISOString(), scope: filesystemOnly ? 'filesystem-only; PostgreSQL and restore NOT qualified' : 'filesystem-and-real-postgres',
  platform: process.platform, arch: process.arch, kernel: os.release(), node: process.version, napi: process.versions.napi,
  libc: header.glibcVersionRuntime ?? 'darwin-libSystem', build, uid: process.getuid(),
  mount: { statfsType: String(statfsSync(runDir).type), volumeClaim: process.env.PROOF_VOLUME ?? null,
    classification: process.env.PROOF_MOUNT_CLASS ?? 'unclassified-not-deployment-qualified',
    hostEvidence: process.env.PROOF_HOST_EVIDENCE ?? 'not-supplied' }, assertions,
};
if (process.platform === 'linux') writeFileSync(join(runDir, 'mountinfo.txt'), readFileSync('/proc/self/mountinfo'), { flag: 'wx', mode: 0o600 });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  for (const cp of children) {
    if (cp.exitCode === null && cp.signalCode === null) cp.kill('SIGKILL');
  }
  for (const pid of descendants) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  report.status = 'interrupted';
  report.failedStep = step;
  report.finishedAt = new Date().toISOString();
  try {
    writeFileSync(join(runDir, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch {} // Never overwrite a completed report during process teardown.
  process.exit(signal === 'SIGINT' ? 130 : 143);
});
function passed(name, evidence = {}) { assertions.push({ name, ...evidence }); }
function start(mode) {
  const cp = fork(join(root, 'proof-worker.mjs'), [mode, runDir], { execArgv: [], env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.add(cp);
  const messages = [];
  let exited = false;
  let exitCode;
  let exitSignal;
  let failed = false;
  cp.on('message', value => messages.push(value));
  cp.on('error', () => { failed = true; });
  cp.on('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });
  async function message(type, id) {
    let found;
    await until(() => {
      assert(!failed && !messages.some(v => v.type === 'fatal'), 'Proof worker failed');
      const index = messages.findIndex(v => v.type === type && (id === undefined || v.id === id));
      if (index >= 0) { found = messages.splice(index, 1)[0]; return true; }
      assert(!exited, 'Proof worker exited before expected evidence');
      return false;
    }, `worker-${type}`);
    return found;
  }
  return { cp, message,
    async request(command) { const id = randomUUID(); cp.send({ id, command }); return message('reply', id); },
    async exit() { await until(() => exited, 'worker-exit'); return { exitCode, exitSignal }; },
  };
}
async function owner(mode = 'filesystem') {
  const w = start(mode); const ready = await w.message('ready');
  assert.equal(ready.acquired, true, 'Expected actual syscall acquisition');
  return { ...w, ready };
}
async function contention(mode = 'filesystem') {
  const w = start(mode); const ready = await w.message('ready');
  assert.equal(ready.acquired, false, 'Live owner must exclude contender');
  assert.equal(ready.pgAttempted, false, 'Filesystem denial must precede PostgreSQL acquisition');
  assert.equal((await w.exit()).exitCode, 0);
  return ready;
}
async function clean(w) {
  const closed = await w.request('close');
  await w.request('exit');
  assert.equal((await w.exit()).exitCode, 0);
  return closed;
}
async function assertStopped(w) {
  await until(() => {
    if (process.platform === 'linux') return /^State:\s+T/m.test(readFileSync(`/proc/${w.cp.pid}/status`, 'utf8'));
    assert.equal(process.platform, 'darwin');
    return execFileSync('/bin/ps', ['-o', 'state=', '-p', String(w.cp.pid)], { encoding: 'utf8' }).trim().startsWith('T');
  }, 'kernel-reports-stopped-owner');
}
try {
  step = 'invalid-input-and-descriptor-errors';
  for (const value of [undefined, null, '1', {}, true, 1n, NaN, Infinity, -1, 0.5, 2147483648]) {
    assert.throws(() => addon.tryLock(value), error => error.code === 'ERR_LOCK_FD');
  }
  assert.throws(() => addon.tryLock(), error => error.code === 'ERR_LOCK_FD');
  assert.throws(() => addon.tryLock(1, 2), error => error.code === 'ERR_LOCK_FD');
  const closed = openLock(runDir);
  closeSync(closed.fd);
  assert.throws(() => addon.tryLock(closed.fd), error => error.code === 'ERR_LOCK_SYSCALL' && error.syscall === 'fcntl(F_GETFD)' && Number.isInteger(error.errno));
  const directoryFd = openSync(runDir, 'r');
  try { assert.throws(() => addon.tryLock(directoryFd), error => error.code === 'ERR_LOCK_FILE'); }
  finally { closeSync(directoryFd); }
  passed(step, { contract: 'bad types/ranges/arity throw; closed fd produces syscall error, never busy/success' });

  step = 'two-process-contention-and-stopped-live-owner';
  let a = await owner();
  const initialInode = a.ready.inode;
  const b = await contention();
  assert(a.cp.pid > 0);
  a.cp.kill('SIGSTOP');
  await assertStopped(a);
  for (let i = 0; i < 3; i++) { await contention(); await delay(100); }
  a.cp.kill('SIGCONT');
  assert.equal((await a.request('status')).filesystemHeld, true);
  passed(step, { ownerPid: a.cp.pid, inode: initialInode, stoppedStateConfirmed: true, competingAttempts: 4, contender: b.events });

  step = 'clean-close-releases-with-owner-still-alive';
  const closeEvidence = await a.request('close');
  const afterClose = await owner();
  assert.equal(afterClose.ready.inode, initialInode);
  await clean(afterClose);
  await a.request('exit'); assert.equal((await a.exit()).exitCode, 0);
  passed(step, { events: closeEvidence.events, sameInode: true });

  step = 'process-death-releases-without-unlink';
  a = await owner();
  a.cp.kill('SIGKILL');
  assert.equal((await a.exit()).exitSignal, 'SIGKILL');
  const afterKill = await owner();
  assert.equal(afterKill.ready.inode, initialInode);
  await clean(afterKill);
  passed(step, { sameInode: true });

  step = 'default-child-does-not-inherit-lifetime';
  a = await owner();
  const child = (await a.request('spawn-child')).child;
  descendants.add(child.pid);
  process.kill(child.pid, 0);
  await contention();
  a.cp.kill('SIGKILL'); await a.exit();
  process.kill(child.pid, 0); // Child really outlived the lock owner.
  const whileChildLives = await owner();
  process.kill(child.pid, 0);
  assert.equal(whileChildLives.ready.inode, initialInode);
  await clean(whileChildLives);
  process.kill(child.pid, 'SIGKILL'); descendants.delete(child.pid);
  passed(step, { childPid: child.pid, acquiredWhileChildAlive: true, closeOnExecCheckedByAddon: true });

  step = 'explicit-inheritance-negative-control';
  a = await owner();
  const inherited = (await a.request('inherit-child')).child;
  descendants.add(inherited.pid);
  assert.equal(inherited.inode, initialInode);
  a.cp.kill('SIGKILL'); await a.exit();
  await contention(); // Must fail while a deliberately duplicated descriptor survives.
  process.kill(inherited.pid, 'SIGKILL'); descendants.delete(inherited.pid);
  // Kernel release after child death is asynchronous relative to kill(2).
  await until(() => {
    const h = openLock(runDir);
    try { return addon.tryLock(h.fd); } finally { closeSync(h.fd); }
  }, 'explicit-inherited-descriptor-death');
  const afterInheritedDeath = await owner(); await clean(afterInheritedDeath);
  passed(step, { childPid: inherited.pid, lockSurvivedOwnerDeath: true, releasedAfterLastDescriptorDeath: true });

  if (!filesystemOnly) {
    step = 'real-database-connection-loss-retains-filesystem';
    control = await connectControl();
    a = await owner('dual');
    const cfg = databaseConfig();
    const backend = await control.query('SELECT pid FROM pg_stat_activity WHERE datname = $1 AND application_name = $2', [cfg.database, a.ready.applicationName]);
    assert.equal(backend.rows.length, 1);
    const pid = backend.rows[0].pid;
    // Terminate ONLY the dedicated session of this owned child; never the
    // container, database, unrelated sessions, pool clients, or server itself.
    const killed = await control.query('SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE pid = $1 AND datname = $2 AND application_name = $3 AND usename = current_user', [pid, cfg.database, a.ready.applicationName]);
    assert.equal(killed.rows[0]?.terminated, true);
    const lost = await a.message('db-lost');
    assert.equal(lost.writable, false);
    assert.equal(lost.filesystemHeld, true);
    const { STORAGE_OWNER_LOCK_KEY } = await storageModule();
    let pgAcquired = false;
    await until(async () => {
      const r = await control.query('SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired', [...STORAGE_OWNER_LOCK_KEY]);
      pgAcquired = r.rows[0]?.acquired === true;
      return pgAcquired;
    }, 'postgres-session-lock-released');
    assert(pgAcquired);
    await control.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [...STORAGE_OWNER_LOCK_KEY]);
    await contention('restore');
    await contention('dual');
    const state = await a.request('status');
    assert.equal(state.writable, false); assert.equal(state.filesystemHeld, true);
    await clean(a);
    passed(step, { database: cfg.database, terminatedBackendPid: pid, postgresLockBecameAvailable: true, filesystemStillExcludedAppAndRestore: true, realStorageOwnerLatchedReadOnly: true });

    step = 'restore-entry-filesystem-then-postgres-then-session-fence';
    const restore = await owner('restore');
    assert.deepEqual(restore.ready.events, ['filesystem-acquired', 'postgres-acquisition-start', 'postgres-acquired', 'app-sessions-absent', 'admission-permitted']);
    await contention('dual');
    const released = await clean(restore);
    assert(released.events.indexOf('postgres-closed') < released.events.indexOf('filesystem-closed'));
    passed(step, { admissionEvents: restore.ready.events, releaseEvents: released.events, noRestoreDataMutation: true });

    step = 'postgres-admission-refusal-closes-unadmitted-filesystem-descriptor';
    const { acquireStorageOwner } = await storageModule();
    blocker = await acquireStorageOwner(cfg.url, { role: 'app' });
    const denied = start('restore'); const denial = await denied.message('ready');
    assert.equal(denial.acquired, false); assert.equal(denial.pgAttempted, true);
    assert.deepEqual(denial.events, ['filesystem-acquired', 'postgres-acquisition-start', 'postgres-admission-refused', 'filesystem-closed-after-admission-refusal']);
    assert.equal((await denied.exit()).exitCode, 0);
    const filesystemAvailable = await owner(); await clean(filesystemAvailable);
    await blocker.close(); blocker = undefined;
    passed(step, { events: denial.events });

    step = 'restore-refuses-draining-app-sessions-after-both-locks';
    const pg = await (await import('./proof-common.mjs')).pgModule();
    const draining = new pg.Client({ connectionString: cfg.url, application_name: `swl-app:proof-draining-${randomUUID()}`, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
    draining.on('error', () => {});
    try {
      await draining.connect();
      const denied = start('restore'); const denial = await denied.message('ready');
      assert.equal(denial.acquired, false); assert.equal(denial.pgAttempted, true);
      assert(denial.events.includes('postgres-acquired'));
      assert(!denial.events.includes('admission-permitted'));
      assert.equal((await denied.exit()).exitCode, 0);
      passed(step, { events: denial.events });
    } finally { await draining.end(); }
    const finalRestore = await owner('restore'); await clean(finalRestore);
  }
  const final = statSync(join(runDir, '.storage-owner.lock'));
  assert.equal(`${final.dev}:${final.ino}`, initialInode);
  passed('stable-lock-inode-preserved-through-all-cases');
  report.status = 'passed-for-recorded-scope-only';
} catch {
  report.status = 'failed'; report.failedStep = step;
  // A failed proof is NOT fallback permission; retain all fixture files.
  process.exitCode = 1;
} finally {
  for (const cp of children) {
    if (cp.exitCode === null && cp.signalCode === null) cp.kill('SIGKILL');
  }
  for (const pid of descendants) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await blocker?.close().catch(() => {});
  await control?.end().catch(() => {});
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(runDir, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, scope: report.scope, failedStep: report.failedStep ?? null, report: join(runDir, 'result.json') }));
}
