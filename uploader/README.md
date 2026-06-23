# simonswanderlust-images

Self-hosted image uploader for the Astro blog. Uploads a photo, generates
responsive AVIF/WebP variants (EXIF/GPS preserved), stores them on disk, and
returns a `heroImage` YAML snippet to paste into a post.

## Contract

Filenames: `{key}-{width}.{format}` at widths 640/1280/1920 (plus the source's
own width, never upscaled), formats `avif` + `webp`. Must match the blog's
`site/src/lib/images.ts`. Variants are served with a one-year immutable cache.

---

## Install & run locally (Docker — recommended)

**Prerequisite:** Docker Desktop (or any Docker Engine) running. Check with
`docker info`.

```bash
# 1. From the repo root, create your env file from the template:
cp .env.example .env

# 2. Generate a long random AUTH_TOKEN straight into .env (no echo):
#    (PUBLIC_BASE_URL=http://localhost:3000 for local use)
printf 'AUTH_TOKEN=%s\nPUBLIC_BASE_URL=http://localhost:3000\n' "$(openssl rand -hex 32)" > .env

# 3. Build the image and start the container in the background:
docker compose up -d --build

# 4. Open the admin UI and log in with the token from your .env:
open http://localhost:3000/admin/      # macOS (or just browse to the URL)
```

Find your token any time with `grep AUTH_TOKEN .env`. Paste it into the admin
page's "Auth token" field, pick a key (e.g. `trips/rhodes-2021/hero`) and alt
text, choose a photo, and click **Upload** — the page prints the `heroImage:`
snippet to paste into the post's frontmatter.

Uploaded variants are written to `./data/images/` on the host (a Docker volume),
so they survive container restarts. `./data/` is git-ignored.

## Batch uploader (a post's body photos)

The main `/admin/` page uploads one hero image. For a post's other photos, open
`/admin/batch.html`:

1. Make sure **LM Studio** is running with a vision model (e.g. `qwen/qwen3-vl-4b`)
   and its server is on `:1234`. (Optional — without it you can still fill fields by hand.)
2. Enter your token + a shared prefix (e.g. `trips/rhodes-2021`), pick several photos.
3. Click **Suggest** — the local model proposes a slug and German + English alt text per photo.
4. Review/edit each row, then **Upload all**.
5. Paste the returned `<BodyImage>` snippets (DE into the German post, EN into the English post). `BodyImage` is registered globally for MDX in the blog's `StoryPage`, so no import is needed.

The model runs on your machine via LM Studio; nothing is sent to a cloud service.
Alt text is generated natively in each language, not machine-translated.

## Convert (JPG → WebP)

A standalone utility, separate from the blog pipeline: open `/admin/convert.html`, enter the
token, and select images — they convert to **full-resolution WebP** automatically (orientation
and EXIF/GPS preserved), with a download link per file. Stores nothing on the server and
produces no responsive variants — just format conversion. (`POST /convert`.)

**Manage the container:**

```bash
docker compose logs -f      # follow logs
docker compose restart      # restart after an .env change
docker compose down         # stop and remove the container (keeps ./data)
```

**Quick end-to-end check** (uses the token without printing it):

```bash
export $(grep '^AUTH_TOKEN=' .env)
node -e "require('sharp')({create:{width:1600,height:1067,channels:3,background:'#357'}}).jpeg().toFile('/tmp/sample.jpg')"
curl -s -X POST http://localhost:3000/upload -H "authorization: Bearer $AUTH_TOKEN" \
  -F key=trips/smoke/hero -F alt="Smoke" -F file=@/tmp/sample.jpg
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/trips/smoke/hero-640.webp  # -> 200
```

## Run locally without Docker (Node)

**Prerequisite:** Node >= 22.12.

```bash
npm install
AUTH_TOKEN=$(openssl rand -hex 32) STORAGE_DIR=./data/images \
  PUBLIC_BASE_URL=http://localhost:3000 npm start
# -> "image uploader listening on :3000", admin at http://localhost:3000/admin/
```

---

## Deploy to your server

1. Copy the repo to the server.
2. `cp .env.example .env`, set a long random `AUTH_TOKEN` and
   `PUBLIC_BASE_URL=https://img.simonswanderlust.com`.
3. `docker compose up -d --build`.
4. Point your reverse proxy (nginx/Caddy/Traefik) at the container:
   `https://img.simonswanderlust.com` → `127.0.0.1:3000`, terminating TLS there.
5. Open `https://img.simonswanderlust.com/admin/` and upload.

## Batch (Phase 2 migration)

```bash
STORAGE_DIR=./data/images PUBLIC_BASE_URL=https://img.simonswanderlust.com \
  npm run upload -- ./photo.jpg trips/bucharest-2024/hero "Old town at dusk"
```

Prints the paste-ready `heroImage:` snippet and writes all variants under
`STORAGE_DIR`.

## Develop

`npm install` · `npm test` · `npm run typecheck` · `npm run dev`
