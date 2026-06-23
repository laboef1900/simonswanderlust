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
# 1. From the repo root (uploader/), create your env file from the template:
cp .env.example .env

# 2. Set a strong Postgres password and the matching DATABASE_URL in .env:
#    POSTGRES_PASSWORD=<long-random-string>
#    DATABASE_URL=postgres://images:<same-password>@db:5432/images
#    PUBLIC_BASE_URL=http://localhost:3000

# 3. Build the images and start the containers in the background:
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

Uploaded variants are written to `./data/images/` on the host (a Docker volume),
so they survive container restarts. `./data/` is git-ignored.

## Batch uploader (a post's body photos)

The main `/admin/` page uploads one hero image. For a post's other photos, open
`/admin/batch.html`:

1. Make sure **LM Studio** is running with a vision model (e.g. `qwen/qwen3-vl-4b`)
   and its server is on `:1234`. (Optional — without it you can still fill fields by hand.)
2. Sign in at `/login`, then enter a shared prefix (e.g. `trips/rhodes-2021`) and pick several photos.
3. Click **Suggest** — the local model proposes a slug and German + English alt text per photo.
4. Review/edit each row, then **Upload all**.
5. Paste the returned `<BodyImage>` snippets (DE into the German post, EN into the English post). `BodyImage` is registered globally for MDX in the blog's `StoryPage`, so no import is needed.

The model runs on your machine via LM Studio; nothing is sent to a cloud service.
Alt text is generated natively in each language, not machine-translated.

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

**Prerequisite:** Node >= 22.12, a local Postgres instance.

```bash
npm install
DATABASE_URL=postgres://images:YOUR_PASSWORD@127.0.0.1:5432/images \
  STORAGE_DIR=./data/images PUBLIC_BASE_URL=http://localhost:3000 npm start
# -> "image uploader listening on :3000", open /login to create the first admin
```

## LLM settings

Captioning (the batch "Suggest") runs **in your browser**, calling LM Studio directly — so LM
Studio runs on the same machine you author from, and the server never needs to reach it. The
base URL is therefore "where this browser reaches LM Studio", usually `http://localhost:1234/v1`.
(LM Studio sends permissive CORS; on an https admin page use Chrome, which treats `localhost` as
secure.)

Open `/admin/settings.html`. Configure the base URL, model (dropdown populated live from
`/v1/models`, or type one), caption timeout, max image edge, and the caption prompt. **Test
connection** (also browser-side) checks LM Studio is reachable here and the model is present;
**Save** persists to `SETTINGS_PATH` (default `/data/settings.json`, on the volume) and applies
immediately — no restart. The `LMSTUDIO_*` / `CAPTION_*` env vars seed the defaults until you
save. (The server-side `/suggest` + `/settings/models|test` endpoints remain as a fallback for
running the model on the server instead.)

---

## Deploy to your server

1. Copy the repo to the server.
2. `cp .env.example .env`, set a strong `POSTGRES_PASSWORD`, the matching
   `DATABASE_URL`, and `PUBLIC_BASE_URL=https://img.simonswanderlust.com`.
3. `docker compose up -d --build`.
4. Point your reverse proxy (nginx/Caddy/Traefik) at the container:
   `https://img.simonswanderlust.com` → `127.0.0.1:3000`, terminating TLS there.
5. Open `https://img.simonswanderlust.com/login` to create the first admin account, then upload.

When run as part of the full stack (the repo's root `docker-compose.yml`), the site's nginx also
proxies `/admin/` (and `/upload`, `/suggest`) to this service, so the panel is reachable at
`https://simonswanderlust.com/admin/` — WordPress-style, on the main domain.

## Batch (Phase 2 migration)

```bash
STORAGE_DIR=./data/images PUBLIC_BASE_URL=https://img.simonswanderlust.com \
  npm run upload -- ./photo.jpg trips/bucharest-2024/hero "Old town at dusk"
```

Prints the paste-ready `heroImage:` snippet and writes all variants under
`STORAGE_DIR`.

## Develop

`npm install` · `npm test` · `npm run typecheck` · `npm run dev`
