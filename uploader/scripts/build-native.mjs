// Build the reviewed owned Node-API addon, never a downloaded executable/package.
// macOS: Xcode command-line tools. Linux: the digest-pinned DHI native-build stage.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const uploader = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ?? resolve(uploader, '../.github/native-owner');
assert.equal(process.versions.node.split('.')[0], '26', 'Native build requires Node 26');
const scratch = mkdtempSync(join(tmpdir(), 'swl-native-build-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const version = '26.12.1';
const archiveName = `node-v${version}-headers.tar.gz`;
const expected = 'a983cdcea96e85d137b9b807cc776bb5564fc9e3e1c9185d59bbfaa781efd08f';
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  assert(response.ok, 'Pinned official header/license download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length <= 16 * 1024 * 1024, 'Unexpected official data size');
  return bytes;
}
try {
  for (const name of ['owned-flock.c', 'build-native.mjs']) copyFileSync(join(source, name), join(scratch, name));
  const inputs = join(scratch, 'inputs');
  const headers = join(inputs, 'headers');
  mkdirSync(headers, { recursive: true, mode: 0o700 });
  const url = `https://nodejs.org/dist/v${version}/${archiveName}`;
  const archive = await download(url);
  assert.equal(sha(archive), expected, 'Pinned Node header archive digest mismatch');
  writeFileSync(join(inputs, archiveName), archive);
  const members = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h'];
  execFileSync('tar', ['-xzf', join(inputs, archiveName), '-C', headers, '--strip-components=3', ...members.map(name => `node-v${version}/include/node/${name}`)], { stdio: 'inherit' });
  const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`;
  const license = await download(licenseUrl);
  writeFileSync(join(inputs, 'NODE-LICENSE'), license);
  writeFileSync(join(inputs, 'provenance.json'), JSON.stringify({ headers: { url, sha256: expected, members: Object.fromEntries(members.map(name => [name, sha(readFileSync(join(headers, name)))])) }, license: { url: licenseUrl, sha256: sha(license) } }, null, 2) + '\n');
  execFileSync(process.execPath, [join(scratch, 'build-native.mjs')], { stdio: 'inherit' });
  const output = join(uploader, 'native');
  mkdirSync(output, { recursive: true, mode: 0o755 });
  for (const [from, name] of [['build/owned-flock.node', 'owned-flock.node'], ['build/build.json', 'build.json'], ['inputs/provenance.json', 'provenance.json'], ['inputs/NODE-LICENSE', 'NODE-LICENSE']]) {
    const temporary = join(output, `${name}.part`);
    copyFileSync(join(scratch, from), temporary);
    renameSync(temporary, join(output, name));
  }
  console.log('Built native ownership addon with provenance. Mount/runtime qualification is a separate required gate.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
