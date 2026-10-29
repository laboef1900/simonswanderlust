import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
const root = dirname(fileURLToPath(import.meta.url));
assert.equal(process.versions.node.split('.')[0], '26');
assert(['linux', 'darwin'].includes(process.platform));
assert(process.platform === 'linux' ? ['arm64', 'x64'].includes(process.arch) : process.arch === 'arm64');
const provenance = JSON.parse(readFileSync(join(root, 'inputs/provenance.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [name, hash] of Object.entries(provenance.headers.members)) assert.equal(sha(readFileSync(join(root, 'inputs/headers', name))), hash);
const compiler = process.platform === 'darwin' ? '/usr/bin/clang' : '/usr/bin/cc';
function command(file, args) {
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, LC_ALL: 'C', SOURCE_DATE_EPOCH: '1793232000' } });
  assert(!result.error && result.status === 0, `Build tool failed: ${file}\n${result.stderr ?? ''}`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}
mkdirSync(join(root, 'build'), { mode: 0o700 }); // refuses overwriting a prior build
const args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-fvisibility=hidden', '-Iinputs/headers'];
if (process.platform === 'darwin') args.push('-arch', 'arm64', '-bundle', '-undefined', 'dynamic_lookup');
else args.push('-fPIC', '-shared', '-Wl,-z,relro,-z,now');
args.push('owned-flock.c', '-o', 'build/owned-flock.node');
const compilerVersion = command(compiler, ['--version']);
const compileOutput = command(compiler, args);
const binary = readFileSync(join(root, 'build/owned-flock.node'));
const binaryInspection = process.platform === 'linux'
  ? { elf: command('/usr/bin/readelf', ['-h', 'build/owned-flock.node']), dynamic: command('/usr/bin/readelf', ['-d', 'build/owned-flock.node']), versions: command('/usr/bin/readelf', ['--version-info', 'build/owned-flock.node']) }
  : { macho: command('/usr/bin/otool', ['-hv', 'build/owned-flock.node']), dependencies: command('/usr/bin/otool', ['-L', 'build/owned-flock.node']), sdk: command('/usr/bin/xcrun', ['--show-sdk-version']) };
const report = process.report.getReport().header;
writeFileSync(join(root, 'build/build.json'), JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, napi: process.versions.napi, libc: report.glibcVersionRuntime ?? 'darwin-libSystem', kernel: os.release(), compiler, compilerVersion, args, compileOutput, sourceSha256: sha(readFileSync(join(root, 'owned-flock.c'))), binarySha256: sha(binary), binaryInspection, baseBuild: process.env.NODE_BUILD ?? null, baseRuntime: process.env.NODE_RUNTIME ?? null }, null, 2) + '\n', { flag: 'wx' });
console.log('Native artifact and ABI/toolchain record written; no runtime qualification claimed.');
