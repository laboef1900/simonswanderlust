// Optional independent-container mount check; not a substitute for probe.mjs.
import assert from 'node:assert/strict';
import { closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addon, fixtureRoot, openLock } from './proof-common.mjs';
const [operation, name] = process.argv.slice(2);
assert(['hold', 'try'].includes(operation));
assert(/^shared-[a-z0-9-]+$/.test(name ?? ''));
const dir = join(fixtureRoot, name);
try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
const h = openLock(dir);
let acquired;
try { acquired = addon.tryLock(h.fd); } catch (error) { closeSync(h.fd); throw error; }
console.log(JSON.stringify({ acquired, inode: h.inode, pid: process.pid, operation }));
if (!acquired || operation === 'try') {
  closeSync(h.fd);
  process.exitCode = acquired ? 0 : 2;
} else {
  const timer = setInterval(() => {}, 1000);
  let closed = false;
  function release() {
    if (closed) return;
    closed = true;
    closeSync(h.fd);
    clearInterval(timer);
    console.log(JSON.stringify({ released: true, inode: h.inode }));
  }
  process.on('SIGTERM', release);
  process.on('SIGINT', release);
}
