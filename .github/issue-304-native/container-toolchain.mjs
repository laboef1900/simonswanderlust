// Build-stage only. No toolchain or package manager is copied to runtime.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0);
for (const name of ['NODE_BUILD', 'NODE_RUNTIME']) assert(/^dhi\.io\/node:[^@]+@sha256:[0-9a-f]{64}$/.test(process.env[name] ?? ''), 'Supply immutable reviewed DHI node references');
assert(/^\d{8}T\d{6}Z$/.test(process.env.DEBIAN_SNAPSHOT ?? ''), 'Supply one immutable Debian snapshot timestamp');
const os = readFileSync('/etc/os-release', 'utf8');
const release = parseEnv(os);
assert.equal(release.ID, 'debian', 'Recipe intentionally supports Debian/glibc DHI, not musl');
const suite = release.VERSION_CODENAME;
assert(/^[a-z]+$/.test(suite ?? ''), 'Cannot identify Debian suite');
assert.equal(suite, 'trixie', 'The reviewed snapshot is qualified for Debian trixie only');
const sources = '/proof/inputs/proof.sources.list';
writeFileSync(sources, `deb https://snapshot.debian.org/archive/debian/${process.env.DEBIAN_SNAPSHOT}/ ${suite} main\n`, { flag: 'wx' });
const options = ['-o', `Dir::Etc::sourcelist=${sources}`, '-o', 'Dir::Etc::sourceparts=-', '-o', 'Acquire::Retries=0'];
execFileSync('apt-get', [...options, 'update'], { stdio: 'inherit' });
// DHI's installed +dhi revisions cannot satisfy Debian development packages'
// exact-version dependencies. Align this disposable build stage's six-package
// dependency closure with the immutable snapshot; never copy these libraries to
// the runtime stage, which retains its original digest-pinned DHI packages.
const packages = [
  'gcc=4:14.2.0-1', 'libc6-dev=2.41-12+deb13u4', 'binutils=2.44-3',
  'gcc-14-base=14.2.0-19', 'libgcc-s1=14.2.0-19', 'libstdc++6=14.2.0-19',
  'libatomic1=14.2.0-19', 'libc6=2.41-12+deb13u4', 'libcrypt1=1:4.4.38-1',
];
execFileSync('apt-get', [...options, 'install', '-y', '--no-install-recommends', '--no-remove', '--allow-downgrades', ...packages], { stdio: 'inherit', env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
writeFileSync('/proof/inputs/toolchain-packages.txt', execFileSync('dpkg-query', ['-W', '-f=${Package}\t${Version}\t${Architecture}\n']), { flag: 'wx' });
writeFileSync('/proof/inputs/build-os-release.txt', os, { flag: 'wx' });
