import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { closeSync, fstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addon, openLock, databaseConfig, storageModule } from './proof-common.mjs';

const [mode, runDir] = process.argv.slice(2);
const send = message => { if (process.connected) process.send(message); };
if (mode === 'witness' || mode === 'inherited-witness') {
  let inode = null;
  if (mode === 'inherited-witness') {
    const s = fstatSync(3); inode = `${s.dev}:${s.ino}`;
    // Node startup sets CLOEXEC again; that does not close this inherited fd.
    // The negative control proves lifetime via same inode and last-close, not flags.
  }
  send({ type: 'ready', pid: process.pid, inode });
  process.on('disconnect', () => {}); // Deliberately outlive the owner in the inheritance proof.
  setInterval(() => {}, 1000);
  // Safety bound is child cleanup, NEVER lock takeover. The parent must prove
  // release well before this timer; a timeout is a failed proof.
  setTimeout(() => process.exit(0), 60000);
} else {
  let handle;
  let owner;
  const children = new Set();
  const events = [];
  try {
    handle = openLock(runDir);
    const acquired = addon.tryLock(handle.fd);
    events.push(acquired ? 'filesystem-acquired' : 'filesystem-busy');
    if (!acquired) {
      closeSync(handle.fd); handle = undefined;
      send({ type: 'ready', acquired: false, pgAttempted: false, events });
      process.disconnect();
    } else {
      const inode = handle.inode;
      let dbState = 'not-requested';
      if (mode === 'dual' || mode === 'restore') {
        const { url } = databaseConfig();
        const { acquireStorageOwner } = await storageModule();
        events.push('postgres-acquisition-start');
        try {
          owner = await acquireStorageOwner(url, { role: mode === 'restore' ? 'restore' : 'app' });
          events.push('postgres-acquired');
          if (mode === 'restore') {
            await owner.assertNoAppSessions();
            events.push('app-sessions-absent');
          }
          owner.assertWritable();
          dbState = 'writable';
          events.push('admission-permitted');
          owner.signal.addEventListener('abort', () => {
            dbState = 'readonly';
            events.push('postgres-readonly-filesystem-retained');
            send({ type: 'db-lost', writable: owner.isWritable(), filesystemHeld: handle !== undefined });
          }, { once: true });
        } catch {
          events.push('postgres-admission-refused');
          await owner?.close().catch(() => {});
          closeSync(handle.fd); handle = undefined;
          events.push('filesystem-closed-after-admission-refusal');
          send({ type: 'ready', acquired: false, pgAttempted: true, events });
          process.disconnect();
        }
      }
      if (handle) {
        send({ type: 'ready', acquired: true, inode, pid: process.pid, applicationName: owner?.applicationName ?? null, dbState, events });
        let queue = Promise.resolve();
        process.on('message', message => {
          queue = queue.then(async () => {
            const result = { type: 'reply', id: message.id };
            if (message.command === 'status') {
              Object.assign(result, { filesystemHeld: handle !== undefined, writable: owner?.isWritable() ?? null, events });
            } else if (message.command === 'spawn-child' || message.command === 'inherit-child') {
              assert(handle);
              const explicit = message.command === 'inherit-child';
              const child = fork(fileURLToPath(import.meta.url), [explicit ? 'inherited-witness' : 'witness', runDir], {
                execArgv: [], env: process.env,
                stdio: explicit ? ['ignore', 'ignore', 'ignore', handle.fd, 'ipc'] : ['ignore', 'ignore', 'ignore', 'ipc'],
              });
              children.add(child);
              const ready = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Child readiness timeout')), 5000);
                child.once('error', reject);
                child.once('message', value => { clearTimeout(timer); resolve(value); });
              });
              Object.assign(result, { child: ready });
            } else if (message.command === 'close') {
              // There is no filesystem work in flight in this probe. Existing PG
              // protocol ends before the outer lifetime descriptor is released.
              await owner?.close();
              events.push('postgres-closed');
              if (handle) closeSync(handle.fd);
              handle = undefined;
              events.push('filesystem-closed');
              Object.assign(result, { events });
            } else if (message.command === 'exit') {
              assert(!handle, 'Clean exit requires close first');
              for (const child of children) child.kill('SIGKILL');
              send(result);
              process.removeAllListeners('disconnect');
              process.disconnect();
              return;
            } else throw new Error('Unknown proof command');
            send(result);
          }).catch(() => { send({ type: 'fatal', reason: 'worker-operation-failed' }); process.exit(1); });
        });
        process.on('disconnect', () => {
          for (const child of children) child.kill('SIGKILL');
          process.exit(1);
        });
      }
    }
  } catch {
    // No raw PostgreSQL/connection/credential errors in IPC, stderr or reports.
    send({ type: 'fatal', reason: 'worker-admission-failed' });
    process.exit(1);
  }
}
