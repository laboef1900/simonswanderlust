# LLM Settings Page — Design

**Date:** 2026-06-23
**Status:** Approved (pending spec review)
**Repo area:** `uploader/` (the self-hosted image service) + a nav link in the admin pages.
**Builds on:** `2026-06-22-ai-batch-image-uploader-design.md` (the `/suggest` captioning flow).

## Goal

Give the admin panel a **settings page for the LLM (LM Studio) configuration** so the four
values that currently live in environment variables can be viewed and changed at runtime —
persisted across restarts — without editing `.env` and redeploying. Add a **Test connection**
check, a **live model dropdown**, **advanced tuning** (timeout, max edge), and an **editable
caption prompt**.

## Today vs. after

Today `main.ts` reads `LMSTUDIO_BASE_URL`, `LMSTUDIO_MODEL`, `CAPTION_TIMEOUT_MS`,
`CAPTION_MAX_EDGE` once at boot and builds a fixed captioner; the caption prompt is a hardcoded
constant in `caption.ts`. After this change those five values come from a **runtime settings
store** (env seeds the defaults; a JSON file wins once saved), read fresh on each caption.

## Architecture

### Settings store — `src/settings.ts`

A small, file-backed store. One responsibility: load/merge/validate/persist the LLM settings.

- `interface Settings { lmBaseUrl: string; lmModel: string; captionTimeoutMs: number; captionMaxEdge: number; captionPrompt: string }`
- `defaultsFromEnv(env): Settings` — the initial values (same env vars as today; `captionPrompt`
  defaults to the prompt currently in `caption.ts`, which moves here as `DEFAULT_PROMPT`).
- `createSettingsStore({ path, defaults }): SettingsStore` with:
  - `get(): Settings` — current settings (file merged over defaults; cached in memory).
  - `update(partial): Settings` — validate, merge, write the file atomically, update cache, return the new settings.
- Persistence file: `SETTINGS_PATH` env, default `join(dirname(STORAGE_DIR), 'settings.json')`
  → `/data/settings.json` in the container (on the mounted volume; `./data/settings.json` locally).
  Missing/corrupt file → fall back to defaults (never throws on read).
- **Validation** (in `update`): `lmBaseUrl` must parse as an `http`/`https` URL; `lmModel`
  non-empty; `captionTimeoutMs` integer 1000–600000; `captionMaxEdge` integer 256–4096;
  `captionPrompt` non-empty. Invalid input throws a typed `SettingsError` (→ HTTP 400).

### Endpoints (added to `server.ts`, all require the bearer token)

- `GET /settings` → `{ lmBaseUrl, lmModel, captionTimeoutMs, captionMaxEdge, captionPrompt }`.
- `POST /settings` (JSON body, partial) → validate + persist; returns the updated settings.
  On validation failure → `400 { error }`.
- `GET /settings/models` → server fetches `${baseUrl}/models` from LM Studio (current baseUrl,
  or `?baseUrl=` override for the form) and returns `{ models: string[] }` (the `data[].id`s).
  On failure → `{ models: [], error }` (page degrades to manual entry; never 500).
- `POST /settings/test` (JSON `{ baseUrl?, model? }`, defaults to current) → fetches
  `${baseUrl}/models`; returns `{ ok, reachable, modelPresent, error? }`. A cheap connectivity +
  model-presence check (not a full sample captioning call).

### Caption wiring (changes to `caption.ts` + `/suggest`)

- `CaptionConfig` gains `prompt?: string`; `captionImage` uses `cfg.prompt ?? DEFAULT_PROMPT`.
  `DEFAULT_PROMPT` is exported from `caption.ts` (settings defaults reference it).
- `/suggest` reads `settings.get()` each request and builds the caption config
  (`baseUrl/model/timeoutMs/prompt`) and the downscale `maxEdge` from it — replacing the
  boot-time `captioner` closure + fixed `captionMaxEdge`.
- **Testability:** `buildServer` takes the settings store, plus an optional injected
  `captionImpl: (jpeg, cfg) => Promise<Caption>` (defaults to the real `captionImage`). Tests
  pass a fake store (fixed values) and a stub `captionImpl` — no network, no files.
- Graceful degradation is unchanged: a caption failure (LM Studio down, etc.) → that row gets
  `captionError: true`; the batch never 500s.

### Page — `public/settings.html` (served at `/admin/settings.html`)

Same brand styling (`admin.css`), linked from the admin nav on the other pages. Fields: auth
token, base URL, model (a `<select>` populated from `GET /settings/models` with a "type it in"
fallback), caption timeout, max edge, and a caption-prompt `<textarea>`. Buttons: **Test
connection** (calls `/settings/test`, shows reachable/model-present) and **Save** (POSTs to
`/settings`). On load it `GET /settings` to populate, then tries `/settings/models`. A status
line reports success/errors in the interface's voice.

## Configuration

| Var | Default | Purpose |
|-----|---------|---------|
| `SETTINGS_PATH` | `<dir of STORAGE_DIR>/settings.json` | Where runtime settings persist |

The existing `LMSTUDIO_BASE_URL`, `LMSTUDIO_MODEL`, `CAPTION_TIMEOUT_MS`, `CAPTION_MAX_EDGE`
remain — they now seed the store's defaults (used until the file is saved).

## Error handling

- Settings file missing/unreadable/corrupt → defaults (logged, never throws on read).
- `POST /settings` invalid → 400 with a clear message; nothing persisted.
- `/settings/models` and `/settings/test` LM Studio failures → returned as `{ error }` (page
  shows it); never a 500.
- All four endpoints require the bearer token (401 otherwise), like `/upload` and `/suggest`.

## Security

The base URL is fetched server-side (`/settings/models`, `/settings/test`, and captioning), a
mild SSRF surface. Mitigations: the endpoints require the admin token, and the URL is restricted
to `http`/`https`. Acceptable for an auth-gated admin tool on the user's own server.

## Testing

- `test/settings.test.ts` — defaults-from-env; file merge over defaults; `update` validates
  (rejects bad URL / out-of-range numbers / empty prompt) and persists; corrupt file → defaults.
  Uses a temp file; no network.
- `test/server.test.ts` — `GET /settings` returns current; `POST /settings` persists + 400 on
  invalid; `/settings/models` and `/settings/test` with an injected fake fetch; all 401 without
  auth. Update the existing `/suggest` tests to the new store + `captionImpl` injection.
- `test/caption.test.ts` — `captionImage` uses a custom `prompt` when provided (assert it's sent
  in the request body) and falls back to `DEFAULT_PROMPT` otherwise.
- No test depends on a live LM Studio or real files (temp dirs + injected fakes).

## Out of scope

- Settings unrelated to the LLM (storage, auth token rotation, image quality) — not requested.
- Multiple named LLM profiles / per-post overrides.
- Auth changes (still the single bearer token).
- A full sample-captioning "test" (the cheap `/models` reachability check is enough).
