#!/usr/bin/env python3
"""Temporary #304 CI qualification only; no product entry point or data mutation.

Run via issue-304-native.yml on fresh standard public Linux runners. Every raw
command stream remains private. Only selected, secret-screened evidence is exported.
Failure is not fallback permission. Never remove volumes or lock inodes.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import signal
import socket
import subprocess
import sys
import time

BASE = '57cd3cc517e1e5a964e85463b26529ae1a8aacc5'
BUILD = 'dhi.io/node:26-dev@sha256:c8939885965365c675a024d062bcb761bda4b47e95ce0323aa998ac9bc312fd6'
RUNTIME = 'dhi.io/node:26@sha256:7312902a19cc5724ca350fb631e397cdb1bd6235c1c3f6905246d92e25842a77'
SNAPSHOT = '20261029T000000Z'
PACKET = Path(__file__).resolve().parent
FILES = ['.dockerignore', 'Dockerfile.proof', 'owned-flock.c', 'build-native.mjs',
         'container-toolchain.mjs', 'proof-common.mjs', 'proof-worker.mjs',
         'probe.mjs', 'mount-peer.mjs', 'init-volume.mjs', 'configure-db.mjs',
         'prepare-inputs.mjs', 'dhi-image-inventory.json', 'qualify.py']
os.umask(0o077)
arch = os.environ['EXPECTED_ARCH']
generation = os.environ['GENERATION']
assert re.fullmatch(r'[0-9]+-[0-9]+-(amd64|arm64)', generation)
assert arch in ('amd64', 'arm64') and generation.endswith('-' + arch)
assert os.environ['RUNNER_LABEL'] == {'amd64': 'ubuntu-24.04', 'arm64': 'ubuntu-24.04-arm'}[arch]
private = Path(os.environ['RUN_ROOT']).resolve()
export = Path(os.environ['EVIDENCE_EXPORT']).resolve()
temp = Path(os.environ['RUNNER_TEMP']).resolve()
assert private.parent == temp and export.parent == temp and private != export
private.mkdir(mode=0o700)
export.mkdir(mode=0o700)
password = secrets.token_hex(32)
database = 'swl_native_' + generation.replace('-', '_')
label = 'swl.issue304.generation=' + generation
image = 'swl-native-lock-proof:' + generation
containers = []
steps = []
mounts = {}
peers = {}
provenance = {'status': 'running', 'head': os.environ['CHECKOUT_SHA'], 'sourceCommit': BASE,
              'generation': generation, 'runner': os.environ['RUNNER_LABEL'],
              'buildIndex': BUILD, 'runtimeIndex': RUNTIME, 'debianSnapshot': SNAPSHOT,
              'database': database, 'scope': 'fresh native Linux CI fixtures only',
              'limitations': ['Not evidence for an uninspected deployment data mount.',
                  'NFS/SMB/FUSE, Docker Desktop sharing and musl are not qualified.',
                  'No product API/restore integration; #305 remains separate.',
                  'No forced ENOLCK or genuinely non-CLOEXEC descriptor rejection probe.',
                  'Node headers use pinned SHA256 and HTTPS, not release signatures.',
                  'PG image tag is resolved at run time and its exact image/digest recorded.',
                  'Private fixtures survive until the disposable runner is destroyed; no volume deletion.']}
stage = 'host-preconditions'


def emit(name, value):
    text = json.dumps(value, indent=2) + '\n'
    assert password not in text and 'postgresql://' not in text
    assert '"password"' not in text and '"auths"' not in text
    with (export / name).open('x') as handle:
        handle.write(text)


def run(args, *, data=None, ok=(0,), timeout=120):
    # No shell, argv dump, inherited application environment or raw output in CI.
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'DOCKER_CONFIG') if k in os.environ}
    env['LC_ALL'] = 'C'
    result = subprocess.run(args, input=data, capture_output=True, text=True,
                            timeout=timeout, env=env)
    n = len(steps)
    (private / f'command-{n}.stdout').write_text(result.stdout)
    (private / f'command-{n}.stderr').write_text(result.stderr)
    steps.append({'stage': stage, 'command': Path(args[0]).name, 'exit': result.returncode})
    if result.returncode not in ok:
        raise RuntimeError('command-failed')
    return result


def docker(*args, **kwargs):
    return run(['docker', *args], **kwargs)


def inspect_image(ref):
    item = json.loads(docker('image', 'inspect', ref).stdout)[0]
    assert item['Architecture'] == arch and item['Os'] == 'linux'
    return {'id': item['Id'], 'repoDigests': item['RepoDigests'], 'arch': item['Architecture'],
            'os': item['Os'], 'user': item['Config']['User']}


def create_run(name, args, *, data=None, ok=(0,), timeout=120):
    full = 'swl-native-lock-proof-' + generation + '-' + name
    assert full not in containers
    containers.append(full)
    result = docker('run', '--name', full, '--label', label, *args,
                    data=data, ok=ok, timeout=timeout)
    return full, result


def mount_args(identity, mount):
    return ['--env', 'PROOF_VOLUME=' + identity, '--mount', mount]


def local_mount(path):
    # Positive filesystem allowlist; Docker overlay is not a qualifying data mount.
    row = json.loads(run(['sudo', '-n', 'findmnt', '--json', '--target', str(path),
                         '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS']).stdout)['filesystems'][0]
    assert row['fstype'] in ('ext4', 'xfs', 'btrfs')
    return row


def copy_json(container, remote, name):
    target = private / name
    docker('cp', container + ':' + remote, str(target))
    value = json.loads(target.read_text())
    emit(name, value)
    return value


def wait_owner(name):
    for _ in range(100):
        text = docker('logs', name).stdout.strip()
        if text:
            value = json.loads(text.splitlines()[0])
            assert value['acquired'] is True
            return value
        time.sleep(0.1)
    raise RuntimeError('owner-readiness-timeout')


def cross_container(kind, identity, mount):
    args = mount_args(identity, mount)
    name, _ = create_run(kind + '-owner', ['-d', *args, image, 'mount-peer.mjs', 'hold', 'shared-cross-container'])
    acquired = wait_owner(name)
    records = [acquired]
    def contender(suffix, busy):
        _, result = create_run(kind + '-' + suffix, [*args, image, 'mount-peer.mjs', 'try', 'shared-cross-container'], ok=(2,) if busy else (0,))
        observed = json.loads(result.stdout)
        assert observed['acquired'] is (not busy) and observed['inode'] == acquired['inode']
        records.append(observed)
    contender('live-contender', True)
    docker('kill', '--signal', 'STOP', name)
    pid = int(docker('inspect', '--format', '{{.State.Pid}}', name).stdout)
    stopped = None
    for _ in range(100):
        state = Path(f'/proc/{pid}/status').read_text()
        stopped = re.search(r'^State:\s+(T.*)$', state, re.M)
        if stopped:
            break
        time.sleep(0.05)
    assert stopped is not None
    records.append({'hostPid': pid, 'kernelState': stopped.group(1)})
    for n in range(3):
        contender('stopped-contender-' + str(n), True)
        time.sleep(0.25)
    docker('kill', '--signal', 'KILL', name)
    assert docker('wait', name).stdout.strip() == '137'
    contender('after-death', False)
    clean, _ = create_run(kind + '-clean-owner', ['-d', *args, image, 'mount-peer.mjs', 'hold', 'shared-cross-container'])
    clean_ready = wait_owner(clean)
    assert clean_ready['inode'] == acquired['inode']
    docker('stop', '--time', '10', clean)
    assert docker('wait', clean).stdout.strip() == '0'
    released = json.loads(docker('logs', clean).stdout.strip().splitlines()[-1])
    assert released == {'released': True, 'inode': acquired['inode']}
    records.append(released)
    contender('after-clean-release', False)
    peers[kind] = {'status': 'passed-for-recorded-mount-only', 'observations': records}


def interrupted(signum, frame):
    raise RuntimeError('runner-interrupted')


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    assert platform.system() == 'Linux'
    assert platform.machine() == {'amd64': 'x86_64', 'arm64': 'aarch64'}[arch]
    observed_head = run(['git', '-C', str(PACKET.parent.parent), 'rev-parse', 'HEAD']).stdout.strip()
    provenance['observedCheckout'] = observed_head
    stage = 'host-checkout'
    assert observed_head == os.environ['CHECKOUT_SHA']
    binfmt = Path('/proc/sys/fs/binfmt_misc')
    entries = {p.name: p.read_text() for p in binfmt.iterdir() if p.name not in ('register', 'status')} if binfmt.exists() else {}
    stage = 'host-binfmt'
    provenance['enabledBinfmtNames'] = [name for name, value in entries.items() if 'enabled' in value]
    assert not any('enabled' in v for v in entries.values())
    context = json.loads(docker('context', 'inspect').stdout)[0]
    assert context['Endpoints']['docker']['Host'] == 'unix:///var/run/docker.sock'
    info = json.loads(docker('info', '--format', '{{json .}}').stdout)
    assert info['OSType'] == 'linux' and info['Architecture'] in ({'amd64', 'x86_64'} if arch == 'amd64' else {'arm64', 'aarch64'})
    assert not docker('ps', '-aq').stdout.strip(), 'Requires a fresh disposable daemon'
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 55427))
    host = {'uname': list(platform.uname()), 'cpu': json.loads(run(['lscpu', '--json']).stdout),
            'binfmtEntries': entries, 'docker': {k: info[k] for k in ('OSType', 'Architecture', 'KernelVersion', 'OperatingSystem', 'ServerVersion', 'Driver')},
            'virtualization': run(['systemd-detect-virt'], ok=(0, 1)).stdout.strip()}
    emit('host.json', host)
    provenance['sourceHashes'] = {f: hashlib.sha256((PACKET / f).read_bytes()).hexdigest() for f in FILES}
    stage = 'prepare-pinned-inputs'
    run(['node', str(PACKET / 'prepare-inputs.mjs'), os.environ['APPROVED_SOURCE']], timeout=300)
    emit('inputs.json', json.loads((PACKET / 'inputs/provenance.json').read_text()))
    stage = 'native-dhi-build'
    for ref in (BUILD, RUNTIME):
        docker('pull', '--platform', 'linux/' + arch, ref, timeout=600)
    provenance['baseImages'] = {'build': inspect_image(BUILD), 'runtime': inspect_image(RUNTIME)}
    docker('build', '--platform', 'linux/' + arch, '--pull', '--no-cache',
           '--build-arg', 'NODE_BUILD=' + BUILD, '--build-arg', 'NODE_RUNTIME=' + RUNTIME,
           '--build-arg', 'DEBIAN_SNAPSHOT=' + SNAPSHOT,
           '-f', str(PACKET / 'Dockerfile.proof'), '-t', image, str(PACKET), timeout=1800)
    provenance['proofImage'] = inspect_image(image)
    assert provenance['proofImage']['user'] == '1000'
    stage = 'owned-postgres-fixture'
    docker('pull', '--platform', 'linux/' + arch, 'postgres:18', timeout=600)
    provenance['postgresImage'] = inspect_image('postgres:18')
    password_file = private / 'postgres-password'
    password_file.write_text(password)
    pg, _ = create_run('postgres', ['-d', '--log-driver', 'none',
        '--publish', '127.0.0.1:55427:5432', '--tmpfs', '/var/lib/postgresql:rw',
        '--mount', f'type=bind,src={password_file},dst=/run/proof-password,readonly',
        '--env', 'POSTGRES_PASSWORD_FILE=/run/proof-password', '--env', 'POSTGRES_DB=' + database,
        provenance['postgresImage']['id']])
    provenance['postgresVersion'] = docker('exec', pg, 'postgres', '--version').stdout.strip()
    assert re.search(r'\b18\.', provenance['postgresVersion'])
    for attempt in range(120):
        ready = docker('exec', pg, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', ok=(0, 1, 2))
        if ready.returncode == 0:
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('postgres-readiness-timeout')
    config = json.dumps({'host': '127.0.0.1', 'port': 55427, 'database': database,
                         'user': 'postgres', 'password': password, 'ownedFixture': True})
    for kind in ('bind', 'volume'):
        stage = kind + '-mount-preconditions'
        identity = 'swl-native-lock-proof-' + generation + '-' + kind
        if kind == 'bind':
            location = private / 'bind-fixture'
            location.mkdir(mode=0o700)
            mount = f'type=bind,src={location},dst=/proof-fixtures'
            mounts[kind] = {'type': 'bind', 'source': str(location), 'backing': local_mount(location)}
        else:
            assert docker('volume', 'inspect', identity, ok=(0, 1)).returncode == 1
            docker('volume', 'create', '--driver', 'local', '--label', label, identity)
            v = json.loads(docker('volume', 'inspect', identity).stdout)[0]
            assert v['Driver'] == 'local' and not v['Options']
            mount = f'type=volume,src={identity},dst=/proof-fixtures,volume-nocopy'
            mounts[kind] = {'type': 'volume', 'name': identity, 'driver': v['Driver'],
                            'options': v['Options'], 'backing': local_mount(v['Mountpoint'])}
        args = mount_args(identity, mount)
        create_run(kind + '-init', ['--user', '0', *args, image, 'init-volume.mjs'])
        create_run(kind + '-config', ['-i', *args, '--env', 'PROOF_EXPECT_DATABASE=' + database,
                                     image, 'configure-db.mjs'], data=config)
        stage = kind + '-full-probe'
        container, result = create_run(kind + '-probe', ['--network', 'host', *args,
            '--env', 'PROOF_EXPECT_DATABASE=' + database, '--env', 'PROOF_DB_CONFIG=/proof-fixtures/db.json',
            '--env', 'PROOF_MOUNT_CLASS=native-linux-local-' + kind,
            '--env', 'PROOF_HOST_EVIDENCE=host.json+mounts.json', image, 'probe.mjs'], ok=(0, 1), timeout=300)
        summary = json.loads(result.stdout.strip().splitlines()[-1])
        assert re.fullmatch(r'/proof-fixtures/run-[0-9]+-[0-9a-f-]{36}/result.json', summary['report'])
        report = copy_json(container, summary['report'], kind + '-result.json')
        assert result.returncode == 0 and report['status'] == 'passed-for-recorded-scope-only'
        assert report['scope'] == 'filesystem-and-real-postgres' and report['uid'] == 1000
        assert report['arch'] == {'amd64': 'x64', 'arm64': 'arm64'}[arch] and report['platform'] == 'linux'
        assert report['libc'] and report['build']['baseBuild'] == BUILD and report['build']['baseRuntime'] == RUNTIME
        # Export selected mount evidence only, not the raw namespace mountinfo.
        mountinfo = private / (kind + '-mountinfo.txt')
        docker('cp', container + ':' + summary['report'].replace('result.json', 'mountinfo.txt'), str(mountinfo))
        mounts[kind]['containerMount'] = [line for line in mountinfo.read_text().splitlines() if line.split(' ')[4] == '/proof-fixtures']
        assert len(mounts[kind]['containerMount']) == 1
        runtime_script = "const fs=require('node:fs');const h=process.report.getReport().header;console.log(JSON.stringify({uid:process.getuid(),arch:process.arch,libc:h.glibcVersionRuntime,node:process.version,os:fs.readFileSync('/etc/os-release','utf8'),unexpectedTools:['/bin/sh','/usr/bin/gcc','/usr/bin/cc','/usr/bin/apt-get','/usr/bin/flock'].filter(p=>fs.existsSync(p))}))"
        _, runtime = create_run(kind + '-runtime', [image, '-e', runtime_script])
        detail = json.loads(runtime.stdout)
        assert detail['uid'] == 1000 and not detail['unexpectedTools']
        emit(kind + '-runtime.json', detail)
        if kind == 'bind':
            copy_json(container, '/proof/build/build.json', 'build.json')
            packages = private / 'toolchain-packages.txt'
            docker('cp', container + ':/proof/inputs/toolchain-packages.txt', str(packages))
            emit('toolchain.json', {'packages': packages.read_text()})
        stage = kind + '-independent-containers'
        cross_container(kind, identity, mount)
    provenance['status'] = 'passed-for-recorded-ci-mounts-only'
except BaseException as error:
    provenance['status'] = 'failed'
    provenance['failedStage'] = stage
    provenance['failureType'] = type(error).__name__
    trace = error.__traceback__
    while trace and trace.tb_next:
        trace = trace.tb_next
    provenance['failureLocation'] = {'file': Path(trace.tb_frame.f_code.co_filename).name,
                                     'line': trace.tb_lineno} if trace else None
finally:
    # Stop only names this invocation planned AND whose creation label matches.
    # No daemon-wide cleanup, removal, volume deletion or lock-file unlink.
    stage = 'scoped-container-stop'
    stop_errors = []
    for name in reversed(containers):
        try:
            found = docker('inspect', '--format', '{{json .Config.Labels}}', name, ok=(0, 1))
            if found.returncode == 0:
                assert json.loads(found.stdout).get('swl.issue304.generation') == generation
                docker('kill', '--signal', 'CONT', name, ok=(0, 1))
                docker('stop', '--time', '10', name, timeout=30)
        except BaseException:
            stop_errors.append(name)
    provenance['stopFailures'] = stop_errors
    if stop_errors:
        provenance['status'] = 'failed'
    emit('mounts.json', mounts)
    emit('peers.json', peers)
    emit('steps.json', steps)
    emit('provenance.json', provenance)
print(json.dumps({'status': provenance['status'], 'evidence': str(export)}))
sys.exit(0 if provenance['status'] == 'passed-for-recorded-ci-mounts-only' else 1)
