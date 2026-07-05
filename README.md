# Simon's Wanderlust

[simonswanderlust.com](https://simonswanderlust.com) — a bilingual (DE/EN) personal travel blog.
This repository is the **Astro 7 static-site rebuild** of the original WordPress + Elementor site,
plus a small **self-hosted CMS + image service** so posts can be authored, published, and
re-built entirely on Simon's own server.

It is a **monorepo** with two deployable parts, wired together by the root `docker-compose.yml`:

| Part | What it is | Stack |
| :-- | :-- | :-- |
| [`site/`](site/) | The public blog — a **static** site built from Postgres at runtime | Astro 7, Tailwind 4, MapLibre |
| [`uploader/`](uploader/) | The **admin CMS + image service** (editor, WordPress import, image optimization) | Node 26, Fastify 5, sharp, Postgres |

## How it fits together

Posts are authored in the in-admin editor (`/admin/`), stored in **Postgres**, and rendered to a
**static** site by the same app, in-process — no separate build server. Publishing awaits the
build; the app then serves the built output itself. No content lives in git — MDX files are
export-only backups.

```
reader ──https──► app (Fastify + sharp, single process, host-routed)
                     │  main host: /* → /data/site/current (blog) · /map/ · /admin/ /upload
                     │  img host:  /* → /data/images (variants)
                     ▼
                  Postgres ◄──────── in-process `astro build` on Publish/boot (writes /data/site)
```

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full picture and **[SECURITY.md](SECURITY.md)**
for the security model.

## Quick start (full stack, Docker)

```bash
cp uploader/.env.example .env        # set POSTGRES_PASSWORD, DATABASE_URL
docker compose up -d --build         # app (blog + uploader, one image) + Postgres
```

On a server you can run the **released image from GHCR** instead of building locally — set
`IMAGE_TAG` in `.env` (defaults to the current release) and:

```bash
docker compose pull && docker compose up -d
```

The image is `ghcr.io/laboef1900/simonswanderlust-app` (published on each `vX.Y.Z` tag by
`.github/workflows/release.yml`). If the package is private, `docker login ghcr.io` first.

### Hardened base image (Docker Hardened Images)

The `app` image is *built* on **DHI** (minimal, low-CVE, non-root) `dhi.io/node` bases. Because
that build happens in CI, the release workflow logs in to `dhi.io` using the repo variable
**`DHI_USERNAME`** (not sensitive) and secret **`DHI_TOKEN`** (a dhi.io access token) — add both
before tagging a release, or the build can't pull the DHI bases. `dhi.io` login is **CI-only** —
on the server you just pull the finished image from GHCR.

Because the runtime runs **non-root (uid 1000)**, make its data bind-mount writable once (this now
also covers the site build output, since both live under the same `/data` volume):

```bash
mkdir -p uploader/data && sudo chown -R 1000:1000 uploader/data
docker compose pull && docker compose up -d
```

### Cutting a release

```bash
# 1. bump the IMAGE_TAG defaults in docker-compose.yml + uploader/.env.example
# 2. commit, then tag and push the tag:
git tag v0.X.Y && git push origin v0.X.Y
```

The `release` workflow builds the image (multi-arch amd64+arm64, on the DHI node bases), publishes
it to GHCR, and creates the GitHub Release with generated notes.

Then open `/login` to create the first admin account, write a post in the editor, and hit
**Publish**. The app rebuilds the blog in-process and starts serving it immediately.

For local development of just the static site (no containers):

```bash
cd site && npm install && npm run dev    # needs DATABASE_URL pointing at a Postgres with posts
```

> `npm run build` and `npx astro check` both invoke the Postgres content loader, so they require a
> reachable Postgres with `DATABASE_URL` set. Unit tests (`npm test`) do not hit the database.

## Backups

The app writes its own backups (gzipped DB dumps + incremental image archives, admin settings
page) to `/data/backup/db` — but that is the **same server disk** as the live data, so it is not
a disaster-recovery story by itself. Keep a **host-level offsite backup** (restic/rsync/borg
cron) of `./uploader/data`; that one directory carries the dumps, the image archives, and the
untouched image originals. Details and the restore procedure:
[ARCHITECTURE.md](ARCHITECTURE.md#backups--disaster-recovery).

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — components, content pipeline, runtime build/deploy flow, data model, packaging & release pipeline
- **[SECURITY.md](SECURITY.md)** — auth, authorization, rate limiting, SSRF/XSS/traversal defenses
- **[docs/authoring-workflow.md](docs/authoring-workflow.md)** — how to upload photos and write/publish a post
- **[docs/map-assets.md](docs/map-assets.md)** — self-hosted PMTiles basemap
- **[site/README.md](site/README.md)** · **[uploader/README.md](uploader/README.md)** — per-part details
- **[CLAUDE.md](CLAUDE.md)** — conventions and golden rules (for human and AI contributors)
- `docs/superpowers/` — design specs and phase plans (source of truth for scope)

## Status

- **Done:** static-site skeleton + expedition-log design, Postgres CMS, in-admin editor,
  WordPress import, MapLibre travel map, a security-hardening pass (see SECURITY.md), and the
  single-app-container merge (one GHCR image, in-process Astro builds, configurable DB backups —
  see ARCHITECTURE.md).
- **Remaining:** Phase 4 — DNS cutover.
