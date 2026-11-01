# Installing Wanderlust Studio on your own server

This is the supported installation path for a third party. It covers one Linux host running
the app and Postgres with Docker Compose, behind one HTTPS reverse proxy, serving a blog
domain and an image domain. Every number below comes from the
[2026-10-29 clean-install rehearsal](2026-10-29-clean-install-rehearsal.md) (#292); nothing
here is a benchmark or a guarantee. Examples use `blog.example.com`, `img.example.com` and
placeholder secrets. Replace all of them.

> **Image name.** Releases from 0.18.1 on are published as
> `ghcr.io/laboef1900/wanderlust-studio`; set `IMAGE_TAG` to a version listed on the
> [releases](https://github.com/laboef1900/simonswanderlust/releases) page, or
> [build the image locally](#build-the-image-locally). Releases under the old name
> (`simonswanderlust-app`, up to 0.17.1) are not aliased to the new one.

## 1. What is supported

| Area | Supported | Not supported |
| --- | --- | --- |
| Host | Linux on **amd64** or **arm64**, Docker Engine with Compose v2. Rehearsed natively on Ubuntu 24.04.5 LTS, Docker 28.0.4, Compose 2.38.2, cgroup v2 ([host inventory](2026-10-29-clean-install-rehearsal.md#host-and-image-inventory)) | Windows or macOS as a production host; Docker Desktop (local trials only); Podman, Kubernetes, Swarm; emulated architectures |
| Data storage | The `./uploader/data` bind mount on a local **ext4** filesystem (the qualified native file-lock target, see [write ownership](../ARCHITECTURE.md#write-reconciliation-and-storage-ownership-305)) | NFS, SMB, FUSE or Docker Desktop file sharing for `/data`; musl-based hosts |
| Network | Exactly **one** HTTPS reverse proxy on the same host, in front of `127.0.0.1:3000` | A CDN or any additional proxy hop; exposing port 3000 directly; serving under a sub-path such as `/blog` |
| Domains | A blog domain and a separate image domain, both pointing at the proxy | One shared domain for blog and images in production |
| Languages | German and/or English: DE+EN with either as primary, DE-only or EN-only | Other locales |

Anything outside the left column may work, but nobody has rehearsed it and support questions
about it cannot be answered.

## 2. Requirements (measured, not minimums)

| What | Value | Source |
| --- | --- | --- |
| App memory ceiling | Compose caps the app at **4608 MiB** (`mem_limit` = `memswap_limit`). Keep both equal. | `docker-compose.yml`; [ceiling rationale](2026-10-29-clean-install-rehearsal.md#memory-method-and-derived-maxima) |
| Observed app memory | Whole-container maxima: idle ~114/112 MiB, photo encoding ~1945/1876 MiB, publish build ~1183/1229 MiB (amd64/arm64), on two synthetic 24 MP PNGs and one bilingual story | [Memory maxima](2026-10-29-clean-install-rehearsal.md#memory-method-and-derived-maxima) |
| Host memory | Plan for the 4608 MiB app ceiling **plus** Postgres and the operating system. The rehearsal hosts had about 16 GB; no smaller host was tested, so no minimum is claimed | [Host inventory](2026-10-29-clean-install-rehearsal.md#host-and-image-inventory) |
| CPU | Rehearsal hosts had 4 CPUs (a 2-CPU admission allowance was a test guard, not a requirement) | same |
| Image disk | App image ~1.13 GB uncompressed, Postgres ~0.30 GB, on either architecture | [Local images](2026-10-29-clean-install-rehearsal.md#amd64-local-images) |
| Photo disk | Each uploaded photo keeps its **original** plus 8 variant files. The synthetic, highly compressible PNGs used ~0.66 MB allocated per photo; real camera photos will use more. Measure your own corpus before sizing | [Corpus and disk](2026-10-29-clean-install-rehearsal.md#corpus-and-disk) |
| Backups | In-app dumps and image archives are written to the **same disk** under `/data/backup`; image archives are never pruned automatically. Budget space for them and for an offsite copy | [Backups & DR](../ARCHITECTURE.md#backups--disaster-recovery) |

## 3. Licensing in one paragraph

The software is **AGPL-3.0-only** ([LICENSE](../LICENSE)). If you run a modified version for
others, AGPL §13 requires you to offer them your exact Corresponding Source; release builds
record their source revision in `/app/source-release.json` and link it from `/legal/`. Stories,
photos, MDX story content and the brands "Simon's Wanderlust" and "Wanderlust Studio" are **not**
licensed to you: do not reuse the sample content or present your blog as either brand. Details:
[README — Software, contributions and content rights](../README.md#software-contributions-and-content-rights)
and [NOTICE](../NOTICE).

## 4. Install

### 4a. Prepare the host and configuration

Run these on the server as a user that may run `docker` and `sudo`.

```bash
git clone https://github.com/laboef1900/simonswanderlust.git wanderlust-studio
cd wanderlust-studio
git checkout v<version>          # the release you install; omit only for a local source build
cp uploader/.env.example .env
chmod 600 .env
```

Edit `.env` (it is private; never commit or paste it):

```dotenv
POSTGRES_PASSWORD=<output of: openssl rand -hex 32>
PUBLIC_BASE_URL=https://img.example.com
IMG_HOST=img.example.com
IMAGE_TAG=<version>
# Optional, only for remote AI providers (see 4f):
# ENCRYPTION_KEY=<output of: openssl rand -hex 32>
```

- `POSTGRES_PASSWORD`: use the hex form above. Compose inserts the password into a database
  URL, so characters such as `/`, `@` or `+` from other generators would break it.
- `PUBLIC_BASE_URL` and `IMG_HOST` are **required**: `docker compose` refuses to start with
  `set PUBLIC_BASE_URL in .env` / `set IMG_HOST in .env` when either is missing or empty. They
  name the **image** domain only. The blog domain is set later in Settings (4e).
- `IMAGE_TAG` is required as well; there is no default.

Prepare the data directory. The app runs as uid/gid 1000; without this step the rehearsal
observed `EACCES`, exit code 1 and a restart loop
([log](2026-10-29-clean-install-rehearsal.md#reproduction-runbook-and-per-architecture-log)):

```bash
mkdir -p uploader/data
sudo chown -R 1000:1000 uploader/data
```

### 4b. Get the image

**Released image** (after the first `wanderlust-studio` release):

```bash
docker compose pull
```

If the package requires authentication, run `docker login ghcr.io` first.

#### Build the image locally

Until a release exists, or to run your own changes, build from the checkout. The Dockerfile
uses Docker Hardened Images, so the build host needs access to `dhi.io`:

```bash
docker build -t ghcr.io/laboef1900/wanderlust-studio:local .
```

and set `IMAGE_TAG=local` in `.env`. A local build records an unknown source revision on its
legal page; see the licensing note in section 3.

### 4c. Start and check

```bash
docker compose config --quiet && docker compose up -d
docker compose ps                      # app and db should become "healthy"
curl -fsS http://127.0.0.1:3000/health
```

`docker compose config --quiet` fails before anything starts if a required variable is
missing. The app publishes only `127.0.0.1:3000`; Postgres is never published.

### 4d. Put the reverse proxy in front

Route **both** domains to `127.0.0.1:3000` through one TLS-terminating proxy. The app serves
images, blog and admin from one process and tells them apart by the `Host` header, so the
proxy must:

- pass the original `Host` unchanged;
- **overwrite** `X-Forwarded-Proto` with its own scheme and `X-Forwarded-For` with the client
  address it accepted, and clear `X-Forwarded-Host`;
- accept request bodies of at least **25 MiB** (the upload limit);
- allow responses to take longer than the app's **900-second** build deadline (Publish and
  Rebuild wait for the build);
- refuse hostnames other than your two domains.

This nginx configuration is the one verified with real TLS on both architectures, with the
names and certificate paths replaced
([verified example](2026-10-29-clean-install-rehearsal.md#verified-https-proxy-example)). The
rehearsal bound it to loopback; on a server, listen on the public address and use certificates
from your CA (for example via ACME):

```nginx
server {
  listen 443 ssl;
  server_name blog.example.com img.example.com;
  ssl_certificate     /etc/ssl/example/fullchain.pem;
  ssl_certificate_key /etc/ssl/example/privkey.pem;
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
```

The example overwrites `X-Forwarded-For` with the client address, as rehearsed; appending
(`$proxy_add_x_forwarded_for`, the form `SECURITY.md` shows) is equally valid, because the app
reads only the rightmost entry its one trusted hop added.

Compose sets `TRUSTED_PROXY: docker-gateway` itself: the app trusts loopback and the Docker
bridge gateway as its one proxy hop and refuses to boot if it cannot discover that gateway.
Do not put `TRUSTED_PROXY` in `.env`. The full rules are in
[SECURITY.md — Transport, headers & proxy](../SECURITY.md#transport-headers--proxy).

### 4e. First run in the browser

1. Open `https://blog.example.com/login`. With no accounts yet it offers to create the first
   admin; choose a password of at least 12 characters.
2. The Desk shows a first-run checklist. Its **Language** step chooses DE+EN (either
   language primary), DE-only or EN-only. **Decide before your first Publish:** after a story is
   published the primary language is locked and a published language cannot be removed, so
   no published URL ever moves.
3. **Settings → Site identity:** set the site name, author and tagline, and **Public domain** =
   `https://blog.example.com` (not the image domain; the form refuses it). Until it is set the
   built site asks search engines not to index it (`noindex`, `Disallow: /`). Saving does not
   rebuild: use **Rebuild site now** (Settings → Site & backups) or publish a story.
4. Reader comments are off by default. Turn them on under **Settings → Comments** after the
   public domain is set: only that exact origin may post comments.
5. Upload photos in **Media** and write your first story; see the
   [authoring workflow](authoring-workflow.md).

### 4f. Optional: remote AI providers

Local AI providers need nothing extra. Remote providers store their API keys encrypted with
`ENCRYPTION_KEY` (exactly 64 hex characters; malformed or empty values refuse boot). Generate
it with `openssl rand -hex 32`, store it **separately from your backups** (key escrow), then
`docker compose up -d` to recreate the app. Losing the key loses the stored provider keys,
not your content. See [Connect an optional AI provider](../README.md#connect-an-optional-ai-provider).

## 5. Verify the installation

- `https://blog.example.com/` and `https://blog.example.com/en/` (or your secondary-language
  prefix) load over HTTPS; `https://img.example.com/` does not serve the blog.
- After a login, the session cookie is `Secure` and `HttpOnly`.
- A published photo loads from `https://img.example.com/…`.
- After setting the public domain and rebuilding, `https://blog.example.com/robots.txt` lists
  your sitemap instead of `Disallow: /`.
- With comments enabled, a test comment from the blog appears in **Comments** as pending.

## 6. Upgrades and backups

- **Upgrades:** follow the
  [app upgrade and supported recovery runbook](../ARCHITECTURE.md#app-upgrades-and-supported-recovery).
  Recovery is roll-forward by default; capture a backup generation before every upgrade.
  Postgres major upgrades have their own
  [procedure](../ARCHITECTURE.md#upgrading-a-postgres-major-eg-17--18).
- **Backups:** **Settings → Site & backups** creates database dumps and image archives on
  the same disk. That is not disaster recovery: copy the recovery set **offsite**, together
  with `settings.json`, your `.env` and Compose files, and keep `ENCRYPTION_KEY` in separate
  escrow. See [Backups & disaster recovery](../ARCHITECTURE.md#backups--disaster-recovery);
  the complete offsite inventory and drill are tracked in #296. Restores are CLI-only and
  offline.
- **Changing the blog domain later:** move DNS and the proxy first, then save the new public
  domain, then rebuild. Comments from the old domain are refused from the moment you save.

## 7. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `docker compose` stops with `set PUBLIC_BASE_URL in .env`, `set IMG_HOST in .env`, `set POSTGRES_PASSWORD in .env` or the `IMAGE_TAG` message | The named variable is missing or empty in `.env` next to `docker-compose.yml` |
| App restarts repeatedly, log shows `EACCES` / permission denied | `uploader/data` is not owned by uid/gid 1000; run the `chown` in 4a |
| App exits with `ENCRYPTION_KEY must contain exactly 64 hexadecimal characters.` | Remove the line or set a valid key (4f) |
| App exits with `TRUSTED_PROXY=docker-gateway requires one unambiguous default gateway.` (or `cannot read /proc/net/route`) | The Compose network or `network_mode` was changed; only the shipped bridge topology is supported |
| Images show the blog or a 404 | The proxy rewrote `Host`, or `IMG_HOST` does not match the image domain |
| Comments are refused (403) | The public domain is unset, or does not exactly match the page's origin |
| Publish shows a timeout in the browser while the build continues | The proxy's read timeout is below the 900-second build deadline |
