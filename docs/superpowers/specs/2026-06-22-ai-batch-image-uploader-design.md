# AI-Assisted Batch Image Uploader — Design

**Date:** 2026-06-22
**Status:** Approved (pending spec review)
**Repos touched:** `simonswanderlust-images` (primary) + a small follow-up in the blog repo.
**Builds on:** `2026-06-18-image-hosting-uploader-design.md` (the single-image uploader, now built).

## Goal

Add a **batch uploader for a post's non-hero (body/gallery) photos** to the existing
self-hosted image service. The author drops in several photos at once; a **local
vision model (qwen3-vl-4b via LM Studio)** suggests alt text in **German and English**
plus a key slug for each; the author reviews/edits; on commit each photo is stored
through the existing variant pipeline and the page returns a paste-ready, responsive
**`<RemoteImage>`** snippet (DE + EN) for the post body.

The **hero image stays a separate, deliberate single upload** (the existing `/admin/`
flow + `heroImage:` snippet) — out of scope here.

## Confirmed Requirements

- **Scope:** non-hero, per-post body photos. Hero flow unchanged.
- **Interface:** web, multi-file, in the existing uploader (new `/admin/batch.html`).
- **AI:** local `qwen/qwen3-vl-4b` via LM Studio's OpenAI-compatible API. Validated:
  base64 image → `/v1/chat/completions` → coherent alt + slug; server JIT-loads the model.
- **AI output per photo:** `altEn`, `altDe` (each generated natively, **not** machine-translated),
  and a language-neutral kebab-case `slug`. Always **reviewed/edited** before storing.
- **Flow:** two-phase — **suggest → review → commit** (slug must be locked before storing
  because it determines the stored filename).
- **Keys:** all photos in a batch share a prefix (e.g. `trips/rhodes-2021`); each photo's
  full key is `prefix/slug`. Must satisfy the existing server key rule
  `^[a-z0-9][a-z0-9/_-]*$`.
- **Output:** inline `<RemoteImage src=… width=… height=… alt=… />` per locale (DE + EN),
  preserving the responsive AVIF/WebP pipeline. Requires a small blog-side follow-up so
  `RemoteImage` works inside MDX bodies (today it's hero-only).

## Architecture (Approach A: suggest → review → commit)

Three new pieces in the uploader; everything else is reused unchanged.

```
batch.html ──(1 POST /suggest, N files)──► server ──► caption.ts ──► LM Studio (host)
   │  renders editable rows (thumb, slug, altDe, altEn, dims)
   │
   └─(2 POST /upload per photo at commit)─► server ──► pipeline.ts + storage.ts ──► disk
        returns {src,width,height}; page builds the DE+EN <RemoteImage> snippets
```

- **Phase 1 (suggest):** stateless. The browser holds the `File` objects and posts them to
  `/suggest`, which **stores nothing** — it captions + probes dimensions and returns
  suggestions. Thumbnails are rendered from local object URLs (no server thumbnails).
- **Phase 2 (commit):** the browser posts each photo to the **existing `/upload`** with the
  final `key = prefix/slug`. `/upload` stores variants and returns `{src,width,height}`.
  The page assembles the inline snippets client-side from those plus the edited alt text.
  (The hero `snippet` that `/upload` also returns is simply ignored in batch mode.)

### New module: `src/caption.ts`

```ts
export interface Caption { altEn: string; altDe: string; slug: string; }
export interface CaptionConfig {
  baseUrl: string;           // LMSTUDIO_BASE_URL, e.g. http://host.docker.internal:1234/v1
  model: string;             // LMSTUDIO_MODEL, default qwen/qwen3-vl-4b
  timeoutMs?: number;        // default 60000
  fetchImpl?: typeof fetch;  // injected in tests; defaults to global fetch
}
export async function captionImage(jpeg: Buffer, cfg: CaptionConfig): Promise<Caption>;
```

- Sends the image as a `data:image/jpeg;base64,…` URL in a chat-completions call with a
  low temperature and a prompt that demands **strict JSON** `{altEn, altDe, slug}`: concise,
  factual travel-photo alt (~≤120 chars, no "image of"), English and German written natively,
  and a 2–4 word English kebab-case slug.
- **Robust parsing:** prefer `response_format` JSON schema if available; otherwise extract the
  first `{…}` block (tolerate code fences), validate non-empty strings, and **slugify** the slug
  (`lowercase`, `[a-z0-9-]`, collapse dashes). Throws a typed `CaptionError` on
  network/timeout/parse failure — the endpoint degrades gracefully (below).
- Isolated behind one function and an injectable `fetchImpl` so tests never touch the network.

### New endpoint: `POST /suggest`

- Auth: same bearer token as `/upload`.
- Body: multipart, N image parts (+ optional `prefix`, informational).
- Per image: validate it's an image → make a **downscaled JPEG** (sharp, max edge ~768px) for
  fast inference → probe rotate-corrected intrinsic `width`/`height` → `captionImage(...)`.
- Returns `{ results: [{ filename, slug, altEn, altDe, width, height, captionError? }] }`.
- **Concurrency:** caption **sequentially (concurrency 1)** — one local model serves the batch,
  so serializing keeps inference predictable and avoids contention.
- **Graceful degradation:** a caption failure yields empty `slug/altEn/altDe` + `captionError:true`
  for that row; the endpoint never 500s for AI reasons. If LM Studio is entirely unreachable,
  every row returns empty and the page shows a notice so the author fills fields manually.

### New page: `public/batch.html` (served at `/admin/batch.html`)

- Linked from the main admin page. Inputs: **shared prefix**, **multi-file** picker, **Suggest**.
- After `/suggest`: one row per photo — local thumbnail, editable **slug**, **alt-DE**, **alt-EN**,
  shown dimensions. Client-side validation: slug matches `^[a-z0-9][a-z0-9_-]*$` and is
  **unique within the batch** (flag collisions — `/upload` overwrites a duplicate key silently).
- **Upload all** → `POST /upload` per row with `key = prefix/slug` → on success render two
  paste-ready snippets per photo:
  - DE: `<RemoteImage src="{src}" width={w} height={h} alt="{altDe}" />`
  - EN: `<RemoteImage src="{src}" width={w} height={h} alt="{altEn}" />`
  - Alt is HTML-escaped (`"` → `&quot;`). `src` is the base `{baseUrl}/{key}` (RemoteImage
    derives the srcset, exactly as for the hero).

### Reused unchanged

`variants.ts`, `pipeline.ts`, `storage.ts`, `auth.ts`, `POST /upload`, the filename/width
contract, the CLI. The batch flow rides on top of them.

## Blog-side follow-up (small, separate)

Allow `<RemoteImage>` inside MDX post bodies (it's currently used only for the hero). Likely
via the MDX `components` mapping or a documented import, accepting `{src,width,height,alt}`.
Tracked as its own small blog-repo change/plan; the batch tool is usable for storing + snippet
generation regardless, and the snippets render once this lands.

## Configuration (new env, uploader)

| Var | Default | Purpose |
|-----|---------|---------|
| `LMSTUDIO_BASE_URL` | `http://host.docker.internal:1234/v1` | LM Studio OpenAI endpoint (container → host) |
| `LMSTUDIO_MODEL` | `qwen/qwen3-vl-4b` | Vision model id |
| `CAPTION_TIMEOUT_MS` | `60000` | Per-image caption timeout |
| `CAPTION_MAX_EDGE` | `768` | Downscale longest edge before captioning |

`docker-compose.yml` adds `extra_hosts: ["host.docker.internal:host-gateway"]` so the container
reaches the host's LM Studio on Linux too (Docker Desktop on macOS provides it automatically).

## Error Handling

- **AI down / errors:** per-row empty suggestions + notice; manual entry still works; batch never
  hard-fails on AI.
- **Auth:** `/suggest` and `/upload` both require the bearer token (401 otherwise).
- **Bad input:** non-image parts rejected per file; invalid `prefix/slug` rejected at commit by
  the existing key validation.
- **Duplicate slugs:** flagged client-side before commit (server would otherwise overwrite).
- **Timeout:** bounded model call; on timeout the row degrades to manual.

## Testing

- `test/caption.test.ts` — inject a fake `fetchImpl`; assert parsing of clean JSON, fenced JSON,
  and malformed output; slugification; `CaptionError` on network/timeout. No live model.
- `test/server.test.ts` — `buildServer` gains an injectable `captioner` (default = real
  `captionImage`). New cases: `/suggest` 200 with a stub captioner returning canned rows;
  `/suggest` 401 without auth; non-image handling; degraded row when the stub throws.
- Existing `pipeline`/`storage`/`upload`/`variants`/`auth` tests stay green; `tsc --noEmit` clean.
- No automated test depends on LM Studio running.

## Out of Scope

- Hero image flow (unchanged).
- A full gallery/lightbox component on the blog (only inline single images here).
- Phase-2 WordPress migration (separate effort; the batch tool may help later).
- Machine translation (alt is generated natively per language).
- Server-side persistence of batch/suggestion state (stateless; the browser holds the files).

## Assumptions

- qwen3-vl-4b output quality on real photos is adequate; the author reviews/edits every field,
  so occasional misses are corrected in the loop. (Plumbing + vision validated 2026-06-22.)
- LM Studio runs with JIT model loading (observed) or the model is pre-loaded; first request
  in a session may be slow while the model loads.
- `host.docker.internal` resolves from the container (Docker Desktop on macOS, or `host-gateway`
  on Linux).
