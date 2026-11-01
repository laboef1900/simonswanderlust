# Project Status

Moved verbatim from `CLAUDE.md`. Paths are relative to the repository root. Add new status entries here.

## Project Status and Remaining Phases

- **Implemented, qualification pending:** #309 journey authoring under the owner-approved
  #308 contract. Separate journey, locale and ordered-member tables; author draft editing,
  admin-only publication/unpublication/deletion; permanent per-locale URL history and explicit
  secondary omission. The language lock includes dormant journey publication. Story removal
  scrubs every working and retained snapshot reference inside the same transaction. Recovery
  format v14 carries all three tables; every restore into this schema needs a journey-aware,
  security-compliant reader, including pre-v14 recovery sets. Public output belongs to #310.
  Full suites, runtime/browser qualification, CI and actual-target reverse-collision evidence
  remain release gates; no deployment or owner-content operation is implied.
- **Done:** Phase 1 (skeleton) + Phase 1b (expedition-log layer) — merged to `main`.
- **Done:** Phase A (Postgres CMS foundation) — Postgres Content Layer loader, body-image pipeline,
  runtime `blog-builder` service, compose/volume wiring — merged to `main`.
- **Done:** Phase B (in-admin editor) — DE/EN tabbed editor (EasyMDE), slug-lock, inline photo
  upload, Save draft, Publish (triggers rebuild), Export all (MDX backups to `/data/backup`).
- **Done:** Phase 2 (WordPress import) — in-admin WXR importer; upload WP export → draft posts
  created with slugs preserved and images re-hosted.
- **Done:** Phase 3 (MapLibre travel map) — map page (`/karte/` + `/en/map/`) plotting all trips as
  pins with popups; homepage `MapTeaser` wired to the map; per-story lazy mini-maps (pin + stops);
  self-hosted PMTiles basemap (zero third-party requests), served at `/map/` by the app;
  progressive enhancement with text/link fallback.
- **Done:** Security hardening — auth rate-limiting, admin-only publish, SSRF/timeout/size-cap on
  remote fetches, path-traversal guards, body-HTML sanitization, security headers. See `SECURITY.md`.
- **Done:** Single-app-container merge + DB backup — collapsed the 4-container stack (nginx /
  blog-builder / uploader / db) into 2 services (`app` / `db`); the `app` container serves the blog,
  admin, and images from one process and runs `astro build` in-process; added a scheduled/on-demand,
  retention-pruned Postgres backup feature (CLI-only restore). See `ARCHITECTURE.md` and
  `docs/superpowers/specs/2026-07-03-single-app-container-design.md`.
- **Implemented, integration qualification pending:** #279 first-run Desk checklist under the
  owner-approved #278 Q1–Q5/P1–P2 contract and separately approved `GET /auth/me` context.
  Postgres `onboarding_state` is install-wide operational state; Identity is optional and
  only Photo/Story/Publish count toward explicit permanent Finish. Hide survives restarts;
  Show is Desk-only; authors retain ordinary draft/upload affordances. Boot captures prior
  evidence before cleanup and classifies before listen. Every supported restore retires via
  the permanent off-DB `onboarding.restore-retired` fence: native restore before GPX staging,
  SQL/host/clone recovery before replacement/activation. Fresh native targets use offline
  `prepare-native-restore`; `onboarding-retire` is fence-only and its lease ends on exit.
  Keep all writers stopped with auto-start disabled across recovery commands. No reset or
  data-deletion shortcut. `/setup`, `/login`, `/auth/status`, auth limits and session policy
  remain unchanged. The recorded pre-merge uploader suite/typecheck and actual browser
  setup → upload → draft → publish → Finish with unsaved identity passed their exercised scope;
  merged-head integration checks, CI and final implementation review are not claimed here.
  See `ARCHITECTURE.md`, `SECURITY.md`, `DESIGN.md` and
  `docs/superpowers/specs/2026-10-27-issue-278-first-run-onboarding.md` for contract/evidence limits.
- **Done:** Editable About page + baked-in travel map basemap (v0.5.0).
- **Done:** AI feature removal + conformance hardening (July 2026) — removed the LM Studio
  caption/batch-uploader feature entirely; settings endpoints became admin-only; a global error
  handler logs unexpected errors server-side and returns sanitized 500s; PR CI added.
- **Done:** AI alt-text restored (2026-07-05) — editor-integrated "Suggest alt text" buttons
  (DE/EN hero + body) + photo uploader, browser-direct to local LM Studio; LM config in the JSON
  settings store; read-only `GET /ai-config` for non-admin authors. See
  `docs/superpowers/specs/2026-07-05-ai-alt-text-editor-integration-design.md`.
- **Done:** Stack upgrade (July 2026) — Node 22 → 26 (DHI images, engines, CI), Postgres 17 → 18,
  Astro 6 → 7 (+ `@astrojs/mdx` 7; `compressHTML: 'true'` kept for v6 whitespace behavior), Fastify
  plugins (`multipart` 10, `static` 9.1.3 — security fix), sharp 0.35, TypeScript 6 + Vitest 4 in
  both apps; CI now also runs the full `astro build`.
- **Done:** Phase 0 of the media-library work (2026-07-26) — published image variants now carry an
  EXIF allow-list instead of full metadata (no GPS/XMP/IPTC), `POST /upload` rejects multi-file
  requests with 413 instead of silently dropping files, an explicit `requestTimeout` is set, and a
  new `audit-exif` CLI subcommand reports the stored corpus's actual EXIF/GPS exposure (found 102
  variants with EXIF, zero with GPS). A `strip-gps` remediation subcommand was deliberately **not**
  built, and its trigger never fired. The "server corpus unaudited" caveat was retired 2026-07-29
  (#68 closed as obsolete): there is no production deployment, and the WXR importer re-hosts via
  `processImage`, so imported photos clear `allowedExif()` at encode time — the allow-list is
  **upstream** of the importer. The 2026-07-29 WXR import then re-hosted 665 photos from other
  devices/years through it. See
  `docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md`.
- **Done:** Backend rework, epic #69 (2026-07-28) — four approved issues, landed as PRs #76–#79:
  - **#65 galleries** — a fenced ```gallery block rendered as a photo grid, with per-line
    `| WxH | alt="…" | caption="…"` metadata lifted into the `images` map on save and re-attached by
    the MDX exporter. Gallery URLs are allow-listed by **origin equality** (never a prefix match)
    because the markup is injected *after* `rehype-sanitize`; the `images` map is validated at the
    `posts.ts`/`pages.ts` store chokepoint rather than in `validateDraft`, since the WXR importer
    bypasses the latter.
  - **#63 posts list** — hero thumbnails, client-side search/filter/sort (extracted to
    `public/posts-filter.js` so it is testable), and `POST /posts/bulk` with one rebuild per batch
    and per-post failure reporting. Also fixed a live bug: `pgPostStore` formatted the `date` column
    with `toISOString()`, walking a post's trip date back a day per re-save on any host east of UTC.
  - **#64 + #73 media library** — `media`/`media_folders` tables, virtual folders, bulk
    drag-and-drop upload with an **async encode queue** (concurrency 2), a shared build/encode mutex
    (`work-lock.ts`) where a build preempts the encode backlog, a publish gate that refuses while a
    referenced photo is not `ready`, disk↔database reconciliation, backup dump **v3**, `GET /media`
    at session level **with GPS/uploader redaction for non-admins**, a `/data` free-space
    precondition (507) and `mem_limit`/`memswap_limit` on the app container.
  - **#70 duplicate post** — "New from this one": structure copies, identity resets, slugs asked for
    up front. Zero server change.
  - **Review fixes** — nine findings from the PR re-review: the gallery fence normalizer became a
    line scanner (the old regex rewrote a nested ```gallery example and missed CommonMark's
    longer-closing-fence rule), the media-sync missing-file sweep now paginates past the 200-row
    page cap, `mediaSync.run()` is sequenced before `encodeQueue.recover()`, `POST /media/retry`
    rolls back its status flip on a failed enqueue, `memoryMediaStore.upsert` mirrors the pg
    `ON CONFLICT` clause, and `duplicatePayload` deep-copies the structures it carries.
- **Done:** #75 gallery picker (2026-07-28) — "Insert / edit gallery" on both locale tabs of the
  editor opens the media library in multi-select mode with an ordering strip, and writes the same
  ```gallery text an author would type by hand (no server change; `normalizeGalleryFences` still
  lifts the metadata at the store chokepoint). Two invariants carry the weight, both with
  `@ai-warning`s and tests: the picker seeds its selection from the POST, not from whichever library
  page is loaded, or editing an older post's gallery silently drops the photos the library never
  paged into view; and `public/gallery-fence.js`'s fence scanner must agree with `rewriteFences` in
  `src/body-content.ts` about what a gallery is and where it ends — `test/gallery-fence-parity.test.ts`
  runs both over one corpus, and is the only thing keeping the duplicated rule honest.
- **Done:** #66 gallery polish (2026-07-29) — three layout modes selected by a `#layout:` line
  **inside** the fence (an info-string argument on the opener is unimplementable: the info string
  is discarded before `body-images.ts` ever sees it), plus a `<dialog>` lightbox on all three.
  `site/src/lib/gallery-layout.ts` holds the justified-row partition and the directive reader,
  pure and `astro:`-free because draft preview runs it under `tsx`. An unknown or missing mode
  falls back to the default — `breakout` at the time, `column` since 2026-09-20 (see the story
  spread entry below). The last row is capped at the
  height of the row **above** it, emitted as a container percentage — a fixed-pixel cap computed
  at the design width left the remainder 450px tall beside 210px rows on a tablet. The mode is
  chosen in #75's picker (`layouts`/`layout` options; `GalleryFence.layoutOf`/`withLayout`), whose
  directive round-trip is the risk the #66 review named and is now tested against the renderer's
  own reader. `preview.test.ts`'s CSS parity guard was **strengthened**, not weakened: it now
  scrapes selectors nested inside `@container` blocks too, where the new breakpoints live.
  Lightbox CSS lives with its island rather than in `global.css`, so it is not dead CSS
  hand-mirrored into `preview.ts` — the lightbox does not run in draft preview at all.
- **Done:** WordPress content import (2026-07-29) — the real WXR export imported: 9 DE/EN pairs,
  **665 photos re-hosted**, all under their live WordPress slugs. Required fixing the importer,
  which silently dropped every gallery: Elementor renders galleries as bare `<a href>` anchors with
  no usable `<img>`, so Turndown produced empty `[](url)` links that the re-host pass never matched.
  `wp-content.ts` now folds Elementor slideshows into ```gallery fences using the widget's own
  `data-elementor-lightbox-slideshow` (grouping) and `-title` (alt), and re-hosts once per
  translation pair. Ten published stub posts were deleted first — eight were fictional placeholders
  with no WordPress counterpart, and two carried **wrong EN slugs** (`4-days-in-bucharest`,
  `sun-and-adventure-rhodes`) that violated the SEO slug contract; the import restored the real
  ones. Imported posts are drafts with placeholder `country`/`region`/`coordinates` that
  `validateForPublish` rejects until an author completes them.
- **Done:** #87 fix — `country` and `keyFacts` moved from `PostShared` to `PostLocale`
  (2026-07-30). Both were app-layer fields shared across the DE/EN pair even though the `posts`
  table already stores them per row, so `upsertDraft`'s two `writeLocale` calls always wrote
  whichever locale saved last into both rows, and `get()` read the DE row's values back for both —
  the English page silently showed the German country name after any save. `stops[].name` stays
  shared for now: unlike `country`/`keyFacts`, it mixes geographic (non-prose) lat/lng with a
  translatable name in one array, and a correct per-locale split needs either duplicated
  coordinates (drift risk) or index-parallel per-locale name arrays (desync risk on reorder) — a
  bigger design decision than this fix, left for a follow-up if it's ever prioritized. The
  `posts` table and the Astro loader (`postgres-loader.ts`) were already per-row/per-locale;
  only the uploader's `PostShared`/`PostLocale` split, the editor UI, MDX export, and the WXR
  importer's placeholder needed to change.
- **Done:** #85 WXR importer hardening (2026-07-30) — the importer survives a real export.
  Four decorators around the existing `rehost` seam, in a load-bearing order pinned by tests:
  `sharedRehost( resume+tally( retry( pace( rehostImage ) ) ) )`. Retry and pacing MUST stay below
  `sharedRehost`, which memoises **rejected** promises. Pacing is an **elapsed gate**, so a
  fetch+encode that already outlasted the delay pays nothing. Retry covers only transient
  `FetchError`s, classified off new additive `kind`/`status`/`code` tags rather than message text —
  never a `sharp` decode or an `ENOSPC`, and never `ENOTFOUND`.
  **Resumability is derived from disk, with no state file**: the importer's keys are deterministic
  and un-hashed (every other write path appends `-<hash8>` via `contentHashKey`), so
  `/data/images` *is* the record and `walkStorageKeys` already indexes it. Fail-closed on a partial
  variant set; the hero slot is never resumed because its key encodes no URL identity. Blast radius
  is bounded by `retryBudget` (retries only, so a large export still works), a per-host
  consecutive-failure breaker, and a single-flight 409 on `POST /import` — needed because "run it
  again" is now the documented recovery path. Warnings come from one place instead of three, carry a
  stable reason instead of the raw undici message (which leaked an RFC1918 oracle to non-admin
  authors), and are capped. See
  `docs/superpowers/specs/2026-07-30-wxr-import-hardening-design.md` and `SECURITY.md`.
- **Done:** #96 per-import cap on distinct images (2026-08-25) — bounds the first-attempt
  amplification that #85 deliberately did not claim to cover. The re-host cache is scoped per
  translation pair, so one attachment URL referenced from N groups is fetched N times, and a 25 MiB
  export can reach roughly 40,400 fetches of one third-party URL that **keeps answering** (the
  per-host breaker cuts that to ~20 only when the target is *failing*). `importWxr` now counts the
  distinct (pair, url) re-host operations BEFORE fetching anything and, if the total exceeds
  `maxImages` (default 20,000), throws `ImportTooLargeError` — no work performed, no partial state;
  the `/import` route maps it to a 400 naming the count. 20,000 sits well above a legitimate export
  (the real one was 665 photos) and well below the attack. See `SECURITY.md` (SSRF section).
- **Done:** #100 honest post-tier counters in `ImportSummary` (2026-08-25) — the old single
  `skipped` conflated four unrelated outcomes, so a re-run of an already-published export read
  the same as an export rejected at the import boundary. The summary now names each bucket —
  `imported`, `updated`, `skippedPublished`, `rejected` (a missing translation or an unsafe
  slug, i.e. the path-traversal defence firing), `failed` (a thrown `upsertDraft`) — and every
  group lands in exactly one, so the buckets sum to the group count. `POST /import` 400s only
  when the export yields no groups at all: an all-published re-run is a 200 with
  `skippedPublished`, and `import.html` shows each bucket by name with a dedicated callout for
  `rejected` — the same treatment #85 gave un-hosted photos.
- **Done:** #117 rescan re-queues what it finds (2026-09-05) — `POST /media/rescan` ran only the
  disk sync, which inserts a crashed upload (original on disk, no variants) as `processing`; only
  `encodeQueue.recover()` re-seeds the queue from that status, and it was called from the boot
  chain alone, so an admin's Rescan stranded exactly the rows it discovered until the next restart
  (`/media/retry` skips `processing`). `createReconciler` in `media-sync.ts` is now the single
  entry point — sync **then** recover — for both boot and the route, and the report carries a
  `recovered` count. See `docs/superpowers/specs/2026-09-05-rescan-reconcile-design.md`.
- **Done:** #119 empty slug = unset (2026-09-05) — the write-DE-first workflow broke at the
  second post: the editor sends `en.slug: ''` while the EN title is blank, and both stores plus
  `posts_locale_slug_idx` treated `''` as a taken slug (`duplicate_slug`). `''` is now the
  per-locale "no slug yet" sentinel: exempt from `validateDraft`'s format check and from the
  duplicate pre-check, and the unique index is partial (`WHERE slug <> ''`), migrated on boot by
  a DROP+CREATE in one transaction when the pre-#119 non-partial form is found. Real slugs stay
  unique, `validateForPublish` still refuses `''`, and `exportPost` no longer writes
  `trips/en/.mdx`. See `docs/superpowers/specs/2026-09-05-empty-slug-unset-design.md`.
- **Done:** #99 pair identity in the WXR importer (2026-09-05) — `importWxr` matched an incoming
  group to a stored post through one flat map of *both* slugs of every post, so a group whose EN
  slug equalled an unrelated post's DE slug bound to that post's `translationKey` and `upsertDraft`
  overwrote it (Golden Rule 2). Pair identity is now the (DE slug, EN slug) tuple matched as a
  unit: both slugs owned by one pair → `updated`; no overlap → new pair; **any** other overlap —
  one slug matches, the two slugs belong to two different posts, or a cross-locale namesake — is
  `rejected` before any fetch with a warning naming the owner, and the same rule holds between
  groups of one export. The namesake is rejected rather than admitted because the re-host keys are
  `trips/<slug>/…` with no locale segment (#85's disk-derived resume depends on them), so a new
  pair would write its photos over the existing post's variant files. See
  `docs/superpowers/specs/2026-09-05-wxr-import-pair-identity-design.md`.
- **Done:** #97 `POST /import` is admin-only (2026-09-06) — the last session-level surface that
  wrote gigabytes under `/data` and made outbound fetches the server does not choose. The
  preHandler flipped to `requireAdmin`, `import.html` gates on `ensureAuthed({ admin: true })`,
  and the "Import WXR" nav entry is admin-only so an author never sees a link that bounces them.
  It also resolves the #90 coherence gap: the `importDelayMs`/`importRetries` knobs in `/settings`
  were admin-only while the import they governed was not. See
  `docs/superpowers/specs/2026-09-05-import-require-admin-design.md`.
- **Done:** #95 import encodes take the work-lock (2026-09-06) — `rehostImage` now runs its
  sharp encode + variant writes under `workLock.runShared()`, so a multi-minute WXR import can no
  longer run `sharp` beside `astro build` in one `mem_limit`'d container; a waiting Publish preempts
  the import at the next photo boundary, exactly as it does the encode queue. The **fetch stays
  outside** the lock — a stalling source host must not delay a Publish. The single process-wide
  lock is threaded `main.ts` → `buildServer({ workLock })` → `importWxr({ lock })`; a route test
  pins that it is the SAME instance the builder and queue hold. See
  `docs/superpowers/specs/2026-09-05-import-work-lock-design.md`.
- **Done:** #118 variant-set completeness + atomic writes (2026-09-05) — media-sync called a key
  "present" on its **first** variant file, so a crash after `-640.avif` alone was backfilled as
  `ready`, the publish gate passed it, and the live `<picture>` 404'd on `-1280.webp`; a partial
  restore of `/data/images` likewise left `ready` rows `ready` because the `-orig` counted. The
  walk now records the full `(width, format)` set per key and `isCompleteSet` checks it against
  `variantWidths(intrinsic) × FORMATS`, with the intrinsic width **probed from the retained
  original** — never the largest surviving variant, because variants are written in ascending
  width and a top-truncated set is indistinguishable from a complete set for a smaller photo.
  Backfill: complete → `ready`; partial with original → `processing` (re-queued by the same
  reconcile pass); partial without → `missing`. The prune demotes a `ready` row the same way
  (`demoted` in the report), with a no-probe fast path against the row's own recorded width.
  `storage.ts` writes originals and variants to a `.part-<hex>` temp and renames into place, so
  a truncated file can never carry a final name — which also closes the WXR resume gap #85 left.
  See `docs/superpowers/specs/2026-09-05-variant-set-completeness-design.md`.
- **Done:** #125 CommonMark image destinations in the WXR importer (2026-09-05) — Turndown writes
  `![alt](src "title")` (Elementor titles every image with its filename), escapes `(`/`)`, wraps a
  spaced destination in `<…>` and escapes `]` in alt; the importer's naive regex captured
  `src "title"` as the URL, so `safeFetch` requested a bogus address and the common single-image
  case was "download failed" and left hot-linked. `markdownImages` in `wp-content.ts` now parses
  the Turndown-producible subset of CommonMark and decodes the destination; both extraction sites
  (`buildLocale` and #96's `rehostUrlSet`) use it, keeping the pre-flight count honest. Classic
  `[gallery ids]` and `[caption]` shortcodes expand before Turndown through the existing Elementor
  gallery pipeline instead of surfacing as escaped junk. See
  `docs/superpowers/specs/2026-09-05-wxr-import-image-destinations-design.md`.
- **Done:** #122 slug auto-derivation guard (2026-09-05) — the editor re-derived the slug from
  the title on every keystroke of an unpublished post, so fixing a title typo in a WXR-imported
  draft silently replaced its live WordPress slug (Golden Rule 2). Derivation now only fills an
  *automatic* slug (new post; turned off by typing into the field or by any loaded slug, back on
  when the field is cleared), and a save that changes an existing draft's non-empty slug asks the
  author with both URLs named, sending `confirmSlugChange: true`; `POST/PUT /posts` refuse such a
  rename without the flag (409 `slug_change_unconfirmed`), so no client can rename a draft by
  accident. Filling an unset (`''`) slug never asks. See
  `docs/superpowers/specs/2026-09-05-slug-derive-guard-design.md`.
- **Done: #110 bounded site build (2026-09-05)** — `astro build` was spawned with no deadline
  under the exclusive build/encode lock, so a child hung on a silently unresponsive Postgres held
  every later publish, rebuild and encode until a manual restart while `/health` stayed green.
  `build.ts` now SIGKILLs the child after `BUILD_TIMEOUT_MS` (15 min) and reports a distinct
  `BuildTimeoutError`; both Content Layer loaders read through `site/src/lib/loader-pool.ts` with
  connection/query timeouts so the hung-DB case fails in about a minute. The child's stderr
  stays in server logs; since #297 callers receive a fixed failure code and safe copy.
  The release copy stages into `releases/.<stamp>.partial` and renames into place (a
  release dir is complete or absent), with leftovers swept at the next run; the boot-time build
  retries with backoff (`bootstrapRelease`) and `/health` reports `release` as information, never
  a verdict. See `docs/superpowers/specs/2026-09-05-build-timeout-and-recovery-design.md`.
- **Implemented, unmerged: #297 build reporting (2026-10-29)** — build attempts persist in
  unserved `site/build-state.json`; restart marks a previous running attempt interrupted.
  Admin-only/no-store `GET /rebuild/status`, Desk and Settings report the attempt separately
  from the observed live release. Editor/About preserve acknowledged save tokens after
  rebuild failure; CLI output is classified and points to server logs. Neither metadata
  failure nor post-promotion pruning changes a successful promotion. See
  `docs/superpowers/specs/2026-10-27-issue-297-publish-recovery-design.md` for qualification
  evidence and remaining PR/stack gates.
- **Done:** #113 images archive safety (2026-09-06) — the incremental `images-*.tar` no longer
  leaks its multi-GB `.tmp` on a failed or interrupted run (unlinked in `catch` and from a
  synchronous `process.on('exit')` hook, so `docker stop`'s SIGTERM is covered; a SIGKILL
  leftover is swept at boot and before each run), refuses with a recorded `lastError` when the
  estimated tar plus the `/upload` reserve would not fit `/data`, and derives its mtime cutoff
  from the archives on disk when `state.json` is corrupt, missing, or hand-emptied of tars —
  incremental from the newest stamp, or a fresh full chain — instead of re-tarring ~11 GB.
  `readState` validates every field (a garbage timestamp used to become `NaN` and silently drop
  files from the chain). `POST /backups` answers 409 while a run is in flight, and the schedule
  is anchored to UTC-day / Monday-week windows instead of drifting an hour per day. See
  `docs/superpowers/specs/2026-09-05-images-archive-safety-design.md`.
- **Done:** #114 `restore` CLI safeguards (2026-09-06) — the CLI went from argv straight to the
  `DELETE`s. It now refuses file names outside `BACKUP_FILE_RE`, rejects unrestorable versions
  (`readDump`, shared with `restoreDatabase`) before doing anything, prints the target database
  (never the credentials) plus the dump's and the live per-table counts, requires the literal
  `yes` or `--yes`, and writes a pre-restore dump via `dumpDatabase` into
  `${BACKUP_DIR:-/data/backup}/db` **before** the transaction — aborting if that dump fails
  (Golden Rule 3). One trap worth knowing: dump names have one-second resolution and
  `atomicWrite` renames over an existing file, so a back-to-back undo, two scripted `--yes` runs,
  or a scheduled backup landing in the same second would have overwritten the pre-dump (or the
  file being restored). The no-clobber rule therefore lives in `dumpDatabase` itself, shared by
  every writer, and it is atomic across processes — the finished temp file is published with
  `link(2)`, which fails with `EEXIST` where `rename` would clobber, and a taken name advances
  to the next free second (`createdAt` keeps the real time). See `docs/superpowers/specs/2026-09-05-restore-cli-confirmation-design.md`.
- **Done:** #92 async WordPress import with a progress endpoint (2026-09-06) — `POST /import`
  now runs only the pre-flight on the request path (parse, group validation, the #96 cap, the
  #94 free-space check — every refusal keeps its status code) and hands the multi-minute run to
  `import-jobs.ts`, answering 202; `import.html` polls the admin-only `GET /import/status`.
  `importWxr` became `prepareImport(...).run()` with a progress callback. Progress and outcome
  live in a new **`import_jobs`** table (operational state: excluded from backups, pruned to 20
  rows); boot marks a row the previous process left `running` as `interrupted`, and the page
  says "run it again" — #85's resume makes that free for photos already on disk. Deliberately
  NOT on `encode-queue.ts`: the whole import under `runShared` would hold every Publish off for
  its duration, the opposite of #95. See
  `docs/superpowers/specs/2026-09-05-async-import-job-design.md`.
- **Done:** #126 re-runs merge into existing drafts (2026-09-05) — `importWxr` rebuilt every
  matched draft pair from the export (placeholders and all) and `upsertDraft` overwrote every
  column, while `import.html` promised that re-running was safe and #85 made re-running the
  documented recovery path for un-hosted photos. A re-run over an existing draft is now a **URL
  substitution over the author's stored pair**: `shared`, per-locale fields, body text, alt edits,
  removed photos and a hand-picked hero survive; only the WordPress URLs this run re-hosted are
  swapped in (via the same `applyRehosts` pass `buildLocale` uses on a fresh body), and an empty
  hero slot takes the recovered featured image. The wholesale rebuild is opt-in
  (`overwriteDrafts` multipart field → `ImportDeps.overwriteDrafts`; a checkbox with a scope-naming
  confirm on the page) for "I changed it in WordPress and re-exported". Skip-by-default was
  rejected because it would have made the safe action useless and the useful one destructive. See
  `docs/superpowers/specs/2026-09-05-wxr-import-merge-existing-drafts-design.md`.
- **Done:** #93 `safeFetch` re-validates redirect hops and resolves hostnames (2026-09-05) — the
  SSRF chokepoint no longer lets undici follow a redirect blind. `redirect: 'manual'` plus a
  hand-rolled hop loop (cap 5): every `Location` is resolved against the current hop and put
  through the same scheme/credential/literal check as the first URL, then the hostname is resolved
  (`dns.lookup`, all records) and refused if *any* answer is internal — one `net.BlockList` covers
  loopback, RFC1918 (which the old literal check did **not** block), CGNAT, link-local, multicast,
  the IPv6 equivalents and IPv4-mapped forms. One `AbortController` spans every lookup and hop;
  redirect bodies are cancelled so the byte cap applies where the bytes are. No new `FetchError`
  kind: a refused hop is `blocked`, the hop cap is `http` with the 3xx status, a resolver failure
  is `network` with its code, so #85's retry classifier is untouched. The #90 decision to decline
  this ("WP media URLs legitimately redirect") holds in spirit — hops are followed, just judged
  first — and was verified against a live redirecting `node:http` server. Residual: DNS rebinding
  proper (zero-TTL flip between the check and undici's connect-time lookup) is narrowed, not
  closed; pinning needs `undici` as a dependency and was declined. See
  `docs/superpowers/specs/2026-09-05-safe-fetch-redirects-design.md` and `SECURITY.md`.
- **Done:** #109 login lockout redesign + single password policy (2026-09-05) — the per-account
  lock on `/login` was a self-service denial of service: five failures from anywhere locked the
  public admin username for 15 minutes, correct password or not, so an unauthenticated client
  could keep the admin out indefinitely. The budget is now **100 failures / 15 min across all
  sources**, ten times the per-IP limit, so a single address is cut off long before it can lock
  anyone while a distributed guess is still bounded to 100 per window (NIST SP 800-63B §5.2.2).
  Both limiter maps are bounded (10 000 keys, expiry-ordered O(1) eviction that can only forget a
  counter, never refuse) and usernames are capped at 64 so attacker-sized keys never enter them.
  The 12–1024 password rule moved into `hashPassword` (`assertPasswordPolicy`), so the routes, both
  stores and the CLI `set-password` recovery path — which used to accept a 1-character admin
  password — share one rule. See `docs/superpowers/specs/2026-09-05-login-lockout-design.md` and
  `SECURITY.md` (*Rate limiting*).
- **Done:** #124 no inline `style` in author markup + draft-preview CSP (2026-09-05) — the
  sanitize schema allowed unconstrained `style` on `span`/`code`/`pre` for Shiki's colours, and
  since Astro passes raw HTML through, an author could ship a full-viewport overlay with a
  third-party `url()` to every reader page and the preview. Shiki now emits **classes** instead:
  `site/src/lib/shiki-classes.ts` registers a transformer in both `astro.config.mjs` and
  `MARKDOWN_OPTIONS` (still lockstep-tested) and generates `SHIKI_CSS` from the same theme
  object, inlined by `Base.astro` and by `preview.ts`; `style` is off the schema for every
  element. `GET /posts/:tk/preview` carries a deny-by-default CSP (`default-src 'none'`,
  images from the app's own origin, inline styles only, no scripts). See
  `docs/superpowers/specs/2026-09-05-sanitize-style-csp-design.md` and `SECURITY.md`.
- **Done:** #133 media store input hardening (2026-09-06) — four defects with one shape: the
  memory store accepted input Postgres or the filesystem rejected, so the unit suite never saw
  the 500. `POST /upload` now validates the folder and the versioned key **before**
  `storeOriginal` (a bad folder used to leave an orphan original the reconcile adopted as an
  anonymous `processing` row); `cleanText` strips `\p{C}` like `normalizeTags` (a NUL in a title
  was a pg-only 500); `assertSafeKey` caps keys at `MAX_KEY_LEN` = 200 chars and
  `MAX_KEY_DEPTH` = 8 segments — a cross-lane contract every key producer (the un-hashed WXR
  `trips/<slug>/<name>`, #98) must fit inside; and `renameFolder`/`deleteFolder` run their check
  and both rewrites in one transaction, so media rows can never point at a folder the tree does
  not list. See `docs/superpowers/specs/2026-09-06-media-store-input-hardening-design.md`.
- **Done:** #91 publish gate refuses un-hosted body images (2026-09-06) — a failed WXR re-host
  left the WordPress URL in the body, and nothing stopped publishing it: `validateForPublish`
  looks only at the hero and `notReadyPhotos` filtered a foreign origin out (`srcToKey` → null),
  so the live page hot-linked the old domain (inline image) or silently lost the photo (gallery
  line) — and after the DNS cutover both 404. `foreignImageUrls(body, imageOrigin)` in
  `publish-gate.ts` **renders** the body with the build's own `renderMarkdown` and reads every
  `img`/`source` URL and gallery line from the sanitized hast tree (`analyzeRenderedBody` in
  `site/src/lib/body-images.ts`, before `images` resolution) whose origin is not the image host, by
  **origin equality** on the URL *resolved against that host* — a browser gives an origin-less
  reference the page's, so `//old.example/a.jpg` hot-links and `https:old.example/a.jpg` does not;
  `POST /posts/:tk/publish` and the bulk action refuse (409, count + up to five examples) before
  the media-store check. Rendering instead of scanning is the lesson of the review: three rounds
  of a text scanner each found a fresh divergence from the renderer (code spans across blocks,
  backticks inside attributes, `&colon;`, …), and every one was a silent bypass or a false refusal
  on a named-sensitive surface — two parsers of one grammar cannot be kept in agreement by tests.
  The `images` map is deliberately not consulted (never pruned, no UI to fix a stale key). See
  `docs/superpowers/specs/2026-09-06-publish-gate-foreign-images-design.md` and `SECURITY.md`.
- **Done:** #137 revisions die with their post (2026-09-06) — `post_revisions` has no foreign
  key (`posts` is keyed `(translation_key, locale)`) and `remove()` deleted only `posts`, so up
  to 20 full-body snapshots of a deleted post stayed readable by any author holding a revision
  URL, and — being excluded from backups by design — were never pruned either.
  `pgPostStore.remove` now deletes post and revisions in one transaction — two statements, not a
  data-modifying CTE, whose shared snapshot would miss a revision committed by a save the delete
  had to wait for — `ensureSchema` sweeps orphans left by earlier deletes once per
  boot, and `GET /posts/:tk/revisions/:id` 404s when the post is gone, like the list route. See
  `docs/superpowers/specs/2026-09-06-delete-post-revisions-design.md` and `SECURITY.md`.
- **Done:** #129 blog serving no longer depends on the session store (2026-09-06) — a global
  `onRequest` hook resolved the `sid` cookie against Postgres on every request, so while the
  database was down or hung every public page and image the owner's own browser loaded (the
  admin cookie has `path=/` on the shared host) answered a sanitized 500 while anonymous readers
  were fine — the opposite of the "blog stays up without the DB" design `/health` is built on.
  `createAuthn(users, sessions)` now hands each route its preHandler (`optionalAuth`,
  `requireAuth`, `requireAdmin`) and only a route that declares one queries for a session; the
  blog, image host, basemap and `/admin/*` static pages never do. A failing store on a guarded
  route stays a 500, never "anonymous". When this lands on `dev`, `/health` (#132: disk figure for
  admins only) must declare `optionalAuth` — its own test fails otherwise. See
  `docs/superpowers/specs/2026-09-06-lazy-session-resolution-design.md` and `SECURITY.md`.
- **Done:** Story spread + column galleries by default (2026-09-20) — the owner asked whether
  the WordPress post layout (an opening row of intro / facts / contents / photo, and galleries
  the same width as the text) should carry over. The spread was rebuilt rather than ported:
  from `lg` the story page is the 1112px content box split into a reading column
  (`--container-story-column`, 648–728px) and a **floated rail** (`--container-story-rail`,
  18–21rem) holding Contents, Key Facts and the route map open, with the arrival stamp moved
  to the top-right corner above it; below `lg` the same three are collapsed disclosures stacked
  above the article, exactly as before, plus the map, which used to sit after the body. A float
  and not a grid because the article is one rendered body that cannot be split around a
  sidebar, and `clear: right` on the wide gallery modes keeps them from running under the rail
  (a gallery's own formatting context does **not** avoid the float — it sits outside the
  article's inline range; measured). The WordPress body width itself (1140px, ~140 characters a
  line) was deliberately not copied. `DEFAULT_GALLERY_MODE` flipped `breakout` → `column` in
  both trees (`gallery-layout.ts`, `gallery-fence.js`, the picker's option order), so every
  fence without a directive flips on the next rebuild — that is the intent, and the picker now
  writes `#layout: breakout` for a gallery that should stay wide. On a desktop a break-out spans
  the whole spread from the column's left edge (`100cqw`) instead of centring on a column that no
  longer sits at the centre. The rail's disclosures are opened by a synchronous inline script on
  a `≥ 64rem` viewport (no-JS desktop: collapsed but working), and `initStoryContents` takes the
  same media query so a section link in the rail focuses the heading without collapsing the list.
  See `DESIGN.md` (Layout → The story spread; Break-out; Story contents; Story Opening).
- **Done:** Opening spread only, centred body, square galleries (2026-09-20) — the rail now
  sits beside the story's **first section** alone (`site/src/lib/story-opening.ts` cuts the
  loader's rendered HTML at the first top-level heading that has content before it, so an
  intro heading + paragraphs + first photo make the opening, and the Cuyabeno double-`##`
  start is one opening rather than an empty one); the rest of the story runs **centred at
  50rem** (`--container-story-wide`) with the divider and pagination on the same measure.
  `.story-spread` (float container, `display: contents` below `lg`) is the rail's containing
  block, so it stays off the centred body while the mobile contents strip still spans the
  whole story; `#story-body` became the class `.story-body` on both articles. The story
  hero lost the `N°` (homepage hero keeps it) and carries the coordinates on the field line
  beside date · country. Galleries are partitioned to a **square** (`partitionRows`: row
  count nearest the width, evenest rows within it by DP, every row fills, order preserved)
  with a **168px floor** on multi-photo rows so a 37-photo gallery grows tall rather than
  becoming a contact sheet; the only remaining `--jgal-maxw` cap holds a lone portrait at the
  square's height. `COLUMN_WIDTH` is now 800 (the wider column), so column `sizes` hints never
  under-fetch. Published pages change on the next rebuild. See `DESIGN.md` (The story spread;
  Story Opening; Galleries).
- **Done:** Imported story semantics + import/publish guards (2026-09-20) — all 18 locale rows
  from the nine WordPress story pairs were normalized in the working copy after a database dump:
  per-locale facts moved from `Eckdaten` / `Key data` body blocks into `keyFacts`, empty legacy
  TOC headings disappeared, 43 Elementor `Heading:` + subtitle pairs became one
  `Heading — Subtitle`, Galápagos opening hard breaks became paragraphs, and both Cuyabeno body
  H1s became H2s. The filename-pattern alts on 1,047 unique captionless gallery photos were
  cleared to explicit decorative alts rather than replaced with invented descriptions; the
  warning-only alt audit now reports future filename alts. Hero focus was set for the two portrait
  heroes and the Galápagos iguana, and four curator-selected Galápagos/Cuyabeno fences opt into
  `#layout: breakout` without removing photos. `htmlToMarkdown` now repairs the imported structure,
  while `validateForPublish` refuses real body H1s (but ignores fenced examples). Published
  snapshots remain unchanged until the author publishes each story. See
  `docs/superpowers/specs/2026-09-20-imported-content-semantics-design.md`.
- **Done:** One measure for the story spread and body (2026-09-20) — the opening spread
  (column + rail, 1112px) and the centred body below it (800px) now share `--container-story-wide`
  = `60rem` (960px): the spread shrank, the body grew, and their edges meet. Inside the spread
  the rail is a fixed `18rem` and the column the remainder (`39rem`, 624px); the hero title grid
  is the same 960px box. The rail's inner `max-height` + `overflow-y: auto` is gone — it put a
  second scrollbar beside the page's — so a rail taller than the opening simply sets the spread's
  height. `COLUMN_WIDTH` in `gallery-layout.ts` is 960 (three landscapes a row still clear the
  168px floor: 208px). Published pages change on the next rebuild. See `DESIGN.md`.
- **Done:** Admin shell + AI provider registry (2026-10-19, branch `feature/admin-ui-shell`).
  The admin shell is exactly the viewport: masthead and sidebar never scroll, the gray canvas
  gutter stays visible, and `.cms-workspace` is the one scroll container (`--cms-workspace-h`
  sizes sticky descendants such as the editor inspector), with a minimal shadow on every side.
  The masthead's Content/Media/Manage links and the sidebar's "My journal" header are gone; Log
  out lives in an account menu on the user badge at the sidebar's foot. The editor's page title
  is visually hidden (still the page's `h1`); Story details collapses with a panel icon into a
  slim right-hand rail on desktop, and on phones the drawer opener is the last command-bar
  action — never left of More actions. Settings became vertical tabs (AI models · Images ·
  Comments · Site & backups, mirrored in the URL hash); Images gained **Compare quality**
  (admin-only `POST /settings/image-preview`, in-memory, no EXIF, work-lock + single-flight —
  `docs/superpowers/specs/2026-10-19-image-quality-preview-design.md`). The posts list's "New
  from this one" duplicate (#70) was removed, and with it `posts-duplicate.js` and
  `AdminConfirm.askFields`. **HIGH risk, owner-approved:** the single shared `ai_api_key` was
  replaced by a provider registry — named providers with their own base URL and their own
  encrypted key, a default, and per-use-case assignments — with a boot migration that copies the
  old key envelope to the providers that used it (no decryption) and keeps
  `settings.json.pre-ai-registry`. Model fields are dropdowns filled automatically from each
  assigned provider's `/models` (owner decision). `/ai-config`'s consumer shape is unchanged. See
  `docs/superpowers/specs/2026-10-19-ai-provider-registry-design.md`, `SECURITY.md` (*Secrets*)
  and `DESIGN.md` (Admin authoring). **HIGH risk, owner-approved:** four new regions — Asia,
  Africa, Oceania, Antarctica (DE/EN slugs `asien`/`asia`, `afrika`/`africa`,
  `ozeanien`/`oceania`, `antarktis`/`antarctica`) — with an idempotent widening of
  `posts_region_check`; a region page is built and linked only once its locale has a published
  story (`liveRegions` in `site/src/lib/trips.ts`). See
  `docs/superpowers/specs/2026-10-19-new-regions-design.md`.
- **Done:** Single-language publishing and primary-language configuration, epic #282 (#283
  contract, owner-approved 2026-10-27; #284 uploader and #285 site merged to `dev` 2026-11-01;
  docs closed 2026-11-01). **HIGH risk, owner-approved**, including the Golden Rule 2 amendment
  for EN at root. Four modes — DE+EN DE-primary (simonswanderlust.com, byte-identical route set
  pinned against the pre-change baseline), DE+EN EN-primary, DE-only, EN-only — stored in the
  Postgres singleton `site_language` (`uploader/src/db.ts`; `uploader/src/language.ts` owns the
  store and transition rules). Both locale rows of a story still exist; an absent locale is
  `slug = ''` + `omitted = true`, made unpublishable by the `posts_omitted_unpublished` CHECK.
  `GET /language` is session-level, `PUT /language` admin-only (`uploader/src/server.ts`); the
  primary is locked at the first story/journey publish (`locked_at`, also derived from any
  retained `published_at`), after which only *adding* the secondary is allowed — changing the
  primary is 409 `language_primary_locked`, removing a locale 409 `language_locale_published`
  — so **no mode change moves a published URL** (`uploader/test/language-mode.integration.test.ts`
  compares the URL set before/after every transition). Mode changes, publishes, page saves and
  draft saves serialize on `site_language … FOR UPDATE` first, then pair/journey/namespace
  locks; the rebuild runs only after commit. `uploader/src/build.ts` hands the child
  `SITE_LANGUAGE_JSON` from the same exported `REPEATABLE READ` snapshot as content;
  `site/astro.config.mjs` → `resolveBuildLanguage` re-reads `site_language` and fails the build
  on a mismatch. Routes come from one dynamic page (`site/src/pages/[...path].astro`,
  `publicRoutes`) and `localePrefix`; the EN-at-root map word is `/travel-map/` because the app
  owns `/map/*`. Single-language builds contain no absent-locale route, link, feed, `hreflang`,
  switcher item or retained text (`site/test/built/routes.test.ts` marker grep). Comments are
  bound to the committed published locale set (`getPublishedLocales`; `POST` 400 generic, `GET`
  filtered; admin queue keeps and labels hidden rows). Dump **v12** (`LANGUAGE_DUMP_VERSION`)
  carries `site_language` + `posts[].omitted`; restore replaces the live mode and the CLI needs
  `--accept-language-change` on a locked install whose mode differs; boot writes a
  pre-migration recovery set first. WXR import skips disabled-locale items, MDX export writes
  enabled non-omitted rows only, legacy WP redirects apply to DE-primary installs only. The
  first-run language step (#281) is a conditional add-on, not required by #282. See
  `docs/superpowers/specs/2026-10-27-issue-283-language-mode-contract.md` (§21–24 hold the
  #284/#285 qualification evidence), `SECURITY.md` (*Language modes — reconfirmation and
  leakage review*), `ARCHITECTURE.md` (*Language modes*) and `DESIGN.md` (*Language switcher
  per mode*).
- **Implemented, release pending:** #347 native image decoder hardening (2026-10-27,
  owner-approved). Both locks resolve sharp 0.35.5 / libvips package 1.3.4; uploader's
  install-script permission follows sharp 0.35.5. DHI ARM64 and emulated AMD64 candidates
  loaded the patched heif/rsvg/vips versions and passed JPEG/AVIF/SVG upload, served-variant,
  private-original, EXIF-free preview and rescan checks. Formats and EXIF privacy stay unchanged.
  Recovery is roll-forward only; a new image release/deployment is still required.
  See `docs/superpowers/specs/2026-10-27-issue-347-sharp-codec-upgrade.md`.
- **Done:** Configurable site identity, epic #272 (#273 design, #274 text identity, #275 logo /
  favicon, #276 canonical domain). Closing evidence 2026-11-01: a fresh-install runtime scan on
  `dev` `976f31a` found zero unclassified `Simon|simonswanderlust|Wanderlust` matches in the
  release or the served admin; the remaining ones are #291 software name/copyright/notice texts
  and #293 compose host defaults. The allow-list is data
  (`docs/site-identity-branding-allowlist.json`) read by two regression scans —
  `site/test/empty-build.integration.test.ts` (every file of the zero-content build, all four
  language modes) and `uploader/test/branding-scan.test.ts` (every served admin page/script) —
  so a newly hardcoded owner name fails CI. See `docs/site-identity-branding-allowlist.md`.
- **In progress:** Reader comments (epic #202, spec #203) — design spec landed 2026-09-14
  (`docs/superpowers/specs/2026-09-14-comments-design.md`, incl. an ASVS L1 exception record).
  #205 admin moderation queue landed: `uploader/public/comments.html` (served at
  `/admin/comments.html`, admin-only, rows painted with `textContent`, Delete/Spam confirm via
  `admin-confirm.js`) and `uploader/src/comments-admin.ts` (`AdminComment` — a type kept
  separate from `PublicComment` — and the `/moderation/comments*` routes registered in
  `server.ts`, all `requireAdmin`; author replies are inserted `approved` + `is_author` as flat
  siblings). Route tests: `uploader/test/comments-admin.test.ts`.
  #206 public API landed: `uploader/src/comments-public.ts` — `GET /comments?tk=` (approved
  only, both locales merged oldest-first, `{ enabled, comments[] }` with the pinned public key
  set) and `POST /comments` (rate limit → honeypot 204 → Origin/Referer equality 403 →
  `invalid_comment` 400 → 404 → `comments_disabled` 409 → pending 201 `{ ok: true }`), no session
  preHandler, its own limiter maps, no email accepted, no comment field logged. Route tests:
  `uploader/test/comments-public.test.ts`. The high-risk bullet, the PII sentence and the ASVS
  target sentence above were updated in that phase.
  **Owner approval recorded 2026-09-29**, together with the production wiring the phases had
  missed: `main.ts` never passed `pgCommentStore`/`pgCommentAdminStore` to `buildServer`, so a
  deployed container answered 503 on every comment route while every suite (which injects stores
  directly) stayed green. `uploader/test/main-boot.integration.test.ts` now boots the real
  `src/main.ts` against Postgres and walks a comment from `POST` to moderation to public list.
- **Implemented, release pending:** #291 software license (AGPL-3.0-only), content/brand
  rights and the `wanderlust-studio` image name (owner-approved 2026-10-27). The committed
  third-party inventory must match both lockfiles (`uploader/test/legal-assets.test.ts`
  fails otherwise — regenerate with `node uploader/scripts/generate-third-party-inventory.mjs`).
  Before a release is announced for third-party installs, run
  `uploader/scripts/check-image-legal.mjs` against each published platform image with
  `--revision <tag commit>`; see the spec's *Release-time artifact gate*
  (`docs/superpowers/specs/2026-10-27-software-content-brand-rights-design.md`).
- **Remaining:** Phase 4 = DNS cutover. See `docs/superpowers/plans/` for phase details. Not
  started, deliberately: #67 (AI authoring — design spec landed 2026-07-28, implementation not
  started), #72 (Traefik timeouts). #68 (production EXIF audit) was **closed as obsolete**
  2026-07-29. See `docs/superpowers/plans/IMPLEMENTATION-PROMPT.md` for why each is excluded.
- **Filed out of #85 and deliberately excluded from it** (each with its reason in the §Scope table of
  `docs/superpowers/specs/2026-07-30-wxr-import-hardening-design.md`):
  - **#91 publish gate rejects leftover `wp-content` URLs** — **done 2026-09-06** (see the Done
    bullet above).
  - **#92 move the import off the request path** onto `encode-queue.ts`/`work-lock.ts` with a progress
    endpoint (#85's "Better" option). Progress state that survives a restart likely means a new table,
    so it is a schema change and high-risk in its own right.
  - **#93 `safeFetch` re-asserts on redirect hops** — **done 2026-09-05** (see the Done bullet
    above); the #90 decline is recorded in the spec's "Why this exists".
  - **#94 `/data` free-space precondition on `/import`** (`/upload` has one; an import writes ~11 GB).
  - **#95 import encodes take `work-lock`**, so sharp cannot run beside `astro build`.
  - **#97 `/import` → `requireAdmin`** (every comparable surface already is).
  - **#98 `nameFromUrl` non-injectivity** — `foo.jpg`/`foo.png` collide on one key. Any fix must keep
    keys deterministic; #85's disk-derived resume depends on that.

- **In review (#293, held for the owner):** the supported third-party
  [installation guide](docs/install.md) — platforms as rehearsed (#292), requirements cited
  only from measurements, secrets, uid-1000 data, the verified one-hop nginx example, blog
  domain via Settings (#276), first run, links to the #298 upgrade and backup runbooks.
  Compose now **requires** `PUBLIC_BASE_URL` and `IMG_HOST` (`:?`, no owner-host fallback) and
  `uploader/.env.example` leaves them empty: a server `.env` without both refuses to start.
- **Implemented, device acceptance pending (#302, G5):** phone compose — Preview opens its tab
  inside the tap (fallback link if blocked), DraftGuard also stashes on `visibilitychange` →
  hidden (#138 keys/#22 generations unchanged), Publish/Unpublish shown to admins only, 16px
  field text and 24px checkboxes on coarse pointers (`--control-font`). See
  `docs/superpowers/specs/2026-11-01-phone-compose-audit.md`.
