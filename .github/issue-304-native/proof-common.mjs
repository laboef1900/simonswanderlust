import assert from 'node:assert/strict';
import { constants, openSync, closeSync, fstatSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = dirname(fileURLToPath(import.meta.url));
const canonical = '/Users/simon/localGIT/simonswanderlust/.local/backlog-execution-2026-10-27/native-lock-prerequisite';
export const fixtureRoot = realpathSync(process.env.PROOF_FIXTURE_ROOT ?? root);
assert(fixtureRoot === canonical || fixtureRoot.startsWith(canonical + sep) ||
  (fixtureRoot === '/proof-fixtures' && /^swl-native-lock-proof-[a-z0-9-]+$/.test(process.env.PROOF_VOLUME ?? '')),
'Fixtures must be canonical evidence or the explicitly named proof-only Docker volume');
if (fixtureRoot === '/proof-fixtures') {
  const identity = JSON.parse(readFileSync(join(fixtureRoot, 'VOLUME-IDENTITY.json'), 'utf8'));
  assert.equal(identity.volume, process.env.PROOF_VOLUME);
  assert.equal(identity.proofOnly, true);
}
export function inside(path) {
  const actual = realpathSync(path);
  assert(actual === fixtureRoot || actual.startsWith(fixtureRoot + sep), 'Path escapes fixture root');
  return actual;
}
export const addon = createRequire(import.meta.url)(join(root, 'build/owned-flock.node'));
export function openLock(runDir) {
  inside(runDir);
  const path = join(runDir, '.storage-owner.lock');
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const s = fstatSync(fd);
    assert(s.isFile() && s.nlink === 1, 'Lock inode must be a single-linked regular file');
    assert.equal(s.uid, process.getuid(), 'Lock inode must belong to the proof user');
    assert.equal(s.mode & 0o077, 0, 'Lock inode must be private');
    return { fd, inode: `${s.dev}:${s.ino}`, path };
  } catch (error) { closeSync(fd); throw error; }
}
export function databaseConfig() {
  const filename = process.env.PROOF_DB_CONFIG;
  assert(filename && resolve(filename) === filename, 'PROOF_DB_CONFIG must name an absolute private evidence file');
  inside(filename);
  assert.equal(statSync(filename).mode & 0o077, 0, 'Fixture credential file must not be group/world readable');
  const c = JSON.parse(readFileSync(filename, 'utf8'));
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 55427);
  assert(/^swl_[a-z0-9_]+$/.test(c.database));
  assert.equal(c.database, process.env.PROOF_EXPECT_DATABASE, 'Explicit owned fixture database must match');
  assert.equal(c.ownedFixture, true, 'Operator must attest this is an owned fixture database');
  assert(typeof c.user === 'string' && c.user.length > 0);
  assert(typeof c.password === 'string' && c.password.length > 0);
  const url = new URL('postgresql://127.0.0.1:55427/');
  url.username = c.user; url.password = c.password; url.pathname = c.database;
  return { url: url.toString(), database: c.database };
}
export async function pgModule() {
  return createRequire(join(root, 'inputs/package.json'))('pg');
}
export async function connectControl() {
  const { url, database } = databaseConfig();
  const pg = await pgModule();
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000, application_name: 'swl-native-lock-proof:control', ssl: false });
  client.on('error', () => {}); // Never emit raw driver messages or credentials.
  await client.connect();
  const result = await client.query('SELECT current_database() AS database');
  assert.equal(result.rows[0]?.database, database);
  return client;
}
export async function storageModule() {
  // Exact unchanged approved-commit snapshot, not a replacement lease simulator.
  return import(new URL('./inputs/storage-owner.ts', import.meta.url));
}
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    assert(Date.now() < deadline, `Proof deadline exceeded: ${label}`);
    await delay(25);
  }
}
