# Simon's Wanderlust

[simonswanderlust.com](https://simonswanderlust.com) — a bilingual (DE/EN) personal travel blog.
This repository is the **Astro 6 static-site rebuild** of the original WordPress + Elementor site,
plus a small **self-hosted CMS + image service** so posts can be authored, published, and
re-built entirely on Simon's own server.

It is a **monorepo** with two deployable parts, wired together by the root `docker-compose.yml`:

| Part | What it is | Stack |
| :-- | :-- | :-- |
| [`site/`](site/) | The public blog — a **static** site built from Postgres at runtime | Astro 6, Tailwind 4, MapLibre |
| [`uploader/`](uploader/) | The **admin CMS + image service** (editor, WordPress import, AI alt-text, image optimization) | Node 22, Fastify 5, sharp, Postgres |

## How it fits together

Posts are authored in the in-admin editor (`/admin/`), stored in **Postgres**, and rendered to a
**static** site by a long-running `blog-builder` service that runs `astro build` from the database.
nginx serves the built output; the **Publish** button triggers a rebuild. No content lives in git —
MDX files are export-only backups.

```
reader ──https──► nginx (static blog) ──/admin,/upload,/suggest──► uploader (Fastify + sharp)
                     ▲                                                   │
              blog-dist volume                                          ▼
                     │                                               Postgres ◄── blog-builder
              blog-builder ──astro build from Postgres───────────────────┘  (reads published posts)
```

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full picture and **[SECURITY.md](SECURITY.md)**
for the security model.

## Quick start (full stack, Docker)

```bash
cp uploader/.env.example .env        # set POSTGRES_PASSWORD, DATABASE_URL, BUILD_SECRET
docker compose up -d --build         # blog (nginx) + blog-builder + uploader + Postgres
```

On a server you can run the **released images from GHCR** instead of building locally — set
`IMAGE_TAG` in `.env` (defaults to the current release) and:

```bash
docker compose pull && docker compose up -d
```

The images are `ghcr.io/laboef1900/simonswanderlust-{uploader,blog-builder}` (published on each
`vX.Y.Z` tag by `.github/workflows/release.yml`). If the packages are private, `docker login
ghcr.io` first.

### Hardened base images (Docker Hardened Images)

The stack runs on **DHI** images (minimal, low-CVE, non-root):

- **`blog`** pulls `dhi.io/nginx` directly (non-root, listens on `:8080`).
- **`uploader`** and **`blog-builder`** are *built* on `dhi.io/node` bases. Because that build
  happens in CI, the release workflow logs in to `dhi.io` using repo secrets **`DHI_USERNAME`**
  and **`DHI_TOKEN`** (a dhi.io access token) — add these before tagging a release, or the build
  can't pull the DHI bases.

On the server you must therefore `docker login dhi.io` (so `docker compose pull` can fetch the
nginx image), and — because the uploader runtime runs **non-root (uid 1000)** — make its data
bind-mount writable once:

```bash
docker login dhi.io
mkdir -p uploader/data && sudo chown -R 1000:1000 uploader/data
docker compose pull && docker compose up -d
```

(blog-builder's DHI base is root, so `/srv/blog` needs no change.)

Then open `/login` on the uploader to create the first admin account, write a post in the editor,
and hit **Publish**. The blog rebuilds and nginx serves it.

For local development of just the static site (no containers):

```bash
cd site && npm install && npm run dev    # needs DATABASE_URL pointing at a Postgres with posts
```

> `npm run build` and `npx astro check` both invoke the Postgres content loader, so they require a
> reachable Postgres with `DATABASE_URL` set. Unit tests (`npm test`) do not hit the database.

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — components, content pipeline, runtime build/deploy flow, data model
- **[SECURITY.md](SECURITY.md)** — auth, authorization, rate limiting, SSRF/XSS/traversal defenses
- **[docs/authoring-workflow.md](docs/authoring-workflow.md)** — how to upload photos and write/publish a post
- **[docs/map-assets.md](docs/map-assets.md)** — self-hosted PMTiles basemap
- **[site/README.md](site/README.md)** · **[uploader/README.md](uploader/README.md)** — per-part details
- **[CLAUDE.md](CLAUDE.md)** — conventions and golden rules (for human and AI contributors)
- `docs/superpowers/` — design specs and phase plans (source of truth for scope)

## Status

- **Done:** static-site skeleton + expedition-log design, Postgres CMS, in-admin editor,
  WordPress import, MapLibre travel map, and a security-hardening pass (see SECURITY.md).
- **Remaining:** Phase 4 — DNS cutover.
