# AI photo details in the media library

## Scope

Owner request (2026-10-18): the editor's gallery can already suggest alt text with AI;
the Media page should generate **title, alt text, caption and tags**, for one photo and
optionally for several or all photos.

Reuses the existing caption provider (Settings → Photo descriptions), its
`GET /ai-config?purpose=caption` contract and request-local key, the hosted display
variant, and the existing `PATCH /media/items/*`. No new route, setting, schema, secret,
server egress or dependency. Media metadata is library data: it reaches a story only
when an author inserts the photo and saves, so no published page changes.

## Interaction

**One photo (detail panel).** **Suggest with AI** asks the model once for all six
values. Empty fields are filled; a field that already holds text keeps it and shows the
suggestion beneath with **Use**. Filled fields mark the panel unsaved; nothing is saved
until **Save details**. Switching to another photo or deleting it abandons the request;
a late reply never lands in another photo's panel.

**Several or all photos (dialog).** **Generate details with AI** in the selection bar,
or **Generate details with AI…** above the grid, opens one dialog stating:

- scope — the selected photos, or every photo matching the current folder, subfolder,
  search and status filters across all pages (listed at the server's 200-row page cap);
- fields — Title, Alt text (DE + EN), Caption (DE + EN), Tags;
- **Replace text that is already filled in** — off by default, reset on every opening;
- destination — provider URL and model, with a charge note for remote providers;
- the count of photos that will actually be sent, and how many are left out because they
  are not `ready`.

Generate saves photo by photo, with progress, saved/skipped/failed counts and a list of
failures (key + fixed reason). **Stop** (or Esc) cancels the request in flight and sends
no further save; the dialog stays open with the result.

## Write rules (invariants)

1. A suggestion never **clears** a field: an empty model value is never written.
2. Without Replace, only empty fields are written, per locale. The decision is made
   against the row **re-read immediately before its PATCH**, so text saved elsewhere
   during a slow model call survives. Photos with nothing missing are skipped without a
   model request — re-running continues an interrupted or partly failed run.
3. PATCH bodies are minimal and per-locale (`alt: { en }`), so the untouched locale is
   never sent back stale. The detail panel's own save follows the same per-locale rule.
4. Once stopped, no PATCH is sent, even for a suggestion already received.
5. Three failures in a row stop the run: a down provider, wrong key or non-vision model
   is one problem, not hundreds of paid requests.
6. Only `ready` thumbnails on the configured image origin or the page origin, without
   credentials, are fetched (the editor gallery's rule); the download omits cookies and
   referrer and refuses redirects. The canvas re-encode carries no EXIF, so no GPS.

## Model contract

`LLM.describePhoto(baseUrl, model, guidance, dataUrl, timeoutMs, signal, apiKey)` shares
the caption transport (`visionChat`): one user message with text + image, request-local
Bearer key, `credentials: 'omit'`, `redirect: 'error'`, `no-referrer`, the caption
timeout, cancellation. Failures are fixed categories (`HTTP <status>`, connection,
cancelled, timed out, unreadable, truncated); provider text is never surfaced. The saved
caption prompt is house guidance for the alt fields only; the task and the JSON shape
`{title, altEn, altDe, captionEn, captionDe, tags}` follow it explicitly, and text in
the photo is declared content, not instructions.

`LLM.parsePhotoDetails` accepts the first JSON object with at least one usable field
(through `<think>` blocks, prose and fences, under the review parser's size/depth/
candidate bounds). Every text becomes one line without control characters, clipped at a
word boundary (title 120, alt 300, caption 500 UTF-16 units, never ending on a lone high
surrogate). Tags: list or comma string, split on commas, `#` dropped, case-insensitively
de-duplicated, at most 10 of 40 units (the store's own limit). Missing fields are empty.

## Risk and recovery

Normal risk: client-only, through existing authenticated routes and the caption config
already disclosed to authors (#214 §13). Bulk is the one place an AI value is saved
without per-item review; the documented "suggestions never autosave" rule is narrowed to
the editor accordingly. Overwrite is opt-in, named on the button ("Generate and
overwrite") and never remembered. There is no undo for overwritten library text beyond a
database backup restore; fill-only runs can be undone by hand per photo. Reverting the
UI code leaves all data valid.

## Verification record

- `npm run typecheck`; `npm test` (uploader): 68 files passed, 7 Postgres-only suites
  skipped without `TEST_DATABASE_URL` — this change touches no server code.
- New `test/media-ai.test.ts`: parser bounds and normalization, transport categories,
  key isolation, cancel vs deadline, caption contract on the shared transport; write
  rules, origin rule, paging, re-read-before-save, failure streak, stop-without-save.
- `test/media-browser-dom.test.ts`: suggestion fill/offer/save, late reply after a photo
  switch, not-ready photo; dialog on a selection, overwrite, all-in-view paging across
  201 photos, Esc stops without saving.
- Browser smoke on an isolated Fastify instance (memory stores, real encode queue, real
  variants on a separate image origin with CORS) against a fake OpenAI-compatible vision
  endpoint: real image download, JPEG preparation and transport; single-photo fill and
  **Use**, save round-trip; selection run; all-in-view run with a deliberately unusable
  reply listed as a failure; re-run resumed only the failed photo; overwrite labelling;
  Esc mid-run stopped after one request with nothing saved; 390px layout without
  overflow. No real model was exercised: LM Studio was not running.
