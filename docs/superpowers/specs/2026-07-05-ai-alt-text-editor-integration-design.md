# AI Alt-Text, Editor-Integrated (Browser-Direct LM Studio) — Design

**Date:** 2026-07-05
**Status:** Approved (pending spec review)
**Repos touched:** blog repo — `uploader/` only.
**Builds on:** `2026-06-22-ai-batch-image-uploader-design.md` and
`2026-06-23-llm-settings-page-design.md` (the original AI caption + LM settings work,
**removed** 2026-07-04 in PR #39 / commit `a944ae1`). This design **restores** the
capability in a slimmer, editor-integrated form.

## Goal

Bring back local-LM-Studio **AI alt text**, this time wired **directly into the post
editor** rather than a standalone batch page. Next to each alt-text field in
`editor.html` (and the single-photo uploader `index.html`), a **"Suggest alt text"**
button sends the currently-picked photo to the author's **local LM Studio** vision model
and fills the field with the generated alt text (German or English, matching the field).
The author reviews/edits, then uploads/saves exactly as today.

This reverses a previously-documented "no AI features" decision at the explicit request
of the project owner (who judged the removal a mistake). `CLAUDE.md`, `ARCHITECTURE.md`,
`uploader/README.md`, and the auto-memory files are updated to match.

## Confirmed Requirements

- **Surface:** editor integration only. A "Suggest alt text" button beside each alt
  input in `editor.html` (DE-hero, EN-hero, DE-body, EN-body) and one on the single alt
  input in `index.html`. **No standalone batch page** (`batch.html` is not restored).
- **Model call is browser-direct.** The browser calls LM Studio's OpenAI-compatible API
  (`<baseUrl>/chat/completions`) itself; the **server never contacts the model**. Hence
  **no** `POST /suggest`, `GET /settings/models`, or `POST /settings/test` server routes,
  and **no** `docker-compose`/`.env` changes.
- **AI output:** `altEn` and `altDe` only, each written natively in its language (not
  machine-translated). **The `slug` output of the original is dropped** — editor
  integration does not need it, and parsing is more robust without a required field we
  never use.
- **Language mapping (unambiguous):** each editor button fills only its own field from
  the matching language — `#deHeroAlt`←`altDe`, `#enHeroAlt`←`altEn`,
  `#deBodyImgAlt`←`altDe`, `#enBodyImgAlt`←`altEn`. `index.html`'s single generic field
  fills with `altEn` and shows `altDe` as a copyable hint.
- **Always reviewed:** suggestions only pre-fill an editable input. Nothing auto-saves or
  auto-publishes.
- **Config lives in the JSON settings store** (not `.env`), managed on the admin-only
  Settings page: `lmBaseUrl`, `lmModel`, `captionTimeoutMs`, `captionMaxEdge`,
  `captionPrompt`. Defaults are hardcoded in `defaultSettings()`.
- **Least privilege:** configuring LM settings stays admin-only; **reading** the LM
  config (needed by the browser to run a suggestion) is available to any authenticated
  author via a new read-only `GET /ai-config`.
- **Keep the good hardening** that shipped alongside the July-4 removal: admin-gated
  settings mutation and the sanitized global error handler. This change touches neither.

## Why browser-direct (the load-bearing decision)

The original feature's *live* path captioned from the browser for three reasons, all
still true:

1. The server's SSRF guard (`safe-fetch.ts`) blocks loopback literals, and a
   containerized server cannot reach the host's LM Studio without extra compose wiring.
   Browser-direct avoids both.
2. The vision model runs on the same machine the author uses, so the browser reaching
   `http://localhost:1234` is the natural topology.
3. The server gains **no** new outbound-fetch surface — nothing new for security review.

**Verified viable:** `uploader/src/server.ts` sets `X-Content-Type-Options`,
`X-Frame-Options`, and `Referrer-Policy` on admin routes but **no `Content-Security-Policy`**,
so there is no `connect-src` restriction on a cross-origin `fetch()` to
`http://localhost:1234`. Mixed-content blocking does not apply because browsers treat
`http://localhost` / `http://127.0.0.1` as a potentially-trustworthy (secure) origin.

## Architecture

```
editor.html / index.html
   │  click "Suggest alt text"
   ├─ GET /ai-config  ──►  server (requireAuth) ──► settings store  → {lmBaseUrl, lmModel,
   │                                                                    captionPrompt,
   │                                                                    captionTimeoutMs,
   │                                                                    captionMaxEdge}
   │  alt-suggest.js: read the picked File, LLM.prepImage() downscale → data URL
   └─ POST <lmBaseUrl>/chat/completions  ──►  LOCAL LM Studio (browser-direct)
        parse {altEn, altDe}  →  fill the matching alt input
```

Everything model-facing happens in the browser. The server only **persists** and
**serves** the config.

### New: `uploader/public/llm.js` (browser)

Restored and trimmed from `git show a944ae1~1:uploader/public/llm.js`. Browser global
`window.LLM` with:

- `prepImage(file, maxEdge)` → `{ dataUrl, width, height }`. Loads the `File` into an
  `Image`, downscales the longest edge to `maxEdge` on a canvas, returns a JPEG data URL
  plus the **original** intrinsic dimensions (display only). The original file is never
  re-encoded here — upload still sends the untouched file to `/upload`.
- `caption(baseUrl, model, prompt, dataUrl, timeoutMs)` → `{ altEn, altDe }`. POSTs an
  OpenAI-compatible chat completion with a text part (the prompt) + an `image_url` part
  (the data URL); `AbortController` timeout; parses the reply via `parseCaption`.
- `parseCaption(content)` → `{ altEn, altDe }`. Extracts the first `{…}` JSON object from
  the model text (tolerates prose/code-fence wrapping), requires both fields non-empty.
- `listModels(baseUrl)` → `string[]`. GETs `<baseUrl>/models` for the Settings page model
  dropdown + "Test connection".

> `slug` and `slugify` from the original are **removed** — not needed without the batch
> key workflow.

### New: `uploader/public/alt-suggest.js` (browser)

Small shared wiring helper so the click logic is not duplicated across pages:

```js
// AltSuggest.wire({ button, fileInput, altInput, statusEl, lang, hintEl })
//   lang: 'de' | 'en'  → which language fills altInput
//   hintEl (optional): where to show the other-language suggestion (index.html)
```

On click: `GET /ai-config`; if the file input is empty, show "Pick a photo first."; else
`LLM.prepImage` → `LLM.caption` → set `altInput.value` to the `lang` alt (fires no input
event on programmatic set, so also `dispatchEvent(new Event('input',{bubbles:true}))` in
the editor to trip DraftGuard's dirty tracking). Failures (LM Studio unreachable, parse
error) show an inline, non-blocking message: "Couldn't reach LM Studio at <baseUrl> — is
it running? Fill in the alt text manually." The manual field always remains usable.

### New: `uploader/src/caption.ts` (server, tested)

The canonical, unit-tested parse contract that `llm.js` mirrors, plus the default prompt:

```ts
export const DEFAULT_PROMPT = [
  'You are writing alt text for a photo on a travel blog.',
  'Look at the image and respond with ONLY a JSON object, no prose, no code fences:',
  '{"altEn": "...", "altDe": "..."}',
  '- altEn: concise, factual English alt text (max ~120 chars). Do NOT start with "image of" or "photo of".',
  '- altDe: the same scene described natively in German (write it directly, do not translate word-for-word).',
].join('\n');

export class CaptionError extends Error {}

export function parseCaption(content: string): { altEn: string; altDe: string } {
  // first {…} match → JSON.parse → require non-empty altEn & altDe, else CaptionError
}
```

No network code lives here (the browser does the fetch); `settings.ts` imports
`DEFAULT_PROMPT` as the `captionPrompt` default.

### Edited: `uploader/src/settings.ts`

Restore the five LM fields on `Settings`, their `validate()` bounds, `defaultSettings()`
defaults, and — critically — add them to the known-keys read allow-list (the store drops
unknown keys on load, so an omitted key would be silently discarded):

| Field | Default | Validation |
|---|---|---|
| `lmBaseUrl` | `http://localhost:1234/v1` | parses as a URL, protocol `http:`/`https:` |
| `lmModel` | `qwen/qwen3-vl-4b` | non-empty (trimmed) |
| `captionTimeoutMs` | `60000` | integer, 1000–600000 |
| `captionMaxEdge` | `768` | integer, 256–4096 |
| `captionPrompt` | `DEFAULT_PROMPT` | non-empty (trimmed) |

`backupSchedule` / `backupRetention` are unchanged. Defaults are hardcoded (no
`defaultsFromEnv`), consistent with the current settings-store conventions and CLAUDE.md's
"don't grow `.env`".

### Edited: `uploader/src/server.ts`

- `POST /settings` (stays `requireAdmin`): parse the five LM fields the same field-by-field
  way as the backup fields, then `settings.update(partial)` (400 on `SettingsError`).
- **New `GET /ai-config`** (`requireAuth`, read-only): returns only
  `{ lmBaseUrl, lmModel, captionPrompt, captionTimeoutMs, captionMaxEdge }` so any
  authenticated author can run a suggestion without exposing or being able to mutate
  backup/settings state. `/ai-config` is added to `ADMIN_PREFIXES` for header parity.
- No other route changes; no `/suggest`, `/settings/models`, `/settings/test`.

### Edited: `uploader/public/settings.html`

Restore the LLM config card (base URL input, model `<select>` populated by browser
`LLM.listModels`, a "Test connection" button that lists models client-side, timeout,
max-edge, and prompt textarea) above the existing backup card. Loads `/admin/llm.js`.
Reads/writes via the existing `GET`/`POST /settings` (admin-only page). No server model
routes — the dropdown and test are browser-side.

### Edited: `uploader/public/editor.html`

Add a "Suggest alt text" `button.btn-secondary` inside each `.hero-picker` and
`.body-img-row`, wired via `AltSuggest.wire`:

| Button | fileInput | altInput | lang |
|---|---|---|---|
| DE hero | `#deHeroFile` | `#deHeroAlt` | `de` |
| EN hero | `#enHeroFile` | `#enHeroAlt` | `en` |
| DE body | `#deBodyImgFile` | `#deBodyImgAlt` | `de` |
| EN body | `#enBodyImgFile` | `#enBodyImgAlt` | `en` |

Load `/admin/llm.js` and `/admin/alt-suggest.js`. Each filled field dispatches an `input`
event so DraftGuard marks the form dirty.

### Edited: `uploader/public/index.html`

One "Suggest alt text" button beside `#alt`, wired for `lang: 'en'` reading `#file`, with
the German suggestion shown as a small copyable hint line. Load the two scripts.

## Data flow (a single suggestion)

1. Author picks a photo in a file input and clicks the adjacent "Suggest alt text".
2. `alt-suggest.js` `GET /ai-config` → LM config.
3. `LLM.prepImage(file, captionMaxEdge)` → downscaled JPEG data URL.
4. `LLM.caption(lmBaseUrl, lmModel, captionPrompt, dataUrl, captionTimeoutMs)` → POST to
   LM Studio → `{ altEn, altDe }`.
5. The matching-language alt fills the input; an `input` event marks the form dirty.
6. Author edits if needed and uses the existing Upload/Insert/Save controls unchanged.

## Error handling

- **LM Studio down / unreachable:** browser `fetch` rejects → inline message naming the
  configured base URL; the manual alt field stays fully usable.
- **Model returns unparseable text / missing a field:** `parseCaption` throws
  `CaptionError` → same inline "couldn't suggest, fill in manually" message.
- **No file picked:** "Pick a photo first."
- **`GET /ai-config` 401:** redirect to `/login` (same pattern as other admin fetches).
- Nothing in this flow can corrupt a draft or the live site — it only writes to an input.

## Security

- Model output is written to `input.value` / `textContent` only — **never** `innerHTML` —
  so no XSS is introduced at authoring time; alt text continues through the existing
  escape/sanitize path (`export.ts` / `posts.ts` / `body-images.ts`) at render.
- The server acquires **no** new outbound HTTP; `safe-fetch.ts` is untouched.
- `lmBaseUrl` is admin-configured and validated to `http:`/`https:`.
- LM config **mutation** stays admin-only; `GET /ai-config` is read-only and exposes only
  the five LM fields (not backup settings).

## Testing (Golden Rule: uploader logic is covered by Vitest)

- `uploader/test/caption.test.ts` (new): `parseCaption` — clean JSON; extraction from
  prose/code-fenced replies; `CaptionError` on non-JSON; `CaptionError` when `altEn` or
  `altDe` is missing/empty. (No `captionImage`/network tests — there is no server call.)
- `uploader/test/settings.test.ts` (edit): LM-field validation cases (base URL
  http/https, model non-empty, timeout bounds, max-edge bounds, prompt non-empty); the
  five LM fields round-trip through `update()`; **update the existing "drops stale/unknown
  keys" test** since `lmModel` et al. are known keys again and must now persist; defaults
  include the LM fields.
- `uploader/test/server.test.ts` (edit): `POST /settings` accepts LM fields for an admin
  (and 400s an invalid `lmBaseUrl`); `GET /ai-config` returns the LM subset for a
  non-admin authed user and 401s unauthenticated.
- Browser modules (`llm.js`, `alt-suggest.js`) are not in the Vitest scope; verify
  manually against a running LM Studio (or a stubbed endpoint) via the editor: a
  suggestion fills the field, an unreachable endpoint degrades gracefully, and DraftGuard
  turns dirty. `npm test` + `npx astro check` (site) and the uploader suite must pass.

## Docs & memory (part of this change)

- `CLAUDE.md`: remove the "does not use LM Studio or any AI features" claims and the
  "AI feature removal" framing; add the restored feature to project status.
- `ARCHITECTURE.md` + `uploader/README.md`: document the editor-integrated,
  browser-direct AI alt-text feature and the `GET /ai-config` endpoint.
- Auto-memory: rewrite `ai-batch-uploader.md` (currently "removed — don't reintroduce")
  to record the 2026-07-05 restoration in slimmer form, and note it in
  `blog-rebuild-status.md`.

## Out of scope / non-goals (YAGNI)

- The standalone batch uploader page and multi-photo review grid.
- Any server-side model call, `/suggest`, model-list, or connection-test route.
- Model-generated slugs / key auto-naming.
- Auto-suggesting on file pick (the button is an explicit, deliberate action).
- Filling both locales from one click (kept per-field for correctness; can revisit later).
- `.env` / `docker-compose` LM variables and `extra_hosts` wiring.
