// Preparation only. Downloads data/headers, never executable binaries or scripts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2];
assert(source, 'Pass the approved issue-304 worktree path (not an env/data path)');
const commit = '57cd3cc517e1e5a964e85463b26529ae1a8aacc5';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), commit);
const inputs = join(root, 'inputs');
assert(!existsSync(inputs), 'inputs already exists: retain it; do not overwrite provenance');
mkdirSync(inputs, { mode: 0o700 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = {};
for (const name of ['uploader/src/storage-owner.ts', 'uploader/src/main.ts', 'uploader/src/cli.ts', 'Dockerfile', 'uploader/package.json', 'uploader/package-lock.json', 'docs/superpowers/specs/2026-10-27-issue-304-weak-connection-write-contract.md']) {
  const bytes = readFileSync(join(source, name));
  const committed = execFileSync('git', ['show', `${commit}:${name}`], { cwd: source, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(sha(bytes), sha(committed), `Source differs from approved commit: ${name}`);
  hashes[name] = sha(bytes);
  if (name.endsWith('/storage-owner.ts')) writeFileSync(join(inputs, 'storage-owner.ts'), bytes, { flag: 'wx' });
}
// Preserve the repository's exact pg dependency closure and integrity values.
// These are existing protocol-test dependencies, not the locking implementation.
const lock = JSON.parse(readFileSync(join(source, 'uploader/package-lock.json'), 'utf8'));
assert.equal(lock.lockfileVersion, 3);
const manifest = { name: 'swl-native-lock-private-proof', version: '0.0.0', private: true, type: 'module', dependencies: { pg: lock.packages['node_modules/pg'].version } };
const packages = { '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies } };
function include(name) {
  const key = `node_modules/${name}`;
  if (packages[key]) return;
  const entry = lock.packages[key];
  assert(entry?.integrity && entry?.resolved?.startsWith('https://registry.npmjs.org/'), `Unqualified dependency ${name}`);
  assert(!entry.hasInstallScript, `Dependency has install script: ${name}`);
  assert(!Object.keys(lock.packages).some(k => k.startsWith(`${key}/node_modules/`)), `Nested resolution requires separate review: ${name}`);
  packages[key] = entry;
  for (const dep of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) include(dep);
  for (const dep of Object.keys(entry.peerDependencies ?? {})) {
    if (!entry.peerDependenciesMeta?.[dep]?.optional) include(dep);
  }
}
include('pg');
writeFileSync(join(inputs, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
writeFileSync(join(inputs, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }, null, 2) + '\n', { flag: 'wx' });
const archiveName = 'node-v26.12.1-headers.tar.gz';
const url = `https://nodejs.org/dist/v26.12.1/${archiveName}`;
const expected = 'a983cdcea96e85d137b9b807cc776bb5564fc9e3e1c9185d59bbfaa781efd08f';
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  assert(response.ok, 'Official data download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length <= 16 * 1024 * 1024, 'Unexpected official data size');
  return bytes;
}
const archive = await download(url);
assert.equal(sha(archive), expected, 'Official header archive digest mismatch');
writeFileSync(join(inputs, archiveName), archive, { flag: 'wx' });
const members = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h'];
mkdirSync(join(inputs, 'headers'));
// Extract only the four public Node-API headers. No downloaded source is executed.
execFileSync('tar', ['-xzf', join(inputs, archiveName), '-C', join(inputs, 'headers'), '--strip-components=3', ...members.map(n => `node-v26.12.1/include/node/${n}`)], { stdio: 'inherit' });
const licenseUrl = 'https://raw.githubusercontent.com/nodejs/node/v26.12.1/LICENSE';
const license = await download(licenseUrl);
writeFileSync(join(inputs, 'NODE-LICENSE'), license, { flag: 'wx' });
writeFileSync(join(inputs, 'provenance.json'), JSON.stringify({ commit, hashes, headers: { url, sha256: expected, checksumSource: 'https://nodejs.org/dist/v26.12.1/SHASUMS256.txt', trust: 'official HTTPS plus pinned SHA256; no release-signature verification claimed', members: Object.fromEntries(members.map(n => [n, sha(readFileSync(join(inputs, 'headers', n)))])) }, license: { url: licenseUrl, sha256: sha(license) }, packageLockSha256: sha(readFileSync(join(inputs, 'package-lock.json'))) }, null, 2) + '\n', { flag: 'wx' });
console.log('Prepared pinned headers, license, exact pg lock closure, and unchanged storage-owner snapshot; no build or proof run.');
