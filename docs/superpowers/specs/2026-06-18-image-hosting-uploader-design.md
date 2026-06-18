# Design — Remote Image Hosting + Self-Hosted Uploader

**Date:** 2026-06-18
**Status:** Approved (brainstorming) — ready for implementation planning
**Relates to:** Blog rebuild Phase 2 (WordPress content migration). This is a prerequisite for migrating posts that carry images.

## Problem

The Astro rebuild keeps a **no-binaries-in-git** policy, so images cannot live in
the repository. Today images are referenced as *local* files via Astro's
`image()` schema helper and the `astro:assets` `<Image>` component, and they are
populated for dev by `site/scripts/fetch-sample-images.sh`, which downloads them
from the **live WordPress site**. That scaffold breaks the moment WordPress is
retired at DNS cutover (Phase 4), and it is unsuitable for real authoring.

We need a durable answer to: **where do images live, who optimizes them, and how
does a post reference them** — while keeping the blog a pure static site and the
repository text-only.

## Goals

- Text/MDX stays in git; the repo and the build never touch image binaries.
- Images are hosted on **the user's own server** and served by URL at runtime.
- Images are optimized (modern formats + responsive sizes) for quality and speed.
- Authoring an image is a small, pleasant step: upload via a simple admin UI,
  get back a ready-to-paste reference.
- Builds are robust: a temporarily unreachable image server must not fail a deploy.

## Non-Goals (YAGNI)

- No CMS / browser-based text editing — posts are drafted with AI and committed as
  MDX. The admin UI handles **images only**.
- No multi-user accounts, galleries, albums, or in-UI image editing.
- No build-time fetching/optimization of remote images (rejected — see Decisions).
- No bespoke CDN; the user's reverse proxy (and later Cloudflare, if desired) can
  add caching without changes here.

## Key Decisions

1. **Server hosts images at runtime (not Astro at build time).** Astro's remote
   build-time optimization was rejected because it would bake optimized copies into
   the deployed bundle and serve them from Cloudflare — making the user's server a
   mere build source and coupling every build to the server's availability. The
   user wants their server to be the real image host, so images are referenced by
   URL and served at runtime.
2. **Optimization happens once, at upload, on the server.** A custom container
   (Approach A) using `sharp` is the smallest exact fit; the user controls it and
   it emits precisely the formats/sizes/naming the blog expects. (Approach B,
   originals + `imgproxy` on-the-fly, is the documented future upgrade if infinite
   sizes from one original become desirable.)
3. **EXIF/metadata (including GPS) is preserved.** The full metadata of travel
   photos — GPS coordinates, capture time, camera info, ICC profile — is kept in
   the output variants by design (e.g. potentially useful for the Phase 3 travel
   map). This is an intentional choice with a privacy trade-off: published images
   will carry their original location data.
4. **Two deliverables, one contract.** A small blog-side change and a separate
   uploader service, coupled only by the image-URL convention below, so either can
   be rebuilt without touching the other.

## Architecture

Two components communicate solely through the **image URL contract**.

```
[AI draft → MDX text] ──commit──> git ──> Cloudflare Pages (static build, no binaries)
                                                    │ renders <picture srcset>
                          heroImage: {src,width,height,alt}      │ runtime fetch
[photo] → Uploader (Docker, sharp) → variants on server volume ──┴─> img.simonswanderlust.com
```

### The image URL contract (the interface)

- Images are served from a stable base: **`https://img.simonswanderlust.com/`**
  (subdomain → user's server, fronted by their reverse proxy + TLS).
- Each image has a **slug key**, e.g. `trips/bucharest-2024/hero`.
- The uploader emits variants by a fixed naming convention:
  ```
  {key}-640.avif   {key}-1280.avif   {key}-1920.avif
  {key}-640.webp   {key}-1280.webp   {key}-1920.webp
  ```
  Widths: **640 / 1280 / 1920**. Formats: **AVIF + WebP** (WebP as the broad
  fallback). No upscaling beyond the source's intrinsic width.
- A post's frontmatter stores a small object — enough to build `srcset` and to
  reserve layout space (prevent CLS):
  ```yaml
  heroImage:
    src: "https://img.simonswanderlust.com/trips/bucharest-2024/hero"
    width: 4000        # intrinsic dimensions of the source
    height: 2667
    alt: "Old town rooftops at dusk"
  ```

This contract is the **only** coupling. Both sides must agree on the base URL,
the `-{width}.{format}` suffix convention, and the widths/formats list.

### Component 1 — Blog-side changes (this repo, `site/`)

- **Schema** (`src/content.config.ts`): replace `heroImage: image()` with a zod
  object `{ src: z.string().url(), width: z.number().int().positive(),
  height: z.number().int().positive(), alt: z.string() }`. Drop the `image()`
  helper from the trips collection.
- **`RemoteImage.astro`** (new): renders a `<picture>` with AVIF + WebP `<source srcset>`
  built from `src` + the convention, a `sizes` attribute, intrinsic `width`/`height`
  (or `aspect-ratio`) to prevent layout shift, `decoding="async"`, and `loading`
  controllable per use (`eager` for the LCP hero, `lazy` for cards/below-fold).
- **Integrate** `RemoteImage` into `FeaturedHero.astro`, `StoryCard.astro`, and
  `StoryPage.astro`, replacing their current `astro:assets` `<Image>` usage for
  trip photos.
- **Retire** `scripts/fetch-sample-images.sh` and the local `src/assets/trips/`
  dependency for trip heroes. Dev simply points at the live image URLs (or a
  couple of committed-free sample URLs). The SVG favicon is unaffected.
- **Helper** (`src/lib/`): a pure `imageSrcset(src, format)` /
  `imageSources(heroImage)` function that produces the `srcset` strings from the
  convention — unit-tested in isolation.

### Component 2 — Uploader service (separate repo, Docker, on the user's server)

- **Stack:** Node (Fastify) + [`sharp`](https://sharp.pixelplumbing.com/), a single
  container with a mounted volume for storage (e.g. `/data/images`).
- **`GET /`** — minimal auth-protected drag-drop admin page (single-user auth: a
  password or bearer token via env; served only over TLS behind the reverse proxy).
- **`POST /upload`** — accepts the image file + a slug key (or derives one from the
  filename/date) + optional `alt`. Pipeline:
  1. `sharp(...).rotate()` to apply EXIF orientation, and `.withMetadata()` to
     **preserve** EXIF (incl. GPS), capture time, and the ICC profile in output.
  2. Read intrinsic width/height.
  3. Generate AVIF + WebP at 640/1280/1920 (skip widths ≥ the source width; never
     upscale). Quality ~ AVIF 50–60, WebP ~75 (tunable via env).
  4. Write variants to the volume under `{key}-{w}.{fmt}` (overwrite if present —
     idempotent re-upload).
  5. Respond with JSON **and a ready-to-paste `heroImage` YAML snippet** (src +
     intrinsic width/height).
- **Serving:** the container serves the stored files with
  `Cache-Control: public, max-age=31536000, immutable`; the user's reverse proxy
  maps `img.simonswanderlust.com` to it with TLS.
- **Config (env):** storage path, public base URL, widths, formats/quality, auth
  secret.
- **Phase-2 reuse:** factor the `sharp` pipeline as a library with **two
  entrypoints — the HTTP route and a batch CLI** — so migrating the 18 WordPress
  posts is "pull each WP image → run the same pipeline → write the returned URL
  into the MDX."

## Data Flow (authoring a post)

1. Draft the post with AI → MDX with a placeholder for the hero image.
2. Open the uploader, drag the photo, give it a slug (or accept the derived one),
   add `alt`.
3. Receive the optimized variants on the server + a `heroImage` YAML snippet.
4. Paste the snippet into the MDX frontmatter; commit the **text** to git.
5. Cloudflare builds the static site (no images touched).
6. Browsers fetch the right-sized AVIF/WebP from `img.simonswanderlust.com`,
   cached hard.

## Error Handling

- **Uploader:** reject non-image MIME types and oversized files with clear errors;
  validate the slug; surface `sharp` failures; require auth on both routes.
- **Blog build:** zod schema validation fails the build on a malformed `heroImage`
  (catches typos before deploy).
- **Runtime:** because the build never fetches images, a down image server cannot
  break a deploy — it only yields broken images until the server returns. A
  client-side fallback is out of scope for now.

## Testing

- **Blog:** unit-test the `srcset`/sources builder; schema test for the new
  `heroImage` object; keep existing i18n/paths/trips/format suites green; `astro
  check` clean.
- **Uploader:** unit-test the `sharp` pipeline (input fixture → expected variant
  files, correct intrinsic dimensions, metadata preserved (EXIF/GPS present in
  output), no upscaling); endpoint
  tests for auth + happy-path upload + rejection of non-images; a container smoke
  test (build image, upload a fixture, `curl` a variant and assert cache headers).

## Open Questions / Future

- **Approach B upgrade path:** if size tuning becomes frequent, swap the
  pre-generation step for `imgproxy` in front of stored originals — the URL
  contract can absorb this with a signed-URL builder, leaving the blog largely
  unchanged.
- **Deletion/management UI:** not in scope; can be added to the uploader later.
- **Caching via Cloudflare:** optional later; no code change required here.
