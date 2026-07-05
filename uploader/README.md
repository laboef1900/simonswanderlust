# simonswanderlust-images

Self-hosted image uploader **and admin CMS** for the Astro blog: uploads a photo and generates
responsive AVIF/WebP variants (EXIF/GPS preserved), hosts the in-admin editor, WordPress import,
and AI alt-text — and, since the single-app-container merge, **also serves the public blog itself**
and runs its Astro builds in-process (no separate build server). How it fits the rest of the
stack: [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Security model: [`../SECURITY.md`](../SECURITY.md).

## Contract

Filenames: `{key}-{width}.{format}` at widths 640/1280/1920 (plus the source's
own width, never upscaled), formats `avif` + `webp`. Must match the blog's
`site/src/lib/images.ts`. `/upload` (and the CLI) append a short content-hash
suffix to the key (`…/hero-<hash8>`), so re-uploading a photo mints a new URL
and old URLs keep serving — which is what justifies serving variants with a
one-year immutable cache. (WP-import rehost keys stay deterministic so
re-imports are idempotent.) The untouched upload is additionally persisted as
`{key}-orig.<ext>` next to the variants, so the images dir is a complete media
archive (and future re-encodes stay possible). Originals exist only for uploads
made from this version onward; earlier uploads exist as variants only.

---

## Install & run locally (Docker — recommended)

**Prerequisite:** Docker Desktop (or any Docker Engine) running. Check with
`docker info`.

```bash
# 1. From the monorepo root (the docker-compose.yml lives there, not in uploader/),
#    create your env file from the uploader's template:
cp uploader/.env.example .env

# 2. Set a strong Postgres password and the matching DATABASE_URL in .env:
#    POSTGRES_PASSWORD=<long-random-string>
#    DATABASE_URL=postgres://images:<same-password>@db:5432/images
#    PUBLIC_BASE_URL=http://localhost:3000

# 3. Build the image and start the containers in the background:
docker compose up -d --build

# 4. First run — open /login to create the first admin account:
open http://localhost:3000/login      # macOS (or just browse to the URL)
```

On first run, when no users exist, `/login` shows a "Create the first admin"
form. Fill in a username and password to create the admin account; the form is
closed once any user exists. Sign in at `/login`, then pick a key
(e.g. `trips/rhodes-2021/hero`) and alt text, choose a photo, and click
**Upload** — the page prints the `heroImage:` snippet to paste into the post's
frontmatter.

Uploaded variants — plus the untouched original as `{key}-orig.<ext>` — are
written to `./data/images/` on the host (a Docker volume), so they survive
container restarts. `./data/` is git-ignored. Note that `./data/` (images,
site releases, and the in-app backups) lives on the same disk as everything
else: for disaster recovery, keep a host-level offsite backup of it — see
[`../ARCHITECTURE.md`](../ARCHITECTURE.md#backups--disaster-recovery).

**Manage the container:**

```bash
docker compose logs -f      # follow logs
docker compose restart      # restart after an .env change
docker compose down         # stop and remove the container (keeps ./data)
```

**Quick end-to-end check** (log in via cookie jar, then upload):

```bash
node -e "require('sharp')({create:{width:1600,height:1067,channels:3,background:'#357'}}).jpeg().toFile('/tmp/sample.jpg')"
# Log in (stores the session cookie in cookies.txt), then upload with it.
curl -s -c cookies.txt -X POST http://localhost:3000/login \
  -H 'content-type: application/json' \
  -d '{"username":"simon","password":"YOUR_PASSWORD"}'
curl -s -b cookies.txt -X POST http://localhost:3000/upload \
  -F key=trips/smoke/hero -F alt="Smoke" -F file=@/tmp/sample.jpg
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/trips/smoke/hero-640.webp  # -> 200
```

## Run locally without Docker (Node)

**Prerequisite:** Node >= 26, a local Postgres instance.

```bash
npm install
DATABASE_URL=postgres://images:YOUR_PASSWORD@127.0.0.1:5432/images \
  STORAGE_DIR=./data/images PUBLIC_BASE_URL=http://localhost:3000 npm start
# -> "image uploader listening on :3000", open /login to create the first admin
```

---

## Deploy to your server

1. Copy the repo to the server.
2. From the monorepo root: `cp uploader/.env.example .env`, set a strong `POSTGRES_PASSWORD`, the
   matching `DATABASE_URL`, and `PUBLIC_BASE_URL=https://img.simonswanderlust.com`.
3. `docker compose up -d --build` (or, to run the released GHCR image instead of building:
   `docker compose pull && docker compose up -d`).
4. Because the container runs non-root (uid 1000), make its data bind-mount writable once — this
   now covers image variants *and* the built blog output, since both live under the same `/data`
   volume: `mkdir -p uploader/data && sudo chown -R 1000:1000 uploader/data` (run from the
   monorepo root).
5. Point your reverse proxy (nginx/Caddy/Traefik) at the container, terminating TLS: **both**
   `https://simonswanderlust.com` **and** `https://img.simonswanderlust.com` → `127.0.0.1:3000`.
   One Fastify process serves both domains — a host-header check (`IMG_HOST`) picks image-variant
   serving vs. the blog/admin, so each domain behaves exactly as before the merge. **The proxy
   must forward the original, verbatim `Host` header for both domains** (nginx:
   `proxy_set_header Host $host;` — do not rely on the default, which some nginx configs override
   with `$proxy_host`/the upstream name). If the `Host` header reaching the app isn't exactly
   `img.simonswanderlust.com`, image URLs silently fall through to the blog/admin routing instead
   of serving image variants.
6. Open `https://simonswanderlust.com/login` to create the first admin account, then upload.

The admin panel is reachable directly at `https://simonswanderlust.com/admin/` — the same process
serves it, so there's nothing to proxy to separately anymore.

### Security notes

Full details in [`../SECURITY.md`](../SECURITY.md); the essentials:

- **Always run behind the TLS-terminating reverse proxy.** The app trusts `X-Forwarded-*`
  (so per-IP login throttling and the cookie `secure` flag work); your proxy MUST set
  `X-Forwarded-Proto`. Do not expose port 3000 directly to the internet.
- **Password-verifying endpoints are rate-limited** per client IP (`/login`, `/setup`, and the
  authenticated `POST /users/me/password`) to slow brute-force; they share one bucket, so failed
  current-password guesses count against login attempts from that IP.
- **Publishing is admin-only.** Non-admin accounts can create and edit drafts but cannot publish
  to the public site or change a published slug; only admins can publish.
- **WordPress import is SSRF-guarded.** Remote image fetches reject internal/loopback addresses,
  time out, and cap the download size; imported slugs are validated before anything is written.

## CLI upload (Phase 2 migration)

```bash
STORAGE_DIR=./data/images PUBLIC_BASE_URL=https://img.simonswanderlust.com \
  npm run upload -- ./photo.jpg trips/bucharest-2024/hero "Old town at dusk"
```

Prints the paste-ready `heroImage:` snippet and writes all variants (plus the
untouched `-orig` original) under `STORAGE_DIR`.

## CLI password reset (recovery)

Forgot a password? Reset it from the host — the runtime image has no shell, so use the exec form:

```bash
docker compose exec app node --import tsx src/cli.ts set-password <username>
```

Prompts for the new password when it is omitted (input is echoed) and invalidates that user's
sessions. Routine rotation while logged in uses the "Change my password" card on
`/admin/users.html`. Full recovery notes (including the last-resort `DELETE FROM users;` →
`/setup` fallback) are in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## Develop

`npm install` · `npm test` · `npm run typecheck` · `npm run dev`
