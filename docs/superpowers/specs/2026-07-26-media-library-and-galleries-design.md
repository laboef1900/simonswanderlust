# Media Library & Galleries — Design

**Date:** 2026-07-26
**Status:** Draft (pending spec review)
**Repos touched:** blog repo — `uploader/` and `site/`.
**Builds on:** `2026-06-18-image-hosting-uploader-design.md` (image pipeline),
`2026-06-24-postgres-cms-phase-b-design.md` (in-admin editor),
`2026-07-03-single-app-container-design.md` (runtime).

**Companion spec (separate, not covered here):** AI post authoring with Claude. That work expands
the AI settings page and introduces the project's first server-side model call; it shares almost
no surface with this spec and is designed and shipped on its own.

## Goal

Turn the admin's photo handling from a filesystem listing into a real media library, and give
posts a first-class gallery.

1. **Library** — bulk drag-and-drop upload, virtual folders, per-photo metadata (bilingual alt
   and caption, EXIF, tags), search and filter.
2. **Galleries** — pick many photos from the library, order them, insert them into a post body;
   render them on the blog as a justified grid with a lightbox.
3. **Post management** — hero thumbnails, search/filter/sort, and bulk publish/unpublish/delete.

Two live defects found while designing this are fixed as part of it, and ship first (Phase 0).

## Confirmed Requirements

- **Folders are virtual** — a `folder` column decoupled from the storage key, so reorganising
  never changes an image URL.
- **Metadata:** bilingual alt + caption, EXIF (capture date, camera, lens), best-effort EXIF GPS,
  title, free-form tags.
- **Bulk upload** with per-file progress and retry.
- **Gallery presentation:** justified grid preserving aspect ratios, click for a full-screen
  lightbox; degrades to a plain grid of links without JS.
- **Posts list:** hero thumbnails, search/filter/sort, bulk actions with a single rebuild.
- **GPS is stripped from published variants; camera and capture date are kept.**
- **The variant width contract is unchanged** — `[640, 1280, 1920] + intrinsic width`.
- **Uploads are asynchronous** — the request returns once the original is stored; variants encode
  in a background worker.

## Non-Goals

- Any AI feature. Alt text keeps its browser-direct LM Studio path unchanged.
- Video, audio, PDFs, or any non-image asset.
- Image editing (crop, rotate, colour) in the admin.
- An external CDN or object store.
- A permissions model beyond today's admin/author split.
- Per-gallery titles or captions. Captions belong to the photo.
- Replacing EasyMDE or introducing a build step. `PRODUCT.md:34`'s "vanilla HTML/CSS/JS, no
  bundler, no framework" constraint holds; see *Admin UI* for why it is achievable.
- **Drag-to-reorder** anywhere. It has no keyboard equivalent and would break `PRODUCT.md:58`'s
  WCAG 2.1 AA commitment. Ordering uses move-up/move-down buttons.
- **"Duplicate post" / "New from this one."** Arguably the highest-value CMS affordance for posts
  with repeating structure (key facts, stops, region, country code), and it was raised in review —
  but it is outside what was asked for here. Noted as an obvious follow-up.

---

## Delivery Plan

This is ~5,000 lines across ~40 files, against a `uploader/src` that is 3,531 lines today. It is
**not one branch**. Five phases, each independently shippable, testable and revertible:

| Phase | Scope | Size | Why here |
|---|---|---|---|
| **0** | Privacy + upload hardening (D1, D2) | XS ~150 LOC | A live privacy leak. Zero dependency on anything else — ship first regardless of what happens to the rest. |
| **1** | Posts list: thumbnails, search/filter/sort, bulk actions | S ~350 LOC | Cheapest of the four asks, entirely self-contained, visible win while Phase 2 is in flight. |
| **2** | Media library: table, store, routes, `media.html` | L ~2,000 LOC | The daily pain. Delivers bulk upload + folders. |
| **3** | Gallery insert + render (uniform grid, no lightbox) | M ~700 LOC | Delivers a *working* gallery end to end. |
| **4** | Gallery polish: justified layout + lightbox + break-out | M ~700 LOC | Pure presentation, zero data model. Build after seeing a real Phase 3 gallery. |

Phase 3 ships a plain CSS grid so the feature is complete and usable before the justified-layout
and lightbox work lands. Phase 4 replaces the grid CSS and adds the island; nothing in the data
model or the fence format changes between them.

---

## Defects Fixed (Phase 0)

### D1 — Published image variants embed GPS coordinates

`uploader/src/pipeline.ts:69` calls `.withMetadata()` on every generated variant. Verified by
encoding a geotagged fixture through the real pipeline:

```
webp 640 variant -> exif 340 bytes  GPS: {"GPSLatitudeRef":"N","GPSLatitude":[63,4,33.12],
                                          "GPSLongitudeRef":"E","GPSLongitude":[10,23,19.44]}
avif 640 variant -> exif 340 bytes  GPS: {...identical...}
```

The code propagates whatever EXIF the source carries, GPS included, into every public file.

**Measured exposure, and it is better than the code implies.** A read-only scan of the **local
development** corpus (`uploader/data/images`, 102 variant files across 19 keys) found **102
carrying EXIF and zero carrying GPS**, in EXIF *and* XMP.

Be careful with the reason, because the intuitive one is not what the data shows. The audited
variants are processed exports whose metadata was already largely stripped: **88 of the 102 carry
no `Make`, `Model` or `Software` at all**, and the remaining 14 carry only
`Software = Capture One Macintosh`. "The Leica Q2 has no GPS receiver" is true independently, but
it is *not* what this audit established, and it does not generalise to WordPress-imported photos
shot on other devices in other years.

So the defect is **latent on the corpus that was measured** — not proven latent everywhere. The
server's corpus was never reachable from the development environment and remains unaudited; run
`audit-exif` there before relying on this finding. The day a geotagged photo is uploaded (a phone
shot, or anything geotagged via the Leica FOTOS app), the old code would have published
coordinates silently.

That distinction changes the remediation, not the fix. The pipeline change still ships in Phase 0.
The expensive part — rewriting the existing corpus — becomes **conditional on an audit**, because
re-encoding is not free: sharp cannot rewrite metadata without re-encoding, and **7 of the 19
local keys have no `-orig` file** to re-encode losslessly from (originals postdate issue #21).
The scan was of the local data directory, which may not mirror the server, so the audit runs
there too before anything is rewritten.

**Fix:** replace the blanket `.withMetadata()` with an explicit **allow-list re-injection**.
Allow-listing rather than "removing GPS" is deliberate: sharp has no per-tag removal, and
`withMetadata()` also carries XMP and IPTC blocks with their own location fields.

- **Kept:** `Make`, `Model`, `LensModel`, `DateTimeOriginal`, `ExposureTime`, `FNumber`,
  `ISOSpeedRatings`, `FocalLength`, plus the ICC profile via `keepIccProfile()` (colour accuracy
  matters; an ICC profile carries no location).
- **Dropped:** the entire GPS IFD, XMP, IPTC, and `Orientation` (variants are already
  auto-oriented by `.rotate()`; re-injecting it would double-rotate).

*Implementation risk:* `withExif()` replaces EXIF wholesale and takes string values. The exact
serialisation per tag must be settled by a round-trip test, not reasoned about. If a tag proves
impractical to write back, drop it from the allow-list — never widen back to blanket metadata.

**Remediating existing photos is audit-gated, not automatic.**

`node --import tsx src/cli.ts audit-exif` is read-only, cheap and always safe: it walks
`storageDir`, reports how many variants carry EXIF and how many carry GPS, and lists the affected
keys and whether each still has an `-orig`. **Run this on the server first.** If it reports zero
GPS — as the local corpus does — no rewrite is needed and Phase 0 is complete with the pipeline
change alone.

Only if the audit finds GPS does `node --import tsx src/cli.ts strip-gps [--dry-run] [--key <k>]`
run. It is deliberately the *last* resort, because **sharp cannot rewrite metadata without
re-encoding**:

1. **Re-encode from `-orig` when present** — lossless source, output quality identical to a fresh
   upload. **7 of the 19 local keys have no original** (originals postdate issue #21); those
   require `--from-variants`, which re-encodes the largest existing variant and costs one
   generation of lossy-on-lossy quality. The command refuses to touch them without that flag and
   names them.
2. **Atomic writes.** Write `${file}.tmp` in the same directory, verify it decodes with
   `sharp().metadata()`, then `rename()` — the pattern `settings.ts` already uses. A truncated
   variant is unrecoverable: the URL is content-hash-immutable and cannot be replaced without
   editing every published post.
3. **Preserve mtimes** (`utimes` after write). `backup.ts:90` selects archive members by
   `mtimeMs >= sinceMs`, so a naive rewrite makes the next scheduled backup tar the entire variant
   corpus — and image archives are deliberately never pruned.
4. **Run a backup first** (Golden Rule 3), and require free space ≥ total variant bytes. Resumable
   per key, so an interrupted run continues rather than restarting.

A companion `reencode <key>` subcommand regenerates variants from the retained `-orig`, giving a
damaged variant a recovery path at all — which it does not have today.

Because variants are served `immutable, max-age=365d`, a browser that already cached a photo keeps
the old copy for up to a year. There is no way around that short of changing URLs, which would
break published posts.

> `@ai-warning` for `pipeline.ts`: never reintroduce a blanket `withMetadata()`. Metadata on
> public variants is an explicit allow-list; widening it is a privacy change, not a refactor.

### D2 — `POST /upload` silently discards files

`uploader/src/server.ts:162-171` reassigns `buf` and `mimetype` on every file part while `key` and
`alt` are single scalars, so N files in one request means N−1 are buffered into memory and
dropped. Silent data loss, not an unsupported feature.

**Fix:** register multipart with `limits: { files: 1, parts: 8 }`.

**The rejection is a `413`, not a `400`.** Verified in
`node_modules/@fastify/multipart/index.js:22`: `FilesLimitError` is
`createError('FST_FILES_LIMIT', 'reach files limit', 413)`, raised out of the `req.parts()`
iterator before the handler observes a second file part. `setErrorHandler` (`server.ts:93`) passes
4xx through verbatim, so the client gets `413 {"error":"reach files limit"}`. Tests assert 413.

This also closes a real hole: the plugin currently allows `files: Infinity` / `parts: 1000`, and
Fastify's 1 MiB `bodyLimit` does not apply to multipart at all (the plugin's parser never consumes
the body), so one authenticated request may stream ~25 GB today.

---

## Data model

Two new tables in `uploader/src/db.ts`, following the existing convention: idempotent
`CREATE TABLE IF NOT EXISTS`, every new column also appended as `ALTER TABLE ... ADD COLUMN IF
NOT EXISTS`, `NOT NULL` columns carry defaults, no migration framework.

```sql
CREATE TABLE IF NOT EXISTS media (
  key           text PRIMARY KEY,          -- storage key incl. content hash
  folder        text NOT NULL DEFAULT '',  -- virtual path, '' = root
  title         text NOT NULL DEFAULT '',
  alt_de        text NOT NULL DEFAULT '',
  alt_en        text NOT NULL DEFAULT '',
  caption_de    text NOT NULL DEFAULT '',
  caption_en    text NOT NULL DEFAULT '',
  tags          text[] NOT NULL DEFAULT '{}',
  width         integer NOT NULL DEFAULT 0,   -- 0 = unknown (unreadable probe)
  height        integer NOT NULL DEFAULT 0,
  orig_bytes    bigint  NOT NULL DEFAULT 0,   -- the stored original
  variant_bytes bigint  NOT NULL DEFAULT 0,   -- sum of generated variants
  status        text NOT NULL DEFAULT 'processing'
                CHECK (status IN ('processing','ready','failed','missing')),
  error         text,                         -- fixed enum, never a raw message
  taken_at      timestamptz,
  camera        text,
  lens          text,
  lat           double precision,
  lng           double precision,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS media_folder_idx   ON media (folder);
CREATE INDEX IF NOT EXISTS media_taken_at_idx ON media (taken_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS media_uploaded_idx ON media (uploaded_at DESC);
CREATE INDEX IF NOT EXISTS media_tags_idx     ON media USING gin (tags);
CREATE INDEX IF NOT EXISTS media_status_idx   ON media (status) WHERE status <> 'ready';

CREATE TABLE IF NOT EXISTS media_folders (
  path       text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Three choices worth their reasoning:

- **`status` defaults to `'processing'`, not `'ready'`** — fail closed. Every insert sets it
  explicitly, so the default only fires when an insert *forgets* the column; defaulting to `ready`
  would declare a photo with no variants publishable, which is exactly what the publish gate
  exists to prevent.
- **`width`/`height` default to 0.** `db.ts:129` makes defaults mandatory on `NOT NULL` columns,
  and the backfill genuinely can produce unknowns: `listMedia` returns `width: number | null`
  "when unreadable" (`media-files.ts:31`). `0` means unknown; the UI shows `—` and such a photo is
  not selectable for a gallery (it cannot be laid out).
- **`orig_bytes` and `variant_bytes` are separate.** The request knows the first, the worker
  computes the second; one column would have been ambiguous about which the library shows.

**`media_folders` is the single source of truth for the folder tree.** Every write that sets a
`folder` also upserts the folder row (and its ancestors). This deliberately avoids a
"folder exists if a row OR any media.folder starts with it" union rule, which is two sources of
truth and a bug farm.

**The filesystem stays the source of truth for a file's existence.** The `media` row is metadata
*about* a file on disk, preserving the property `ARCHITECTURE.md` relies on: photos survive a
database loss.

> `@ai-warning`: `taken_at` is EXIF wall-clock time with no zone. `exif-reader` relabels those
> digits as UTC (`new Date(Date.UTC(...))`), so a shot taken at 18:23 in Norway stores as `18:23Z`.
> Format with `getUTC*` accessors only — a local-time formatter double-shifts it and silently
> mislabels photos across timezones.

### TypeScript contract (Contract-First)

**Naming.** `uploader/src/media.ts` is **renamed to `media-files.ts`** (it walks the disk:
`listMedia`, `imageUsage`, `deleteMedia`), and its exported `MediaItem` becomes **`MediaFiles`**.
The new database module is `media-store.ts` and owns the name `MediaItem`. Without this there
would be two `media-*` modules exporting two different `MediaItem`s, both imported by `server.ts`.

```ts
// media-store.ts
export type MediaStatus = 'processing' | 'ready' | 'failed' | 'missing';
export type MediaError  = 'decode_failed' | 'encode_failed' | 'write_failed' | 'no_space';

export interface MediaExif {
  takenAt: Date | null;   // wall-clock triple; read with getUTC*
  camera: string | null; lens: string | null;
  lat: number | null; lng: number | null;
}

export interface MediaItem {
  key: string;
  src: string;            // `${baseUrl}/${key}`
  thumbSrc: string | null;// server-derived; see below
  folder: string; title: string;
  alt:     { de: string; en: string };
  caption: { de: string; en: string };
  tags: string[];
  width: number; height: number;          // 0 = unknown
  origBytes: number; variantBytes: number;
  fileCount: number;                       // for the delete confirmation
  status: MediaStatus; error: MediaError | null;
  exif: MediaExif;                         // lat/lng redacted for non-admins
  uploadedAt: Date;
  uploadedBy: string | null;               // redacted for non-admins
}

export interface NewMediaItem {
  key: string; folder?: string; title?: string;
  alt?: { de?: string; en?: string }; caption?: { de?: string; en?: string };
  tags?: string[];
  width: number; height: number; origBytes: number;
  status: MediaStatus;                     // required — no implicit default
  exif: MediaExif;
  uploadedBy: string | null;
}

export type MediaPatch = Partial<Pick<NewMediaItem,
  'folder' | 'title' | 'alt' | 'caption' | 'tags'>>;

export interface MediaQuery {
  folder?: string; recursive?: boolean;
  q?: string; tag?: string; status?: MediaStatus;
  sort?: 'uploaded' | 'taken' | 'title' | 'key';
  order?: 'asc' | 'desc';
  page?: number; pageSize?: number;
}

export interface MediaStore {
  list(q: MediaQuery): Promise<{ items: MediaItem[]; total: number }>;
  get(key: string): Promise<MediaItem | null>;
  upsert(item: NewMediaItem): Promise<MediaItem>;
  patch(key: string, fields: MediaPatch): Promise<MediaItem>;
  move(keys: string[], folder: string): Promise<number>;
  remove(key: string): Promise<void>;
  notReadyKeys(keys: string[]): Promise<Set<string>>;   // publish gate
  claimNextProcessing(): Promise<MediaItem | null>;
  setStatus(key: string, s: MediaStatus, e?: MediaError): Promise<void>;
  setVariantBytes(key: string, bytes: number): Promise<void>;
  folders(): Promise<string[]>;
  createFolder(path: string): Promise<void>;
  renameFolder(from: string, to: string): Promise<number>;
  deleteFolder(path: string): Promise<void>;            // refuses if non-empty
}
```

Both a `pgMediaStore(pool)` and a `memoryMediaStore()` ship, mirroring `PostStore` — that is why
`posts.test.ts` runs without a database today, and the media suites must too.

**`thumbSrc` is server-derived, not guessed by the client.** `variantWidths` never upscales
(`variants.ts:11`), so a photo narrower than 640 px has no `-640.webp` — only `-<intrinsic>.webp`.
A client deriving thumbnails would be a third copy of the width contract, which the codebase
deliberately keeps in exactly two cross-referenced places.

### Folder path validation

Folders never touch the filesystem, but they go into SQL `LIKE` patterns, URLs and the DOM, so
they are validated at every entry point. `assertSafeKey`'s narrowness is not reusable here (folder
names are human-facing and must allow `Patagonien Süd`), so this is its own rule:

```ts
// One segment: Unicode letter/digit at both ends; interior may add space, hyphen,
// underscore, dot. Excludes control/format chars (bidi overrides, zero-width),
// HTML and URL metacharacters, and LIKE wildcards.
const SAFE_FOLDER_SEG = /^[\p{L}\p{N}](?:[\p{L}\p{N} _.\-]{0,62}[\p{L}\p{N}])?$/u;
export const MAX_FOLDER_DEPTH = 6;
export const MAX_FOLDER_LEN = 200;

export function assertSafeFolder(path: string): void {
  if (path === '') return;                                   // root
  if (path.length > MAX_FOLDER_LEN) throw new Error('folder path too long');
  if (path.normalize('NFC') !== path) throw new Error('folder path must be NFC');
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(path)) throw new Error('folder path has control/format chars');
  const segs = path.split('/');
  if (segs.length > MAX_FOLDER_DEPTH) throw new Error('folder nesting too deep');
  for (const s of segs) if (!SAFE_FOLDER_SEG.test(s)) throw new Error(`invalid folder segment`);
}
```

Called on `createFolder`, **both** arguments of `renameFolder`, `move`, `patch`, and the
`MediaQuery.folder` filter.

**Subtree moves must not use `LIKE`.** `WHERE folder LIKE $1 || '/%'` treats `%` and `_` in a
folder name as wildcards — a folder literally named `%` would move the entire library on rename.
The regex above already excludes them, but defence in depth matters for an irreversible bulk
write: use `starts_with(folder, $1 || '/')`. Rename semantics are exact-match update **plus**
prefix rewrite, so `Iceland` moves `Iceland/*` but never `Iceland 2024`. Renaming onto an existing
folder returns **409**; merging is not supported. A `to` that is a descendant of `from` is
rejected. `media-store.test.ts` covers a folder named `%`.

---

## Upload pipeline (asynchronous)

One 24 MP Leica frame costs a measured **19.24 s and ~1.94 GB peak RSS**, ~80% of it the
full-resolution AVIF variant. The variant contract stays as-is by decision, so the request must
not hold the connection: at concurrency 2 a VPS sits at 40–90 s against nginx's default 60 s
`proxy_read_timeout`, and a 6-concurrent batch already measured 63.6 s requests.

The response can still be complete immediately, because the storage key is a pure function of the
content hash, and `sharp(buf, { failOn: 'none' }).metadata()` returns orientation-corrected
dimensions in **0.0002 s** — versus the **0.467 s** full re-encode `pipeline.ts:45` performs today
purely to read them.

### Storage key derivation

Bulk upload has no post slug to derive a key from, and `KEY_RE`/`SAFE_KEY_RE` are **lowercase
only** — so a Leica's `L1002345.JPG` is a 400 today. Specified explicitly:

```ts
// library/<yyyy>/<slug>, then contentHashKey() appends -<hash8>.
// Deliberately NOT derived from the virtual folder: folders are renameable,
// keys are immutable, and coupling them would desynchronise on the first rename.
function libraryKey(filename: string, now: Date): string {
  const base = filename.replace(/\.[^.]+$/, '')
    .toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')   // strip diacritics
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `library/${now.getUTCFullYear()}/${base || 'photo'}`;
}
```

Editor uploads keep their existing `trips/<slug>/hero` and `trips/<slug>/<name>` keys unchanged.

### `POST /upload` (session)

1. Read the single file part; validate mimetype and key as today.
2. `contentHashKey(key, buf)`.
3. Branch on any existing row for that key — **all three states specified**, because the key is
   the primary key and re-uploading identical bytes is the normal case when a folder is dropped
   twice:
   - `ready` → return it with `{ duplicate: true }`. No re-encode, no rewrite.
   - `processing` → return `{ duplicate: true, status: 'processing' }`. Do **not** re-enqueue.
   - `failed` → reset to `processing`, re-enqueue, return `{ status: 'processing' }`.
   - Any supplied `alt`/`title` on a duplicate updates the row (it is not silently discarded), but
     the stored values win for the returned `snippet`.
4. `metadata()` for dimensions and format; `parseExif()`.
5. `storeOriginal(key, buf, ext, opts)` — writes only `${key}-orig.${ext}`.
6. `upsert` the media row with `status: 'processing'`.
7. Enqueue an encode job; return `{ src, width, height, key, status, snippet }`.

**`storage.ts` refactor and its three callers.** `storeVariants()` splits into
`storeOriginal(key, data, ext, opts)` and `storeVariantFiles(key, variants, opts)`, with
`assertSafeKey` and `SAFE_EXT_RE` staying in `storeOriginal` so the single write chokepoint is
preserved. `storeVariants()` is **retained as a thin wrapper** calling both, because two of its
three callers need the synchronous contract:

| Caller | Becomes |
|---|---|
| `server.ts:184` (`POST /upload`) | `storeOriginal` + enqueue |
| `cli.ts:17` (`uploadFile`) | unchanged — keeps `storeVariants` |
| `wp-images.ts:15` (WP re-host) | unchanged — keeps `storeVariants`; the importer returns `{src,width,height}` synchronously into the post body. **WP-imported images do get `media` rows**, inserted `status: 'ready'` after the synchronous encode. |

`SECURITY.md:69` states the chokepoint is in `storeVariants` and must be updated to name
`storeOriginal`.

### Encode worker

`uploader/src/encode-queue.ts`, started from `main.ts`:

- In-process queue, concurrency **2** — the measured throughput plateau (N=6 bought +12%
  throughput for +47% memory). Single-process deployment, so an in-process semaphore suffices;
  the pattern mirrors `withSetupLock`.
- **The queue pauses while a site build runs.** `build.ts` spawns `astro build` *in the same
  container*, `docker-compose.yml` sets no `mem_limit`, and the natural workflow this design
  creates is "drop 100 photos, close the tab, write the post, click Publish" — which would put a
  build and two encoders in one container competing for memory, where an OOM kills the blog, the
  admin and the image host together. The builder already serialises; the queue takes the same
  lock. This is the single most important line in this section.
- On boot, seed from `media WHERE status = 'processing'`. A crash mid-encode self-heals because
  re-encoding overwrites the same deterministic filenames.
- Success → write variants, `setVariantBytes`, `status = 'ready'`.
- Failure → `status = 'failed'` with a `MediaError` **enum** (never a raw message; libvips
  embeds filesystem paths, and the library UI displays this field). The real error is logged to
  stdout only, matching the global handler's contract. Never crash the app over an encode failure.
- **Bounded:** an author cannot queue unbounded work — `parts: 8` per request, and the queue
  refuses to enqueue beyond a configured backlog (returning `429`) so disk and memory stay
  bounded.

**Shutdown.** `createShutdown` (`shutdown.ts:20`) currently takes `{close, end, exit, log, error}`
and runs `close() → end() → exit(0)`. It gains a **`drain: () => Promise<void>`** hook and the
order becomes `close → drain → end → exit`. Without this, in-flight jobs are still running when
`pool.end()` fires, their final `setStatus` write fails, and every `docker stop` logs a rejection
while leaving rows stuck in `processing`. This changes `createShutdown`'s signature and its
existing tests.

### Publish gate

**Not in `validateForPublish`.** That function is `(pair: PostPair) => void` — synchronous, pure,
with no store access and no knowledge of `cfg.baseUrl`. Making it async would ripple through every
`posts.test.ts` case for no benefit.

The gate lives in the `POST /posts/:tk/publish` handler in `server.ts`, which already has both
`cfg.baseUrl` and the media store:

```ts
// src -> storage key: strip the base URL and any hand-pasted variant suffix.
function srcToKey(src: string, baseUrl: string): string | null
```

The handler collects every URL the post references (hero + `images` map keys — gallery URLs are
already `images` keys, since `body-images.ts` skips any that are not), maps them through
`srcToKey`, calls `notReadyKeys()`, and blocks with a message naming the photos. **URLs with no
media row do not block** — WordPress-imported and legacy files already exist on disk.

Draft preview may show broken images for photos still encoding. Surfaced honestly: the editor
shows "N photos still processing".

### Client

Three concurrency limits, deliberately different:

| Limit | Value | Why |
|---|---|---|
| Browser uploads | 3 | Transfer-bound, not CPU-bound. Keeps the pipe full without making progress meaningless. |
| Server encode queue | 2 | Measured CPU/memory plateau. **Must** be server-side — a client limit is advisory and a second tab or `curl` bypasses it. |
| Concurrent builds + encodes | 1 | The OOM mitigation above. |

`fetch()` cannot report upload progress, so the queue uses `XMLHttpRequest` with
`upload.onprogress`. That is a different code path from every other admin request and therefore
cannot reuse `Auth`'s 401 handling — it needs its own, explicitly.

**Failed uploads get a retry affordance**, distinct from failed *encodes*. One laptop sleep or one
503 in a 100-file batch must not leave the author guessing which files landed. The queue keeps
per-file state and offers "Retry failed (N)".

The tab must stay open for the uploads (bandwidth-bound; ~1 GB for a 100-photo batch of 10 MB
frames) but not for encoding, which continues server-side after the tab closes.

An explicit Fastify `requestTimeout` is set so the server, not the proxy, owns a stalled upload.

---

## EXIF extraction

`uploader/src/exif.ts` — pure, no I/O, unit-tested.

Dependency: **`exif-reader@2.0.3`**. Zero dependencies, no install script, MIT, no known CVEs,
co-maintained by sharp's author. The alternative `exifreader` was checked and rejected: three DoS
CVEs and a `postinstall` colliding with this repo's `allowScripts` policy. Both names were
verified against the live registry.

sharp exposes EXIF as **raw bytes only** (`exif?: Buffer` is its entire EXIF surface), so a parser
is genuinely required.

```ts
export function parseExif(raw: Buffer | undefined): MediaExif   // never throws
```

IFD grouping is not flat: camera body under `Image`, lens and time under `Photo`, GPS under
`GPSInfo` — `parsed.Image?.Make`, `parsed.Photo?.DateTimeOriginal`, `parsed.Photo?.LensModel`,
`parsed.GPSInfo?.GPSLatitude`.

```ts
function toDecimal(dms: unknown, ref: unknown): number | null {
  if (!Array.isArray(dms) || dms.length < 2) return null;
  const [d = 0, m = 0, s = 0] = dms as number[];
  if (![d, m, s].every(Number.isFinite)) return null;   // guards 0/0 -> NaN
  const dec = d + m / 60 + s / 3600;
  if (!Number.isFinite(dec)) return null;
  return ref === 'S' || ref === 'W' ? -dec : dec;
}
```

**Every string leaving this module is sanitised**, because EXIF values are attacker-controlled
bytes that flow into Postgres and then into the admin DOM:

```ts
const clean = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001F\u007F]/g, '').normalize('NFC').trim().slice(0, 120);
  return s || null;
};
```

The NUL strip is not cosmetic: Postgres `text` rejects a NUL byte (`\u0000`) outright, so a crafted JPEG would
500 every upload of that file — a trivial DoS. The length cap stops a multi-megabyte `Model` from
entering every `GET /media` response.

Verified behaviours the implementation must handle:

- **Rationals arrive pre-divided** (`[63, 4, 33.12]`), not as numerator/denominator pairs. Most
  DMS snippets online assume the pair form and produce garbage here.
- **Missing EXIF** — `meta.exif` is `undefined`; passing it to `exifReader()` throws. Guard first.
- **Malformed EXIF throws** rather than returning null — except partial corruption, which succeeds
  with `Image: null`. The bundled `.d.ts` understates that nullability, so use optional chaining,
  not truthiness, under `strictNullChecks` (Golden Rule 7).
- **Zero-denominator rationals** yield `NaN`; the `Number.isFinite` guard is what stops a broken
  coordinate reaching the database.
- **HEIC is unsupported** — sharp's prebuilt binaries decode only the AV1 flavour of HEIF, so
  iPhone `.heic` fails at decode before EXIF matters. Pre-existing, documented not changed.
- Parsing is low-risk: pure JS, bounds-checked, no filesystem or network access, and sharp has
  already stripped the container — where the rejected alternative's CVEs live. The realistic
  failure is a thrown exception; `try/catch` is the whole mitigation.

**GPS is best-effort.** The Leica Q2 has no built-in GPS, so unless a photo was geotagged via the
Leica FOTOS app, `lat`/`lng` are null. When present, the editor **offers** — never automatically
applies — to fill the post's `coordinates` or append a `stops[]` entry. AE-1 film scans carry
scanner EXIF or none.

`pipeline.test.ts` can assert real GPS round-trips: libvips maps `IFD3` to the GPS IFD, so
`withExif({ IFD3: { GPSLatitude: '63/1 4/1 3312/100', ... } })` works. The existing test comment
claiming otherwise is wrong and is corrected.

---

## Reconciliation

`uploader/src/media-sync.ts`:

- **Backfill** — insert a row for every key on disk with none. It uses **its own walk that also
  matches `ORIGINAL_FILE_RE`**, not plain `listMedia`: a `processing` row has written only
  `${key}-orig.<ext>` and has no variant files yet, so a variants-only walk would never discover a
  crashed upload — the case it most needs to heal. Probe failure → insert with `width/height = 0`
  rather than aborting the pass.
- **Alt-text harvest** — for each key, copy alt text from posts referencing its URL into
  `alt_de`/`alt_en` by the referencing row's locale. **Exact URL matches only**: `heroImage.src`
  equality and the `![alt](src)` parse that `normalizeBodyImages` already performs. No fuzzy
  matching — a mis-attribution would silently poison the library and then denormalize into future
  posts. Logs what it did.
- **Prune** — a row whose files have all vanished is marked `status: 'missing'`, never deleted.
  **Skips rows whose `status <> 'ready'`**, or an in-flight upload would be marked missing by a
  concurrent pass.

Runs after `listen()`, never blocking boot, logging to stdout, degrading gracefully on failure.
`POST /media/rescan` (admin) triggers it on demand.

## Backups

`backup.ts` gains `media` and `media_folders` and goes to **`version: 3`**. Three things the
naive version of this change gets wrong:

1. **`backup.ts:237` is an allow-list:**
   `if (dump.version !== 1 && dump.version !== 2) throw ...`. Bumping `DUMP_VERSION` without
   widening this guard to accept **1, 2 and 3** makes every newly written dump unrestorable — and
   a test that only checks "a v2 dump still restores" passes anyway. Tests must assert a **v3**
   dump restores.
2. **Restore ordering.** `media.uploaded_by` references `users(id) ON DELETE SET NULL`, and
   `restoreDatabase` does `DELETE FROM users`. `DELETE FROM media_folders, media` must run
   **before** `users`, or the FK nulls every `uploaded_by` before users are re-inserted.
3. **`tags text[]` cannot round-trip through `asJsonb`** (`backup.ts:228`), which every other
   non-scalar column uses. It needs a `$n::text[]` bind with a real JS array.

Without this, a database restore would lose every folder, caption and tag while the photos came
back — the worst kind of partial recovery.

---

## Galleries

### Body encoding

A fenced block with the language `gallery`, one image URL per line. Blank lines and `#`-prefixed
lines are ignored; order is line order. Alt text and captions come from the post's `images` map,
not the fence.

````markdown
```gallery
https://img.simonswanderlust.com/trips/patagonia-2025/dsc0412-1a2b3c4d
https://img.simonswanderlust.com/trips/patagonia-2025/dsc0455-9f8e7d6c
```
````

**This does not work today, and one config line is why.** Verified against the real pipeline:
Shiki intercepts the unknown language, warns
`[Shiki] The language "gallery" doesn't exist, falling back to "plaintext"`, and emits
`class="astro-code github-dark"` with `data-language="plaintext"` — which `rehype-sanitize` strips,
because `data-*` is absent from its `'*'` allow-list. The token `gallery` survives nowhere.

Languages in `syntaxHighlight.excludeLangs` bypass Shiki entirely. Proven with the one entry
already configured, `math`: the output is byte-identical before and after sanitize, with
`class="language-math"` intact.

**Two files must change together**, or the draft preview diverges from the build:

- `site/astro.config.mjs` — currently has **no** `markdown` key, so this block is new. Specifying
  the option *replaces* the default, so it must keep `math`.
- `site/src/lib/render-markdown.ts:24` — the mirrored options.

To make the parity testable, `render-markdown.ts` **exports** the options rather than hard-coding
them inside `getRenderer()`:

```ts
export const MARKDOWN_OPTIONS = {
  syntaxHighlight: { type: 'shiki', excludeLangs: ['math', 'gallery'] },
  shikiConfig: { theme: 'github-dark' },
} as const;
```

imported by `getRenderer()` and by a test that compares it against `astro.config.mjs`. A silent
divergence here means previews and the live site disagree about what a gallery is.

**Considered and rejected: splitting the markdown before rendering.** `@astrojs/markdown-satteri`
instantiates its heading slugger *inside* each `render()` call, so a post with two `## Etappe`
sections split across a gallery emits duplicate `id`s, and `BODY_SCHEMA`'s `clobberPrefix: ''`
(which exists so `<Toc>` anchors resolve) means both Toc links point at the first heading. Fixing
that requires re-slugging merged headings and rewriting `id`s in already-emitted HTML — a
post-render HTML pass, i.e. exactly what the split was meant to avoid.

### Render path and its security boundary

`site/src/lib/body-images.ts` gains a `galleryNode()` beside `pictureNode()` and one branch in the
existing `visit()`: match `pre > code` whose className contains `language-gallery`, parse the URLs,
replace the node — **after** `rehypeSanitize`, exactly as `pictureNode` does today.

That "after sanitize" position is what makes the next three rules mandatory rather than
defensive. `pictureNode` is safe today only because its `src` comes off a hast `<img>` node the
sanitizer already protocol-checked (`defaultSchema.protocols.src = ['http','https']`). **Gallery
URLs arrive as text content, which sanitize never protocol-checks.**

**1. URLs are allow-listed, not merely parsed.** Verified attack: a fence line of
`javascript:alert(1)` promoted into the lightbox's `<a href>` emits
`<a href="javascript:alert(1)-1280.webp">`, which evaluates `alert(1)` then throws — the payload
fires. The `images`-map gate is not a control (`images` is unvalidated author-supplied jsonb;
`server.ts:420` casts it and `validateDraft` ignores it), and neither is the publish gate (a
`javascript:` URL has no media row, so it is not blocked).

```ts
let u: URL; try { u = new URL(raw); } catch { continue; }
if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
if (!raw.startsWith(imageBaseUrl)) continue;   // the only thing a gallery may reference
```

The escalation this closes is real: `GET /posts/:tk/preview` is `requireAuth` (any author), runs
the identical transform, and is served **same-origin with `/admin/*` with no CSP**. A non-admin
author stores the payload in a draft; the admin opens the preview; the script runs with the
admin's cookie against `POST /users`, `GET /backups/*`, `POST /posts/:tk/publish`.

**2. Every value from the `images` map is coerced to a string before it reaches hastscript.**
Attribute and text escaping is correct — `'" onerror="alert(1)'` verified as
`alt="&#x22; onerror=&#x22;alert(1)"` — **but the map is JSON, and hastscript treats a node-shaped
object in a children array as a node**: `h('figcaption', [{type:'raw', value:'<script>…'}])`
emits a live script tag, and `transformBodyImages` stringifies with `allowDangerousHtml: true`.
So `String(v ?? '')` at the render boundary, **and** validation at the API boundary: `validateDraft`
rejects any `images` entry whose `alt`/`caption` is not a string or whose `width`/`height` are not
positive integers. `PUT /pages/:key` (`server.ts:552`) carries the identical `as Record<...>` cast
and gets the same treatment.

**3. Dimensions are validated before any arithmetic reaches a `style` attribute.** The layout
emits `style="--r:…"` computed from those unchecked values; `preview.ts:36` already documents this
exact hazard for `heroImage` and coerces, while `body-images.ts` does not. A `width` of
`'1;} html{display:none}/*'` injects CSS into a post-sanitize node; a `height` of `0` yields
`--r:Infinity` and breaks the layout. Skip any item without `Number.isInteger(w) && w > 0 &&
Number.isInteger(h) && h > 0`.

Failure modes, chosen so nothing silently disappears: a URL with no `images` entry is skipped; if
that leaves the gallery empty, the original sanitized `<pre>` is left visible.

### Per-locale captions

`images` values widen from `{width, height}` to `{width, height, alt?, caption?}`. Because DE and
EN are already separate rows, German captions live on the DE row and English on the EN row with no
new schema.

**There are three independent `ImageDims` declarations and all three must widen in lockstep:**

| File | Type | Note |
|---|---|---|
| `uploader/src/posts.ts:5` | `PostLocale.images` | the obvious one |
| `site/src/lib/body-images.ts:9` | `transformBodyImages`'s parameter | **`galleryNode` cannot read `alt`/`caption` without this** |
| `uploader/src/pages.ts:4` | `PageContent.images` | plus the `as Record<...>` cast at `server.ts:552` |

Because the new properties are optional and the arguments are not fresh object literals, `tsc` and
`astro check` pass whether or not this is done — the failure mode is galleries rendering with
empty alt and no captions on a **green build**. The earlier claim that consumers need "zero
changes" was wrong: the *arity* is unchanged, the value type is not.

Galleries are supported in `pages` bodies (the About page) on the same terms.

Values are **denormalized from the library at insert time**, so a published snapshot stays
self-contained and editing a post cannot leak live before publish (issue #20). A "Sync captions
from library" action re-pulls current values on demand.

### MDX export round-trip

`export.ts:11` matches only `/!\[([^\]]*)\]\(([^)]+)\)/g`, so it never touches gallery fence lines
— an "Export all" backup would preserve the fence text but lose every gallery photo's width,
height, alt and caption, and re-importing would produce a gallery `body-images.ts` skips entirely.

**Fix:** `bodyToMdx` emits per-line metadata alongside each gallery URL, and `normalizeBodyImages`
gains the matching parse branch:

````
```gallery
https://img.…/a-1a2b3c4d | 3000x2000 | alt="Sunrise over the towers" | caption="Day 3"
```
````

The parser tolerates a bare URL (no metadata) for hand-written fences, and `export.test.ts` gains
a case for a body containing a gallery.

### Layout (Phase 4)

`site/src/lib/gallery-layout.ts` + `gallery-layout.test.ts`. The justified-row algorithm partitions
photos by comparing whether row height is closer to target with or without the next photo; the last
row is capped rather than stretched.

**Emitted DOM is explicitly nested per row** — `flex-wrap: nowrap` on one container holding all 13
photos would put them on a single line:

```html
<div class="jgal"><div class="jgal__row">…</div><div class="jgal__row">…</div></div>
```

**Honest statement of what is and is not fluid.** Emitting ratios rather than pixels lets the
browser redo the justification arithmetic **within a row** at any width — that is real, and it is
why `flex: calc(var(--r) * 100) 1 0` is used. But **row membership is fixed at build time.** The
partition is computed for a 1112 px container; between 600 px and 1112 px the same rows simply get
shorter (a 3-up row renders at 198 px tall in a 644 px container), and below 600 px an
`@container` query stacks to one photo per line. This is an accepted trade-off, not a solved
problem, and the earlier draft overstated it.

Consequently `sizes` is derived from a **conservative bound**, not from the build-time percentage,
which is only accurate at the width the partition was computed for.

Two gotchas found empirically, to be encoded as CSS comments:

1. **`flex-grow` below 1 does not consume the free space.** With `flex: var(--r) …` a lone
   portrait (`--r: 0.667`) rendered **808 px instead of 1112 px** — CSS distributes only `Σgrow`
   of the free space when `Σgrow < 1`. Hence the `* 100`.
2. **The popular "pure-CSS justified gallery"** (`flex-wrap: wrap` + computed `flex-basis`)
   measured lines of 507 px and 741 px against a 300 px target. Hence `nowrap` + `flex-basis: 0`.

Gallery CSS lives in `site/src/styles/global.css` as **plain CSS classes**, not Tailwind utilities
— custom-property-driven flex is not expressible as utilities, and plain CSS avoids depending on
Tailwind's source scanning for markup injected at runtime by `body-images.ts`.

There is no full-bleed pattern in the codebase (the hero only looks full-width because it is a
sibling *outside* the `max-w-3xl` wrapper). The gallery gets an opt-in break-out, measured
overflow-free from 390 px to 1440 px:

```css
--jgal-w: min(100% + 24rem, 100vw - 3.5rem, 1112px);
width: var(--jgal-w);
margin-inline: calc((100% - var(--jgal-w)) / 2);
```

`100vw - 3.5rem` prevents horizontal overflow (`100vw` includes the classic scrollbar).
`margin-left: 50%; transform: translateX(-50%)` is **not** used — a transform makes the element a
containing block for fixed-position descendants.

CLS is zero: each item's height comes from `width × 1/aspect-ratio`, resolved before any image byte
arrives.

### Lightbox (Phase 4)

`site/src/scripts/gallery-lightbox.ts`, loaded by a `<script>` in `StoryPage.astro` — the gallery
markup is injected HTML, not a component, and Astro only bundles script tags it parses. It no-ops
when the page has no gallery. Same island pattern as `travel-map.ts`.

- **Degradation:** each photo is a real `<a>` to its largest variant. JS off → clicking opens the
  full-resolution image, and the grid is already correctly laid out by CSS alone.
- **Native `<dialog>` + `showModal()`** gives focus trap, Esc, `inert` background, `::backdrop`
  and focus restoration for free. Verified that the top layer escapes the gallery's
  `container-type: inline-size` containment, which a `position: fixed` div would not.
- **Measured gap:** the browser does *not* lock page scroll behind a modal dialog. Fixed in CSS:
  `html:has(dialog.jgal__lb[open]) { overflow: hidden; }`.
- Arrow keys and `Home`/`End` navigate; backdrop click closes; position announced via a polite
  live region; `prefers-reduced-motion` respected.
- All strings come from `site/src/i18n/ui.ts` via data attributes, mirroring `data-readstory`
  (Golden Rule 6).
- **The script never touches the grid** — no measuring, no class toggling — or CLS returns.

### Draft preview limitation

`uploader/src/preview.ts` is a standalone page that inlines its own `STYLE` constant and loads no
site CSS or JS ("no site CSS is built for drafts"). The gallery CSS block is **copied into that
`STYLE` constant** so draft previews are not an unstyled column of full-width images. The
lightbox is **not** available in draft preview; clicking a photo opens the full-size image. Stated
here so it is not discovered mid-implementation.

---

## Admin UI

The admin has no bundler, no framework, no shared template, and **no modal or toast component**.
For calibration: `editor.html` is 852 lines with 666 lines of inline script; the largest
standalone module, `draft-guard.js`, is 137 lines; `admin.css` is 588 lines.

An honest estimate for the library client is **~1,500 lines** — 2.25× the editor's inline script.
That is mechanically fine in vanilla JS (a tree, a grid and a drop zone are plain DOM), but only
with stated structure. Three rules, all load-bearing:

**1. Three files, not one.** "No bundler" permits multiple `<script>` tags; it never required one
file.

| File | Responsibility |
|---|---|
| `media-api.js` | fetch/XHR, state object, selection math, key slugification, upload queue. **No DOM.** |
| `media-browser.js` | the `media.html` library page |
| `media-picker.js` | the modal used by the editor |

**2. One state object, one `render()`.** Five interacting states (selection × folder × filter ×
queue × detail-dirty) with no reactive layer is where 1,500 lines rot. The grid is rebuilt from
state; never mutated ad hoc. ~50 lines of discipline, stated in the spec so it is not optional.

**3. DOM is built with `textContent`; `innerHTML` is permitted only for `= ''`.** Every existing
admin page already follows this (verified across all nine), but it is convention, not a written
rule — and this module renders attacker-influenced EXIF strings, folder names and captions. Made
explicit here, and covered by a browser-mirror test following the `llm-mirror.test.ts` precedent
already in this repo (which exists for exactly this reason).

`admin.css` gains its first modal, built on native `<dialog>` — same choice as the blog lightbox,
same accessibility reasons. Existing tokens and `.posts-table` / `.card` / `.btn-*` /
`.status-badge` / `.route` are untouched.

### Accessibility

`PRODUCT.md:58` commits to WCAG 2.1 AA and keyboard/screen-reader usability. A multi-select photo
grid is one of the harder patterns, so it is specified rather than assumed:

- Roving `tabindex` over the grid with `aria-multiselectable="true"`; arrow keys move focus,
  `Space` toggles selection, `Shift+Arrow` extends a range, `Ctrl/Cmd+A` selects all.
- Mouse equivalents (click, shift-click, ctrl/cmd-click) are additive, not the only path.
- **Ordering uses move-up/move-down buttons**, not drag — ~20 lines, keyboard-accessible by
  default, and touch-friendly.
- The drop zone has a visible `<input type="file" multiple>` fallback; drag-and-drop is an
  enhancement.

### `media.html`

Folder tree sidebar, photo grid, drop zone, selection toolbar and a detail panel editing title,
both alt texts, both captions, tags and folder, with EXIF read-only. Photos still encoding show a
processing badge; failed ones show Retry. Delete stays admin-only and still refuses when a post or
page references the photo.

### Editor integration

- **Insert gallery** in the body toolbar opens the picker; photos are multi-selected and ordered,
  then inserted as a fence with dimensions, alt and captions merged into the locale's `images`
  map. Cursor inside an existing fence turns it into **Edit gallery**.
- **The hero picker gains "Choose from library"** — not just "upload". "Select multiple of the
  photos from the library" implies a library-first mental model, and reworking
  `uploadHero()`/`uploadBodyImg()` (`editor.html:385-465`) to browse as well as upload is a real
  chunk of Phase 3, not a footnote.
- The picker shows **usage refs** ("used in: Patagonia") — "did I already use this shot?" is a
  picker-time question, and `imageUsage` already computes it.
- Photos uploaded from the editor land in the library with metadata instead of being invisible
  to it.
- AI alt-text buttons are untouched.

### `posts.html` (Phase 1)

- `PostSummary` gains `heroSrc`, `date`, `country`, `region`.
- Hero thumbnails.
- Search, status/region/country filters and sort, **client-side** — at 20 posts a new endpoint
  would be premature. The threshold at which it should become server-side is documented in place.
- Checkbox selection with `POST /posts/bulk { action, keys[] }` (admin-only) for publish,
  unpublish and delete, with **one** rebuild at the end. Partial failures are reported per post
  rather than aborting the batch.

---

## HTTP API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/upload` | session | Single-file upload; returns immediately, encodes async |
| GET | `/media` | session¹ | Paginated, filtered listing + usage refs for the page |
| GET | `/media/items/*` | session¹ | One item |
| PATCH | `/media/items/*` | session | Edit metadata |
| DELETE | `/media/items/*` | **admin** | Delete files + row; 409 if referenced |
| POST | `/media/move` | session | Bulk move `{keys[], folder}` |
| POST | `/media/retry` | session | Re-queue failed encodes |
| POST | `/media/rescan` | **admin** | Reconcile disk ↔ database |
| GET | `/media/folders` | session | Folder tree |
| POST | `/media/folders` | session | Create `{path}` |
| PATCH | `/media/folders` | **admin** | Rename `{from, to}`; 409 if target exists |
| DELETE | `/media/folders` | **admin** | Delete; refuses if non-empty |
| POST | `/posts/bulk` | **admin** | `{action, keys[]}`, single rebuild |

¹ **Deliberate, documented privilege change.** `GET /images` is admin-only today with an explicit
justification in the code (`server.ts:205`: *"Admin-only: it exposes the full inventory of uploaded
files, same trust boundary as /settings"*), locked in by `server.test.ts:240`. The gallery picker
needs authors to browse, so `GET /media` moves to session — **but `exif.lat`, `exif.lng` and
`uploadedBy` are redacted for non-admins in the serializer.** Handing every author the GPS
coordinates of every photo through a lower gate would undo D1. Folder rename and delete are
admin-only because they are bulk-irreversible and media has no revision history, unlike posts.
`server.test.ts` asserts the redaction, not just the status code, and `SECURITY.md §Authorization`
records the decision.

**`'/media'` is added to `ADMIN_PREFIXES` (`server.ts:62`)**, which currently lists `'/images'` —
otherwise the entire new admin API loses `X-Frame-Options: DENY` and `Referrer-Policy:
no-referrer`.

`GET /images` and `DELETE /images/*` are replaced; `media.html` is their only consumer (verified
repo-wide). Item routes nest under `/media/items/*` so a wildcard key can never collide with the
static `/media/folders`.

### Query-parameter safety

`SECURITY.md` claims "SQL is parameterized throughout", and `pg` placeholders cover `folder`, `q`,
`tag` and `status`. **`sort` and `order` are the exception** — they are SQL identifiers and
keywords, which `pg` cannot parameterize, and the TypeScript union types are erased at runtime
while the values arrive from a query string:

```ts
const SORT_COL = { uploaded: 'uploaded_at', taken: 'taken_at', title: 'title', key: 'key' } as const;
const col   = SORT_COL[q.sort ?? 'uploaded'] ?? 'uploaded_at';   // allow-list map, never raw input
const dir   = q.order === 'asc' ? 'ASC' : 'DESC';                // binary choice
const limit = Math.min(Math.max(Number(q.pageSize) || 50, 1), 200);
const like  = '%' + String(q.q ?? '').replace(/[\\%_]/g, '\\$&') + '%';   // ILIKE $n ESCAPE '\'
```

`pageSize` is capped (unbounded `LIMIT` materializes the table per request); `q` has its LIKE
wildcards escaped (a bare `_` is otherwise a full-table wildcard, and `%a%a%a%a%a%a` is a cheap
authenticated CPU sink on the process that also serves the blog); `tags` are capped at 30 per item
× 40 chars server-side, since a GIN index stores one entry per element.
`media-store.test.ts` asserts an unknown `sort` falls back rather than reaching SQL.

Usage references are computed only for the visible page. No new scanning is needed for galleries:
`imageUsage` already matches against raw `bodyMarkdown`, where gallery URLs live.

---

## Testing

**`uploader/`**
- `exif.test.ts` — DMS→decimal incl. S/W; pre-divided rationals; missing EXIF; malformed EXIF
  (empty, garbage, truncated, `Image: null`); zero-denominator `NaN`; **NUL bytes, oversize and
  non-string values**.
- `pipeline.test.ts` — **no `GPSInfo` in output variants**; `Make`/`Model`/`DateTimeOriginal`
  present; not double-rotated; the `metadata()` fast path returns the same dimensions as the old
  re-encode.
- `storage.test.ts` — the existing traversal-guard cases still pass through `storeOriginal`;
  `storeVariants` wrapper preserves the synchronous contract.
- `media-store.test.ts` (+ integration behind `TEST_DATABASE_URL`) — query/filter/sort/paginate;
  unknown `sort` falls back; folder named `%` does not mass-move on rename; rename onto an existing
  folder 409s; delete-non-empty refused.
- `encode-queue.test.ts` — concurrency cap; **pauses during a build**; failure → `failed` + enum;
  boot recovery of orphaned `processing` rows; idempotent re-encode; backlog cap 429s.
- `media-sync.test.ts` — backfill discovers an originals-only key; prune skips non-`ready` rows;
  alt harvest is exact-match only.
- `shutdown.test.ts` — `close → drain → end → exit` ordering.
- `server.test.ts` — every new route's authz; **`exif.lat`/`uploadedBy` redacted for non-admins**;
  multi-file upload rejected with **413**; duplicate upload short-circuits in all three states.
- `posts.test.ts` / publish-handler tests — gate blocks on `processing`, allows when a URL has no
  media row; `srcToKey` strips base URL and variant suffix; bulk endpoint partial-failure
  reporting.
- `backup.test.ts` — a **v3** dump restores; v1 and v2 still restore; restore ordering; `text[]`
  round-trip.
- `export.test.ts` — a body containing a gallery round-trips alt/caption/dimensions.
- Browser-mirror test for `media-api.js`'s pure parts (selection range math, key slugification,
  queue scheduling), following `llm-mirror.test.ts`.

**`site/`**
- `gallery-layout.test.ts` — the ten verified cases (1, 2, 3, 7, 13 landscape; 9 and 13 mixed;
  5 portraits; a lone 4:1 panorama; a panorama in a mix), asserting no row overflows, stretched
  rows fill exactly, the last-row cap holds, and no photo is lost.
- `body-images.test.ts` — fence → figure grid; unknown URL skipped; empty gallery leaves the
  `<pre>`; **`javascript:` and `data:` URLs rejected**; **off-base-URL rejected**; **a node-shaped
  object in `alt`/`caption` cannot emit markup**; **non-integer dimensions skip the item**.
- `render-markdown.test.ts` — `MARKDOWN_OPTIONS` parity with `astro.config.mjs`.

**Verification loop:** `npx astro check`, `npm test` in both apps, then `npm run dev` for visual
work.

---

## Risks & Open Questions

- **The EXIF allow-list re-injection is the least certain implementation detail** (see D1). Bounded
  risk with a stated fallback.
- **The encode queue is the riskiest *architectural* choice.** `status` becomes a correctness
  invariant spanning a Postgres row, files on disk, publish validation and an already-built static
  release — with no shared transaction. Its failure mode is silent: if a job is lost, the URL is
  already in the post body and `-orig` is on disk, so `astro build` succeeds and the site goes live
  with broken `<img>` elements. The publish gate is the only check; it must be tested hard. The
  build/encode mutual exclusion is what keeps the OOM interaction from making this worse.
- **`docker-compose.yml` sets no `mem_limit`**, so a spike kills the whole `app` container — blog,
  admin, image host and any in-flight build together. The encode semaphore caps peak RSS at the
  measured ~3.9 GB and the build lock prevents the compounding case, but an explicit `mem_limit` is
  a worthwhile follow-up.
- **Bulk upload remains slow by choice.** ~19 s of encoding per 24 MP frame. Measured for 100
  photos: ~35 min at concurrency 1, **~20 min at concurrency 2** on a 10-core M5, extrapolating to
  roughly **50–65 min on a 2–4 core VPS**, which is where this runs. The async queue makes that
  background work nobody waits on. A tested switch for capping the top variant width is left
  documented in `variants.ts` so the decision can be revisited without redesign.
- **Disk growth:** ~17.5 MB per photo (6.9 MB variants + 10.7 MB original) ≈ 1.75 GB per 100
  photos, plus roughly the same again in `/data/backup` because originals are captured by the
  incremental image archive. A 100-photo trip costs ~4 GB all-in. The one-off `strip-gps` pass adds
  one full-corpus archive unless mtimes are preserved (see D1).
- **The 25 MB upload limit rejects Leica Q2 DNG** (43–84 MB) with a 413. This is a JPEG-only
  workflow. Stated, not changed.
- **The `metadata()` fast path must re-verify the SVG case.** The existing `@ai-warning` about SVG
  deliberately rasterising to `png` (an anti-stored-XSS measure) is based on the re-encode probe;
  `metadata()` reports `svg`. If they disagree, the fast path must preserve current `-orig`
  extension behaviour.
- **Row membership in a gallery is fixed at build time** (see *Layout*). Between 600 px and
  1112 px the desktop partition simply renders shorter. Accepted; revisit if it looks wrong on a
  real gallery.

## Documentation to update

`CLAUDE.md` (structure, status), `ARCHITECTURE.md` (media tables, encode queue, backup v3, EXIF
policy), `SECURITY.md` (**`:69` write-chokepoint now `storeOriginal`**, the metadata allow-list,
the `GET /media` authorization decision and its redaction), `PRODUCT.md` (library and gallery
capabilities), `docs/authoring-workflow.md` (bulk upload, gallery flow, `proxy_read_timeout`),
`uploader/README.md`.
