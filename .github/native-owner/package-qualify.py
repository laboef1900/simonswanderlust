#!/usr/bin/env python3
"""#305 actual-package qualification. Python stdlib + Docker, no host product tests.
Input DATABASE_URL is read from a private env file; no secret is passed in argv.
All database/volume/container names are unique to --prefix. Retains fixtures; stops only
containers this invocation created. Run only against an explicitly owned PG fixture.
Upload only output/sanitized-evidence; private env, dumps and binaries never leave
the fixture runner. Named-volume proof does not qualify deployment-mounted storage;
--data-root runs the same matrix on bind-mounted subdirectories of one owner-authorized,
empty directory on the deployment filesystem (the G6 gate), and qualifies only that mount.
"""
import argparse
import base64
import hashlib
import http.client as http_client
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.parse
import uuid
import zlib
import struct

P = argparse.ArgumentParser(description=__doc__)
P.add_argument('--image', required=True)
P.add_argument('--source-sha', required=True)
P.add_argument('--expected-arch', choices=['arm64', 'amd64'], required=True)
P.add_argument('--pg-container', required=True)
P.add_argument('--database-env', required=True)
P.add_argument('--output', required=True)
P.add_argument('--prefix', required=True)
P.add_argument('--port', type=int, default=34315)
P.add_argument('--source-root', required=True)
P.add_argument('--data-root', help='Absolute, empty directory created for this run on the '
               'deployment filesystem. Each scenario binds a fresh subdirectory to /data. '
               'Without it, Docker named volumes are used (development/CI evidence only).')
A = P.parse_args()
assert re.fullmatch(r'[0-9a-f]{40}', A.source_sha), 'Full frozen source SHA required'
assert re.fullmatch(r'swl_305_package_[a-z0-9_]{1,35}', A.prefix), 'Owned unique prefix required'
assert 1024 <= A.port <= 65535
OUT = Path(A.output).resolve()
assert not OUT.exists() or not any(OUT.iterdir()), 'Use a new empty private evidence directory'
OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(OUT, 0o700)
DATA_ROOT = None
if A.data_root:
    DATA_ROOT = Path(A.data_root)
    assert DATA_ROOT.is_absolute() and DATA_ROOT.is_dir() and not DATA_ROOT.is_symlink(), \
        '--data-root must be an existing absolute directory, not a symlink'
    assert not any(DATA_ROOT.iterdir()), '--data-root must be empty and created for this run'
    # Never inside a live data root: production's /data carries the stable owner lock.
    for parent in [DATA_ROOT, *DATA_ROOT.parents]:
        assert not (parent / '.storage-owner.lock').exists(), 'Refusing a directory inside a live data root'
SECRET = []
CREATED = []
VOLUMES = []
DATABASES = []
E = {'sourceSha': A.source_sha, 'imageTag': A.image, 'expectedArch': A.expected_arch,
     'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'steps': [],
     'fixtures': {'prefix': A.prefix, 'pgContainer': A.pg_container, 'containers': CREATED,
                  'volumes': VOLUMES, 'databases': DATABASES},
     'deploymentMountGate': ('Evaluated on --data-root (see dataRoot): qualifies only that filesystem/mount for this image'
                             if DATA_ROOT else
                             'NOT qualified: mandatory independent operational predeployment/preenablement gate')}
if DATA_ROOT:
    E['dataRoot'] = {'path': str(DATA_ROOT),
                     'hostFsType': subprocess.run(['stat', '-f', '-c', '%T', str(DATA_ROOT)], text=True,
                                                  capture_output=True).stdout.strip() or None}


def data_mount(volume):
    """The /data mount for a scenario: a bind of its own subdirectory, or a named volume."""
    return ('type=bind,src=' if DATA_ROOT else 'type=volume,src=') + volume + ',dst=/data'


def clean(text, limit=16000):
    for value in sorted(SECRET, key=len, reverse=True):
        if value:
            text = text.replace(value, '[REDACTED]')
    text = re.sub(r'postgres(?:ql)?://[^\s\"\'<>]+', '[REDACTED_DATABASE_URL]', text)
    text = re.sub(r'(?i)(set-cookie|cookie|authorization):[^\r\n]*', r'\1: [REDACTED]', text)
    return text[-limit:] if limit else text


def persist():
    (OUT / 'issue-305-packaged-owner-runtime.json').write_text(json.dumps(E, indent=2) + '\n')

def record(name, **facts):
    E['steps'].append({'name': name, **facts})
    persist()
    print(name, flush=True)


def cmd(args, *, input=None, timeout=90, ok=True, env=None):
    r = subprocess.run(args, input=input, text=True, capture_output=True,
                       timeout=timeout, env=env)
    if ok and r.returncode:
        raise RuntimeError('Command failed (' + args[0] + '): ' + clean(r.stdout + r.stderr))
    return r


def docker(args, **kw):
    return cmd(['docker', *args], **kw)


def node(volume, envfile, code, *, timeout=90, user=None, name=None):
    name = name or A.prefix + '_helper_' + secrets.token_hex(5)
    args = ['run', '--rm', '-i', '--platform=linux/' + A.expected_arch,
            '--network', PG_NETWORK, '--mount', data_mount(volume)]
    if user:
        args += ['--user', user]
    if envfile:
        args += ['--env-file', str(envfile)]
    args += ['--name', name, A.image, 'node', '--import', 'tsx', '--input-type=module', '-']
    try:
        return docker(args, input=code, timeout=timeout)
    except subprocess.TimeoutExpired:
        docker(['stop', '--time', '5', name], ok=False, timeout=15)
        raise


def execjs(container, code):
    return docker(['exec', '-i', container, 'node', '--input-type=module', '-'], input=code)


def until(fn, description, seconds=60):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        result = fn()
        if result:
            return result
        time.sleep(.2)
    raise RuntimeError('Deadline waiting for ' + description)


def sql(database, statement):
    assert database in DATABASES or database == 'postgres'
    env = dict(os.environ, PGPASSWORD=PASSWORD)
    r = docker(['exec', '-e', 'PGPASSWORD', A.pg_container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                '-U', USER, '-d', database, '-A', '-t', '-c', statement], env=env)
    return r.stdout.strip()


def make_db(suffix):
    name = A.prefix + '_' + suffix
    # CREATE, never reuse or drop: collision is a hard refusal.
    sql('postgres', 'CREATE DATABASE "' + name + '"')
    DATABASES.append(name)
    url = urllib.parse.urlunsplit((DB.scheme, DB.netloc, '/' + name, '', ''))
    parsed = urllib.parse.urlsplit(url)
    auth = parsed.netloc.rsplit('@', 1)[0]
    url = urllib.parse.urlunsplit((parsed.scheme, auth + '@' + PG_IP + ':5432', parsed.path, '', ''))
    SECRET.append(url)
    path = OUT / (suffix + '.env')
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write('DATABASE_URL=' + url + '\nPUBLIC_BASE_URL=http://127.0.0.1:' + str(A.port) +
                '\nSTORAGE_DIR=/data/images\nSITE_DIR=/data/site\nBACKUP_DIR=/data/backup\nPORT=3000\n')
    persist()
    return name, path


def make_volume(suffix):
    name = A.prefix + '_' + suffix
    if DATA_ROOT:
        path = DATA_ROOT / name
        os.mkdir(path, 0o700)  # FileExistsError: never reuse a scenario directory
        name = str(path)
    else:
        assert docker(['volume', 'inspect', name], ok=False).returncode != 0, 'Volume already exists'
        docker(['volume', 'create', '--label', 'swl.private-qualification=305', name])
    VOLUMES.append(name)
    node(name, None, "import fs from 'node:fs'; fs.chownSync('/data',1000,1000); fs.chmodSync('/data',0o700);", user='0')
    persist()
    return name


def start(suffix, volume, envfile, command=None, port=False):
    name = A.prefix + '_' + suffix
    assert docker(['container', 'inspect', name], ok=False).returncode != 0, 'Container already exists'
    args = ['run', '-d', '--name', name, '--platform=linux/' + A.expected_arch,
            '--label', 'swl.private-qualification=305', '--env-file', str(envfile),
            '--network', PG_NETWORK, '--mount', data_mount(volume)]
    if port:
        args += ['-p', '127.0.0.1:' + str(A.port) + ':3000']
    args += [A.image, *(command or [])]
    CREATED.append(name)
    persist()
    docker(args)
    return name


def cli(suffix, volume, envfile, args, success):
    name = A.prefix + '_' + suffix
    assert docker(['container', 'inspect', name], ok=False).returncode != 0, 'Container already exists'
    CREATED.append(name)
    persist()
    r = docker(['run', '--name', name, '--platform=linux/' + A.expected_arch,
                '--network', PG_NETWORK, '--env-file', str(envfile), '--mount', data_mount(volume),
                A.image, 'node', '--import', 'tsx', 'src/cli.ts', *args], timeout=180, ok=False)
    (OUT / (suffix + '.log')).write_text(clean(r.stdout + r.stderr))
    assert (r.returncode == 0) == success, suffix + ': ' + clean(r.stdout + r.stderr)
    if not success:
        refusal = r.stdout + r.stderr
        assert any(reason in refusal for reason in [
            'read-only', 'storage_read_only',
            'exclusive storage ownership and drained app database sessions could not be confirmed',
        ]), clean(refusal)
    record(suffix, exitCode=r.returncode)
    return r


COOKIE = ''


def http(method, path, body=None, content_type='application/json'):
    global COOKIE
    headers = {'Origin': 'http://127.0.0.1:' + str(A.port)}
    if COOKIE:
        headers['Cookie'] = COOKIE
    if body is not None:
        headers['Content-Type'] = content_type
        if isinstance(body, dict):
            body = json.dumps(body).encode()
    c = http_client.HTTPConnection('127.0.0.1', A.port, timeout=60)
    try:
        c.request(method, path, body=body, headers=headers)
        r = c.getresponse()
        raw = r.read(1024 * 1024)
        cookie = r.getheader('set-cookie')
        if cookie:
            COOKIE = cookie.split(';', 1)[0]
            SECRET.extend([cookie, COOKIE, COOKIE.partition('=')[2]])
        try:
            data = json.loads(raw)
        except ValueError:
            data = raw.decode(errors='replace')[:300]
        return r.status, data
    finally:
        c.close()


def healthy():
    try:
        status, body = http('GET', '/health')
        return {'status': status, 'body': body} if status == 200 else False
    except (OSError, http_client.HTTPException):
        return False


def lock_probe(volume, envfile):
    code = """import fs from 'node:fs'; import {createRequire} from 'node:module';
const fd=fs.openSync('/data/.storage-owner.lock',fs.constants.O_RDWR);
const acquired=createRequire(import.meta.url)('/app/uploader/native/owned-flock.node').tryLock(fd);
fs.closeSync(fd); console.log(JSON.stringify({acquired}));"""
    return json.loads(node(volume, envfile, code).stdout)['acquired']


def exact_signal(container, pid, signal):
    assert isinstance(pid, int) and pid > 1
    execjs(container, 'process.kill(' + str(pid) + ',' + json.dumps(signal) + ');')


def main_exit(container):
    r = execjs(container, "import fs from 'node:fs'; console.log(fs.existsSync('/tmp/main-exit.json')?fs.readFileSync('/tmp/main-exit.json','utf8'):'null');")
    return json.loads(r.stdout)


def png():
    def chunk(name, value):
        return struct.pack('!I', len(value)) + name + value + struct.pack('!I', zlib.crc32(name + value) & 0xffffffff)
    raw = b''.join(b'\x00' + b'\x20\x60\xa0' * 64 for _ in range(64))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB',64,64,8,2,0,0,0)) + chunk(b'IDAT',zlib.compress(raw)) + chunk(b'IEND',b'')


try:
    source_root = Path(A.source_root).resolve()
    actual_sha = cmd(['git', '-C', str(source_root), 'rev-parse', 'HEAD']).stdout.strip()
    assert actual_sha == A.source_sha, 'Source checkout is not the explicitly frozen SHA'
    source_files = ['uploader/src/main.ts', 'uploader/src/cli.ts', 'uploader/src/data-owner.ts', 'uploader/src/storage-owner.ts']
    source_hashes = {name: hashlib.sha256((source_root/name).read_bytes()).hexdigest() for name in source_files}
    E['sourceFileHashes'] = source_hashes
    text = Path(A.database_env).read_text()
    values = dict(line.split('=', 1) for line in text.splitlines() if '=' in line and not line.lstrip().startswith('#'))
    connection = values['DATABASE_URL'].strip().strip('\"\'')
    SECRET.append(connection)
    DB = urllib.parse.urlsplit(connection)
    USER, PASSWORD = urllib.parse.unquote(DB.username or ''), urllib.parse.unquote(DB.password or '')
    assert USER and PASSWORD, 'Private PostgreSQL credentials required'
    SECRET.append(PASSWORD)
    host = json.loads(docker(['info', '--format', '{{json .}}']).stdout)
    observed = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'amd64', 'amd64': 'amd64'}.get(host['Architecture'])
    assert host['OSType'] == 'linux' and observed == A.expected_arch, 'Refusing cross-architecture/emulated Docker'
    E['host'] = {k: host[k] for k in ['OSType', 'Architecture', 'KernelVersion', 'Driver']}
    image = json.loads(docker(['image', 'inspect', A.image, '--format', '{{json .}}']).stdout)
    assert image['Os'] == 'linux' and image['Architecture'] == A.expected_arch
    E['image'] = {k: image[k] for k in ['Id', 'RepoDigests', 'Os', 'Architecture']}
    nets = json.loads(docker(['inspect', A.pg_container, '--format', '{{json .NetworkSettings.Networks}}']).stdout)
    PG_NETWORK = next((name for name, n in nets.items() if n['IPAddress']), '')
    assert PG_NETWORK, 'Owned PG must be reachable from the native Docker network'
    PG_IP = nets[PG_NETWORK]['IPAddress']
    record('native-platform', native=True)
    v1, v2, v3 = make_volume('data'), make_volume('second_root'), make_volume('restore_root')
    d1, e1 = make_db('app')
    d2, e2 = make_db('restore')
    inventory = """import fs from 'node:fs'; import os from 'node:os'; import {createRequire} from 'node:module'; import {createHash} from 'node:crypto';
const root='/app/uploader/native'; const addon=createRequire(import.meta.url)(root+'/owned-flock.node');
const binaries=['/usr/bin/cc','/usr/bin/gcc','/usr/bin/clang','/usr/bin/make','/bin/sh'];
const forbidden=['/proof','/app/uploader/test','/app/uploader/scripts/build-native.mjs','/app/.github',
'/usr/include/node','/usr/local/include/node',root+'/inputs',root+'/owned-flock.c',root+'/build-native.mjs',root+'/container-toolchain.mjs'];
const fd=fs.openSync('/data/inventory-lock','wx',0o600); const loaded=addon.tryLock(fd); fs.closeSync(fd);
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const report={platform:process.platform,arch:process.arch,node:process.version,abi:process.versions.modules,napi:process.versions.napi,
libc:process.report.getReport().header.glibcVersionRuntime,kernel:os.release(),uid:process.getuid(),addonLoaded:loaded,
forbiddenPresent:[...binaries,...forbidden].filter(p=>fs.existsSync(p)),
incumbentSiteTestFileCount:fs.readdirSync('/app/site/src',{recursive:true}).filter(p=>/\\.(?:test|spec)\\.[cm]?[jt]sx?$/.test(p)).length,
sourceFileHashes:Object.fromEntries(['uploader/src/main.ts','uploader/src/cli.ts','uploader/src/data-owner.ts','uploader/src/storage-owner.ts'].map(p=>[p,sha('/app/'+p)])),binarySha256:sha(root+'/owned-flock.node'),
fsType:fs.statfsSync('/data').type.toString(16),mounts:fs.readFileSync('/proc/self/mountinfo','utf8').split('\\n').filter(l=>l.split(' ')[4]==='/data'),
build:JSON.parse(fs.readFileSync(root+'/build.json')),provenance:JSON.parse(fs.readFileSync(root+'/provenance.json')),
basemapBuild:fs.readFileSync('/map-assets/BASEMAP_BUILD','utf8').trim()}; console.log(JSON.stringify(report));"""
    E['package'] = json.loads(node(v2, e1, inventory).stdout)
    assert E['package']['addonLoaded'] and E['package']['uid'] == 1000
    runtime_arch = 'x64' if A.expected_arch == 'amd64' else 'arm64'
    assert E['package']['platform'] == 'linux' and E['package']['arch'] == runtime_arch
    assert E['package']['build']['platform'] == 'linux' and E['package']['build']['arch'] == runtime_arch
    assert E['package']['sourceFileHashes'] == source_hashes, 'Image product source does not match frozen checkout'
    assert E['package']['binarySha256'] == E['package']['build']['binarySha256'], 'Native artifact differs from build provenance'
    assert E['package']['forbiddenPresent'] == [], 'Runtime contains build/proof/test tooling'
    assert E['package']['fsType'] == 'ef53', 'Qualification deliberately requires Linux-local ext4, not shared/FUSE/network storage'
    record('actual-package-inventory', addonLoaded=True, linuxLocalExt4=True)
    # Supervises, but does not acquire any lock. The child is the actual packaged main.
    # A private preload only enables an ordinary child on SIGUSR2, to prove noninheritance.
    preload = """import {spawn} from 'node:child_process'; import fs from 'node:fs';
process.on('SIGUSR2',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync('/tmp/ordinary-child.json',JSON.stringify({pid:child.pid}));});"""
    preload_url = 'data:text/javascript,' + urllib.parse.quote(preload)
    supervisor = """const {spawn}=require('node:child_process'),fs=require('node:fs');
const child=spawn(process.execPath,['--import','tsx','--import',PRELOAD,'src/main.ts'],{stdio:'inherit'});
fs.writeFileSync('/tmp/main-pid.json',JSON.stringify({pid:child.pid}));
child.on('exit',(code,signal)=>fs.writeFileSync('/tmp/main-exit.json',JSON.stringify({code,signal})));
setInterval(()=>{},1000);""".replace('PRELOAD', json.dumps(preload_url))
    main = start('main', v1, e1, ['node', '-e', supervisor], port=True)
    health = until(healthy, 'actual packaged main health', 180)
    pid = json.loads(execjs(main,"console.log(require('node:fs').readFileSync('/tmp/main-pid.json','utf8'))".replace("require('node:fs')", "(await import('node:fs')).default")).stdout)['pid']
    E['fixtures']['mainPid'] = pid
    record('actual-main-health', **health)
    password = secrets.token_urlsafe(30)
    SECRET.append(password)
    status, body = http('POST', '/setup', {'username':'package-owner','password':password})
    assert status == 200, (status, body)
    status, me = http('GET','/auth/me')
    assert status == 200 and me['authenticated']
    owner_id = me['userId']
    key, save_id, upload_id = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    payload = {'translationKey':key,'saveId':save_id,'expectedOwnerId':owner_id,'shared':{},
               'de':{'title':'Packaged ownership fixture','slug':'','bodyMarkdown':'Synthetic retained fixture.'},
               'en':{'title':'Packaged ownership fixture','slug':'','bodyMarkdown':'Synthetic retained fixture.'}}
    status, saved = http('POST','/posts',payload)
    assert status in [200,201], (status,saved)
    status, fetched = http('GET','/posts/'+key)
    assert status == 200, (status,fetched)
    boundary = 'swl-proof-' + secrets.token_hex(10)
    pieces = []
    for name,value in {'uploadId':upload_id,'expectedOwnerId':owner_id,'retryGeneration':'0','title':'Synthetic ownership image'}.items():
        pieces.append(('--'+boundary+'\r\nContent-Disposition: form-data; name="'+name+'"\r\n\r\n'+value+'\r\n').encode())
    pieces.append(('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="ownership.png"\r\nContent-Type: image/png\r\n\r\n').encode()+png()+b'\r\n')
    pieces.append(('--'+boundary+'--\r\n').encode())
    status, uploaded = http('POST','/upload',b''.join(pieces),'multipart/form-data; boundary='+boundary)
    assert status in [200,201,202], (status,uploaded)
    E['fixtures'].update({'postKey':key,'uploadId':upload_id})
    record('authenticated-save-upload', postStatus=200,uploadStatus=status,readStatus=200)
    status, backup = http('POST','/backups',{})
    assert status == 200 and not backup.get('lastError'), (status,backup)
    names = json.loads(execjs(main,"import fs from 'node:fs'; console.log(JSON.stringify(fs.readdirSync('/data/backup/db').filter(x=>/^db-.*\\.json\\.gz$/.test(x))));").stdout)
    assert names
    dump = '/data/backup/db/' + sorted(names)[-1]
    E['fixtures']['dump'] = dump
    record('real-authenticated-backup', dump=dump)
    cli('live_bootstrap_refused',v1,e1,['prepare-native-restore','--yes'],False)
    cli('live_restore_refused',v1,e1,['restore','--yes',dump],False)
    cli('fs_before_pg_offline_refused',v1,e2,['prepare-native-restore','--yes'],False)
    assert sql(d2,"SELECT count(*) FROM pg_tables WHERE schemaname='public'") == '0'
    assert not lock_probe(v1,e1)
    exact_signal(main,pid,'SIGSTOP')
    try:
        assert not lock_probe(v1,e1)
        cli('stopped_owner_bootstrap_refused',v1,e1,['prepare-native-restore','--yes'],False)
    finally:
        exact_signal(main,pid,'SIGCONT')
    record('sigstop-exclusion', mainPid=pid)
    # Catch top-level actual main rejection in the SAME process, keeping it alive:
    # admission failure must close its fd even without relying on process exit.
    caught = """import fs from 'node:fs'; try { await import('./src/main.ts');
fs.writeFileSync('/tmp/admission.json',JSON.stringify({unexpected:'admitted'})); }
catch(e) {fs.writeFileSync('/tmp/admission.json',JSON.stringify({code:e.code}));} setInterval(()=>{},1000);"""
    fs_denied = start('fs_denied_main',v1,e2,['node','--import','tsx','--input-type=module','-e',caught])
    fs_refusal = until(lambda: json.loads(execjs(fs_denied,"import fs from 'node:fs';console.log(fs.existsSync('/tmp/admission.json')?fs.readFileSync('/tmp/admission.json','utf8'):'null')").stdout),'filesystem denial before actual main bootstrap')
    assert fs_refusal == {'code':'storage_read_only'}, fs_refusal
    assert sql(d2,"SELECT count(*) FROM pg_tables WHERE schemaname='public'") == '0'
    assert sql(d2,"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND starts_with(application_name,'swl-app:')") == '0'
    record('filesystem-before-main-and-offline-pg-writes',virginDatabase=d2,publicTables=0,appSessions=0)
    denied = start('pg_denied_main',v2,e1,['node','--import','tsx','--input-type=module','-e',caught])
    def admission():
        return json.loads(execjs(denied,"import fs from 'node:fs';console.log(fs.existsSync('/tmp/admission.json')?fs.readFileSync('/tmp/admission.json','utf8'):'null')").stdout)
    refusal = until(admission,'actual second-root PG admission failure')
    assert refusal == {'code':'storage_read_only'}, refusal
    assert lock_probe(v2,e1), 'Actual main PG admission failure leaked FS fd in still-live process'
    untouched = json.loads(execjs(denied,"import fs from 'node:fs';console.log(JSON.stringify(fs.readdirSync('/data').filter(x=>!['.storage-owner.lock','inventory-lock'].includes(x))))").stdout)
    assert untouched == [], untouched
    record('two-roots-one-db-admission-cleanup',refusal=refusal,failedProcessStillAlive=True,filesystemReleased=True,noMainWrites=True)
    exact_signal(main,pid,'SIGUSR2')
    child = until(lambda: json.loads(execjs(main,"import fs from 'node:fs';console.log(fs.existsSync('/tmp/ordinary-child.json')?fs.readFileSync('/tmp/ordinary-child.json','utf8'):'null')").stdout),'ordinary actual-main child')
    child_pid = child['pid']
    fdcode = "import fs from 'node:fs';const p='/proc/"+str(child_pid)+"/fd';console.log(JSON.stringify(fs.readdirSync(p).map(n=>{try{return fs.readlinkSync(p+'/'+n)}catch{return null}})));"
    fds = json.loads(execjs(main,fdcode).stdout)
    assert not any(x and '.storage-owner.lock' in x for x in fds), fds
    E['fixtures']['ordinaryChildPid'] = child_pid
    record('ordinary-child-noninheritance',childPid=child_pid,lockDescriptorInherited=False)
    lockpid = sql(d1,"SELECT a.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND l.classid=5461836 AND l.objid=313 AND l.granted")
    assert re.fullmatch(r'[0-9]+',lockpid), 'Exactly one known ownership backend required: '+lockpid
    assert sql(d1,'SELECT pg_terminate_backend('+lockpid+')') == 't'
    E['fixtures']['terminatedOwnerBackendPid'] = int(lockpid)
    def fenced():
        s,b=http('POST','/media/folders',{'folder':'must-not-land'})
        return {'status':s,'body':b} if s==503 and isinstance(b,dict) and b.get('error')=='storage_read_only' else False
    fence = until(fenced,'PG-loss application mutation fence',30)
    assert not lock_probe(v1,e1), 'PG loss released FS lifetime lock'
    cli('pg_lost_restore_refused',v1,e1,['restore','--yes',dump],False)
    assert sql(d1,"SELECT count(*) FROM media_folders WHERE path='must-not-land'") == '0'
    record('pg-loss-fence-retains-fs',**fence,backendPid=int(lockpid))
    exact_signal(main,pid,'SIGKILL')
    exit_result = until(lambda:main_exit(main),'actual main process death')
    assert exit_result['signal']=='SIGKILL',exit_result
    execjs(main,'process.kill('+str(child_pid)+',0)')
    assert lock_probe(v1,e1), 'Surviving ordinary child retained parent lock'
    record('death-reacquisition-with-live-child',mainExit=exit_result,childStillAlive=True)
    # Stop the explicitly known ordinary child, never a PID/name wildcard.
    exact_signal(main,child_pid,'SIGTERM')
    until(lambda: sql(d1,"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND starts_with(application_name,'swl-app:')") == '0','dead main sessions drained')
    # Valid real restore into the SAME stopped synthetic app target; mandatory undo
    # backup/confirmation logic executes. Original dump and new undo set retained.
    cli('standalone_same_root_restore',v1,e1,['restore','--yes',dump],True)
    record('same-volume-main-offline-writer',sameDataVolume=v1,sameDatabase=d1)
    # Separate bootstrap-only target exercises offline preparation and restore.
    cli('standalone_bootstrap',v3,e2,['prepare-native-restore','--yes'],True)
    copycode = "import fs from 'node:fs';console.log(fs.readFileSync("+json.dumps(dump)+").toString('base64'));"
    dumpbytes = base64.b64decode(node(v1,e1,copycode).stdout)
    private_dump = OUT / Path(dump).name
    private_dump.write_bytes(dumpbytes)
    os.chmod(private_dump,0o600)
    node(v3,e2,"import fs from 'node:fs';fs.mkdirSync('/data/backup/db',{recursive:true});fs.writeFileSync("+json.dumps(dump)+",Buffer.from("+json.dumps(base64.b64encode(dumpbytes).decode())+",'base64'));" )
    cli('standalone_bootstrap_target_restore',v3,e2,['restore','--yes',dump],True)
    # Normal close of a fresh real main releases the descriptor, not just SIGKILL.
    docker(['stop','--time','10',main])
    fresh = start('graceful_main',v1,e1,port=True)
    until(healthy,'restarted packaged main',180)
    assert not lock_probe(v1,e1)
    docker(['stop','--time','30',fresh],timeout=45)
    state = json.loads(docker(['inspect',fresh,'--format','{{json .State}}']).stdout)
    assert state['ExitCode']==0,state['ExitCode']
    assert lock_probe(v1,e1)
    cli('after_close_restore',v1,e1,['restore','--yes',dump],True)
    record('graceful-close-reacquisition',exitCode=0,filesystemReleased=True)
    E['status']='passed'
except BaseException as error:
    E['status']='failed'
    E['failure']={'type':type(error).__name__,'message':clean(str(error))}
    print('Qualification failed: '+clean(str(error)), file=sys.stderr)
finally:
    # Save bounded secret-screened process logs, retain all volumes/DBs/containers.
    # Containers are stopped even on failure; no Docker remove/prune is performed.
    for name in CREATED:
        try:
            log=docker(['logs',name],ok=False,timeout=15)
            (OUT/(name+'.log')).write_text(clean(log.stdout+log.stderr))
            docker(['stop','--time','10',name],ok=False,timeout=25)
        except Exception as error:
            E.setdefault('cleanupErrors',[]).append({'container':name,'message':clean(str(error))})
    E['finishedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    persist()
    # Positive-list export: never upload *.env, dumps, or arbitrary private root.
    export=OUT/'sanitized-evidence'
    export.mkdir(exist_ok=True)
    (export/'issue-305-packaged-owner-runtime.json').write_text(clean(json.dumps(E,indent=2), limit=0)+'\n')
    for file in OUT.glob('*.log'):
        (export/file.name).write_text(clean(file.read_text()))

sys.exit(0 if E.get('status')=='passed' else 1)
