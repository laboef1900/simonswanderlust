# AI provider registry and use-case assignments

**Date:** 2026-10-19
**Risk:** HIGH — credentials (multiple encrypted slots), a boot-time settings + secret migration,
admin/author disclosure, settings contract.
**Status:** **Implementation approved by the owner on 2026-10-19** (§11). Merge requires a separate
human decision on the final HEAD.
**Branch:** `feature/admin-ui-shell` (worktree `simonswanderlust-admin-ui`)
**Supersedes, where stated:** `2026-09-19-encrypted-ai-review-secrets-design.md` (#214) §4.4
"only application slot is `ai_api_key`", §5 provider resolution, §6 `POST /settings` secret
semantics, §7 UI contract, and §13 "share the editorial API key". Everything else in #214 —
crypto primitives, `ENCRYPTION_KEY` handling, backup v6, restore, author disclosure, browser-direct
inference, no server egress — stays authoritative.

## 1. Why

The owner asked for the Settings page to manage AI like the CompendiQ reference (screenshot
attached to the 2026-10-19 request): a **Providers** list (name, base URL, Edit / Set default /
Test / Delete, **+ Add**) and a **Use case assignments** grid (per use case: provider select,
model, and a resolved `→ Provider / model` line). Asked to choose between a layout-only regroup of
today's fields and a real registry, the owner chose **Full provider registry** (ask, 2026-10-19).

Today's model cannot express that: four hard-coded presets, two independent custom URLs, one
LM Studio URL shared by both features, and **one portable `ai_api_key`** sent to whichever remote
destination either feature selects (#214 §3 residual, #214 §13 owner acceptance).

## 2. Scope

In scope: `uploader/src/settings.ts`, a new `uploader/src/ai-providers.ts` (registry types,
validation, legacy derivation, resolution, secret-slot naming), `uploader/src/secrets.ts` (one
migration helper), `uploader/src/main.ts` (boot migration), `uploader/src/server.ts`
(`/settings`, new `/ai-providers*` routes, `/ai-config` resolution), `uploader/public/settings.html`
(+ vertical tabs), `uploader/public/tabs.js` (vertical orientation), `uploader/public/admin.css`
(settings block), tests, and current-state docs (§10).

Out of scope / unchanged: the `/ai-config` **response shape** (every consumer — `alt-suggest.js`,
`editor-review.js`, `editor-excerpt.js`, `media-ai.js`, `media-ai-dialog.js`, `media-browser.js` —
stays byte-for-byte unchanged); `llm.js`; schema (`app_secrets` already holds arbitrary named
rows); backup format (v6 already dumps/restores every `app_secrets` row); auth/session; public
routes or slugs; any server-side model call.

## 3. Data model

### 3.1 Provider (non-sensitive, in `settings.json`)

```ts
type AiProviderKind = 'lm-studio' | 'openrouter' | 'deepseek' | 'custom';
interface AiProvider {
  id: string;         // ^[a-z0-9][a-z0-9-]{0,39}$ — server-assigned, immutable
  name: string;       // 1–60 chars after trim, no \p{C}; unique case-insensitively
  kind: AiProviderKind; // immutable after creation
  baseUrl: string;    // absolute http(s), no userinfo/query/fragment, ≤ 300 chars
}
```

- `kind` keeps the existing client semantics: `lm-studio` is local and **never** holds or receives
  a key; `openrouter` / `deepseek` require one; `custom` may have one. Add pre-fills
  `https://openrouter.ai/api/v1` / `https://api.deepseek.com/v1` / `http://localhost:1234/v1`;
  the URL stays editable (an "OpenRouter – Embeddings" style endpoint is legitimate).
- At most **20** providers; at least **1**.
- New ids: `p-` + 8 hex chars from `crypto.randomBytes`, regenerated on collision.

### 3.2 Settings fields

Removed: `lmBaseUrl`, `captionProvider`, `captionCustomBaseUrl`, `aiProvider`, `aiCustomBaseUrl`.
Added:

| Field | Default (fresh install) | Validation |
|---|---|---|
| `aiProviders` | `[{ id: 'lm-studio', name: 'Local LM Studio', kind: 'lm-studio', baseUrl: 'http://localhost:1234/v1' }]` | §3.1, as one field |
| `aiDefaultProviderId` | `'lm-studio'` | must reference a provider |
| `reviewProviderId` | `null` | `null` (= follow default) or a provider id |
| `captionProviderId` | `null` | `null` (= follow default) or a provider id |

Kept unchanged: `aiModel` (review model), `lmModel` (photo model), `reviewPrompt`,
`reviewTimeoutMs`, `captionPrompt`, `captionTimeoutMs`, `captionMaxEdge`, and `captionMaxTokens`
(#268, merged from `dev`; part of the caption config and the settings response).

Use cases are the two features that exist: **Story review & excerpts** (`reviewProviderId`,
`aiModel`, prompt, timeout) and **Photo descriptions** — alt text and media details
(`captionProviderId`, `lmModel`, prompt, timeout, max edge).

Cross-field rule (in `validate()`): default and both assignments reference existing providers.
`loadSettings` keeps its field-by-field recovery and adds one repair step after it: a dangling
`aiDefaultProviderId` falls back to the first provider, a dangling assignment to `null`; each
repair is logged by field name, never by value.

### 3.3 Secret slots

One `app_secrets` row per remote provider: `ai_provider_key:<id>`. The slot name is built only
from a validated, server-assigned id — no client string ever becomes a slot name. The legacy
`ai_api_key` slot is read only by the boot migration (§5) and is deleted by it.

## 4. Resolution and HTTP contracts

All responses are explicitly constructed and carry `Cache-Control: no-store` (existing hook). All
settings/provider mutations and full config reads run inside the existing `settingsOperation`
queue. Admin routes use `requireAdmin` (401 anonymous / 403 author).

### 4.1 Resolution

`resolve(useCaseProviderId) = providers.find(id === (useCaseProviderId ?? aiDefaultProviderId))`.
Validation guarantees a hit; a miss is a 500-class invariant failure, never a silent fallback.

### 4.2 `GET /ai-config` — `requireAuth`, response shape unchanged

- `?purpose=caption`: resolve the photo provider. Kind `lm-studio` → respond immediately, outside
  the queue, **without touching the secrets store** (#214's caption isolation):
  `{ lmModel, captionPrompt, captionTimeoutMs, captionMaxEdge, captionProvider: kind,
  captionBaseUrl: provider.baseUrl, captionApiKey: null }`. Remote → queued,
  `captionApiKey = secrets.get(slot(provider))`.
- no purpose: resolve the review provider; same caption fields plus
  `{ aiProvider: kind, aiBaseUrl, aiModel, reviewPrompt, reviewTimeoutMs, hasAiApiKey, aiApiKey }`.
  Local → `aiApiKey: null, hasAiApiKey: false`, no secret access (a local provider cannot hold a
  key, §4.4). Remote → `get` its own slot; missing row → `null`/`false`; unreadable → sanitized 503.
- `lmBaseUrl` and `captionCustomBaseUrl` leave the caption fields (no consumer reads them from
  `/ai-config`; the settings page reads `/settings`).

**Invariant:** a key is only ever returned together with the base URL of the provider that owns
it. Two use cases on two providers return two different keys; nothing is shared implicitly.

### 4.3 `GET /settings` / `POST /settings` — `requireAdmin`

GET adds `aiProviders: [{ id, name, kind, baseUrl, hasApiKey }]` (presence via `has`, no
decryption; one query per provider, ≤ 20), `aiDefaultProviderId`, `reviewProviderId`,
`captionProviderId`, and drops `hasAiApiKey` and the removed fields.

POST accepts `aiDefaultProviderId`, `reviewProviderId`, `captionProviderId` plus the kept fields.
It **rejects** `aiApiKey` (400 "API keys are managed per provider.") and `aiProviders` (400
"Providers are managed with /ai-providers."), so an old client cannot believe it saved a key.
Removed legacy fields are ignored as today's unknown fields are.

### 4.4 Provider routes — `requireAdmin`

| Route | Body | Effect |
|---|---|---|
| `POST /ai-providers` | `{ name, kind, baseUrl, apiKey? }` | create; 201 + settings response |
| `PUT /ai-providers/:id` | `{ name?, baseUrl?, apiKey? }` | edit; `kind` in body must equal stored or 400 |
| `DELETE /ai-providers/:id` | — | 409 `provider_is_default` / `provider_in_use` (names the use cases); else delete |
| `GET /ai-providers/:id/credential` | — | `{ apiKey: string \| null }` for the Settings **Test** action |

- `apiKey` semantics (own-property check, as #214): omitted → untouched; non-empty string without
  `\p{C}` → encrypt + upsert the provider's slot; `''`/`null` → delete the slot; any other type →
  400. A non-empty key for a `lm-studio` provider → 400.
- Order and failure semantics are #214 §6 unchanged: validate everything first (including
  encryption availability when a key changes), **secret first, settings second**; a settings
  failure after a committed secret is `500 settings_partial_failure`. For DELETE the order is the
  same: drop the slot, then the provider; a partial failure leaves a provider showing "Not
  configured" — the safe direction.
- `credential`: local kind → `null` without touching the store; unknown id → 404; unreadable → 503.

## 5. Boot migration (legacy → registry)

Runs in `main.ts` after `ensureSchema`, before `listen`, only when `settings.json` has **no**
`aiProviders` key but has at least one legacy field.

1. **Derive (pure, `ai-providers.ts`)** with deterministic ids so a crashed run repeats exactly:
   - `lm-studio` ← legacy `lmBaseUrl` (or default). Always present.
   - review preset `openrouter`/`deepseek` → id = kind; caption preset likewise (one provider if
     both select the same preset).
   - each distinct non-empty custom URL (review first, then caption) → `custom`, `custom-2`; an
     unselected custom URL is kept as a provider so no configured value is lost.
   - assignments: the provider each feature had selected; a selected `custom` with an empty URL
     (legacy-valid, config-invalid) → `lm-studio`, which receives no key.
   - default = the review provider.
   - `keyed` = every derived remote provider that a feature had **selected** — exactly the
     destinations that received the shared key before. Unselected custom URLs never get a copy.
2. **Secrets (one Postgres transaction, `secrets.ts`)**: if `ai_api_key` exists,
   `INSERT INTO app_secrets (key, ciphertext, iv, tag) SELECT 'ai_provider_key:'||id, ciphertext,
   iv, tag FROM app_secrets WHERE key = 'ai_api_key' ON CONFLICT (key) DO NOTHING` for each `keyed`
   id, then `DELETE … WHERE key = 'ai_api_key'`. Pure SQL: **no decryption, no master key needed**
   (#214 envelopes carry no AAD, so a copied envelope decrypts under its new name). Identical
   ciphertext under the same IV is a copy of one encryption, not nonce reuse.
3. **Settings**: write `settings.json.pre-ai-registry` (non-secret legacy file, once, no clobber),
   then persist the registry shape through the store's atomic rename.

Crash matrix: before 2 commits → nothing changed, rerun. After 2, before 3 → legacy file, keys
already copied, `ai_api_key` gone; rerun derives the same ids, `ON CONFLICT DO NOTHING`, writes 3.
DB unavailable → boot fails as it does today when `ensureSchema` cannot run. A legacy `ai_api_key`
that appears **after** migration (restoring an old dump) is left untouched and unused; the restore
CLI already tells the operator to reconcile settings and re-enter keys.

## 6. Settings UI

Read alongside `DESIGN.md` (Admin authoring). One flat document per tab inside the white
workspace; no cards inside the card.

- **Vertical tabs** replace the anchor index: AI models · Images · Comments · Site & backups.
  `role="tablist"` with `aria-orientation="vertical"`, `tabs.js` gains ArrowUp/ArrowDown for
  vertical lists, the active tab is mirrored in `location.hash` (deep links survive; unknown hash →
  first tab), the page title reads **Settings · AI models**. Below 72rem the list becomes a
  horizontal, wrapping strip above the panel.
- **Providers** (AI models tab): one row per provider — name, a `default` badge, kind, mono base
  URL, key state as text ("Key stored" / "No key" / "Local — no key"), and text actions **Edit ·
  Set default · Test · Delete**. Default's Set default/Delete are disabled with a reason;
  Delete of an assigned provider is refused with the use cases named. **+ Add** opens the same
  inline form below the list (name, kind, base URL pre-filled per kind, masked key field for remote
  kinds, Save / Cancel). Edit opens it under the row. The key input is `type=password`,
  `autocomplete=new-password`, never pre-filled; blank means keep; **Remove stored key** is a
  separate confirmed action. Changing the URL of a provider with a stored key warns and confirms,
  naming old and new URL ("the stored key will be sent to …"). Delete confirms with scope.
- **Test** lists models from the browser (`LLM.listModels`): typed key if the form is open, else
  the stored key via `/credential` for remote kinds; reports reachable + model count; fills the
  model dropdowns of every use case on that provider. The open form has its own **Test
  connection** (a provider being added has no row yet); with the key blank and the URL changed it
  refuses rather than send a stored key to an unsaved URL.
- **Use case assignments**: rows *Story review & excerpts* and *Photo descriptions* — provider
  select (first option `Default — <name>`), a model **dropdown** filled from that provider's
  model list, and a live `→ <Provider> / <model>` line plus the destination URL. A saved model the
  provider does not list stays selectable ("saved, not listed"); **Other model ID…** reveals a text
  field for an unlisted model or a provider whose list cannot be read. Each feature's prompt,
  timeout (and max edge for photos) follows the panel in its own subsection. One **Save AI
  settings** for the assignments and prompts.
- **Automatic model lookup — refinement (owner decision, 2026-10-19, "Automatically").** This
  supersedes the earlier "never on page load for remote kinds" rule here and in #214 §13. When
  the AI models tab is shown, the page lists models (`GET <baseUrl>/models`) for every provider
  assigned to a use case — explicitly or via the default — and again whenever a row's provider
  changes or its refresh button is pressed. Remote kinds fetch their key from `/credential` into
  a request-local variable that is cleared afterwards. Lists are cached per provider for the page
  load, concurrent lookups are deduplicated, and stale results are dropped. Only `/models` is ever
  called automatically, never a completion, so no draft or photo leaves the browser and no usage
  is billed. The added exposure: opening Settings now sends the stored key of each assigned remote
  provider to that provider — its own URL — without a click.
- **Test review** stays (#214 refinement): selected provider + model + prompt + timeout with the
  built-in sample, key = stored provider key via `/credential`, never saving.
- Set default confirms when it moves a use case that follows the default to another destination.
- Copy explains: keys are stored encrypted per provider; every signed-in author's browser receives
  the key of the provider assigned to a use case, in memory, when using it; the server never calls
  a model; the provider receives drafts or resized photos; remote providers may charge.

## 7. Trust boundaries and residual risks

| Boundary | Change vs #214 |
|---|---|
| Author → app | Unchanged class: authors receive the key(s) of the provider(s) assigned to the two use cases. Now up to **two different** keys instead of one shared key. Keys of unassigned providers never reach an author. |
| Admin → app | **New:** `/credential` returns any remote provider's key to an admin browser in memory, for Test. The admin entered it; same disclosure class as an admin reading `/ai-config` today. |
| Key ↔ destination | **Narrowed:** a key is bound to one provider's base URL. It moves only when an admin edits that provider's URL, which warns and confirms. Switching a use case to another provider sends that provider's own key, never the previous one. |
| Migration | Copies the shared envelope to every destination that already received it; never widens. |
| DB writer | Unchanged residual: no AAD, so a privileged DB writer can swap envelopes between slots and route a key to another provider. Same class as #214 §11 replay. |
| Cross-store writes | Unchanged residual, now per provider operation (§4.4). |

## 8. Misuse cases

| Misuse / challenge | Answer |
|---|---|
| Client sends `ai_provider_key:../x` as an id | Ids are validated by regex and must exist in the registry before any slot name is built. |
| Old browser tab posts `aiApiKey` to `/settings` | 400; nothing written. |
| Admin points an OpenRouter-kind provider at `http://evil` with a stored key | Allowed (admin authority, #214 portability) but warned + confirmed, HTTP warned, mixed content explained. |
| Delete the provider Story review uses | 409 naming the use case; reassign first. |
| Settings.json hand-edited to a dangling id | Load repairs to default / first provider and logs the field. |
| Corrupt key row on the photo provider | Photo descriptions 503 (sanitized); review on another provider unaffected; local photo provider never touches the store. |
| Restore an old v6 dump after migration | Its `ai_api_key` is inert; provider slots restored from the dump only if present; re-enter keys per provider. |
| 21st provider / 61-char name / duplicate name | 400 with a fixed message. |

## 9. Rollback and containment

- **Before deploy:** take **Back up now** (v6 dump containing `ai_api_key`) and keep the host copy
  of `settings.json`. The migration also leaves `settings.json.pre-ai-registry`.
- **Containment without rollback:** assign both use cases to the local provider.
- **Rollback:** older image + restore the pre-deploy dump (brings `ai_api_key` back) + copy
  `settings.json.pre-ai-registry` over `settings.json`. Without the dump, re-enter the shared key in
  the old Settings page. The old loader drops the registry fields on its next write.
- A key suspected sent to a wrong endpoint must be revoked at the provider.

## 10. Verification and docs

Automated: settings validation (provider shape, limits, uniqueness, cross refs, load repair);
legacy derivation table (every provider combination, custom URL kept/dropped, empty custom,
dedupe, keyed set); migration against real Postgres (copy + delete in one transaction, rerun
idempotence, no master key required, legacy-after-migration inert); route matrix (anon/author/
admin), key omitted/replace/remove, local-key refusal, delete refusals, partial failure;
`/ai-config` resolution for default/explicit/local/remote, caption isolation with a throwing
secrets store, response shape unchanged; settings DOM suite for providers, assignments, tabs,
warnings and tests. Then `npm test` + `tsc --noEmit` (uploader, with `TEST_DATABASE_URL`) and a
browser smoke of the real Settings page at desktop and mobile widths with disposable keys and a
local model-list fixture — no paid requests.

Docs with the implementation: `SECURITY.md` (AI section: per-provider keys, admin credential
route, migration), `ARCHITECTURE.md` (settings shape, routes), `uploader/README.md` (operator
steps), `DESIGN.md` (Settings bullets), `CLAUDE.md` (AI/LLM security bullets + status entry).

### Verification (2026-10-19, worktree `feature/admin-ui-shell`)

- Uploader `tsc --noEmit` clean; **1,837 tests in 75 files passed** with `TEST_DATABASE_URL` on a
  disposable Postgres 18 (integration suites ran, including the real-`main.ts` boot from a legacy
  settings file + `ai_api_key`). Site: 290 tests passed; `astro check` 0 errors/warnings/hints;
  the in-process `astro build` produced 15 pages against the empty disposable schema.
- Real `src/main.ts` against that Postgres with a legacy `settings.json` (review OpenRouter,
  captions local, an unselected custom URL) and an encrypted legacy key: boot logged the
  migration (3 providers), wrote `settings.json.pre-ai-registry`, and left exactly one slot,
  `ai_provider_key:openrouter` — the unselected custom provider received no copy and the legacy
  row was gone.
- Settings page in headless Chrome at 1440×900 and 390×844: edited the custom provider to a
  local CORS model-list fixture with a disposable key; form **Test connection** and row
  **Test** (via `/credential`) both reached the fixture with that key and no cookie; assigning
  Photo descriptions made `/ai-config?purpose=caption` return the fixture URL with that key while
  default `/ai-config` kept OpenRouter with the migrated key. Delete of the assigned provider was
  refused with the use case named; a URL edit with a stored key and Set default (moving a
  default-following use case) both asked for confirmation naming both destinations, and
  cancelling left settings unchanged. Tabs: click, ArrowUp/Down, hash and title verified; narrow
  widths switch to a horizontal strip with no horizontal overflow. No paid or external provider
  request was made.

## 11. Owner decision

Question asked on 2026-10-19: approve implementing this design, including (1) per-provider
encrypted keys replacing the single shared key, (2) the boot migration that copies the shared key
to every provider that used it and deletes the legacy slot without decrypting, (3) the new
admin-only credential route for provider tests, (4) the unchanged residuals: authors receive the
assigned providers' keys, non-atomic secret/settings writes, no AAD binding between slot and key.

Decision: the owner selected **"Approve implementation"** (ask prompt in the implementing session,
2026-10-19), over the alternatives "Approve, but keep legacy key" and "Not yet". Conditions: none
beyond this spec; approval covers implementation only — the final-HEAD merge decision is separate.
