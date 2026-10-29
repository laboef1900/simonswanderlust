#!/usr/bin/env python3
"""Parent-run, disposable fresh Linux hosts only. No installs, builds or releases."""
import argparse
import concurrent.futures
import contextlib
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import re
import signal
import secrets
import shutil
import socket
import ssl
import struct
import subprocess
import threading
import time
import zlib

ROOT = Path(__file__).resolve().parent
REPO = None
IMAGE = 'ghcr.io/laboef1900/simonswanderlust-app:0.17.1'
PROXY = 'nginx:1.28-alpine'
BLOG, IMG = 'blog.issue292.test', 'img.issue292.test'
STATE = None
EVIDENCE = None
EXPORT = None
COOKIE = ''
CONTEXT = None
COMPOSE = []
PROJECT = ''
SECRET_VALUES = []
PROVENANCE = json.loads((ROOT / 'provenance.json').read_text())
# No ambient app/Compose/Docker variables, tokens, proxy credentials or HOME.
# Commands use only installed system binaries and a generation-private HOME.
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
       'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}
DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']
EVIDENCE_FILES = (
    'steps.jsonl', 'provenance.json', 'released-manifest.json', 'corpus.json',
    'idle-baseline-memory.json', 'encode-memory.json', 'publish-build-memory.json',
)
# Admission budgets for this disposable two-image exercise, NOT measured hosting
# minima. Check actual available resources; never free space or tune the daemon.
APP_MEMORY = 4608 * 1024**2
HOST_RESERVE = 2048 * 1024**2
PULL_DISK_RESERVE = 8 * 1024**3
RUNTIME_DISK_RESERVE = 3 * 1024**3


def export_evidence():
    # Positive selection, not a recursive upload of the run directory. Every
    # selected file must be a regular JSON/JSONL file and contain no generated
    # credential or PEM key. Fail closed before making any uploadable directory.
    selected = []
    for name in EVIDENCE_FILES:
        path = EVIDENCE / name
        if not path.exists():
            continue
        if path.is_symlink() or not path.is_file():
            raise RuntimeError('evidence selection contains a non-regular file')
        text = path.read_text()
        if 'PRIVATE KEY' in text or any(value and value in text for value in SECRET_VALUES):
            raise RuntimeError('evidence credential screen refused export')
        if name.endswith('.jsonl'):
            for line in text.splitlines():
                json.loads(line)
        else:
            json.loads(text)
        selected.append((name, text))
    if not selected:
        raise RuntimeError('no sanitized evidence available')
    # The export target is new per generation, outside the private run root.
    stage = EXPORT.with_name(EXPORT.name + '.staging')
    stage.mkdir(mode=0o700)
    for name, text in selected:
        target = stage / name
        target.write_text(text)
        target.chmod(0o644)
    stage.chmod(0o755)
    stage.rename(EXPORT)


def resource_inventory(phase, docker_root):
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        if key in ('MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'):
            memory[key] = int(value.split()[0]) * 1024
    disks = {name: {'freeBytes': shutil.disk_usage(path).free,
                    'totalBytes': shutil.disk_usage(path).total,
                    'filesystemDevice': path.stat().st_dev}
             for name, path in [('runRoot', STATE), ('dockerRoot', Path(docker_root))]}
    disk_budget = PULL_DISK_RESERVE if phase == 'before-pull' else RUNTIME_DISK_RESERVE
    record('resource-inventory', phase=phase, cpuCount=os.cpu_count(), memoryBytes=memory,
           disks=disks, appMemoryCeilingBytes=APP_MEMORY, hostReserveBytes=HOST_RESERVE,
           freeDiskAdmissionBudgetBytes=disk_budget,
           caveat='exercise admission allowances, not measured minimum hosting requirements; disk checked again after pulls')
    if (os.cpu_count() or 0) < 2 or memory.get('MemAvailable', 0) < APP_MEMORY + HOST_RESERVE:
        raise RuntimeError('missing prerequisite: available CPU/memory for bounded two-encoder workload and host reserve')
    if any(value['freeBytes'] < disk_budget for value in disks.values()):
        raise RuntimeError('missing prerequisite: actual free disk below exercise admission allowance; no daemon cleanup authorized')


def command(args, timeout=120):
    result = subprocess.run(args, env=ENV, capture_output=True, timeout=timeout)
    if result.returncode:
        # Never print argv, stdout/stderr, Docker inspect Env or HTTP response bodies.
        raise RuntimeError('command failed: ' + Path(args[0]).name + ' (output withheld)')
    return result.stdout.decode()


def dc(*args, timeout=120):
    return command(COMPOSE + list(args), timeout)


def record(step, **fields):
    with (EVIDENCE / 'steps.jsonl').open('a') as f:
        f.write(json.dumps({'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                            'step': step, **fields}) + '\n')
    print(step, flush=True)


class LocalTLS(http.client.HTTPSConnection):
    def connect(self):
        self.sock = self._context.wrap_socket(
            socket.create_connection(('127.0.0.1', 443), self.timeout),
            server_hostname=self.host)


def request(path, method='GET', payload=None, host=BLOG, headers=None, auth=True,
            expected=200, raw=None, timeout=980):
    global COOKIE
    h = dict(headers or {})
    if auth and COOKIE:
        h['Cookie'] = COOKIE
    body = raw
    if payload is not None:
        body = json.dumps(payload).encode()
        h['Content-Type'] = 'application/json'
    conn = LocalTLS(host, context=CONTEXT, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=h)
        response = conn.getresponse()
        data = response.read()
        response_headers = response.getheaders()
        status = response.status
        if path == '/setup' and status == 200:
            cookies = [v for k, v in response_headers if k.lower() == 'set-cookie']
            if not cookies or not all('secure' in c.lower() and 'httponly' in c.lower() for c in cookies):
                raise RuntimeError('setup session missing Secure/HttpOnly')
            COOKIE = cookies[0].split(';', 1)[0]
            SECRET_VALUES.extend((COOKIE, COOKIE.split('=', 1)[1]))
        if status != expected:
            raise RuntimeError(f'HTTP {method} {path}: expected {expected}, observed {status}; body withheld')
        return data
    finally:
        conn.close()


def api(*args, **kwargs):
    return json.loads(request(*args, **kwargs))


def until(check, seconds=180):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (OSError, http.client.HTTPException, RuntimeError, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError('bounded readiness wait expired')


# cgroup memory includes the app, encoder, build subprocess and page cache; not RSS.
# Child RSS is sampled separately. No process command lines leave the container.
SAMPLE_JS = r"""
const fs=require('node:fs');
function n(p){try{return Number(fs.readFileSync(p,'utf8').trim())}catch{return null}}
let rss=0, astro=0;
for(const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){
 try { const status=fs.readFileSync('/proc/'+pid+'/status','utf8');
 const v=Number((status.match(/^VmRSS:\s+(\d+)/m)||[])[1]||0)*1024;
 if(Number(pid)===process.pid) continue;
 rss+=v; if(fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes('astro.mjs')) astro+=v;
 }catch{}
}
console.log(JSON.stringify({cgroupCurrent:n('/sys/fs/cgroup/memory.current')??n('/sys/fs/cgroup/memory/memory.usage_in_bytes'),cgroupLifetimePeak:n('/sys/fs/cgroup/memory.peak')??n('/sys/fs/cgroup/memory/memory.max_usage_in_bytes'),processRssSum:rss,astroRss:astro}));
"""


@contextlib.contextmanager
def measure(phase):
    stop = threading.Event()
    samples = []
    errors = []
    def sample():
        deadline = time.monotonic() + 1200
        while not stop.is_set() and time.monotonic() < deadline:
            try:
                values = json.loads(dc('exec', '-T', 'app', 'node', '-e', SAMPLE_JS, timeout=15))
                values['elapsedSeconds'] = round(time.monotonic() - started, 3)
                samples.append(values)
            except (RuntimeError, subprocess.TimeoutExpired, ValueError):
                errors.append('sample unavailable')
            stop.wait(1)
    started = time.monotonic()
    worker = threading.Thread(target=sample, daemon=True)
    worker.start()
    try:
        yield
    finally:
        stop.set()
        worker.join(20)
        (EVIDENCE / (phase + '-memory.json')).write_text(json.dumps({
            'phase': phase, 'elapsedSeconds': time.monotonic()-started,
            'method': 'one Docker exec sample approximately every second; cgroup lifetime peak is cumulative, not phase-specific; RSS sum can double-count shared pages',
            'samples': samples, 'sampleFailures': len(errors)}, indent=2))
        if not samples or not any(s.get('cgroupCurrent') is not None for s in samples):
            raise RuntimeError('missing prerequisite: no usable cgroup memory samples')


def disk():
    stats = {'apparentBytes': 0, 'allocatedBytes': 0, 'files': 0}
    for path in (STATE / 'uploader/data/images').rglob('*'):
        if path.is_file():
            stat = path.stat()
            stats['apparentBytes'] += stat.st_size
            stats['allocatedBytes'] += stat.st_blocks * 512
            stats['files'] += 1
    return stats


def png(path, seed):
    # Two valid 24 MP RGB PNGs, deterministic stripe/gradient synthetic pixels.
    # No EXIF, GPS, remote corpus, malformed streams or adversarial codec inputs.
    width, height = 6000, 4000
    compressor = zlib.compressobj(6)
    encoded = bytearray()
    for y in range(height):
        pixels = bytes(((x // 24 + y // 16 + seed) % 256) for x in range(width))
        # RGB grayscale keeps generation deterministic and cheap.
        line = bytearray(width * 3)
        line[0::3] = pixels
        line[1::3] = pixels
        line[2::3] = pixels
        encoded.extend(compressor.compress(b'\0' + line))
    encoded.extend(compressor.flush())
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind+data) & 0xffffffff)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', encoded) + chunk(b'IEND', b''))
    return {'file': path.name, 'width': width, 'height': height, 'bytes': path.stat().st_size,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'seed': seed}


def upload(path):
    boundary = 'issue292-' + secrets.token_hex(16)
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\nrehearsal/{path.stem}\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\nContent-Type: image/png\r\n\r\n').encode()
    body += path.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
    return api('/upload', 'POST', raw=body, headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})


def prepare(expected_arch):
    global COMPOSE, PROJECT, CONTEXT
    if platform.system() != 'Linux' or Path('/.dockerenv').exists():
        raise RuntimeError('requires a fresh Linux VM, not a Mac or Docker container')
    for binary in ('docker', 'openssl', 'python3', 'systemd-detect-virt'):
        if not shutil.which(binary, path=ENV['PATH']):
            raise RuntimeError('missing prerequisite: ' + binary)
    if os.geteuid() != 0:
        raise RuntimeError('requires root on the disposable VM only')
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    if arch != expected_arch:
        raise RuntimeError('host architecture does not match the native runner matrix')
    vm = command(['systemd-detect-virt', '--vm']).strip()
    # No existing containers/volumes, no removal, prune, install or daemon tuning.
    if command(DOCKER + ['ps', '-aq']).strip() or command(DOCKER + ['volume', 'ls', '-q']).strip():
        raise RuntimeError('Docker daemon is not fresh: existing containers or volumes')
    daemon = json.loads(command(DOCKER + ['info', '--format', '{{json .}}']))
    daemon_arch = {'x86_64': 'amd64', 'aarch64': 'arm64', 'amd64': 'amd64', 'arm64': 'arm64'}.get(daemon['Architecture'])
    if (daemon['OSType'] != 'linux' or daemon_arch != arch or
            any('rootless' in value for value in daemon.get('SecurityOptions', []))):
        raise RuntimeError('missing prerequisite: native Linux rootful Docker daemon')
    if not daemon.get('MemoryLimit') or not daemon.get('SwapLimit'):
        raise RuntimeError('missing prerequisite: Docker memory and swap limit support')
    for port in (3000, 443):
        try:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', port))
        except OSError:
            raise RuntimeError('missing prerequisite: loopback port ' + str(port) + ' is unavailable') from None
    version = json.loads(command(DOCKER + ['version', '--format', '{{json .}}']))
    record('host', architecture=arch, kernel=platform.release(), vm=vm,
           osRelease=Path('/etc/os-release').read_text(),
           docker={side: {key: version[side].get(key) for key in ('Version','ApiVersion','Os','Arch','GitCommit')}
                   for side in ('Client','Server')},
           compose=command(DOCKER + ['compose', 'version']).strip(),
           python=platform.python_version(), openssl=command(['openssl','version']).strip(),
           daemon={'architecture': daemon_arch, 'rootful': True, 'containersBeforeRun': 0,
                   'volumesBeforeRun': 0, 'driver': daemon['Driver'],
                   'cgroupVersion': daemon.get('CgroupVersion')},
           cliSha256={name: hashlib.sha256(Path(shutil.which(name, path=ENV['PATH'])).read_bytes()).hexdigest()
                      for name in ('docker','python3','openssl')})
    resource_inventory('before-pull', daemon['DockerRootDir'])
    PROJECT = 'issue292-' + arch + '-' + secrets.token_hex(4)
    (STATE / 'project-name.txt').write_text(PROJECT+'\n')
    shutil.copyfile(REPO / 'docker-compose.yml', STATE / 'docker-compose.yml')
    template = (REPO / 'uploader/.env.example').read_text()
    password = secrets.token_hex(32)
    SECRET_VALUES.append(password)
    # Copy the source template, replacing only known installer inputs. No secrets
    # are passed in argv or environment; Compose reads this private 0600 file.
    text = template.replace('change-me-to-a-long-random-string', password)
    text = text.replace('https://img.simonswanderlust.com', 'https://' + IMG).replace('IMG_HOST=img.simonswanderlust.com', 'IMG_HOST=' + IMG)
    (STATE / 'private.env').write_text(text)
    image_ref = PROVENANCE['image'] + '@' + PROVENANCE['platformDigests'][arch]
    override = STATE / 'digest.yml'
    override.write_text('services:\n  app:\n    image: ' + image_ref + '\n')
    COMPOSE = DOCKER + ['compose', '--project-name', PROJECT, '--project-directory', str(STATE),
                       '--env-file', str(STATE / 'private.env'), '-f', str(STATE / 'docker-compose.yml'),
                       '-f', str(override)]
    import urllib.request
    with urllib.request.urlopen('https://api.github.com/repos/laboef1900/simonswanderlust/releases/latest', timeout=30) as response:
        release = json.load(response)
    if release['tag_name'] != 'v0.17.1':
        raise RuntimeError('latest release changed; parent must review/re-pin rehearsal before running')
    record('published-release', tag=release['tag_name'], url=release['html_url'], publishedAt=release['published_at'])
    pinned_index = PROVENANCE['image'] + '@' + PROVENANCE['indexDigest']
    manifest = json.loads(command(DOCKER + ['manifest', 'inspect', pinned_index], timeout=120))
    if json.loads(command(DOCKER + ['manifest', 'inspect', IMAGE], timeout=120)) != manifest:
        raise RuntimeError('released tag no longer matches pinned release index')
    platforms = {entry['platform']['architecture']: entry['digest'] for entry in manifest['manifests']
                 if entry.get('platform', {}).get('os') == 'linux'}
    if any(platforms.get(a) != d for a, d in PROVENANCE['platformDigests'].items()):
        raise RuntimeError('pinned release index does not match expected native manifests')
    (EVIDENCE / 'released-manifest.json').write_text(json.dumps(manifest, indent=2))
    dc('pull', timeout=900)
    command(DOCKER + ['pull', PROXY], timeout=300)
    info = json.loads(command(DOCKER + ['image', 'inspect', image_ref]))[0]
    if info['Architecture'] != arch or info['Os'] != 'linux':
        raise RuntimeError('image architecture differs from fresh host; emulation is not acceptance')
    record('released-image', requested=IMAGE, indexDigest=PROVENANCE['indexDigest'],
           platformDigest=PROVENANCE['platformDigests'][arch], repoDigests=info['RepoDigests'],
           imageId=info['Id'], architecture=info['Architecture'], uncompressedSizeBytes=info['Size'],
           caveat='released older codecs; benign corpus only, not security support or downgrade qualification')
    dbinfo = json.loads(command(DOCKER + ['image', 'inspect', 'postgres:18-alpine']))[0]
    proxyinfo = json.loads(command(DOCKER + ['image', 'inspect', PROXY]))[0]
    for name, item in [('database', dbinfo), ('proxy', proxyinfo)]:
        if item['Architecture'] != arch or item['Os'] != 'linux':
            raise RuntimeError('supporting image architecture differs from native host')
        record(name + '-image', repoDigests=item['RepoDigests'], imageId=item['Id'],
               architecture=item['Architecture'], uncompressedSizeBytes=item['Size'])
    resource_inventory('after-pull', daemon['DockerRootDir'])
    data = STATE / 'uploader/data'
    data.mkdir(parents=True, mode=0o755)
    data.chmod(0o755)
    os.chown(data, 0, 0)
    dc('up', '-d', timeout=180)
    time.sleep(35)
    logs = dc('logs', '--no-color', 'app')
    permission_failure = 'EACCES' in logs or 'permission denied' in logs.lower()
    record('skipped-chown', observedPermissionFailure=permission_failure,
           operatorSymptom='look for EACCES/permission denied and restart/unhealthy state; raw logs withheld')
    cid = dc('ps', '-aq', 'app').strip()
    state = json.loads(command(DOCKER + ['inspect', '--format', '{{json .State}}', cid]))
    record('skipped-chown-state', status=state['Status'], exitCode=state['ExitCode'],
           restarting=state['Restarting'], health=state.get('Health', {}).get('Status'))
    dc('stop', 'app')
    if not permission_failure:
        raise RuntimeError('skipped-chown did not produce expected permission evidence; investigate, do not claim success')
    os.chown(data, 1000, 1000)
    dc('up', '-d', timeout=180)
    certs = STATE / 'tls'
    certs.mkdir()
    command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
             '-subj', '/CN=Issue292 client-only rehearsal CA', '-keyout', str(certs/'ca.key'), '-out', str(certs/'ca.pem')])
    command(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN='+BLOG,
             '-keyout', str(certs/'server.key'), '-out', str(certs/'server.csr')])
    (certs/'extensions.cnf').write_text('subjectAltName=DNS:'+BLOG+',DNS:'+IMG+'\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n')
    command(['openssl', 'x509', '-req', '-in', str(certs/'server.csr'), '-CA', str(certs/'ca.pem'),
             '-CAkey', str(certs/'ca.key'), '-CAcreateserial', '-days', '2', '-extfile', str(certs/'extensions.cnf'), '-out', str(certs/'server.pem')])
    config = STATE / 'nginx.conf'
    config.write_text('''events {}\nhttp {
 access_log off;
 error_log /dev/null crit;
 server {
  listen 127.0.0.1:443 ssl;
  server_name blog.issue292.test img.issue292.test;
  ssl_certificate /tls/server.pem;
  ssl_certificate_key /tls/server.key;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 25m;
  client_body_timeout 30s;
  location / {
   proxy_pass http://127.0.0.1:3000;
   proxy_set_header Host $http_host;
   proxy_set_header X-Forwarded-Proto $scheme;
   proxy_set_header X-Forwarded-For $remote_addr;
   proxy_set_header X-Forwarded-Host "";
   proxy_connect_timeout 5s;
   proxy_send_timeout 60s;
   proxy_read_timeout 960s;
  }
 }
}\n''')
    proxy_info = json.loads(command(DOCKER+['image','inspect',PROXY]))[0]
    record('proxy-image', requested=PROXY, repoDigests=proxy_info['RepoDigests'], imageId=proxy_info['Id'])
    command(DOCKER + ['run', '-d', '--name', PROJECT+'-proxy', '--network', 'host',
                     '--read-only', '--tmpfs', '/var/cache/nginx', '--tmpfs', '/var/run',
                     '--mount', 'type=bind,src='+str(config)+',dst=/etc/nginx/nginx.conf,readonly',
                     '--mount', 'type=bind,src='+str(certs)+',dst=/tls,readonly',
                     PROXY, 'nginx', '-g', 'daemon off;'])
    CONTEXT = ssl.create_default_context(cafile=str(certs/'ca.pem'))
    until(lambda: request('/health', timeout=5), 180)
    # CA is trusted by this SSL context only; no /etc/hosts or trust store edits.
    for host in (BLOG, IMG):
        with socket.create_connection(('127.0.0.1',443), timeout=5) as sock:
            with CONTEXT.wrap_socket(sock, server_hostname=host) as tls:
                record('tls-verified', host=host, protocol=tls.version(), cipher=tls.cipher()[0],
                       certificateSha256=hashlib.sha256(tls.getpeercert(binary_form=True)).hexdigest())
    try:
        with socket.create_connection(('127.0.0.1',443), timeout=5) as sock:
            with ssl.create_default_context().wrap_socket(sock, server_hostname=BLOG):
                raise RuntimeError('rehearsal CA unexpectedly trusted globally')
    except ssl.SSLCertVerificationError:
        record('tls-default-trust-rejected', expected=True)
    ports = json.loads(command(DOCKER + ['inspect', '--format', '{{json .NetworkSettings.Ports}}', cid]))
    if ports.get('3000/tcp') != [{'HostIp':'127.0.0.1','HostPort':'3000'}]:
        raise RuntimeError('app port is not exclusively loopback')
    dbid = dc('ps','-q','db').strip()
    dbports = json.loads(command(DOCKER + ['inspect','--format','{{json .NetworkSettings.Ports}}',dbid]))
    if any(dbports.values()):
        raise RuntimeError('database has published port')
    limits = json.loads(command(DOCKER + ['inspect', '--format', '{{json .HostConfig}}', cid]))
    if limits['Memory'] != APP_MEMORY or limits['MemorySwap'] != APP_MEMORY:
        raise RuntimeError('existing app memory/swap ceiling was not applied')
    record('network-boundary', appPorts=ports, databasePorts=dbports,
           appMemoryBytes=limits['Memory'], appMemorySwapBytes=limits['MemorySwap'])


def exercise():
    request('/login', auth=False)
    record('readme-login-entry', status=200, caveat='HTTP entry tested; no browser interaction claimed')
    password = secrets.token_urlsafe(32)
    SECRET_VALUES.append(password)
    request('/setup', 'POST', {'username':'rehearsal-admin','password':password},
            headers={'X-Forwarded-Proto':'http'})
    record('setup', status=200, secureCookie=True, httpOnlyCookie=True)
    request('/settings', 'POST', {'commentsEnabled':True})
    until(lambda: api('/health', timeout=5).get('release') is True, 1000)
    with measure('idle-baseline'):
        time.sleep(10)
    corpus = STATE/'corpus'
    corpus.mkdir()
    descriptions = [png(corpus/f'synthetic-{i}.png', i*31) for i in (1,2)]
    (EVIDENCE/'corpus.json').write_text(json.dumps(descriptions, indent=2))
    before = disk()
    with measure('encode'):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            uploads = list(pool.map(upload, sorted(corpus.glob('*.png'))))
        def ready():
            return all(api('/media/items/'+u['key'])['status']=='ready' for u in uploads)
        until(ready, 900)
    after = disk()
    record('encode', photos=2, before=before, after=after,
           allocatedDeltaBytesPerPhoto=(after['allocatedBytes']-before['allocatedBytes'])/2,
           apparentDeltaBytesPerPhoto=(after['apparentBytes']-before['apparentBytes'])/2)
    image = uploads[0]
    hero = {k:image[k] for k in ('src','width','height')}
    hero['alt'] = 'Synthetic grayscale stripes'
    if image.get('format'):
        hero['format'] = image['format']
    pair = {'translationKey':'issue292-rehearsal','status':'draft',
            'shared':{'date':'2026-10-27','countryCode':'DE','region':'europe',
                      'coordinates':{'lat':52.52,'lng':13.405},'commentsEnabled':True}}
    for locale in ('de','en'):
        pair[locale] = {'locale':locale,'slug':'issue292-rehearsal-'+locale,
                        'title':'Synthetic install rehearsal '+locale,'excerpt':'Benign synthetic rehearsal content.',
                        'country':'Germany','heroImage':hero,'bodyMarkdown':'## Rehearsal\n\nSynthetic content only.', 'images':{}}
    saved = api('/posts','POST',pair)
    tk = saved['translationKey']
    record('draft-saved', translationKey=tk)
    with measure('publish-build'):
        request('/posts/'+tk+'/publish', 'POST', {'baseUpdatedAt':saved['updatedAt'],'baseRouteVersion':None})
    de = request('/'+pair['de']['slug']+'/')
    en = request('/en/'+pair['en']['slug']+'/')
    variant = request('/'+image['src'].split('https://'+IMG+'/')[1]+'-640.webp', host=IMG)
    record('publish', status=200, deBytes=len(de), enBytes=len(en), imageVariantBytes=len(variant))
    comment = {'translationKey':tk,'postedLocale':'en','authorName':'Synthetic Reader','body':'Synthetic rehearsal comment.'}
    request('/comments','POST',comment,headers={'Origin':'https://'+BLOG},auth=False,expected=403)
    record('issue319-reproduction', requestHost=BLOG, origin='https://'+BLOG,
           configuredImageOrigin='https://'+IMG, observedStatus=403, expectedKnownDefect=True)
    request('/comments','POST',comment,headers={'Origin':'https://'+IMG},auth=False,expected=201)
    public = api('/comments?tk='+tk,auth=False)
    if public['comments']:
        raise RuntimeError('pending synthetic comment became public without moderation')
    pending = api('/moderation/comments?status=pending')['comments']
    pending_ids = [c['id'] for c in pending if c['translationKey'] == tk]
    if len(pending_ids) != 1:
        raise RuntimeError('control comment missing from pending moderation')
    record('comment-origin-control', status=201, pendingHidden=True,
           caveat='image Origin control is not successful blog-origin posting; #319 remains open')
    # Compare persistent authenticated post and bytes across app+DB restarts.
    dc('restart','db',timeout=90)
    dc('restart','app',timeout=90)
    until(lambda: request('/health',timeout=5),180)
    persisted = api('/posts/'+tk)
    if persisted['de']['slug'] != pair['de']['slug'] or request('/'+pair['de']['slug']+'/') != de:
        raise RuntimeError('published story did not survive restart')
    if request('/en/'+pair['en']['slug']+'/') != en:
        raise RuntimeError('published English story did not survive restart')
    if request('/'+image['src'].split('https://'+IMG+'/')[1]+'-640.webp',host=IMG) != variant:
        raise RuntimeError('image did not survive restart')
    request('/comments?tk='+tk,auth=False)
    restarted_pending = api('/moderation/comments?status=pending')['comments']
    if [c['id'] for c in restarted_pending if c['translationKey'] == tk] != pending_ids:
        raise RuntimeError('pending comment did not survive restart')
    record('restart-survival', authenticatedSession=True, post=True, publishedBytes=True,
           imageBytes=True, pendingComment=True, healthStatus=200)
    # Exercise trusted single-hop IP behavior last: five unauthenticated comment
    # refusals consume the real loopback budget despite differing client XFF.
    statuses = []
    for i in range(6):
        conn = LocalTLS(BLOG,context=CONTEXT,timeout=10)
        try:
            conn.request('POST','/comments',json.dumps(comment),headers={
                'Content-Type':'application/json','Origin':'https://'+BLOG,
                'X-Forwarded-For':'198.51.100.'+str(i+1)})
            response = conn.getresponse()
            statuses.append(response.status)
            response.read()
        finally:
            conn.close()
    record('single-trusted-hop', statuses=statuses, spoofedClientAddresses=6,
           expected='403 for first five then 429; proxy overwrites reader-supplied XFF')
    if statuses != [403,403,403,403,403,429]:
        raise RuntimeError('unexpected single-hop limiter results')
    appid = dc('ps','-q','app').strip()
    state = json.loads(command(DOCKER+['inspect','--format','{{json .State}}',appid]))
    record('final-container', oomKilled=state['OOMKilled'], health=state.get('Health',{}).get('Status'),
           finalDiskFreeBytes=shutil.disk_usage(STATE).free)
    record('rehearsal-finished', caveat='does not establish a minimum hardware size or #319 fix')


def main():
    global REPO, STATE, EVIDENCE, EXPORT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fresh-disposable-linux-host', action='store_true', required=True)
    parser.add_argument('--resources-reviewed', action='store_true', required=True)
    parser.add_argument('--expected-architecture', choices=('amd64', 'arm64'), required=True)
    parser.add_argument('--generation', required=True)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--run-root', type=Path, required=True)
    parser.add_argument('--evidence-export', type=Path, required=True)
    parser.add_argument('--runner-label', choices=('ubuntu-24.04', 'ubuntu-24.04-arm'), required=True)
    parser.add_argument('--checkout-sha', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,100}', args.generation):
        raise SystemExit('Invalid generation identifier; no runtime started.')
    if not re.fullmatch(r'[a-f0-9]{40}', args.checkout_sha):
        raise SystemExit('Invalid checkout revision; no runtime started.')
    if args.runner_label != {'amd64':'ubuntu-24.04', 'arm64':'ubuntu-24.04-arm'}[args.expected_architecture]:
        raise SystemExit('Runner label/architecture mismatch; no runtime started.')
    REPO = args.source_root.resolve()
    STATE = args.run_root.resolve()
    EXPORT = args.evidence_export.resolve()
    if (STATE.exists() or EXPORT.exists() or EXPORT.with_name(EXPORT.name + '.staging').exists() or
            STATE == REPO or STATE in REPO.parents or REPO in STATE.parents or
            STATE == EXPORT or STATE in EXPORT.parents or EXPORT in STATE.parents):
        raise SystemExit('Requires new, separate run/export paths outside checkout; no runtime started.')
    os.umask(0o077)
    STATE.mkdir(mode=0o700)
    EVIDENCE = STATE / 'evidence'
    EVIDENCE.mkdir()
    home = STATE / 'home'
    home.mkdir()
    ENV['HOME'] = str(home)
    ENV['DOCKER_CONFIG'] = str(home / '.docker')
    success = False
    def terminated(signum, frame):
        raise RuntimeError('bounded rehearsal interrupted; no completion claimed')
    signal.signal(signal.SIGTERM, terminated)
    signal.signal(signal.SIGINT, terminated)
    try:
        actual = {name: hashlib.sha256((REPO/name).read_bytes()).hexdigest() for name in PROVENANCE['inputs']}
        provenance = {**PROVENANCE, 'actualInputs': actual, 'generation': args.generation,
                      'checkoutSha': args.checkout_sha, 'runnerLabel': args.runner_label,
                      'harnessSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                      'workflowSha256': hashlib.sha256((REPO/'.github/workflows/issue-292-native.yml').read_bytes()).hexdigest(),
                      'manifestSha256': hashlib.sha256((ROOT/'provenance.json').read_bytes()).hexdigest()}
        (EVIDENCE / 'provenance.json').write_text(json.dumps(provenance, indent=2))
        if actual != PROVENANCE['inputs']:
            raise RuntimeError('source input hash differs from reviewed preparation; review/re-pin before executing')
        record('generation-started', generation=args.generation,
               note='temporary native release qualification; no deployment or security-support claim')
        prepare(args.expected_architecture)
        exercise()
        success = True
    except Exception as error:
        # Dependency exceptions can contain credentials. Only our RuntimeError
        # messages are safe; never serialize upstream exception messages or argv.
        record('stopped-with-failure', exceptionType=type(error).__name__,
               reason=str(error) if type(error) is RuntimeError else 'dependency detail withheld',
               note='no success claimed; raw logs and response bodies withheld')
    finally:
        # Stop only this generation; never remove/prune host containers or volumes.
        if COMPOSE:
            try:
                dc('stop', timeout=120)
                record('compose-stopped')
            except Exception:
                record('compose-stop-unconfirmed', remedy='discard disposable GitHub VM; do not prune shared state')
                success = False
        if PROJECT:
            try:
                command(DOCKER + ['stop', PROJECT+'-proxy'], timeout=30)
                record('proxy-stopped')
            except Exception:
                record('proxy-stop-unconfirmed', note='proxy may not have started; disposable VM is cleanup boundary')
        try:
            export_evidence()
        except Exception:
            raise SystemExit('Sanitized export unavailable; upload nothing from the private run root.') from None
    if not success:
        raise SystemExit('Rehearsal stopped; sanitized selected evidence retained. No success claimed.')


if __name__ == '__main__':
    main()
