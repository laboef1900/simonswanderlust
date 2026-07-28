# AI Post Authoring with Claude (Agent-CLI Sidecar) — Design

**Date:** 2026-07-28
**Status:** Draft, revision 3 (owner decisions folded in 2026-07-28)
**Repos touched:** blog repo — `docker-compose.yml`, `.github/workflows/release.yml` (a second GHCR
image; see §The `authoring` service), `uploader/src/settings.ts`, `uploader/src/server.ts`,
`uploader/public/settings.html`, `uploader/public/editor.html`, docs
(`PRODUCT.md`, `CLAUDE.md`, `SECURITY.md`, `ARCHITECTURE.md`) and a new `authoring/` tree.
**No change to `site/`.**
**Refs:** #67 — this is the design only; the issue stays open for implementation.
**Builds on:** `2026-06-24-postgres-cms-phase-b-design.md` (the in-admin editor and the `PostPair`
contract), `2026-07-03-single-app-container-design.md` (the `app`/`db` topology and the DHI runtime),
`2026-07-26-media-library-and-galleries-design.md` (`GET /media` at session level with redaction),
`2026-07-05-ai-alt-text-editor-integration-design.md` (the browser-direct LM Studio path, which this
design leaves **completely unchanged**).

> **Revision 3 supersedes revisions 1 and 2.** Revision 1 assumed a terminal-invoked sidecar that
> logged into the CMS and wrote via HTTP. Revision 2 added an editor button and settings-driven
> config. **Revision 3's decision 7 removes the sidecar's CMS credential entirely** — it now returns
> text and the app performs every write in-process. §Owner decisions records all seven decisions and
> what each costs. §Why not a credential in the settings store still stands, and revision 3
> **reinforces** it rather than reversing it.

## Owner decisions (2026-07-28, revisions 2–3)

| # | Decision | Effect on revision 1 |
|---|---|---|
| 1 | **A button in the admin editor triggers a run** | Reverses the "no admin-UI button" non-goal. The `app` container gains one narrow outbound call — to the sidecar, never to a model. See §The trigger endpoint. |
| 2 | **Tunable config lives on the admin Settings page**, not in the sidecar's environment | New settings fields + UI. Secrets are explicitly excluded — see decision 4. |
| 3 | **Provider is selectable: Anthropic, or any OpenAI-compatible endpoint** (LM Studio, Ollama) | New provider abstraction in the sidecar. Makes a **fully zero-egress** configuration possible. |
| 4 | **Secrets stay in `authoring/.env`** | Unchanged from revision 1, and it is what makes decision 2 safe. |
| 5 | **Provider priority: Claude CLI → Anthropic API → local LLM** | The CLI on a **subscription** is the primary path. See §Provider abstraction. |
| 6 | **No spend cap in this repo** | Managed on the Anthropic account. This design adds no metering and does not pretend to. |
| 7 | **The app performs every CMS write in-process; the sidecar returns text only** | **Largest change in revision 3.** No CMS account, no login, no CMS credential. See §Division of labour. |

**Decisions 2 and 4 look contradictory and are not.** The split is secrets versus settings:

| Lives in `authoring/.env` (gitignored, never on `/data`) | Lives in `/data/settings.json` (admin UI) |
|---|---|
| `ANTHROPIC_API_KEY` — **tier 2 only** | provider tier + model id, base URL, timeout |
| *(tier 1 uses a login profile on a volume, not a secret)* | the drafting/translation prompts |
| *(tier 3 usually needs nothing)* | |

**No secret ever enters the settings store**, so §Why not a credential in the settings store still
holds in full — `GET /settings` returns the whole object with no redaction concept, and nothing it
now returns is confidential. The owner gets a UI for everything worth tuning, and the store never has
to learn write-only semantics.

## Division of labour (owner decision 7)

**The sidecar is a text service. It has no CMS credential, no session, and no database access.**

```
button → POST /authoring/runs        (app, requireAuth, async → 202 + run id)
   │
   ├─ app loads the post (or the pasted notes) and builds a prompt
   ├─ app POSTs {prompt, context} to the sidecar over the compose network
   ├─ sidecar calls the model and returns {title, excerpt, bodyMarkdown}
   └─ app shape-checks, then validateDraft(pair), then posts.upsertDraft(pair, baseUpdatedAt)
      IN-PROCESS — see the validateDraft warning below
```

**⚠ `upsertDraft` is not the whole of `POST /posts` — call `validateDraft` yourself.** The route is
`validateDraft(pair)` at `server.ts:826` and *then* `posts.upsertDraft(...)` at `:827`. Going
in-process skips the line above, which is precisely the bypass the codebase already documents: the
`@ai-warning` at `posts.ts:265-270` exists because the WXR importer calls `upsertDraft` directly and
never runs `validateDraft`. Every place this spec leans on `validateDraft` as a gate — the
non-blank-German-title rule, the "slug is format-checked only when present" rule, slice 1's
acceptance criteria — is true **only if the authoring handler calls it explicitly**. Add it to the
handler and assert it in a test, or those guarantees are prose.

**What this buys, and why it is worth reversing revision 2's framing for:**

- **No `claude-agent` account, no `POST /login`, no session cookie, no CMS credential.** The entire
  "credential scope" problem disappears rather than being mitigated. `authn.ts` never needed a
  service-account concept, which is just as well — it does not have one.
- **Prompt injection shrinks from a write-capability problem to an output-quality problem.**
  Revision 1's central worry was that imported WordPress prose could steer a client holding CMS
  write credentials. It now steers a service whose only power is to **return a string**. The app,
  not the model's client, decides what reaches the database.
- **The concurrency contract becomes enforceable rather than merely specified.** One-write-per-run
  and the `updatedAt` echo were rules the sidecar had to be trusted to follow; they are now ordinary
  code in one handler, and testable.

**What it costs — state this plainly rather than discovering it later.** The drafts-only guarantee
moves from *credential scope* to *code invariant*. Previously the sidecar could not publish because
its account lacked the role; now it cannot publish because the authoring handler only ever calls
`upsertDraft` and never `publish`. A credential cannot be edited carelessly; a handler can. The
mitigation is a test asserting the authoring path never reaches `publish`, `rebuild`, or any admin
route — cheap, and it must exist before this ships.

**Consequence for the four slices below:** every "`POST /login` → … → `PUT /posts/:tk`" flow becomes
"app reads → sidecar drafts → app writes". The acceptance criteria are unchanged in substance — they
describe what must end up in the database, and that contract does not care who wrote it.

**Consequence worth stating plainly:** with `provider: openai-compatible` pointed at LM Studio, there
is **no API key at all** and no outbound internet. In that configuration this feature is entirely
self-hosted, and `PRODUCT.md` Principle 4 is not amended — only the Anthropic configuration amends
it. See §Documented commitments this amends.

## Goal

Let the owner draft posts with Claude without putting an LLM client, an Anthropic credential, or an
outbound model fetch inside the `app` container.

A **model client runs as a separate container on the compose stack**. It receives a prompt from the
app, calls the model, and returns generated text. **It holds no CMS credential and never touches the
database** (§Division of labour). The app writes the result as a **draft**; publish stays a human
admin action in the browser, which keeps a human review step in front of every AI-written post.

Four slices, sequenced. All four are writes the app already knows how to make; the fourth also reads
`GET /media`, which has since shipped.

## Confirmed Requirements (decided by the owner, 2026-07-26 / 2026-07-28)

- **Architecture is settled:** a model client in its own compose service. Not the Anthropic API
  called from the Fastify process. Not a CLI inside the `app` container.
- **Drafts only, never publishes.** `POST /posts/:tk/publish` is out of scope. Under revision 3 this
  is a code invariant in the authoring handler rather than a credential scope — see §Division of
  labour for what that trades away and the test that must cover it.
- **One write per run**, performed by the app after the sidecar returns.
- **The app MUST echo `updatedAt`** on every write to an existing post.
- **Slugs stay human.** The agent never proposes or changes a slug.
- **The browser-direct LM Studio alt-text path stays exactly as it is**, alongside this. It costs
  nothing, works offline, and is the only zero-egress AI path in the product.
- **The Anthropic credential never enters `/data`** — not the settings store, not a backup.

## Non-Goals (YAGNI)

- **No publish, unpublish, delete, bulk action, rebuild, settings write, user management, or backup
  access from the sidecar.** All admin-only today (`uploader/src/server.ts:859`, `:972`, `:995`,
  `:912`, `:1036`, `:592`, `:679`, `:1071`) and they stay that way.
- **No streaming into the editor.** There is no SSE/WS path on posts, so "watch it type" is a
  *second* server change, not a client-side choice. Explicitly out of scope.
- **No new server→LLM call, and no proxying a model through `safeFetch`.** Preserved verbatim from
  `CLAUDE.md:302-304`, and **still true under revision 3**: the trigger endpoint calls the *sidecar*,
  which is not a model. Fastify never opens a connection to Anthropic or to LM Studio. The rule
  constrains what the app may talk to, and a compose-internal service on the app's own network is not
  what it was written to prevent.
- **No cost/budget/metering feature.** None exists (`uploader/src/rate-limit.ts` is auth-only) and
  this design does not build one — see "Failure modes".
- **No scoped-token or service-account mechanism.** Verified absent — `users.ts` models a user as
  `{id, username, passwordHash, isAdmin, createdAt}` with no token, scope, or machine-account field,
  and `authn.ts` has exactly two guards. **Revision 3 makes this moot rather than merely accepted:**
  the sidecar authenticates to nothing, so there is no identity to scope. Adding tokens would still
  be a separate, higher-risk change, and this design no longer needs one.
- **No change to the `PostPair` contract, the Zod schema, the slug contract, or the publish gate.**
- ~~**No admin-UI button that triggers the sidecar.**~~ **Reversed by owner decision 1.** The app
  gains exactly one outbound call, to a hardcoded compose-internal hostname. It is scoped and
  bounded in §The trigger endpoint; it is not a general-purpose fetch and must not become one.

## What today's API already gives us (re-verified 2026-07-28)

Issue #67's review comments were written before #63/#64/#65/#70/#73 merged. Every load-bearing claim
was re-checked against `dev` at commit `9f8abd4`; line numbers below are current, and where the issue
is now wrong it is called out.

**Draft creation is not gated on anything a model cannot produce.**

- `validateDraft` (`uploader/src/posts.ts:147-152`) requires exactly one thing: a non-blank German
  title. It additionally format-checks a slug **only if one is present**.
- `draftWithDefaults` (`uploader/src/posts.ts:271-294`) fills a missing `heroImage` with
  `PLACEHOLDER_HERO` (`:204` — `{src:'', width:0, height:0, alt:''}`) and a missing `images` map with
  `{}`.
- The two-complete-locales-plus-image-dimensions contract lives in `validateForPublish`
  (`uploader/src/posts.ts:168-202`) and `validateLocale` (`:154-166`) — **publish only**.

So "title + excerpt + body as a draft, one or both locales" is fully reachable today. Slices 1–3
require **zero** server change. Do not let the spec's length imply otherwise.

**Every edit is a whole-pair overwrite.** `upsert` (`uploader/src/server.ts:814-837`) strips
`updatedAt`, sets `translationKey`, and hands the rest to `posts.upsertDraft`. There is no PATCH.
Every edit is GET `/posts/:tk` → mutate in memory → PUT the entire `PostPair`
(`uploader/src/posts.ts:22-25`). A field the agent forgets to carry forward is silently erased.

**Authoring endpoints reachable at session level (`requireAuth`), i.e. by a non-admin author:**

| Endpoint | Location | Note |
| :-- | :-- | :-- |
| `GET /posts`, `GET /posts/:tk` | `server.ts:789`, `:791` | list + full pair incl. `updatedAt` |
| `POST /posts`, `PUT /posts/:tk` | `server.ts:838`, `:839` | create / overwrite draft |
| `GET /posts/:tk/revisions[/:id]` | `server.ts:844`, `:850` | read-only history |
| `GET /posts/:tk/preview` | `server.ts:800` | server-rendered HTML preview |
| `POST /upload` | `server.ts:234` | one file, ≤25 MB, 507 when `/data` is tight |
| `GET /media`, `GET /media/items/*` | `server.ts:400`, `:523` | **redacted for non-admins** |
| `GET /media/folders`, `POST /media/folders`, `POST /media/move`, `POST /media/retry` | `server.ts:430`, `:433`, `:465`, `:490` | reversible media ops |
| `GET /ai-config` | `server.ts:613` | LM Studio config, read-only |
| `POST /export`, `POST /import` | `server.ts:1095`, `:1102` | **see credential scope below** |

**`GET /images` no longer exists.** Issue #67 cites `GET /images` at `server.ts:248` (admin-only) as
slice 4's blocker and `DELETE /images/*` as part of the admin blast radius. Both routes are gone —
`/images` survives only as a header prefix (`server.ts:109`). The media library replaced them:
`GET /media` is `requireAuth` (`server.ts:400`) and `DELETE /media/items/*` is `requireAdmin`
(`server.ts:567`). **Slice 4 is therefore no longer blocked** — the blocker shipped with #64.

**⚠ GPS redaction does NOT come for free on this path — decision 7 moved the read out from under it.**
`redactForNonAdmin` (`uploader/src/media-store.ts:219-221`) nulls `exif.lat`, `exif.lng` and
`uploadedBy`, and it has **exactly one call site**: `serializeMedia` (`server.ts:389`), the HTTP
response serializer, applied only when `req.authUser?.isAdmin` is false.

Revisions 1–2 got redaction by construction, because the sidecar read `GET /media` as a non-admin.
Under decision 7 the app does the reading — in-process via `cfg.media.list()`, or over HTTP under the
**owner's own session**, and the owner is the admin. Both return coordinates in full.

**Therefore, mandatory for slice 4:** the authoring handler MUST pass every media row through
`redactForNonAdmin` **unconditionally**, ignoring the session's role, before any of it reaches a
prompt. This is the only thing standing between the media library and a POST to `api.anthropic.com`,
and `CLAUDE.md` §3 forbids GPS leaving this system. Assert it with a test that seeds a row with
`lat`/`lng` and greps the composed prompt — role-independence is the property, so the test must run
as an **admin**, which is the case that currently fails. Do not restate the old "non-admin, therefore
redacted" argument anywhere: there is no non-admin identity left to carry it.

**Authentication is browser-shaped, and there is no service-account concept.** Verified: `users.ts`
models a user as `{id, username, passwordHash, isAdmin, createdAt}` (`uploader/src/users.ts:34-39`)
with no token, scope, or machine-account field; `sessions.ts` stores only `{id, userId, expiresAt}`
against a hashed token. `authn.ts` has exactly two guards, `requireAuth` and `requireAdmin`
(`uploader/src/authn.ts:48-55`).

**Under revision 3 this is context, not a constraint.** Revision 1 concluded from the above that the
sidecar had to log in as an ordinary non-admin user and carry a session cookie. Decision 7 removes
that requirement entirely — the sidecar authenticates to nothing. The absence of a service-account
concept stops being a problem to work around and becomes a fact with no consequence. The section is
kept because it documents *why* a scoped-token design was never on the table.

## Architecture

```
compose stack (default `up`: app + db only)
────────────────────────────────────────────
  db ──── app  (Fastify: blog + admin + images + in-process astro build)
           │ ▲                    ▲
   prompt  │ │ {title,            └── posts.upsertDraft() — IN-PROCESS, no HTTP
  + context│ │  excerpt,
           │ │  bodyMarkdown}
           ▼ │
       authoring  (profile: `authoring`, no published port)
           │
           ├──► Claude CLI, subscription login   (tier 1 — no API key)
           ├──► api.anthropic.com                (tier 2 — API key)
           └──► host LM Studio / Ollama          (tier 3 — NO egress at all)

  The app never contacts a model.  The sidecar never touches the database.
  Every model arrow starts at the sidecar; every write starts at the app.
```

### The `authoring` service

- **New compose service** in the root `docker-compose.yml`, gated by
  `profiles: ["authoring"]` so `docker compose up -d` continues to bring up exactly `app` + `db`.
  There are no `profiles:` entries in the file today, so this is the first one — say so in the
  comment. The compose file also declares no explicit `networks:`, so the sidecar joins the same
  default project network as `app` and `db` and reaches the app at `http://app:3000`.
- **No published port**, so nothing outside the compose network can reach it **inbound**. That is the
  only thing omitting a port buys — it does not constrain what the sidecar dials out to, as the
  egress bullet below makes plain.
- **Its own image**, built from a new `authoring/` tree in this repo (Dockerfile + prompts +
  a thin entrypoint). It is *not* built from the root `Dockerfile` and shares nothing with the `app`
  image. **How it is produced needs deciding before implementation, and the obvious answer is
  wrong:** adding `build: ./authoring` to compose contradicts `ARCHITECTURE.md:18-20`
  (*"`docker-compose.yml` has no `build:` key, so `docker compose up -d --build` is a no-op"*) and the
  compose header's "Compose only RUNS the published image". The consistent option is a second GHCR
  image built by a tag-triggered job — which means `.github/workflows/release.yml` is touched, and
  this spec's "Repos touched" header must say so. Pin this in the implementation plan.
- **Egress to `api.anthropic.com` only** is the intent. Docker's default bridge does not enforce
  that; treat host-level egress restriction as an operational recommendation in `SECURITY.md`, not
  as a control this design implements. Mark as **unimplemented**, not as a mitigation.
- **⚠ The sidecar CAN reach the app; it simply has no reason and no credential to.** Compose declares
  no `networks:`, so Docker's embedded DNS resolves `app` from the sidecar — `POST /login`
  (rate-limited), `POST /setup` (zero-users guarded) and `/health` are reachable, and it could set
  `X-Forwarded-For` against `trustProxy: true` (`server.ts:102`). Anywhere this spec says the sidecar
  "is never given an address" for the CMS, read it as **holds no credential**, which is the true and
  weaker claim. Closing the gap properly needs a dedicated compose network the sidecar shares with
  nothing — a change this design does not specify. Recorded as accepted residual risk: the sidecar is
  the one process that both ingests untrusted prose and talks to a third party.

### The trigger endpoint (owner decision 1)

One new route on the app: **`POST /authoring/runs`**, `requireAuth` (drafting is author-level work;
publishing stays admin-only and the sidecar cannot publish).

**Asynchronous to the browser, synchronous to the sidecar. Be precise about which "returns
immediately" is meant** — the earlier phrasing left the result with no way home, and an implementer
cannot proceed without this:

```
browser → POST /authoring/runs
            └─ app registers run id, returns 202 IMMEDIATELY to the browser
               and continues the work in a detached async task:
                 app → POST http://authoring:<port>/run   (ONE request)
                       … the app awaits this for minutes …
                 app ← 200 {title, excerpt, bodyMarkdown} on the SAME response
                 app → redactForNonAdmin / shape check / posts.upsertDraft()
                 app → run record ends 'done' or 'failed'
browser → GET /authoring/runs/:id   (polls; the editor opens the draft on 'done')
```

**The sidecar answers on the request it was given and never initiates a connection to the app.** That
is what keeps §Credential scope's claim true and keeps the `trustProxy` concern lapsed. A callback,
a webhook, or a queue the app drains would all reopen it — do not add one.

**The 202 is to the browser only.** `POST /posts/:tk/publish` awaits the full in-process Astro build
before responding (`server.ts:862-880`), and that shape is what makes publish sensitive to proxy
timeouts — `requestTimeout: 120_000` bounds *receiving* a request, not handler duration (`@ai-note`,
`server.ts:95-100`). The detached task avoids that for the browser leg. The app→sidecar leg is a
different matter: it is an internal call not passing the reverse proxy, and it is bounded by
`authoringTimeoutMs` (default 600 000), **not** by a short timeout. The existing encode queue is the
in-repo precedent for fire-and-poll.

**Do not use `safeFetch` for this call.** Two reasons, and the first is not the one you would expect:

1. `assertFetchableUrl` would **not** block it. `isBlockedHost` only rejects *literal* IPs — loopback,
   link-local, ULA IPv6 — and its own `@ai-warning` states it "does NOT resolve DNS, so a hostname
   that resolves to a private address is not caught here" (`uploader/src/safe-fetch.ts:18-24`). A
   compose service name passes the guard. So safeFetch is not a barrier here; it is simply the wrong
   tool.
2. `DEFAULT_TIMEOUT_MS = 15_000` (`safe-fetch.ts:14`). A drafting call runs for minutes, so the one
   protection that would actually apply is the one that would break it, and none of the others (SSRF
   blocklist, 25 MB streamed cap) is relevant to a single POST at a fixed internal hostname.

Use a small dedicated client instead: no user-supplied URL, no redirect following, and
`authoringTimeoutMs` as the deadline.

**Where the hostname may live, exactly** — it is a security boundary, so state it rather than saying
"hardcoded" and "from configuration" in the same breath:

- **Allowed:** a literal default in the app's source (`http://authoring:8080`), overridable by an
  **environment variable on the `app` service** for local development.
- **Forbidden:** the JSON settings store, any admin-UI field, and any part of the request body or
  query string. Any of those turns a narrow internal call into an operator- or caller-controlled SSRF
  primitive, which is exactly what `safeFetch` exists to prevent elsewhere. This is the one config
  value `.env` may grow for this feature, and only because settings-store placement would be worse.

### Settings-driven configuration (owner decisions 2 and 3)

New fields on `Settings` (`uploader/src/settings.ts:7-15`). None is a secret.

| Field | Default | Notes |
|---|---|---|
| `authoringProvider` | `'claude-cli'` | `'claude-cli'` \| `'anthropic-api'` \| `'openai-compatible'` |
| `authoringBaseUrl` | `'http://host.docker.internal:1234/v1'` | Used only when provider is `openai-compatible`. **See the trap below.** |
| `authoringModel` | `'claude-opus-5'` | Free text; meaning depends on provider |
| `authoringTimeoutMs` | `600000` | Drafting runs are long — validate against a much larger ceiling than `captionTimeoutMs`'s 600 000 cap allows for a *caption* |
| `authoringDraftPrompt` | see `authoring/prompts/` | Slice 1 |
| `authoringTranslatePrompt` | see `authoring/prompts/` | Slice 2 |

**⚠ The `localhost` trap — do not reuse `lmBaseUrl`.** The existing `lmBaseUrl` defaults to
`http://localhost:1234/v1` (`settings.ts:26`) and is consumed by **`GET /ai-config` → the browser**,
which runs on the owner's own machine, where LM Studio also runs. `localhost` is correct *there*. The
sidecar is a **container**: `localhost` inside it resolves to the container itself, so reusing
`lmBaseUrl` would fail with a connection error that looks like "LM Studio is down" while LM Studio is
running perfectly. Hence a separate `authoringBaseUrl`.

On Docker Desktop `host.docker.internal` resolves out of the box. **On a Linux host it does not** —
the `authoring` service needs `extra_hosts: ["host.docker.internal:host-gateway"]` in
`docker-compose.yml`, or the host's LAN IP instead. State this in the deploy notes; it is the most
likely first-run failure.

**⚠ Every new field must be registered in FOUR places** — five counting the UI. Miss one and the
failure is silent in a different way each time:

| Place | Miss it and… |
|---|---|
| `defaultSettings()` (`settings.ts:24-34`) | the field is `undefined` until someone saves it |
| `validate()` (`:36-61`) | out-of-range values reach consumers unchecked |
| the merge whitelist in `createSettingsStore()` (`:69-76`) | it is read from disk, **discarded**, and re-defaulted on every restart, with no error |
| **the per-key whitelist in `POST /settings` (`server.ts:595-601`)** | **the admin UI cannot write it at all** — the page posts it and the server silently drops it |
| `uploader/public/settings.html` | there is no control to set it |

The store-side whitelist is opt-in by design — *"Pick known keys only, so truly unknown fields in an
older settings.json are dropped"* — and `POST /settings` mirrors that shape independently.

**§Testing's settings round-trip does not cover the fourth.** A test that writes through the *store*
and reloads exercises three of the four; the route's whitelist sits above it and stays untested. Drive
the round-trip through `POST /settings` → reload → `GET /settings` instead, or add a second case that
does.

**⚠ A load-time validation failure reverts the entire store to defaults, silently** (`settings.ts:
80-84`: `catch { current = {...defaults} }`). Adding six fields adds six new ways to trip a fallback
that also wipes the LM alt-text config and the backup schedule. Keep every new validator permissive
(non-empty string, parseable URL, integer in a wide range) and never make a new field required in a
way an older `settings.json` could fail.

**Read scope.** `GET /ai-config` is `requireAuth` and deliberately serves the browser's LM config to
any signed-in author (`server.ts:610-622`). The authoring fields hold no secret, so exposing them
there is defensible — but they are not needed by the browser, so **keep them off `/ai-config`** and
read them admin-side via `GET /settings`. Smaller surface, no argument to have later.

**Consequence for the editor button, which needs deciding:** drafting is author-level
(`POST /authoring/runs` is `requireAuth`), but `GET /settings` is `requireAdmin` (`server.ts:588`),
so a non-admin author's browser cannot see whether authoring is configured at all. Do **not** solve
this by moving the fields onto `/ai-config` — that widens the read surface for a cosmetic gain.
Render the button unconditionally for any signed-in author and let the run fail with the
"sidecar unreachable" message §Failure modes already specifies. One narrow addition is acceptable if
that proves too blunt: a boolean `authoringEnabled` on `/ai-config`, carrying no configuration values.

### Provider abstraction (owner decision 3)

Three tiers behind one interface, in the owner's stated order of preference (decision 5):

| Tier | `authoringProvider` | Auth | Cost model | Egress |
|---|---|---|---|---|
| **1 (primary)** | `claude-cli` | **Subscription login**, profile on disk | Subscription — no per-token billing | `api.anthropic.com` |
| 2 (fallback) | `anthropic-api` | `ANTHROPIC_API_KEY` from `authoring/.env` | Per-token | `api.anthropic.com` |
| 3 (offline) | `openai-compatible` | usually none | Free | **none** |

**⚠ Tier 1 needs a writable `HOME` on a persisted volume — this is its defining constraint.** A
subscription login writes a credential profile to disk. Without a persisted writable `HOME`, the CLI
must be re-authenticated on **every container restart**, which turns a background feature into a
chore. Mount a named volume at the sidecar's `HOME` and treat it as credential-bearing: it is not
`/data`, it must not be captured by `backup.ts`, and it must not be world-readable.

> This is exactly the property that rules the CLI out of the `app` container. §Why not inside the
> `app` container argues the DHI runtime has no shell, no package manager, and no writable `HOME` for
> credentials — tier 1 needs all three. The two sections agree; the sidecar exists so that the `app`
> image never has to grow them.

**Tier ordering is a settings choice, not a fallback chain.** The sidecar does **not** silently
retry a failed tier against the next one — a tier-1 auth failure must surface as a tier-1 auth
failure, not quietly become an API charge. "Priority" here means the order in which the owner should
prefer to configure them, and the order the settings UI should present.

The existing `lmBaseUrl` default already ends in `/v1` (`settings.ts:26`), so the tier-3
OpenAI-compatible shape is the one this codebase has been talking to since the alt-text feature
shipped. A second consumer of a familiar contract, not a new integration style.

**This is the feature's most valuable property and should not be traded away later:** with
`openai-compatible` selected, AI post authoring runs with zero third-party egress and zero cost,
exactly like the existing browser-direct alt-text path. Quality will be lower than Opus 5; that is
the owner's tradeoff to make per run, not the spec's to make once.

### Why not inside the `app` container

The default runtime base is `dhi.io/node:26` — minimal, non-root, no shell, no package manager
(`Dockerfile:17-18` for the ARGs, `:6-16` for the rationale, `:121` for `USER 1000`;
`ARCHITECTURE.md:337` and `:385-386`; `SECURITY.md:259-260`). This is already why `docker compose
exec` must invoke `node` directly (`uploader/src/cli.ts:22-25`). Running a CLI there would mean
adding a shell and a package manager to the runtime and giving it a writable `HOME` for credentials —
undoing the single property that made merging the builder into the CMS defensible.

> **Correction to issue #67:** its citations for this point (`ARCHITECTURE.md:281`,
> `SECURITY.md:187`) are stale — those lines now discuss image archives and the XSS sanitizer. The
> current citations are the ones above.
>
> **Caveat, also from #67 and confirmed:** the documented no-subscription fallback
> (`Dockerfile:11-13`, `--build-arg NODE_RUNTIME=node:26-slim`) **does** ship a shell and a package
> manager. "No shell" is a property of the *default* build, not of every supported build. Designing
> around the fallback would be wrong; asserting it as absolute would also be wrong.

### Why not a credential in the settings store

`GET /settings` is `reply.send(cfg.settings.get())` with no filtering (`uploader/src/server.ts:
587-589`), and the store has no redaction concept anywhere: `Settings` is a flat interface
(`uploader/src/settings.ts:7-15`), `get()` returns a shallow copy of the whole object (`:87`), and
`update()` writes the whole object as plaintext JSON via atomic rename (`:88-97`) to
`/data/settings.json` (`uploader/src/main.ts:24-26`).

**Get the severity right.** The audience for `GET /settings` is an already-authenticated admin who
can also pull a full database dump via `GET /backups/:name` (`server.ts:1082`), so "leaked to the
browser" overstates it. The real argument is **secret-at-rest**: a first secret on the `/data` bind
mount, in a store that has never had to protect one, would mean inventing write-only semantics and
redaction from scratch. The sidecar sidesteps that rather than solving it.

## Credential scope and handling

**The sidecar authenticates to nothing on this stack.** It holds model credentials and no others.

- **CMS credential: none.** Decision 7 removed it. No account is provisioned, no password is stored,
  no session is created. It can *reach* the app over the compose network (see the ⚠ under §The
  `authoring` service) but has nothing to authenticate with, so every mutating route answers 401.
- **Model credential, tier 1 (primary):** a subscription login profile on the sidecar's own named
  volume. Never on `/data`, never in the settings store, never in `authoring/.env`.
- **Model credential, tier 2:** `ANTHROPIC_API_KEY` in `authoring/.env`. Never written to `/data`,
  never written to the settings store, never logged.
- **Model credential, tier 3:** usually none.

**Explicit non-goal: neither credential may land in `/data/backup`.** This is preserved by default
today — `backup.ts` dumps `users`, `posts`, `pages`, `media`, `media_folders`
(`uploader/src/backup.ts:59-73`) and tars files under `/data/images` (`:80-119`); `settings.json` is
not covered by either. Keep it that way, and state it in `SECURITY.md` so a future "back up settings
too" change has to confront it deliberately.

**What the app's own session can reach on the sidecar's behalf, and why that is accepted.** Revision 3
left no CMS identity to scope, so this is no longer a question about the sidecar's rights — it is a
question about which endpoints the *authoring handler*, running inside the app under the owner's own
session, must be kept away from. It calls exactly one thing: `posts.upsertDraft`.

- `POST /import` (`server.ts:1102`) is session-level. It parses an uploaded WXR file and re-hosts its
  remote images through `safeFetch` (SSRF guard, timeout, streamed size cap). Under revision 1 a
  compromised sidecar could have driven those fetches; it now has no way to call anything. Left on
  record because the `safeFetch` guard is what makes session-level acceptable for it at all, and
  because tightening `/import` to admin-only would be a behavioural change to the human importer
  workflow that this design does not justify on its own.
- `POST /export` (`server.ts:1095`) writes MDX backups into `/data/backup`. Bounded, idempotent,
  non-destructive. Not on the authoring path.
- `POST /upload`, `POST /media/move`, `POST /media/folders`, `POST /media/retry` are session-level by
  the **reversibility** rule documented in `SECURITY.md:50-63`. A move never changes an image URL, so
  no move can break a published post.

**What the authoring path must never reach**, and what §Testing's first test asserts: publish /
unpublish / delete (`server.ts:859`, `:972`, `:995`), bulk actions (`:912`), `POST /rebuild`
(`:1036`), settings writes (`:592`), user creation (`:679`), irreversible media deletion (`:567`),
and `GET /backups/:name` — **a downloadable full database dump** (`:1082`). Revision 1 kept the AI
away from these with a credential that lacked the role; revision 3 keeps it away with a handler that
does not call them, which is cheaper but easier to erode. Hence the test.

**`trustProxy` note — a risk revisions 1–2 had and revision 3 does not.** Fastify is constructed with
`trustProxy: true` (`uploader/src/server.ts:102`, `@ai-warning` at `:91-94`), so it reads
`X-Forwarded-For` from any caller. A sidecar that called the app would have been the first non-browser
client on that network and could have chosen its own rate-limit bucket. **Decision 7 reverses the
direction of the connection**, so no new client appears and the concern lapses. Recorded because the
reversal is the reason, and a future change that has the sidecar call back into the app revives it.

## The four slices

Each is separable and independently shippable. Slices 1–3 need no server capability that does not
already exist; slice 4 needs `GET /media`, which shipped with #64.

**Read every "flow" below as in-process.** They are written in HTTP terms — `GET /posts/:tk`,
`PUT /posts/:tk`, `POST /posts` — because that is the vocabulary for *what* each slice reads and
writes, and those contracts are unchanged. Under decision 7 nobody makes those requests: the
authoring handler calls `posts.get()` / `posts.upsertDraft()` directly. Two consequences apply to
every slice and are not repeated in each:

- **`validateDraft` is yours to call** (see §Division of labour's ⚠). The routes call it; the store
  does not.
- **`PostError` codes are thrown, not returned as HTTP status.** Where a slice says "a 409 with
  `code: 'conflict'`", in-process that is a `PostError` with `code === 'conflict'`; `server.ts:832`
  is where the *route* maps it to 409. The authoring handler does its own mapping onto the run
  record's status, and the editor sees that — not a 409.

### Slice 1 — Draft from rough notes (DE)

The owner pastes rough notes; the agent produces a German draft.

**Flow:** owner pastes notes in the editor → `POST /authoring/runs` → app prompts the sidecar →
sidecar returns `{title, excerpt, bodyMarkdown}` → app composes
`{translationKey:'', status:'draft', shared:{…}, de:{…}, en:{…}}` and makes **one**
`upsertDraft` call → editor polls, then opens the new draft.

**Acceptance criteria**

- Produces `de.title`, `de.excerpt`, `de.bodyMarkdown`. `en` is left as empty strings.
- `de.slug` and `en.slug` are `''` (empty) — `validateDraft` only format-checks a slug when one is
  present (`posts.ts:150`), so an empty slug is valid for a draft and forces the human to choose.
- `heroImage` and `images` are omitted; `draftWithDefaults` fills them (`posts.ts:280-281`).
- `shared` carries only what the notes actually state; `coordinates` defaults to `{lat:0,lng:0}`
  (`posts.ts:290`). The agent never invents coordinates, `countryCode`, or `date`.
- Exactly **one** write, producing **zero** revisions: the snapshot is guarded by `if (existing)`
  (`posts.ts:342`, `:536`), and a create has no pre-save state. Verified by `GET /posts/:tk/revisions`
  returning an empty list. (§Testing's "exactly one new revision" applies to slices 2–3, which
  overwrite an existing pair — not here.)
- The post is `status: 'draft'` and does not appear on the public site until a human publishes.
- Body Markdown contains no `<BodyImage>` tags and no ```` ```gallery ```` fences — the agent has no
  image to reference yet, and both are normalized at the store chokepoint
  (`posts.ts:271-294`) where a malformed `images` map is rejected.

### Slice 2 — Translate DE → EN

**Flow:** `GET /posts/:tk` → fill the `en` locale in memory, carrying `updatedAt` forward → **one**
`PUT /posts/:tk` including `updatedAt`.

**Acceptance criteria**

- Writes `en.title`, `en.excerpt`, `en.bodyMarkdown`. **Leaves `en.slug` exactly as fetched** —
  including empty. Golden Rule 2 makes a published slug an SEO contract, and `upsertDraft` throws
  `slug_locked` (409) if a published post's slug changes (`posts.ts:338-340`).
- Every other field of the fetched `PostPair` is echoed back byte-identically. Because `upsert`
  overwrites the whole pair (`server.ts:819`), an omitted `shared.stops` or `de.images` entry is
  data loss, not a no-op.
- `updatedAt` is echoed. A 409 with `code: 'conflict'` (`server.ts:832`) aborts the run with a
  message telling the owner to close their editor tab and re-run — the agent does **not** re-fetch
  and retry, because retrying would clobber the edit that caused the conflict.
- Translation is written natively in German→English, not machine-transliterated — the same standard
  the alt-text feature already applies (`2026-07-05` spec, "AI output").
- Exactly one revision is added (`REVISION_CAP` accounting below).

### Slice 3 — Polish / expand an existing draft

Same shape as slice 2, different prompt: the agent rewrites or extends one locale's
`title`/`excerpt`/`bodyMarkdown`.

**Acceptance criteria**

- All of slice 2's field-preservation and `updatedAt` criteria.
- **Never touches** `slug`, `status`, `heroImage`, `images`, or `shared` — the human and the upload
  pipeline own those. `images` in particular is validated at the store chokepoint
  (`posts.ts:276`, `imagesMapError`) precisely because the WXR importer bypasses `validateDraft`; the
  agent has no business writing it.
- **Every image the body referenced before the rewrite still appears in it afterwards, enforced by an
  explicit check.** This is the likeliest real data loss in the whole design and nothing else catches
  it: `bodyMarkdown` is the field the model is *supposed* to rewrite, so §Prompt injection's
  writable-field diff cannot see inside it, and `normalizeBodyImages` merges into the incoming map
  without pruning (`posts.ts:223-255`) — so a dropped `![alt](src)` line leaves the `images` entry
  behind and the photo simply **vanishes from the post** while every other check stays green. The
  guard is cheap: collect the multiset of `src`s from `![…](…)`, `<BodyImage>` tags and ```` ```gallery ````
  lines before and after, and abort the run on any loss. A gained src is also suspect — the model has
  no business inventing image URLs — so treat the comparison as equality, not containment.
- Refuses to run against a post whose `status` is `'published'` **unless** the owner passes an
  explicit flag: editing a published post's working copy is legal (the published snapshot is
  preserved — `posts.ts:355-357`) but it silently creates unpublished changes the owner may not
  expect.

### Slice 4 — Draft from the photos in a trip folder

**No longer blocked.** `GET /media` is session-level with non-admin redaction
(`server.ts:400`, `:389`; `media-store.ts:219-221`).

**Flow:** `GET /media?folder=<path>&recursive=1` → read each item's `title`, `alt`/`caption`, `tags`,
and non-GPS EXIF (camera, lens, capture date) → compose a draft → **one** `POST /posts`.

**Acceptance criteria**

- **Every row passes through `redactForNonAdmin` before it reaches the prompt, regardless of the
  session's role** — see the ⚠ above. `exif.lat`/`exif.lng`/`uploadedBy` reach the model only if this
  is forgotten, and the run executes as the admin owner, so nothing else nulls them. The model is
  never asked to infer or request coordinates either, but that is a prompt convention; the redaction
  call is the control.
- Paginates properly: `GET /media` defaults to 50 per page (`media-store.ts:114`) and returns
  `{total, items}` (`server.ts:421-427`). A folder with more than one page must not be silently
  truncated.
- Skips items whose `status` is not `ready`. Referencing a still-encoding photo would later block
  publish at the `notReadyPhotos` gate (`server.ts:867-873`).
- **Does not embed image URLs in the body** in this slice. Body-image and gallery markup carries its
  own post-sanitize security contract (origin-equality allow-listing, `SECURITY.md:191-200`) and the
  `images` dimension map comes from the upload pipeline, not from a model. The agent writes prose
  that *describes* the trip; the human inserts photos in the editor. Revisit only with a separate
  spec.

## Concurrency contract

Three rules, all mandatory. **Revision 3 moves enforcement from the sidecar into the app**, where
they are ordinary code in one handler instead of rules a separate process had to be trusted to
follow. The rules and their reasons are unchanged; only the enforcer is.

**1. One write per run.** Every `upsertDraft` over an existing pair snapshots the pre-save state into
the revision ring, capped at `REVISION_CAP = 20` per translation key with the oldest pruned
(`uploader/src/posts.ts:42`; memory store `:342-351`, pg store `:538-549`). An agent that saved
iteratively would **evict the owner's entire human revision history in 20 writes**. One write per run
costs exactly one revision slot — the same as a human pressing Save — and needs no schema change.

> Issue #67 cites `posts.ts:35` for `REVISION_CAP`; it is now line 42. The value and the semantics
> are unchanged.

**2. Echo `updatedAt` on every write to an existing post.** The optimistic-concurrency check is
**opt-in**: `upsert` reads `updatedAt` off the body and only builds `baseUpdatedAt` when it is
present (`uploader/src/server.ts:818-824`); `assertNotStale` returns immediately when
`baseUpdatedAt` is `undefined` (`uploader/src/posts.ts:117-121`). Omitting it does not fail loudly —
it **overwrites whatever the owner has open in a browser tab**, and the *owner's* next Save then 409s,
telling them **they** are stale. This is a spec requirement, not an implementation detail.

**3. On `conflict`, stop.** In-process this is a `PostError` with `code === 'conflict'`, not an HTTP
409 — `server.ts:832` is where the *route* maps the code to a status, and the authoring path does not
go through the route (§The four slices). It means a human wrote while the model was thinking: the run
aborts and reports; it never re-fetches and re-applies, because doing so would discard the human edit
that produced the conflict. `duplicate_slug` and `slug_locked` arrive the same way and should be
unreachable if slices 2–4 honour "never touch the slug"; treat them as bugs in the handler, not as
retryable conditions. **A vanished post throws nothing at all** — see §Failure modes.

**What the build layer already handles.** No coordination is needed on the build side:
`createSiteBuilder` coalesces concurrent builds one-deep (`uploader/src/build.ts:88-127`),
`astro build` is a spawned child process rather than in-process work (`:31-40`), and the shared work
lock makes a build preempt the encode backlog at the next job boundary
(`uploader/src/work-lock.ts:12-20`). The sidecar never triggers a build anyway — it cannot publish
and cannot call `POST /rebuild`.

## Prompt injection

**The reading agent will consume attacker-influenced text.** The WXR importer creates drafts directly
from imported WordPress HTML converted to Markdown (`uploader/src/wp-import.ts:82` calls
`upsertDraft`; `wp-content.ts:8` is the turndown conversion), and media metadata is author-supplied
free text. Slices 2, 3, and 4 all feed that text back to a model.

**`rehype-sanitize` does not help here.** It runs at *render* time in `site/src/lib/body-images.ts`
(`SECURITY.md:177-188`) and stops injected HTML reaching the published page. It does nothing about
imported prose steering the model when that prose is handed back as context. Different layer,
separate answer.

**Revision 3 changes the severity, not the existence, of this risk.** Under revision 1 the worry was
concrete and serious: injected prose steering a client that held CMS write credentials. Under
decision 7 the model's client **cannot write anything** — it returns a string to the app, and the app
decides what reaches the database. What remains is an output-quality problem: injected text can make
the draft say something the owner did not intend.

That residual risk is bounded by three things already true:

1. **Every result is a draft.** Publishing stays a human admin action in the browser, so a poisoned
   draft cannot reach the public site without someone reading it first.
2. **The app validates the shape before writing** — one guard, specified once below.
3. **`imagesMapError` still guards the store chokepoint** (`posts.ts:276`) for anything that does
   reach `upsertDraft`, exactly as it does for the WXR importer today.

### The pre-write guard, specified once

Earlier drafts described this three different ways — a narrow response contract, a diff against the
fetched pair, and a rejection test — which read as three guards and are not. **It is two steps, both
in the app, and neither is optional:**

**Step 1 — parse the sidecar response into exactly `{title, excerpt, bodyMarkdown}`, all strings.**
Construct a fresh object with those three keys; never spread the response. Any other key is *dropped
without error*, which is why §Testing can table-drive a response carrying `slug`/`status`/`images`/
`heroImage`/`shared` and assert none of it survives: the contract forbids sending them, and the parse
is what makes the contract true rather than aspirational. **Do not let this erode** — the moment the
response grows a structural field, this reverts to a write-capability problem with extra steps.

**Step 2 — compose the pair the app will write, then diff it against the pair the app fetched**, and
abort if anything outside the slice's declared writable fields differs (slug, status, `images`,
`heroImage`, `shared`, and the locale the slice does not own). Step 1 already makes step 2 hard to
fail, and that is the point: step 2 catches a bug in the app's own composition logic, not just a
misbehaving sidecar. **For slice 1 there is no fetched pair**, so step 2 degrades to asserting the
composed pair's non-writable fields equal `draftWithDefaults`' output — the same check against a
different baseline, not a skipped check.

Both steps run in the app. A guard the untrusted-text-handling process runs on itself is not a guard.

**The answer this design gives is capability, not filtering:**

1. **The model's client can write nothing at all.** Successful injection can make the sidecar return
   bad prose. It cannot publish, cannot delete a post, cannot create a user, cannot pull a database
   dump, cannot change settings, and cannot trigger a rebuild — not because a credential lacks the
   role, but because the sidecar has no CMS credential, no session, and no database. This is what
   decision 7 bought, and it is the point issue #67's framing (a client holding CMS credentials) was
   written before.
2. **A human publishes.** Every AI-written word passes a human admin before it is public.
3. **Untrusted content is fenced in the prompt.** Post bodies and media metadata are passed inside an
   explicit delimiter with a standing instruction that content within it is data to be worked on,
   never instructions to be followed. This reduces but does not eliminate the risk; state it as
   mitigation, not as a solved problem.
4. **The pre-write guard above.** An injection that talks the model into rewriting a slug dies at
   step 1 (the field never survives parsing) and again at step 2 (the diff), rather than relying on
   the store's `slug_locked` `PostError` as the only backstop. Note what it cannot do: the guard sees
   `bodyMarkdown` as one opaque writable field, so injected *prose* passes it by design — that is
   what item 1's capability argument and item 2's human review are for. Slice 3's image-preservation
   check is the one content-level check, and it exists because losing a photo is not an opinion.

**Residual risk, accepted and recorded:** a successful injection can produce plausible-looking German
or English prose that a hurried reviewer publishes. Nothing in this design prevents that; the human
review step is the control.

## Failure modes

There are **no cost, budget, quota, or metering primitives anywhere in the codebase** — confirmed,
`uploader/src/rate-limit.ts` covers auth endpoints only. This design does not add any. What it does
instead is make every failure a *local, visible, non-destructive* failure of one run.

| Failure | Behaviour |
| :-- | :-- |
| Anthropic API unreachable / 5xx | Run exits non-zero with the error. Nothing was written — the single write happens last. |
| Anthropic API slow | The run takes longer. Nothing in the app is blocked: no session is held open server-side beyond the cookie, no build is queued, no lock is held. |
| Rate-limited / quota exhausted / over budget | Same as unreachable: the run fails, nothing is written. **There is no budget check** — the ceiling is whatever the Anthropic account enforces. Accepted for a single-author blog; revisit only if a runaway loop actually happens. |
| Model returns unusable output | The shape check (prompt-injection item 4) rejects it; the run exits non-zero without writing. |
| `db` down | The app's own read fails before the sidecar is ever called. Nothing is written; the button reports the error. |
| Sidecar unreachable | The trigger call fails fast at the app. Nothing is written. This is the one failure the *owner* sees immediately, so its message must name the `authoring` service and the `profiles:` gate — "is it running?" is the first thing to check. |
| 409 `conflict` on the final write | The app aborts with "someone edited this while I was working — reload the editor and re-run". No retry: re-applying would discard the human edit that caused the conflict. |
| **The post is deleted while the run is in flight** | **Must be handled explicitly; the concurrency contract does not cover it.** `assertNotStale` is guarded by `if (existing)` in both stores (`posts.ts:339` memory, `:530` pg), so when the row is gone the staleness check *silently passes* and `upsertDraft` happily **recreates the deleted post** — carrying its old slugs, which may then throw `duplicate_slug` if a human reused one. Neither outcome is acceptable: the owner deleted it. The handler MUST re-read the pair immediately before writing and abort the run if it has vanished. Reachable via `DELETE /posts/:tk` (`server.ts:995`) or a bulk action (`:912`) during the minutes the model is thinking. |
| Model auth failure | Tier 1: the subscription login profile expired or the volume was lost — re-authenticate the CLI. Tier 2: bad `ANTHROPIC_API_KEY`. **Must surface as a tier-specific auth error and must NOT silently fall through to another tier** (§Provider abstraction). |
| Sidecar crashes mid-run | Nothing was written; the app's poll for that run reports failure. The **run** must not be retried — a silently re-run draft spends tokens nobody asked for — but the **service** is long-lived under decision 1, so `restart: unless-stopped` is correct and a crash-once-stay-dead policy would leave the editor button permanently broken. The two are separable precisely because run state lives in the app (§Run state), not in the sidecar: a restarted sidecar comes back with nothing to resume. |
| Partial write (server crash between the two locale INSERTs) | Pre-existing hazard, unchanged: `upsertDraft` writes `de` and `en` as two non-transactional INSERTs, and `pgPostStore.get()` returns `null` for a stranded single-locale key (`posts.ts:95-101`). Media usage scans already work around it via `usageRows()`. The sidecar surfaces the resulting 404 rather than papering over it. |

**Observability stays as-is.** Plain text to stdout, captured by Docker (`CLAUDE.md`, Observability).
The app logs the run's start, the translation key it touched, and the outcome. The sidecar logs the
model call and its outcome, and **never logs the model credential or the prompt body** — imported
post text passes through it, and that text is exactly what §Prompt injection says not to trust.
Neither process can log GPS coordinates **provided slice 4's mandatory `redactForNonAdmin` call is in
place** — it is what keeps coordinates out of the prompt, and therefore out of the sidecar, which
otherwise sees whatever the app sends it. Do not treat this as automatic: it is a call someone has to
make, on a path whose session is the admin's.

## Documented commitments this amends

These edits ship **in the same change** as the implementation. Without them, a future session reads
the repo's own rules as contradicting the deployed stack.

### `PRODUCT.md`

- **Principle 4 — "Self-hosted independence"** (`PRODUCT.md:54`), verbatim today:

  > *"4. **Self-hosted independence** — The stack is two containers, `app` (Fastify, which also
  > builds the Astro site in-process) and `db` (Postgres), with no third-party runtime services."*

  The commitment being amended is **independence**, not a container count. A paid hosted API with
  per-request cost and outbound internet is exactly what the principle exists to exclude. The
  amendment must name the principle and preserve the distinction: the *serving* stack stays two
  containers with no third-party runtime service; an **optional, profile-gated authoring sidecar**
  depends on a hosted API and is not part of serving the blog.

- **Capabilities and Constraints — Auth** (`PRODUCT.md:31`), verbatim today:

  > *"**Auth:** Cookie-based sessions with admin/non-admin roles; rate-limited login."*

  **Needs no amendment under revision 3.** Revisions 1–2 would have made it describe a machine
  identity as well as a human one; decision 7 removed the machine identity, so every session on this
  stack still belongs to a person. Listed here only so the next reader can see the question was asked
  and answered, not skipped.

- **Principle 1 — "Author-first workflow"** (`PRODUCT.md:51`) says *"no multi-tenant complexity"*.
  **Also untouched** — see open question 5. The deployment still has exactly one identity.

### `CLAUDE.md` § 4 AI/LLM Security (`CLAUDE.md:302-304`)

Verbatim today:

> *"- The **only** AI feature is browser-direct alt-text suggestion against a local LM Studio vision
> model. The server never contacts the model. **Keep it that way** — do not proxy the model through
> the server or through `safeFetch`; doing so would create a new outbound-fetch surface."*

**This splits into two clauses with different fates, and the edit must state both:**

1. **The server-scoped rule is PRESERVED, non-cosmetically.** Fastify still never contacts a model.
   `safeFetch` is untouched. The sidecar's traffic to the app is **inbound**, not proxied outbound.
   The two things the rule exists to prevent — a server-side SSRF surface and a model credential
   inside the app process — are both genuinely avoided. Restate it in server-scoped terms and keep
   it as a standing instruction.
2. **"no new outbound-fetch surface" is AMENDED at the stack level.** A compose service with egress
   to `api.anthropic.com` is precisely a new outbound surface. It is not in the `app` process, but it
   is in the stack, and the sentence as written no longer holds. Say so plainly.

The section also needs: drafting is drafts-only and the sidecar writes nothing; imported WordPress
text is untrusted model input; and the existing "treat model output as untrusted" clause now covers
post bodies, not just alt text.

**`CLAUDE.md` — four more statements this falsifies.** `:302-304` is the one everybody thinks of, but
it is not the only place the repo asserts the current shape, and a future session reads the Project
Overview first:

- `:34` — *"**Enabled profiles:** … AI (one narrow feature)."* Two features now.
- `:62-64` — *"The blog has **one** small AI feature: editor-integrated alt-text suggestions … (the
  server never contacts the model; **no new server SSRF surface**)."* Same claim as `:302`, stated
  earlier and read sooner. The parenthetical stays true of the `app` process and false of the stack.
- `:506` — the repo-structure comment *"`docker-compose.yml` # app + db (WordPress-style, two
  services)"*. Three, one profile-gated.
- `:601` — the status list records #67 as *"Not started, deliberately"*.

**`ARCHITECTURE.md:30`** describes `settings.json` as *"admin-configurable settings (backup
schedule/retention)"* — it gains the LM and authoring fields.

### `SECURITY.md`

Add a section for the new service covering **network position** (compose-internal, no published
port, profile-gated out of the default `up`), **credential handling** (model credentials only — a
subscription login profile on the sidecar's own volume, or `ANTHROPIC_API_KEY` in `authoring/.env`;
no CMS credential exists; nothing on `/data`, nothing in `/data/backup` — and the `backup.ts`
behaviour that currently guarantees it), and **authorization scope** (the authoring handler calls
`upsertDraft` and nothing else; publish/rebuild/settings/users/backups/media-delete are not on its
path, asserted by the test named first in §Testing). Record that no spend metering exists anywhere in
this repo and that the concurrency cap is the only bound on run frequency. Also record the accepted
residual risk that `POST /import`'s `safeFetch` surface is reachable at session level — pre-existing,
and no longer reachable by a machine identity now that there is none.

> **`trustProxy` — the risk shrinks but does not vanish.** Revisions 1–2 had the sidecar calling the
> app as a routine matter, making it the first non-browser client on the internal network, free to
> choose its own `X-Forwarded-For` rate-limit bucket (`server.ts:102`, `@ai-warning` at `:91-94`).
> Decision 7 reverses the intended direction, so nothing on the authoring path is such a client. But
> reachability is a property of the network, not of intent, and compose puts the sidecar on the same
> default network (see §The `authoring` service): a *compromised* sidecar can still dial `app:3000`
> and pick its bucket. Record it as accepted residual risk with a reduced likelihood, not as retired.

### `ARCHITECTURE.md`

Add the optional third service to the topology table and note that it is absent from the default
`up`, has no published port, and is not built from the root `Dockerfile`.

### `docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md:10-12`

Its companion-spec note says this work *"introduces the project's first server-side model call."*
That is no longer the design. Correct it to point at this spec and say the opposite: the sidecar
introduces **no** server-side model call.

## Testing

> **Rewritten for revision 3.** The previous version assumed the sidecar was a CMS client and
> concluded there was "no new `uploader/` behaviour to test". Decision 7 inverted that: the app now
> owns the write path, so nearly all the testable behaviour is in `uploader/`, and the sidecar is
> reduced to a stub-able text service.

**The load-bearing test — write it first.** Assert that a run leaves the post's stored `status`
unchanged and adds no published output: seed a published post, run the authoring path, and assert
`status` and the published snapshot are byte-identical afterwards. Also assert the handler never
calls `publish`, `unpublish` or `rebuild`.

**Be honest about what that buys.** Under revision 3 drafts-only is a code invariant rather than a
credential scope (§Division of labour), and a *negative* assertion over a code path can only cover the
inputs someone thought to write. This test is a **canary, not a guarantee** — it catches the erosion
people actually commit (a handler quietly gaining a publish call) and cannot catch a path nobody
tested. That is why the stored-`status` assertion comes first: it checks real state rather than a
spy, so it fails for reasons the author did not anticipate. A credential could not be edited
carelessly; this can, and the test is the cheapest thing standing in for it.

**`uploader/test/` — the new surface:**

- `POST /authoring/runs` requires a session (401 unauthenticated) and does **not** require admin —
  drafting is author-level.
- It returns `202` **to the browser** before the sidecar call resolves, while the detached task keeps
  running (§The trigger endpoint). Assert both halves: the early 202, and that the write still lands.
- The rate limit and the concurrency cap both reject: `N+1` concurrent runs is refused rather than
  queued, and the fixed window refuses a burst. This is the only bound on spend (§Run state).
- **Media redaction is role-independent.** Seed a media row with `exif.lat`/`lng`, run slice 4 **as an
  admin**, and assert no coordinate appears in the composed prompt. Running it as a non-admin proves
  nothing — `serializeMedia` would redact anyway, and the admin case is the one that ships.
- **Images survive a slice-3 rewrite.** Stub a model response that drops one `![alt](src)` line and
  assert the run aborts rather than writing.
- The pre-write guard: step 1 drops unknown keys, step 2's diff aborts on a changed non-writable
  field. Table-drive a response carrying `slug`, `status`, `images`, `heroImage`, `shared`
  (§The pre-write guard).
- `validateDraft` is called on the in-process path. Assert a pair with a blank German title is
  rejected — it would otherwise sail past, since the store does not check it.
- Deleting the post mid-run aborts the write rather than recreating it (§Failure modes).
- Exactly one `upsertDraft` per run. **One new revision for slices 2–3; zero for slice 1**, where no
  pre-save state existed. Assert against `GET /posts/:tk/revisions`, not a spy, so the `REVISION_CAP`
  accounting is real.
- `updatedAt` is echoed on every write to an existing post, and a stale value aborts the run with
  `PostError.code === 'conflict'` and no retry.
- Settings round-trip **through `POST /settings`**, not through the store: write each new `authoring*`
  field over HTTP, reload, and read it back. A store-only round-trip misses the route's own per-key
  whitelist, which is the fourth of the four registration places (§Settings-driven configuration) and
  the one whose failure mode is "the admin UI cannot save this field at all".

**Sidecar unit tests** — provider selection resolves to the configured tier and **does not fall
through** to another tier on an auth failure (§Provider abstraction); the response shape is exactly
`{title, excerpt, bodyMarkdown}`.

**Integration** — one test per slice against a throwaway Postgres plus the app, model call stubbed.
Assert the post ends `status: 'draft'`.

**Not worth testing:** the model's output quality. Stub the model everywhere; a test that asserts on
generated prose is a flake generator.

- `npx tsc --noEmit` and `npm test` in `uploader/`; `npx astro check` and `npm test` in `site/` are
  unaffected but must stay green (Golden Rule 1, Automated Verification Loop).

## Run state and durability

**Gap identified in review, decided here.** §The trigger endpoint specifies `202` + a run id with the
editor polling, and cites the encode queue as precedent — but the encode queue persists state on the
`media` row (`status = 'processing'`, re-seeded by `encodeQueue.recover()`), and this design named no
equivalent.

**Decision: run state lives in memory, bounded, and is not reconstructible — deliberately.**

CLAUDE.md requires in-memory state to be reconstructible *because* losing the encode queue strands a
`processing` row with no worker. **No such hazard exists here:** the write happens last, so a run
lost to a restart leaves nothing behind — no partial post, no stranded status, no orphaned row. There
is nothing to reconstruct because there is nothing to repair.

Requirements this places on the implementation:

- **Bound the map.** Cap concurrent runs and evict completed entries on a timer, or a long-lived
  `app` accumulates run records forever. This is the only real leak risk in the design.
- **Cap concurrency AND rate — they are different controls and only one of them is a spend bound.**
  A concurrency cap bounds simultaneity, so at cap 1 a stuck editor tab that re-fires on every
  completion still produces unbounded *sequential* runs, billing all afternoon at exactly the rate
  the cap permits. `POST /authoring/runs` is `requireAuth`, costs tokens per call, has an
  `authoringTimeoutMs` of 600 000, and decision 6 puts no spend cap in this repo — so this endpoint
  needs both: a small concurrency cap (1–2, rejecting rather than queueing) **and** a fixed-window
  rate limit. The repo already has the primitive: `fixedWindowLimiter` (`uploader/src/rate-limit.ts:19`).
  Non-Goals correctly notes it is auth-only today; extending it to one more route is a few lines and
  is the difference between a bounded and an unbounded bill.
- **A poll for an unknown run id returns "failed", not 404.** After a restart the editor must get a
  definite answer it can show the owner, not an ambiguity it has to guess about.
- **A run is polled by the session that started it.** Record the owning user id on the run record;
  a poll from a different user gets the same "failed" answer as an unknown id, so the endpoint never
  reveals that someone else's run exists. Note the ordering this implies: unknown ⇒ failed, and after
  a restart *every* id is unknown, so the ownership check only ever fires within one process
  lifetime. With one author that is bookkeeping — but it costs a line and it is the difference
  between "not a control" and "not implemented" if a second account ever exists.

- **Say so in `ARCHITECTURE.md`** next to the encode-queue description, so the asymmetry reads as a
  decision rather than an oversight.

If a future change makes a run write *before* it finishes — streaming partial drafts, say — this
decision is void and run state must move to Postgres. Note that in the code.

## Rollback and containment

`CLAUDE.md`'s Change Risk table puts "anything touching authn/authz or sessions" at **High risk** and
requires a documented rollback or containment plan. This adds an authenticated route, a container and
a credential at rest, so it qualifies. The plan is unusually cheap, which is a reason to write it
down rather than to skip it:

- **Containment is the `profiles:` gate.** `docker compose stop authoring` (or simply not passing
  `--profile authoring`) removes the model client, the credential at rest and the egress in one
  action, with zero effect on serving the blog — `app` + `db` are what the default `up` brings up
  either way. The editor button then fails with "sidecar unreachable", which §Failure modes already
  requires to name the service and the profile.
- **Rollback of the app image** is the standard promote-by-tag flow (`IMAGE_TAG` in the server's
  `.env`). The new route is additive; nothing in the existing schema or `/data` layout changes, so a
  rollback needs no data migration.
- **What rollback does NOT undo:** drafts already written. They are ordinary posts and stay in
  Postgres, which is the intended outcome — but say so, because "roll back the feature" and "undo
  what it wrote" are different requests. Deleting an unwanted draft is the existing admin action.
- **Blast radius if the sidecar is compromised:** it holds a model credential and can reach `app:3000`
  unauthenticated (see §The `authoring` service). It cannot write content. Revoke by rotating the
  Anthropic key or invalidating the CLI login profile on its volume — independently of every other
  secret in the stack, which is why the credential lives in `authoring/.env` and not the root `.env`.

## Open questions (for the owner — do not answer these in implementation)

1. ~~**Sidecar lifecycle.**~~ **Answered by decision 1.** The editor button means something *does*
   need to call it, so the sidecar is a **long-lived service** listening on the compose network.
   `run --rm` is no longer viable. Cost of the decision, stated plainly: the container now holds the
   Anthropic credential at rest for as long as it is up — which revision 1 avoided. Two mitigations,
   both cheap: keep it behind `profiles: ["authoring"]` so `docker compose up -d` does not start it
   unless asked, and prefer `provider: openai-compatible` when there is no key to hold at all.
2. ~~**Does the AI settings page need expanding at all?**~~ **Answered by decisions 2 and 3** — yes,
   with a new card carrying provider, base URL, model, timeout and the two prompts. Secrets stay out
   (decision 4), so the read-scope concern resolves cleanly: the fields hold nothing confidential,
   and they stay off `/ai-config` regardless because the browser has no use for them.
3. ~~**How does the owner invoke a run?**~~ **Answered by decision 1** — a button in `editor.html`,
   backed by the async `POST /authoring/runs` endpoint.
4. ~~**Which model, and at what cost ceiling?**~~ **Answered by decisions 5 and 6.** Provider and
   model are settings fields, so this is no longer a once-and-correctly decision. Tier 1 (Claude CLI
   on a subscription) has **no per-token cost at all**, which is the owner's stated primary path.
   **No spend cap lives in this repo** — it is managed on the Anthropic account. Nothing here meters
   spend, and this design does not add metering; say so in `SECURITY.md` rather than implying a
   control that does not exist.

5. ~~**Does the sidecar's author account appear in the admin Users list?**~~ **Dissolved by
   decision 7.** There is no account. The sidecar authenticates to nothing, so nothing appears in
   the Users list and `PRODUCT.md` Principle 1 ("no multi-tenant complexity") is untouched — the
   deployment still has exactly one identity, the owner.

6. ~~**`.env` growth.**~~ **Answered by decision 4** — the sidecar gets its own gitignored
   `authoring/.env`, referenced via `env_file:` on the service. The root `.env` does not grow, so
   `CLAUDE.md`'s rule is honoured literally rather than argued around, and the app's bootstrap config
   and the sidecar's credentials sit in separate blast radii.

## Unverified in this spec

The **Claude agent CLI's own surface** — its headless invocation form, how it authenticates (API key
vs. subscription login), whether it needs a writable `HOME`, and how it is installed into a container
image — was **not** verified against this repository or against current Anthropic documentation while
writing this spec, because none of it is present in the codebase.

**Everything about *this repo* above is verified; the tier-1 claims are not, and decision 5 makes
tier 1 the primary path.** Do not read the paragraph above as "nothing important depends on this".
Four claims rest entirely on unverified CLI behaviour, and each should be pinned in the
implementation plan before the `authoring/Dockerfile` is written:

1. *"Tier 1 needs a writable `HOME` on a persisted volume — this is its defining constraint."* If the
   CLI can authenticate from an environment variable instead, the volume and its handling requirements
   disappear.
2. **§Why not inside the `app` container** is argued around what tier 1 needs (shell, package manager,
   writable `HOME`). The conclusion — keep the model client out of the DHI runtime — survives on its
   own merits for tiers 2 and 3, but the *argument as written* is tier-1 shaped.
3. `authoringModel` defaulting to `'claude-opus-5'` assumes the CLI takes a model id in that form.
4. Open question 4's *"Tier 1 … has **no per-token cost at all**"* is asserted flatly and is not
   checkable from this repo.

**One question this spec does not answer and should not:** whether driving a subscription login from
an unattended container is within the terms of that subscription. That is the owner's call and must
be made explicitly rather than inherited from this document's silence.
