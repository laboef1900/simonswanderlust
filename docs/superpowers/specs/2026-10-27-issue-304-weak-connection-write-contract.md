# Weak-connection write contract: ambiguous outcomes, session end, draft isolation (#304)

Date: 2026-10-27. Risk: **High** (post/page write contracts, sessions and draft storage on shared
devices, additive schema, filesystem ownership/recovery, and `PATCH /media/items/*`).
**Status: OWNER-APPROVED CONTRACT — development/CI native-lock qualification passed;
actual deployment-mount qualification remains a pre-deployment/pre-enablement gate.**
On 2026-10-29, the owner approved D1–D3 and D5–D7, selected **always keep local drafts**
for D4, and approved the recorded sequencing amendment. The independent read-only
authenticated-context prerequisite is also approved. These decisions preserve §5.3's
native-lock implementation/packaging requirements and authorize no merges or deployments.

Parent epic: #303. Blocks: #305 (reconcile lost responses), #306 (user-scoped stashes, offline
signals, stale-tab conflicts). Independent narrow fixes that this contract must stay compatible
with: #345 (restored stash keeps its base token) and #362 (one write in flight per editor tab).
Baseline: `origin/dev` at `11e16d1b8e43141d296b801ee663a351ae3fe415` (the issue was planned
against `9e400f9`; line references below are re-verified at `11e16d1`, and several have moved).

## 1. Problem and scope

Today the admin client treats a lost response as "nothing happened". Verified at `11e16d1`:

| # | Finding | Evidence |
|---|---|---|
| F1 | `doSaveDraft` reports `Save failed: <error>` on a network error. For a new post the `POST /posts` may have committed; a second Save creates a second pair (new random `translationKey`) or hits `duplicate_slug`. A draft with **both slugs empty** (#119 `''` = unset) never collides, so the duplicate is silent. | `uploader/public/editor.html:1744-1755`; `uploader/src/server.ts:1563` passes `tk=''`, `posts.ts:935` generates `randomUUID()`; partial unique index `db.ts:112` |
| F2 | `POST /posts` cannot carry a client key: the handler overwrites `translationKey` with `''`. A POST naming an **existing** key would, if it were honored, go through `upsertDraft`'s update branch **without** a stale check (`baseUpdatedAt` absent). | `server.ts:1519`; `posts.ts:941-966` |
| F3 | A committed-but-unseen `PUT /posts/:tk` bumps `updated_at`; the next Save 409s `conflict` and the dialog offers Reload, discarding edits typed since — for the author's own write. Same for `PUT /pages/:key`, whose response waits for a full rebuild (the likeliest proxy timeout in the app). | `editor.html:1762-1771`; `server.ts:1940-1976`; `about.html:157-177` |
| F4 | Comparing "stored working copy == payload sent" is not exact: the store normalizes every save (`draftWithDefaults` fills date/country/region/hero placeholders; `normalizeBodyImages` rewrites `<BodyImage/>` tags and lifts gallery-line metadata into `images`). The #75 gallery picker writes metadata lines that are lifted on every save, so gallery edits would routinely compare unequal. | `posts.ts:430-471`, `492-540` |
| F5 | `media-browser.js` handles any 401 with `location.href = '/login'` (no `?next`); the in-memory `File` queue is destroyed. `media-picker.js` has the same default. The media page has no `beforeunload` guard while uploads run. | `media-browser.js:42`; `media-picker.js:67` (issue cited `:56` at `9e400f9`) |
| F6 | `retryFailed()` re-queues uploads that failed with `network error` though they may have landed. Upload identity is `contentHashKey(libraryKey(filename, now), bytes, encodingProfile)`: the key embeds the **UTC year** and the **current encoding settings**, so a retry across New Year or after a settings change creates a second row and variant set. The browser cannot derive the key. | `media-api.js:196`, `290-295`; `server.ts:447-459`; `media-store.ts:773-784`; `storage.ts:79-82` |
| F7 | Historical baseline: queue refusal could strand `processing`. **#348 is independently implemented**: new keys retain their original and row as `failed/queue_full`; existing general-path keys restore prior status/error, and inactive-processing duplicates settle as `failed/queue_full`. Its same-key admission guard covers these transitions. Receipts must preserve this recovery, not remove new rows/files. | actual #348 `server.ts:517-618`; `encode-queue.ts:250-288` |
| F8 | DraftGuard keys (`swl:draft:<tk>`, `swl:draft:new:<nonce>`, `swl:draft:about`) carry no user. The new-post orphan scan offers the newest `swl:draft:new*` of any account on the browser. | `draft-guard.js:107-124`; `editor.html:597-598`; `about.html:92` |
| F9 | `markClean` removes the adopted source key unconditionally, even if the source tab has since written a newer stash. (A comment on #306 links an external test script and a command for it; it was treated as untrusted and **not executed**. The defect was confirmed by reading the code only.) | `draft-guard.js:79-91` |
| F10 | `PATCH /media/items/*` has no concurrency check. The browser already sends a per-field diff against the panel's render snapshot (`detailPatch`), so a stale tab overwrites only the fields its author changed — still silently. Since #271 library alt/caption reach published galleries on the next rebuild. | `server.ts:749-776`; `media-browser.js:617-635`; `media-store.ts:644-666` |
| F11 | Sessions have a fixed 30-day TTL, no renewal. Mid-batch 401s mostly come from logout in another tab, a password change in another tab (`destroyAllForUser`), account deletion, or a restore — not from timeout. `requireAuth` runs as a preHandler, before the handler reads any multipart part, so a 401 is a definite refusal. | `authn.ts:6`, `24-32`; `sessions.ts:57-62`; `server.ts:417` |
| F12 | `/auth/status` returns `username` but no user id; usernames are reusable after `DELETE /users/:id` (plain `DELETE`). | `server.ts:1197-1202`; `users.ts:216-218` |
| F13 | `draft-guard.js:6-8` calls a stash that outlives logout "acceptable for this single-author admin"; the app has multiple accounts. This spec supersedes that note; #306 rewrites it. | `draft-guard.js:6-8` |
| F14 | `POST /media/move` and `POST /media/folders` are set/ensure operations (`ensureFolders`, `UPDATE … SET folder`) with no concurrency check. | `server.ts:648-656`, `680-690`; `media-store.ts:555-558`, `667-673`, `707-711` |

In scope: the client/server contract for every authoring write under an unknown outcome, the
session-end behavior of an upload batch, and the scope, lifetime and migration of browser draft
stashes. Out of scope: publish/unpublish/rebuild/delete outcomes (#297), offline authoring, a
service worker, real-time collaboration, session renewal, and the GPX route writes (already
specified, §4).

## 2. Vocabulary

**Outcome** of one request, as the client classifies it:

- **Landed** — a valid 2xx acknowledgement was received. Post/page adoption additionally requires
  the attempt/form owner fence (§5.2); a mismatched acknowledgement never cleans local work.
- **Refused** — the app answered with a status that guarantees nothing was written: 400, 401,
  403, 404, 409 (except where §3 says to check a receipt first), 413, 507. A 401 is always
  Refused (F11).
- **Unknown** — no response (network error, abort, stall watchdog), any 5xx including
  proxy-generated 502/503/504, a 2xx whose body cannot be parsed, and `POST /upload` 429 (F7).

**Write class** of a route:

- **A — Create-once by client key.** The client proposes the identity; a replay can never
  create a second resource or update an existing one.
- **B — Token-guarded update with write receipt.** Optimistic concurrency (`updatedAt`) plus a
  server-stamped receipt that tells the writer whether *its* attempt is the latest write.
- **C — Idempotent set/ensure, last-writer-wins + re-read.** Re-applying the same request yields
  the same state; unknown outcomes are resolved by reading the state.
- **D — Field-conditional patch.** Each changed field carries the value the author saw; a
  mismatch refuses the write.
- **X — Excluded**, with a named owner.

**Probe**: the single automatic read the client performs after an Unknown (or receipt-checked
409) outcome. After one probe the UI offers only a manual **Check again**. No loops, no
exponential backoff, **no automatic re-send of any write**.

## 3. Write inventory

| Route | Caller | Class | Unknown-outcome behavior | Owner |
|---|---|---|---|---|
| `POST /posts` | editor | **A** (§5.1) | Probe `GET /posts/<createKey>`; adopt only on receipt match | #305 |
| `PUT /posts/:tk` | editor | **B** (§5.2) | Probe `GET /posts/:tk`; receipt match → adopt token, mark clean | #305 (409 dialog #306) |
| `PUT /pages/:key` — the save | About | **B** (§5.2) | Probe `GET /pages/:key`; receipt match → adopt | #305 |
| `PUT /pages/:key` — the rebuild it triggers | About | X | Rebuild outcome reporting | #297 |
| `POST /upload` | media queue; editor/About/title-image inline uploads | **A** (§5.3) | Probe `GET /upload/receipts/:uploadId` | #305 |
| `POST /media/folders` | media page | **C** | Probe `GET /media/folders`; present → done, absent → offer **Create again** | #305 |
| `POST /media/move` | media page | **C** | One bounded authoritative selected-key lookup, independent of filters/pagination; show each stored folder (§5.4) | #305 |
| `PATCH /media/items/*` | media detail panel; Media AI details | **D** recommended; explicit **C** policy alternative (§5.5) | Probe item; compare canonical persisted values; conditional envelope fails closed across versions | #306 |
| `POST /media/retry` | media page | **C** (skips `ready`/`processing`, `server.ts:705-726`) | Probe = reload listing; re-send explicit and safe | #305 (classification only; no behavior change required) |
| `POST /export` | posts list | **C** (rewrites the same backup files) | Unchanged; safe to repeat | none (no change) |
| `POST /posts/:tk/publish`, `/unpublish`, `POST /posts/bulk`, `DELETE /posts/:tk`, `POST /rebuild` | editor, posts list, settings | X | Persisted-vs-live reporting | #297 |
| `PUT/DELETE /posts/:tk/route`, `POST /posts/:tk/route/import`, `POST/DELETE /gpx/imports*` | editor GPX | X — already token-guarded; unknown commit outcome specified | GET route state, never repeat replacement | `2026-10-23-gpx-route-import-design.md` §5 ("Unknown commit outcome", "Commit succeeds, response is lost") |
| `PATCH`/`DELETE /media/folders`, `DELETE /media/items/*` | media page (admin) | X — admin-only irreversible | Existing action/outcome UI unchanged; media deletion must invalidate associated receipts (§5.3) | Epic #303 exclusion; receipt bookkeeping #305 |
| `POST /media/rescan` | media page (admin) | X for its existing media reconciliation; bounded receipt-recovery hook (§5.3) | Existing action reporting retained; #305 adds explicit receipt recovery/deferred reporting, not automatic client replay | #305 hook only |
| `/settings*`, `/ai-providers*`, `/users*`, `/backups`, `/import`, `/moderation/*`, `/setup`, `/login`, `/logout` | admin/auth | X — not authoring writes | Unchanged | Not part of #303; owner may file separately |

### Client outcome rules (all class A/B/C/D callers)

1. **Landed** → apply the response only after its route's acknowledgement checks. Post/page
   normal 2xx and receipt-probe adoption use the same owner/generation fence (§5.2).
2. **Refused 401** → session-end flow (§5.6); nothing is retried automatically.
   A 403 `owner_changed` likewise pauses that form's writes and preserves its captured owner,
   form and stash; it never re-scopes or replays them as the new account.
3. **409 `conflict`** (posts/pages) and **409 `already_exists`** (posts) → run the receipt probe
   *before* showing any conflict UI. A browser- or proxy-level replay of a non-idempotent request
   (HTTP/1.1 keep-alive reconnects) reaches the client as exactly this shape: the original's
   response is lost, the replay's 409 is seen.
4. Other **Refused** → show the server error; nothing was written.
5. **Unknown** → show "Outcome unknown — checking…", run one probe, then show the proven stored
   result or retain Unknown. Absence/current old state is not proof an in-flight write cannot commit.
   Only the route-specific guarded explicit action below may re-send; never infer safe retry from age.
6. `navigator.onLine` never decides an outcome and never triggers a request (§5.8).

## 4. Excluded writes

- Publish/unpublish/bulk/delete/rebuild: #297 owns truthful persisted-vs-live reporting. #305
  must not add a second resync for them.
- GPX route writes: the approved GPX spec already requires a GET before any repeated replacement
  and its own `baseVersion` + `baseUpdatedAt` pair. Route writes bump `posts.updated_at` through
  `touchPostPair`, which (per §5.2) clears the post's write receipt — so a route write between a
  lost save and its probe correctly reads as "changed elsewhere".
- Admin-only irreversible media operations and administration routes: excluded by epic #303.
  The narrow server receipt-finalization hook on existing admin Rescan and receipt invalidation
  on media deletion are necessary §5.3 recovery bookkeeping, not new destructive operations or
  a redesign of those actions' unknown-outcome UI.

## 5. Mechanisms

### 5.1 Post create idempotency (decision D1)

**Recommended contract — client-proposed `translationKey`, create-only POST.**

- The editor generates `createKey = crypto.randomUUID()` once per new-post page load and sends it
  as `translationKey` on every `POST /posts` for that unsaved post.
- `POST /posts` validates `translationKey` as a canonical lowercase UUID
  (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`); anything else → 400
  `invalid_translation_key`. The field is **required** (400 `translation_key_required`
  when absent) — clean cutover; an old open tab gets a Refused 400, its stash keeps the work,
  and a reload fixes it. The WXR importer is unaffected (it calls the store directly).
- The store gains a create-only path (`createOnly: true` on `upsertDraft`, or a sibling
  `createDraft`). Under the existing advisory pair lock (`post-pair-lock.ts:6-8`), **existence is
  checked first**: if any row has that `translation_key`, throw `PostError('already_exists')` → 409
  `{ code: 'already_exists' }` with no write. Only then the slug checks, so a replay of a
  landed create can never surface as `duplicate_slug`. The update branch is unreachable from
  POST. Memory store mirrors this exactly.
- Concurrency: two POSTs with the same key serialize on `pg_advisory_xact_lock(hashtextextended(tk))`;
  the second sees the first's rows and gets `already_exists`. No unique index on
  `(translation_key, locale)` is added (see rejected alternatives).
- Reconcile (Unknown or 409 `already_exists`): one `GET /posts/<createKey>`:
  - **404** → not visible yet, not proof the original request has finished. Retain its attempt ID.
    Explicit **Save again** may POST the **same** createKey because the create-only lock prevents
    duplicate/overwrite even if the original commits late. It cannot generate a replacement key.
  - **200 and receipt matches any retained unresolved attempt for this resource/context** (§5.2)
    → adopt `tk = createKey`, the token and slugs from that same response; re-key this context's
    stash without touching other contexts; `history.replaceState` with `?tk=`. Clean only the
    matched attempt's form generation; newer edits remain dirty.
  - **200 otherwise** → show the stored version alongside local work; no automatic PUT or POST.
    #305 provides preserve-and-compare behavior before #306 enhances the conflict dialog.
- Exact key / lifetime / persistence: key = `translationKey`; lifetime = the life of the pair;
  persistence = the `posts` rows themselves (no extra table). The key also travels in the new-post
  stash payload as `createKey` (§5.7), so a tab that crashed after a lost POST response can be
  reconciled on restore.

Alternatives:

- *Request-id table* (`post_create_requests(user_id, request_id, translation_key, created_at)`,
  bounded window): rejected — a second source of truth, a retention window after which a restored
  stash replays into a duplicate, a payload-hash comparison to detect id reuse, and a new
  operational table, all to emulate what a client-proposed primary identity gives for free.
- *No change + reconcile-by-lookup* (search the posts list by slug/title): rejected — inexact;
  two drafts with empty slugs (#119) or equal titles are indistinguishable (F1).
- *Unique index on `(translation_key, locale)`*: rejected as part of this change. The advisory
  lock already serializes every pair mutation; a `CREATE UNIQUE INDEX` on a database holding any
  legacy duplicate would fail `ensureSchema` and stop the app from booting. It may be proposed
  separately with a pre-check migration.

### 5.2 Write receipts for `PUT /posts/:tk`, `POST /posts`, `PUT /pages/:key` (decision D1)

**Recommended contract — server-stamped, writer-only receipt.**

- Request: required `saveId` and `expectedOwnerId` (canonical lowercase UUIDs; invalid/missing
  → Refused 400), stripped from content like `updatedAt`/`confirmSlugChange`. Capture
  `expectedOwnerId` when the authenticated form is initialized or from the verified owner-scoped
  draft being restored; it is immutable for that form/context and is **not** read afresh from
  whichever account currently owns the cookie at Save time. Each logical form attempt retains
  `{ saveId, expectedOwnerId, resource, baseUpdatedAt, generation, sentPayload }` until resolved.
  An identical explicit retry reuses its ID and owner; a changed form gets a new ID but does not
  discard unresolved older IDs or their snapshots. This is bookkeeping, never a replay queue.
- All three authenticated routes validate `expectedOwnerId === req.authUser.id` **before any
  content, receipt, revision or other write**, including create/update and page-triggered rebuild.
  Mismatch → Refused 403 `{ code: 'owner_changed' }`; existing role checks still apply. This
  client identifier grants no authority. Startup `/auth/me`, focus reads and even an immediately
  preceding preflight cannot replace this per-request fence: the cookie may change between them.
- The validated session/expected-owner pair is also the only source of `last_save_by`. Normal
  successful save responses and GET reconciliation envelopes carry `ownerUserId` (the requesting
  authenticated user) alongside the existing result; only same-owner reads expose `lastSaveId`.
  Before adopting **either** a normal 2xx or a probe, require response owner = attempt owner =
  current form/context owner, and no detected account switch. Save acknowledgements also echo
  `saveId`; a missing/mismatched acknowledgement is Unknown/unsupported, never clean. Do not add
  these operational fields to content. Adoption still cleans only the acknowledged generation.
- A→B in another tab: B's cookie cannot submit A's form; preserve A's text, attempts and scoped
  stash on refusal and pause writes until explicit same-owner reauthentication/reconciliation.
  A request authenticated as A before the switch may finish as A, but never becomes B's attempt.
  If the switch is detected before its response, retain that response as A's evidence without
  adopting/cleaning until A returns explicitly. Never re-key A's stash to B, discard A's form,
  or auto-replay on login/focus. No cross-account form-transfer feature is offered.
- Schema (additive, `db.ts`): `posts.last_save_id uuid NULL`, `posts.last_save_by uuid NULL`;
  `pages.last_save_id uuid NULL`, `pages.last_save_by uuid NULL`. No foreign key (a deleted user's
  stale id is harmless and keeps restore ordering independent). `ALTER TABLE … ADD COLUMN IF NOT
  EXISTS`, placed in the column-migrations section (they are not referenced by
  `POST_SNAPSHOT_SQL`, so the `db.ts:130-135` ordering trap does not apply).
- Write rule (posts): inside the save transaction, after `touchPostPair`, set both locale rows'
  `last_save_id = saveId, last_save_by = validatedOwnerId` from the route's verified pair above
  (both `NULL` for explicitly receipt-less internal writes).
  `touchPostPair` itself sets both columns to `NULL` — it is the single chokepoint every other
  pair bump goes through (publish, unpublish, GPX attach/detach; `post-pair-lock.ts:12-25`,
  `posts.ts:1004,1027`, `gpx-store.ts:57`). Hence **I4**: `last_save_id = S` iff attempt `S` is the
  latest write of any kind to the pair. Pages: set in the same transaction as the save (after
  #344 lands, inside its serialization). The WXR importer passes no receipt → `NULL`. The memory
  stores mirror the same set/clear rule at every place they bump `updatedAt` (they do not share
  `touchPostPair`), so the unit suites exercise I4.
- Read rule: `GET /posts/:tk` and `GET /pages/:key` return content, `updatedAt` and
  `lastSaveId: string | null` from **one SQL statement/MVCC snapshot**, or one repeatable-read
  transaction. Non-null only when `last_save_by` equals the requesting user. A separate query
  outside that snapshot is forbidden: it could combine old content/token with a new receipt.
  Return an operational read envelope; do not put receipt fields in `StoredPostPair`/
  `StoredPagePair`, revisions, exports, AI inputs, the posts list or the site loader.
- Dumps exclude receipts through explicit column lists; no dump-version bump. **Restore must
  actively invalidate them**, not merely omit them from INSERTs: inside the offline restore
  transaction clear post/page receipt columns (including existing pages preserved by v1 dumps)
  and delete upload receipts. Writers/encoders must be stopped throughout restore. See §10.
- Client reconcile for PUT (Unknown or 409 `conflict`): one consistent GET, subject to the same
  owner fence as normal 2xx. An owner mismatch preserves the form/stash and pauses; it is not a
  foreign-write comparison or permission to adopt B's token under A's text:
  - Receipt matches **any** retained unresolved attempt → that attempt landed. Adopt this
    response's token and slugs; mark clean only if its generation still equals the current form.
    Newer edits remain dirty and can be saved explicitly with the refreshed base. Refresh revisions.
  - No match, token equals attempt base → original may still be running. Keep its ID/snapshot.
    An explicit token-guarded Save again is safe, but must not label the original definitively
    failed: whichever attempt wins the lock, a subsequent 409/probe still recognizes its own ID.
  - No match, different token → stored state changed; stash first and compare without discarding.
  - 404 → resource absent; local form/stash and unresolved identity remain recoverable.
  - A failed/malformed probe → Unknown, manual Check again only.
- About: identical, against `GET /pages/:key`; whatever the probe concludes about the save, the
  rebuild's outcome stays #297's to report.

Alternatives:

- *Client-side equality of raw stored vs sent payload*: rejected, not an owner fallback. Defaults
  and image/gallery normalization make it violate #305's own-landed-write requirement. Receipts
  avoid maintaining a second body parser. A future alternative would need correct canonical
  equivalence and the full acceptance proof; this proposal does not offer one.
- *Receipt in an operational side table keyed by resource*: equivalent semantics, but every
  `touchPostPair` caller would have to write a second table; rejected for coupling.
- *Rejecting a `saveId` equal to the stored one*: unnecessary — a replay already 409s on the
  token (PUT) or `already_exists` (POST), and forging another user's receipt is impossible
  because `last_save_by` is server-stamped.

### 5.3 Upload receipts and ownership (decision D2)

All upload callers participate: media queue, picker, editor hero/body/title image and About.
Each file has an immutable `uploadId` and captured `ownerUserId`, retained with its in-memory
File across explicit retries. A different account cannot resolve or inherit an unknown attempt.
The multipart `uploadId` is required; invalid/missing IDs are refused before writes.

Each request also carries `expectedOwnerId`; the authenticated handler compares it to the session
before claiming/writing and refuses mismatch. A second-tab login racing Resume therefore cannot
submit A's unknown File as B. This identifier grants no authority; the session remains required.

**Durable identity.** Add an operational `upload_receipts` table keyed `(user_id, upload_id)`.
Persist byte SHA-256, canonical request identity (explicit/derived base key, filename, initial
metadata/folder), the **frozen encoding profile and final media key**, state, owning process
incarnation and result/error category. Reuse with different bytes or request identity is 409
`upload_id_reused`. Existing receipts are resolved before deriving a key from current year or
settings; metadata/folder are never reapplied on a receipt hit. A reserved media key/row is not
an accepted upload. No credentials, EXIF/GPS or photo bytes enter the receipt.

**Exclusive execution, not leases.** The single app process keeps an execution mutex per receipt
from claim through file writes, enqueue and finalization; duplicate requests observe pending.
Across restart, reclamation requires positive exclusion of the former process: hold a
kernel-released exclusive lifetime lock on one stable lock file in the shared data directory
before accepting uploads or recovering receipts. If that lock cannot be obtained, the replacement
does not serve writes. This is not a ten-minute lease; a stalled process keeps ownership until it
has quiesced and released the lock or terminated. Do not release the per-receipt mutex on HTTP
abort while asynchronous writes still run. Database disconnects/timeouts do not transfer ownership.
Finalization checks the immutable claim/incarnation. Initialize exclusively owned recovery before
new requests; its initial pass is bounded, and deferred work has the follow-on owner below.
Receipt age never permits takeover. Shared-data multi-app deployments remain unsupported and must
fail closed at this lock. This lock requires the qualified native implementation described
below; it is not an existing repository facility or a guessed Node API.

**Concrete lock feasibility and prerequisite (original research; qualification and approved
sequencing update recorded in “Native-lock qualification status” below).**

- The inspected `uploader/src/storage-owner.ts:29-124` holds a dedicated **PostgreSQL session
  advisory lock**, with heartbeat loss latching writes read-only and ending that connection.
  Preserve its approved DB/restore safeguards. It is not a filesystem lifetime lock: a database
  connection can end while previously issued filesystem operations in the process still exist.
  It cannot by itself prove the old process is excluded from the volume.
- Darwin's documented [`flock(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)
  and Linux's [`flock(2)`](https://man7.org/linux/man-pages/man2/flock.2.html) provide
  `flock(fd, LOCK_EX | LOCK_NB)` on an open file. These are advisory locks requiring all writers
  to cooperate. Last-close releases them; Apple's
  [`close(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/close.2.html)
  also documents descriptor release on process exit. This establishes a native primitive, not
  its availability through this app. Never unlink/replace the lock file while it can be held:
  another inode would allow a second owner. Hold a strongly owned descriptor until all protected
  work has stopped; prevent unintentional inheritance into build children.
- The consulted [Node 26 filesystem API](https://nodejs.org/docs/latest-v26.x/api/fs.html)
  (served as v26.12.1) documents no `flock`/`fcntl` locking API. Its `'wx'`/`O_EXCL` is exclusive
  **creation**, not a crash-released lock; a stale-file timeout is not an equivalent. Inspected
  uploader package/lockfile/source contains no native filesystem-lock binding. Do not invent
  `fs.flock`, use a private Node binding, or assume a transitive package exposes one.
- `Dockerfile:17-18,104-122` selects `dhi.io/node:26` and starts plain Node without a shell;
  it installs/copies no locking helper. Docker's [DHI variant documentation](https://docs.docker.com/dhi/explore/available)
  describes minimal runtime images without development tools. Neither this Dockerfile nor
  those docs proves a `flock` executable exists there, or on macOS. No image inventory, binary,
  native build or macOS/DHI lock test has been run for this proposal.
- **Required before #305 implementation:** choose and review an explicit Node-26-compatible
  native binding (or an owned Node-API addon) for this syscall, its dependency/license/build
  provenance, and reproducible macOS arm64 plus deployed DHI architecture/libc packaging.
  No specific third-party package is selected or asserted compatible here. A separately locked
  helper process is not interchangeable: its death could release the lock while Node still
  writes, so any helper alternative needs a demonstrated lifetime/exclusion protocol first.
  Specify the canonical lock path and acquire it in every app/restore entry point **before**
  admission; retain the existing PG ownership/quiescence protocol as well, in one consistent
  acquisition order. Qualify real data mounts with two-process contention, live-owner
  stall, DB disconnect, process death, inherited-descriptor and restore tests. Native macOS
  local disk and Linux volumes need separate evidence. Under the approved sequencing
  amendment below, the actual deployment mount must pass before deployment or enablement;
  Docker Desktop sharing, NFS/SMB and other unqualified mounts are not presumed equivalent.
- **Owner tradeoff within D2:** accepting automatic crash recovery requires this native
  dependency/build/mount-validation cost. If it is declined, an explicitly amended design must
  keep pending receipts blocked until an operator has established offline exclusion; it cannot
  silently substitute PG ownership, age-based takeover or a guessed binary. D2 approval alone
  is not proof the implementation prerequisite has been met.

Serialize physical side effects by frozen **media key** as well as by receipt: two different
upload IDs for identical content must not race status restoration against another receipt's
accepted job. Reuse #348's `encodeQueue.withAdmission(key, ...)`, with the row re-read inside it;
do not introduce an unrelated second key mutex. Order is receipt ownership then media-key admission;
recovery uses the same order. Queue state checks, status settling, original validation and enqueue
are coordinated there, so a reserved row cannot be mistaken for a durable original or active job.
Receipt status reads never mutate or enqueue work.

**Every return path finalizes truthfully:**

| Branch | Receipt transition / response |
|---|---|
| Validation/auth refusal before claim | No receipt; definite request refusal only, never proof about an earlier attempt with the same ID. |
| Existing `ready` duplicate | Commit the existing duplicate metadata behavior (title patch, blank-alt/root-folder fill) and `accepted` receipt together in one DB transaction, with the actual stored response. Verify ready media; no new original is required. Recovery must not reapply metadata. |
| Existing `processing` duplicate | Confirm a durable original and active queue job; if inactive, use #348's idempotent enqueue. Only then `accepted`. A processing row alone remains `pending`. |
| New/failed/missing photo | Reserve identity/row → atomically store the complete original → enqueue accepted → persist `accepted` → 2xx. A probe between any earlier steps reports `pending`, never done. |
| `storeOriginal` failure | Settle the actual write failure under the same-key guard; partial/uncertain storage is never acceptance. Record `retryable` only after the writer has stopped and absence of a complete recoverable original/job is established. Preserve valid retained originals; cleanup uncertainty remains `pending` for explicit recovery, not blind byte resend. |
| Queue refusal | Preserve #348: a **new key keeps its row and complete original as `failed/queue_full`**; the general existing-key path restores its prior status/error. Existing inactive `processing` or `failed/queue_full` duplicates settle as `failed/queue_full`, never phantom processing. Keep `withAdmission` held through the settled status write. Receipt remains `pending` with reason `queue_full` and joins bounded receipt recovery; 429 is not accepted and does not authorize retransmitting already retained bytes. No new-row/file rollback. |
| Crash between durable original/enqueue/receipt completion | Under exclusive process ownership and same-key admission, validate the frozen original/hash/profile and actual media state. Proven matching ready → accepted; complete matching original → bounded enqueue, then accepted; proven incomplete/nonrecoverable original → settle failure then retryable. Queue full/uncertain disk state remains pending and is handled by the follow-on recovery owner below, not success or endless startup retry. |
| Claimed media subsequently deleted | `gone`, not not-landed, for pending as well as accepted receipts; no automatic recreation or takeover. Media deletion records this terminal receipt invalidation with its DB removal, serialized with same-key admission, so deferred recovery cannot resurrect a deliberately deleted retained original. Fresh upload is a new explicit operation. |

Enqueue acceptance means durable original plus a recoverable queued job, **not** completed encoding.
The UI may mark the transfer `done` while showing media `processing`; an encoder failure remains
visible as failed media. Startup re-seeds accepted processing rows before claiming active encoding.
No receipt finalization may bypass #348's retained-original/status-restoration semantics or #347's
roll-forward-only codec/profile rules.

**Deferred recovery owner — #305's server receipt reconciler, not GET.** Startup performs at most
one page of 100 pending receipts; it does not wait/retry until the queue empties. The reconciler
also runs on coalesced encode-completion/capacity-release signals and explicitly from the existing
admin `POST /media/rescan` reconciliation path. These triggers and receipt finalization are new
#305 work: existing #348 `recover()` reads one bounded processing page and leaves overflow for
Rescan/restart; it neither revisits nor finalizes receipts.

- One receipt recovery pass at a time, at most 100 records per page and no enqueue beyond the
  queue's available capacity. Use keyset pagination and a sweep cursor, not repeated page 1:
  unresolved/error rows cannot starve later receipts. Coalesce triggers rather than accumulating
  an unbounded task list. Continue another bounded page only after forward progress with capacity,
  yielding between pages; saturation waits for a capacity signal, not a timer/spin/startup loop.
  Retain a pending wakeup if a capacity signal arrives during a pass, avoiding a lost-drain race.
- Acquire receipt then same-key admission and re-read receipt/media. Validate retained bytes
  against the receipt's SHA-256 and frozen key/profile, including the media row's stored profile;
  never derive them from today's settings/year or overwrite a conflicting original/profile.
  Matching active media can finalize after original/profile validation; ready media uses the
  proven-ready duplicate branch (no new original required), with matching frozen row/profile
  evidence, not status alone. Matching durable originals set `processing` and enqueue
  idempotently under the guard, then finalize accepted **without byte resend**. On renewed
  saturation, settle status/error as in #348 before releasing the guard; never leave unqueued
  phantom processing. A crash after enqueue but before finalization uses these same checks.
  Keep metadata untouched. Prior failed/missing states recover only with this proof; a `gone`
  receipt is terminal and cannot be revived by a stale scan/finalizer. Finalization updates must
  condition on the same claim/state and cannot overwrite deletion invalidation. Do not acquire
  a receipt execution mutex while holding media-key admission (including deletion).
- Receipt finalization failure, unavailable DB/disk or identity/profile mismatch stays pending
  with a bounded reason category, not accepted or retryable-by-age. Stop automatic continuation
  on such failure; expose it to the admin's explicit Rescan action, which runs another bounded
  receipt pass even when no encode-completion event can occur. Report deferred/blocked receipt
  counts and continuation availability; an explicit subsequent pass advances the same fair scan.
  Recovery cannot silently rely on a restart to revisit a failed finalization.
- A pending probe names `queue_full`/`recovery_required` as appropriate and explains that original
  bytes are retained when verified. Admins can explicitly run Rescan; authors are told an admin
  must reconcile blocked recovery. **Check again remains read-only.** Neither this control nor
  server drain recovery resends the upload request or transfers its owner. They complete a
  durable server operation, not an offline/client replay queue.

`GET /upload/receipts/:uploadId` is authenticated, owner-scoped and `no-store`. It returns
`accepted` plus the existing upload result shape, `pending`, `retryable` with a server-issued
retry generation, or `gone`; unknown/other-owner IDs yield indistinguishable 404. The next
explicit retry must carry the returned generation; the server consumes it under the receipt
mutex and rejects older generations before side effects. Initial requests use generation zero,
so an original delayed until after a terminal failure/retry cannot reopen the old attempt.
Same-generation concurrent requests return pending or the completed receipt, never run twice.

One automatic probe per Unknown; then **Check again**. Only `accepted` becomes `done`.
`pending`, failed checks and **404 stay Unknown**: absence can mean request not yet claimed,
restore invalidation or another owner, not permission to retry. `retryable` enables explicit
Retry with the same ID/frozen identity and the returned generation. A definite pre-claim
refusal may be retried explicitly only if that item has no unresolved earlier attempt.
No blind re-send, metadata refill or ownership transfer occurs.

**Retention:** keep the minimal identity/hash/profile/state record for the account's lifetime;
do not prune it after seven days. Large cached response material may be reconstructed from the
stored media key rather than retained. Account deletion and offline restore invalidate receipts;
they do not make a missing receipt evidence of non-commit. Restore must stop all writers and
clear receipts explicitly (§10). This durable policy is an owner cost decision, not a fabricated
bounded-window deduplication guarantee.

Upload stall watchdog: 120 seconds with no progress while sending, or no response 120 seconds
after send completion, aborts the client wait as Unknown, not the server operation. JSON saves
have no new client timeout (About may await rebuild). Closing a page loses its File/attempt IDs;
reselection is a **new** upload, with no receipt-level dedup promise across year/profile changes.
This limitation never authorizes automatic retry and must be stated beside reselection.

Rejected alternatives: filename/list matching (not unique), current-profile hash alone (year/
settings drift), global raw-byte dedup (changes media semantics), time-based claim takeover,
pruning then interpreting absence as failure, and deleting a receipt after storage failure.

### 5.4 Folder create and move (class C)

- `POST /media/folders`: idempotent ensure. Probe `GET /media/folders`: present → "Folder
  created"; absent → "Not visible yet" with explicit **Create again**, safe by ensure semantics.
- `POST /media/move`: keep explicit last-writer-wins set semantics, but reconcile through one new
  authenticated, `no-store` **read-only** `POST /media/lookup` with `{ keys }` (1–100 distinct
  validated storage keys, the existing bulk bound). Its one store query reads every requested
  key independent of folder/search/status filters and pagination and returns `{ key, folder }`
  or explicit missing for each. No metadata/GPS/uploader identity is returned. No per-key fan-out.
- Show each photo's actual stored folder: target, another folder, or deleted. A completed lookup
  permits an explicit **Move again** under the documented last-writer-wins policy, not a claim
  that the previous writer cannot commit later. Unavailable/incomplete lookup retains Unknown
  and only Check again; omission from the visible page is never evidence.
- Folder creation's probe reports presence/absence **at read time**; an absent folder may still
  be created by the original request. Explicit Create again is safe because ensure is idempotent.
  An ensured empty folder after a failed move is harmless; this does not prove item locations.

### 5.5 Media detail concurrency (decision D6)

**Recommended contract — field-level expected-value preconditions, no media schema change.**

- Keep `PATCH /media/items/*`, but use a fail-closed envelope
  `{ conditional: { version: 1, patch: { … }, expect: { … } } }`, with no top-level mutable fields.
  Every changed title/alt-locale/caption-locale/tags/folder field needs its matching expectation;
  missing/extraneous fields or unsupported version → 400 before writes. New servers refuse legacy
  top-level public PATCH writes; migrate **all** callers, including single/bulk Media AI.
  Internal store users such as upload fill-only behavior retain their explicit existing contract.
- Compare and store using the **same canonicalization**: cleanText control removal/length limits,
  normalizeTags trimming/deduplication/limits/order, validated NFC folder paths. Browser comparison
  uses a shared pure canonicalizer with parity tests against the store, not raw input equality.
  `["x","x"]` therefore compares as stored `["x"]`; body/gallery parsing is not duplicated here.
- pg: one conditional UPDATE with `IS NOT DISTINCT FROM` expectations and `RETURNING` actual
  stored fields; zero rows → missing 404 or 409 `media_changed`, with redacted current item.
  Memory store mirrors this. Unrelated fields remain untouched; no partial conditional patch.
- Detail panel sends expectations from its render snapshot. A 409 keeps local fields and offers
  compare, **Use mine** (explicit retry against newly read values) or **Use stored**. On Unknown,
  one item GET compares each canonical field: intended value → achieved; expected value → not
  yet visible (explicit guarded Save again); other value → compare. Mixed results stay visible.
  Never clean newer form generations or mistake current state for proof no late writer exists.
- Media AI fill-empty expects canonical empty values (`[]` for tags, `''` for text); overwrite
  expects the values just read. It reports conflicts/Unknown without automatic replay. Both
  single-photo and bulk consumers are REQUIRED, not an optional extension.
- Successful conditional responses carry `conditionalVersion: 1`; a missing marker is unsupported,
  not success. Against the inspected old server the envelope contains none of the top-level
  mutable fields it reads, so it produces **no mutation**, even though it may answer 200.
  Preserve the dirty form and require compatible code. A prior capability GET alone is
  insufficient: rollback can occur between that read and this write.

Alternatives:

- *Revision column on `media`*: every PATCH bumps `media.revision`; stale → 409. Rejected as
  the default: schema change on a content table; `backup.ts:177` dumps `media` with `SELECT *`, so
  the column would silently enter dumps — it would need either a `DUMP_VERSION` 11 + allow-list
  bump and restore support, or an explicit exclusion; and it raises false conflicts for unrelated
  fields (a bulk move or AI fill of the *other* locale would 409 an alt edit the per-field diff
  deliberately tolerates, `media-browser.js:607-616`).
- *Last-writer-wins + re-read*: a genuine owner policy alternative explicitly allowed by
  #304/#306, not a safety-equivalent fallback. It intentionally allows stale field overwrite.
  If selected, record that decision and consistently replace class D/conflict expectations with
  class C throughout before implementation; its unknown-outcome read and all callers stay required.

### 5.6 Session end during a batch (decision D3)

**Recommended contract — pause in place; sign in in a new tab; explicit Resume with an owner
check.**

- Media page: no 401 anywhere navigates away (**I15**). The first 401 pauses the queue: nothing
  new starts; in-flight requests finish on their own (a 401 among them → `needs-auth`).
- A persistent `role="alert"` banner (Editorial desk styling) states: session ended; *M photos
  uploaded, N waiting*; a **Sign in in a new tab** link to `/login?next=%2Fadmin%2F`
  (`target="_blank" rel="noopener"`; `safeNextPath` accepts it); **Resume**; and **Stop and clear
  waiting files** (confirmation naming the count).
- Resume runs one `GET /auth/me`: 401 → stay paused; matching `userId` → explicitly re-queue
  definite `needs-auth` refusals and known-unsent files. A different account may take **only**
  known-unsent/definitely-refused files after a confirmation naming both accounts, with new IDs.
  Unknown/in-flight attempts keep their original owner and ID: B's 404 cannot resolve A's write.
  Keep their landed/unknown records visible and require A to sign back in to check them.
  Window focus may run one `/auth/me` read to update the banner; it never resumes writes.
- `beforeunload` is armed while any item is `queued`, `uploading`, `needs-auth`, `unknown` or
  `checking`. The in-memory record of which files landed (`done` + `result.key`) survives the
  whole flow because the page never unloads.
- Other media actions during the pause show "Session ended — sign in again" instead of
  navigating. `media-picker.js`'s default 401 handler uses `/login?next=` + the current path;
  inside the editor it keeps `guard.redirectToLogin()`.
- Editor and About keep stash-then-redirect (`draft-guard.js:179-184`) under scoped keys (§5.7).
  An inline single-file upload interrupted by a 401 is not resumed: the file must be reselected
  (Limits).
- No sessionStorage batch manifest. If the page unloads anyway (OS tab discard, crash),
  the queue is gone and the files must be reselected; receipts still deduplicate a re-upload of a
  file that had landed only when it is re-sent **with its old `uploadId`**, which a reselected item
  does not have — content-hash keys then dedupe it unless the year or profile changed.

The existing login page is reused; no second password form, sliding renewal, credential storage,
persisted File store or automatic replay is introduced. No sessionStorage batch manifest is
needed for the open-page preservation guarantee; the tab-loss limitation remains explicit.

### 5.7 Draft stash scope, logout, legacy entries (decisions D4, D5, D7)

**Owner identifier (fixed shared contract).** Add authenticated `GET /auth/me`
(`requireAuth`, `Cache-Control: no-store`) returning
`{ authenticated: true, username, isAdmin, needsSetup: false, userId }`; unauthenticated → 401.
`Auth.ensureAuthed()` uses it **instead of** its existing `/auth/status` request, handling 401
through the existing safe `?next` redirect. No extra round trip. Login/setup keep `/auth/status`
byte-for-byte unchanged, satisfying #279 without an amendment. `users.id` is the stable,
non-secret owner key. The independently approved #279 prerequisite may deliver this shared
endpoint/helper first; #305 reuses it before its owner checks, and #306 reuses the same context.
A 5xx is not treated as logout.

**Key grammar (fixed isolation contract).**

- `swl:draft:u:<userId>:post:<translationKey>:<contextNonce>` — existing post.
- `swl:draft:u:<userId>:new:<contextNonce>` — unsaved post, payload carries `createKey`.
- `swl:draft:u:<userId>:page:<pageKey>:<contextNonce>` — About.
- Generate a fresh context nonce per page load, never copied sessionStorage identity (#138).
  Recovery discovery scans only the signed-in user's matching resource prefix (or new-post
  prefix). Two tabs editing the same post or About never share a writable stash slot.
- These are context prefixes. Physical records append `:record:<recordId>` and are immutable;
  each durable stash generation gets a new random record ID. Write the new record successfully
  before pruning the same context's superseded record. Discovery picks the newest valid record;
  dismissal/adoption names the exact immutable key, not a mutable shared pointer.
  This avoids the localStorage read-compare-remove race: another context can create a new record,
  but can never rewrite the key an adopter is deleting. No CAS is assumed for localStorage.
- Legacy = any `swl:draft:*` key without verifiable owner scope. Leave it untouched; scoped
  keys remain inert to pre-cutover code (§10).

**Rules.**

- DraftGuard reads and writes nothing until the owner id is known; `stashNow` is a no-op before
  that, and it never writes an unscoped key (**I10**). The editor currently creates the guard
  before `Auth.ensureAuthed()` resolves (`editor.html:594` vs `2182`); #306 must reorder or inject
  the owner.
- Content payload remains form text and image URLs/dimensions. The recovery envelope retains
  the captured `expectedOwnerId`, resource/createKey, actual `baseUpdatedAt`, context/record/
  generation, and unresolved attempt IDs with their sent form snapshots/base/generations (§5.2).
  Validate envelope owner against the scoped key and authenticated restoration owner; mismatch
  is quarantined, never re-scoped. These are non-secret correlation fields, not credentials or
  an executable queue; no restore/focus/online event replays them. A later session identity cannot
  change an existing form's owner; stash-then-redirect preserves its original scope.
- On restore probe the resource once: a receipt matching a retained attempt may refresh its
  token without cleaning newer recovered edits. Otherwise use the stash's **actual** base.
  Never substitute the freshly fetched server token under old restored text. Existing-post
  #345 behavior is preserved and **implemented explicitly for About in #306**: stale base
  produces the normal conflict; missing/malformed base is unsafe to save until explicit compare
  and rebase, with the complete local copy retained. #344's page OCC is not this UI fix.
- A restored new-post createKey that exists is adopted only with an own-attempt receipt match;
  otherwise compare, never PUT without a verified base.
- `markClean` removes only immutable record keys captured for the saved generation (own and
  adopted), with exact record/raw-value checks as a corruption guard, never all keys under a
  context/resource prefix. Newer record IDs survive even if written between check and deletion.
  Re-keying writes the destination first and deletes only the captured source after success.
- Conflict Reload first stashes and preserves the local record, then loads the server into a
  fresh context; it must not call markClean on the preserved record. Keep editing and compare
  leave it dirty. About and existing-post recovery receive the same two-tab guarantees as new posts.
- Logout (D4, owner decision): **always keep local drafts**. `Auth.logout()` neither deletes
  drafts nor offers a deletion choice. A 401 or a session ended elsewhere also deletes nothing.
  Per-account isolation still applies after signing in again; retention is not permission for
  another account to read the records. Browser-profile access remains a shared-device risk.

**Legacy unscoped entries (D5).** No ownership evidence exists: payloads carry no user, and no
server record ties a browser key to an account.

- **Quarantine without app-mediated disclosure**, including to admins. No titles, content,
  previews, download, import, restore prompt or account attribution for unknown-owner entries.
  Admin access to server posts does not authorize another person's never-submitted local text.
- Keep bytes unchanged. Release/authoring guidance says save drafts before upgrading and explains
  manual local-profile recovery: the original author/device custodian can back up the browser
  profile, inspect/export the exact legacy storage record in browser tools in private, and
  manually transfer their own text into an authenticated editor. No app code offers those bytes
  to a later login. This is a profile-access residual, not an authentication bypass claim.
- Explicit disposal is an operator/browser-tools action after backup/export and identification
  of exact records; never automatic deletion on upgrade/logout. The app neither scans content
  nor offers deletion of another account's scoped records. Unknown ownership cannot be inferred
  from a username, matching post title, shared resource or administrator role.

### 5.8 No offline write queue (fixed requirement)

Confirmed by this contract: **no** offline write queue, **no** service worker, **no** Background
Sync, **no** IndexedDB file store, and the `online` event never triggers a write (**I12**).
#306's offline banner is informational: Save/Preview/Publish say "will not reach the server" while
`navigator.onLine === false`, editing continues, stashing continues; a request's result remains
the truth when `onLine` is `true`.

## 6. Limits (mirrored by #306 into `docs/authoring-workflow.md`)

The local draft stash and the upload queue are best-effort. They cannot promise:

- **Storage clearing.** "Clear site data", browser cleanup tools, profile resets, or a browser's
  own deletion of script-written storage for sites not used for some days (WebKit's tracking
  prevention does this) remove stashes without notice.
- **Private browsing.** Storage is discarded when the private window closes and may be smaller
  or refused; a stash write can fail silently (`draft-guard.js:51-56`).
- **Quota.** localStorage holds a few MB per origin; a very large story can exceed it, and the
  stash then silently stops updating.
- **Device loss or theft.** Stashes are plain text in the browser profile, not encrypted, not
  backed up, not synced to other devices.
- **Shared devices.** Per-account keys stop the app from *offering* one account's draft to
  another; they do not stop someone with access to the same browser profile from reading storage
  directly. Logout keeps drafts. Use separate trusted browser profiles; any manual storage
  disposal must follow backup/export and identification of the exact records.
- **Unfinished file transfers.** Selected photos live only in the open page. Closing, reloading
  or a crash of the tab, or the phone discarding a background tab, loses the files that had not
  finished; they must be selected again. Photos that finished are on the server.
- **Server truth.** A stash is never proof that something was saved; only the server's response
  or a successful check is.

## 7. Trust boundaries and misuse cases

Boundaries: browser ↔ app (every id, key and `expect` value is attacker-controllable input from
an authenticated session); one browser profile shared by several accounts; tabs of one account
racing each other; proxy/browser replays of a request.

| Misuse | Contract response |
|---|---|
| **Duplicate replay** (double click, browser keep-alive replay, proxy retry, author re-click after Unknown) | POST create → `already_exists` (existence checked before slugs) → receipt probe; PUT → token 409 → receipt probe; upload → existing receipt result or `pending`; PATCH with `expect` → 409 or identical state; folder/move → idempotent. No path re-sends automatically (**I1**). |
| **Cross-user stash disclosure** | Owner/resource/context keys; no legacy content exposed to any account, including admins; no cross-account recovery or deletion UI; documented direct-profile-access limit. |
| **Attacker-chosen `createKey`** | Validated UUID; only ever used as an SQL parameter, advisory-lock hash input and `safePairHash` input — never a path. Create-only: cannot touch an existing pair. Re-creating a deleted post's key inherits nothing: deletion removes rows, revisions, comments and route rows in one transaction and queues route originals by `sourceId` (`posts.ts:1036-1066`); a new route attach gets a new `sourceId`. |
| **Attacker-chosen `saveId` / owner** | Every save route requires expected owner = authenticated session before any write. Receipt stamps use that validated identity; normal 2xx and receipt reads have the same client owner/generation adoption fence. The owner field is not authority and cannot bypass role checks. |
| **Attacker-chosen `uploadId`** | User-scoped UUID, SHA/request identity checked, immutable key/profile; validation before claim; same-ID replay cannot mutate metadata; minimal identity retained rather than unsafe age pruning. |
| **Hostile `expect` values** | Canonical, field-complete expectations can only refuse a conditional write; envelopes contain no old-server mutable fields. |
| **Account switch in another tab** | Post/page `expectedOwnerId` rejects A's form sent with B's cookie before any write; preserve A's form/stash and pause without re-scoping or auto-replay. Normal 2xx and probe adoption use the same owner fence. Upload transfer is limited to explicitly confirmed known-unsent/refused Files with no unresolved attempt; Unknown stays with its original owner. |
| **Stash poisoning via devtools on a shared profile** | Out of the app's control (Limits); a restored stash still passes every server validation on save. |
| **Offline/online spoofing** | `onLine` only changes wording. |

## 8. Invariants

- **I1** No client write whose outcome is Unknown is re-sent automatically; every re-send is an
  explicit action after at most one automatic probe. Server receipt recovery may finish already
  retained work under §5.3's exclusion/admission bounds; it never replays client content/metadata.
- **I2** `POST /posts` never updates an existing pair.
- **I3** A replay of a landed create never surfaces as `duplicate_slug`.
- **I4** `lastSaveId = S` iff attempt `S` is the latest write of any kind to the pair/page and was
  made by the requesting user.
- **I5** The editor never PUTs without a base token and never POSTs a key it did not generate (or
  restore from its own scoped stash).
- **I6** `(user_id, upload_id)` maps to at most one media key and one byte content.
- **I7** A receipt hit never patches metadata or moves folders.
- **I8** A 401 is Refused: nothing was written.
- **I9** No browser storage contains session tokens, passwords or AI keys. Non-secret recovery
  correlation IDs/generations may accompany form text; they never authorize or trigger a write.
- **I10** DraftGuard only exposes the signed-in owner's scoped records and never writes unscoped
  keys. Unknown-owner legacy records are not exposed to admins or other accounts.
- **I11** Cleanup targets the exact saved/adopted record, never a newer record or another context.
  Explicit logout and session expiry never delete local drafts.
- **I12** `navigator.onLine` never decides an outcome or triggers a write.
- **I13** Receipt columns/table are operational, excluded from content dumps/exports/revisions.
  Offline restore explicitly invalidates them, including preserved pages; missing then means Unknown.
- **I14** `expect` can only make a PATCH fail.
- **I15** No 401 on the media page navigates away.
- **I16** Post/page route writes, receipt stamps and both normal-2xx/probe adoption are fenced to
  the immutable form/attempt owner. Account switch never re-scopes A's form or cleanup to B.
- **I17** Queue saturation retains a new original as `failed/queue_full`; bounded receipt
  recovery has drain-triggered and explicit admin entry points. GET never enqueues, and a complete
  validated retained original never requires byte resend merely to finalize its receipt.

## 9. Security, privacy and documentation impact

`SECURITY.md` (high-risk change; #305/#306 update it in their PRs):

- *Sessions*: unchanged HttpOnly/SameSite cookie, fixed TTL, no renewal; `/auth/status` unchanged.
  `/auth/me` exposes only the caller's non-secret identity under auth/no-store and replaces the
  protected-page context read. No credentials enter storage.
- *Writes*: validated create-only identities; per-request captured-owner checks before post/page
  and upload writes; atomically read writer-only receipts and owner-fenced acknowledgements;
  immutable user-scoped upload identities retained for account lifetime, no age-based takeover;
  qualified filesystem process exclusion alongside existing DB/restore ownership; bounded receipt
  recovery and explicit offline-restore invalidation; receipt GET is read-only/auth/no-store.
- *Media*: recommended `PATCH /media/items/*` preconditions; 409 bodies use `serializeMedia`, so the
  GPS/uploader redaction for non-admins is preserved.
- No new unauthenticated surface, no new outbound request, no new secret.

`ARCHITECTURE.md`: schema additions (four nullable columns, one operational table), the write
classes table, and the backup exclusion list. `docs/authoring-workflow.md`: Limits (§6) and the
Outcome-unknown / session-ended behavior (#306). `CLAUDE.md`: a Done entry when implemented.
UI: admin pages only, Editorial desk styling. **All new copy is added in both locales to
`site/src/i18n/ui.ts`** and delivered through the existing generated `EditorCopy` convention
(extend its dictionary exposure for these consumers, not a second hardcoded copy system).

## 10. Compatibility, migration, rollback

- **Schema:** additive/idempotent; null receipt means no evidence, never proof of non-commit.
  Required IDs/expected owner and conditional envelopes are a clean cutover: new server refuses
  old write shapes before mutation. Internal importer writes remain explicitly receipt-less.
- **Dumps/restore:** no dump version bump for operational receipts. Stop app/encoders before
  CLI restore, clear all post/page receipts and `upload_receipts` in its content transaction,
  including a v1 restore preserving pages; rollback of that transaction also rolls back
  invalidation. Supported raw SQL restore procedures must perform the same offline invalidation
  before traffic resumes. Re-authenticate, reload server state and retain local edits; old
  attempt IDs now yield Unknown, never a fresh-upload authorization.
- **Mixed-version media writes:** the nested conditional envelope reaches an old handler as
  an empty patch. Missing `conditionalVersion: 1` is unsupported, not a clean save. No fallback
  sends top-level fields; include an old-server compatibility regression. A capability probe
  alone does not protect a request racing deployment.
- **Other mixed-version writes:** old servers ignore IDs; no online-safe rollback is claimed for
  post/page/upload writes. Containment is an offline maintenance cutover: stop admission and drain/
  terminate all writers, invalidate sessions, deploy compatible client/server code together and
  require authenticated reload before enabling writes. Never use ignored fields or a capability
  preflight as proof of write safety. Rolling back to pre-contract code forfeits its receipt
  semantics and is not a supported way to continue unresolved attempts; retain local data and
  roll forward to compatible code to reconcile them. Media additionally fails closed per request.
- **Stashes:** scoped records are preserved across rollback; older UI cannot recover them.
  Preserve/export work before reload; never clear recovery records as a version-fix shortcut.
- **Containment:** stop incompatible writes and deploy a compatible roll-forward image. Do not
  downgrade any codec/profile introduced by #347. Additive receipt schema stays in place.
  A rollback to pre-contract code requires stopping writes, retiring open clients and preserving
  local recovery data; it is not advertised as an online safe revert. Receipt/storage uncertainty
  remains Unknown instead of a success claim. No manual destructive schema/data rollback.

## 11. Dependency contracts

- **#305** implements §5.1–5.4, §5.6 and outcome rules, reusing the shared `/auth/me`/protected-page
  helper from §5.7 if the independently approved #279 prerequisite has already delivered it.
  It retains unresolved attempt generations in memory and offers preserve/compare before #306.
  It must not persist this bookkeeping under unscoped legacy keys while awaiting #306's envelope.
  Lands before #306 and #317.
  Owns the bounded server receipt reconciler and its capacity/Rescan triggers plus terminal
  deletion invalidation. These do not replace #348's media queue recovery or authorization.
- **#306** implements conditional media callers, owner/resource/context stashes, exact-record
  cleanup, About base safety, offline UI and Limits. It reuses #305's identity and reconciliation.
- **#345** independently implements post stash-base safety only; keep it, do not claim it fixes
  About. **#344** independently implements page OCC; page receipts join that existing transaction.
- **#348** independently implements retained-original `failed/queue_full` recovery for new keys,
  existing-key status restoration and same-key admission. Integrate those exact semantics before
  receipt finalization; #305 adds bounded pending-receipt recovery/finalization, which #348 does
  not provide. **#347** roll-forward-only codecs/profile identity remain mandatory.
- **#362** single-flight per tab lands first/with #305. An Unknown response may still represent
  a live server request, so it does not justify dropping older unresolved attempt identities.
- **#297 is owner-approved (2026-10-28)** with durable attempt history; **#316 is owner-approved
  (2026-10-28)** with content comparison, measured Media pending counts and its precise §8.5
  #318 AC4 amendment. #297 owns rebuild/publish/unpublish/delete reporting; #316 owns publication/
  Media projections, not save receipt identity. Their optional status-enrichment failures must
  not discard an acknowledged save, and #304's owner/generation fence qualifies normal token/
  mark-clean adoption for post/About consumers rather than adding a second publication resync.
  The #318 amendment restricts new non-admin `impact` to enumerated metadata keys with no location,
  camera or uploader fields and omits `livePending`; existing whole-item GPS/uploader null values
  and camera/lens/capture access remain unchanged. Exact projection-key and existing redaction
  tests remain required. This is not a broader privacy change or an approval of #304.
- **#397 is separately owner-approved**, not awaiting another policy decision; integrate its
  post-promotion pruning boundary before #297. **#361** unpublish token work is independently
  implemented; preserve its receipt-clear/token behavior rather than duplicating it.
- **#302/#299** pagehide stashing rebases onto context keys and exact-record cleanup.
- **#278/#279** use unchanged `/auth/status` and the shared protected-page `/auth/me` helper;
  no identity API conflict or additional context request.
- GPX writes keep their approved reconciliation; touchPostPair invalidates save receipts.

## 12. Acceptance verification (for #305/#306; nothing has been run for this spec)

Full acceptance is preserved; these are planned tests, not executed results.

**#305 AC1–AC6:**
- Route + editor DOM: create commit/drop and replay with empty/non-empty slugs, concurrent same-key
  requests, old request committing after a 404/probe and explicit retry → exactly one pair.
- Post/About PUT: atomic response snapshot barrier, commit/drop, probe before late original commit,
  second attempted Save and 409 → recognize the retained original ID, adopt the correct token,
  preserve later form generations; foreign write → compare without clearing local work.
- Post/new-post/About account switch: load/restore as A, switch cookie to B after startup or even
  after a preflight, then Save → 403 `owner_changed` before **any** write/rebuild; A's form,
  attempts and stash survive, no B receipt or A-record cleanup. Cover normal 2xx and GET owner/
  saveId acknowledgement mismatch, a response authenticated as A arriving after detected switch,
  B as author/admin, and explicit return to A; no focus/login replay or cross-account re-key.
- Folder/move: success/drop with active filters and pagination excluding moved keys → one bounded
  selected-key lookup shows all actual stored folders/missing keys; unavailable lookup stays
  Unknown; no duplicate folder or false failure claim.
- Upload: lost accepted response then Retry/check → one media row/variant set and transfer done.
  Cover ready duplicate, active and inactive processing duplicate, new and prior failed row,
  original-write failure, new-key queue-full retaining row/original as failed, existing-key prior
  status restoration and inactive-processing recovery under the same-key guard, status-settle
  failure, crash at every receipt/storage/enqueue boundary, accepted processing across restart,
  deleted media, late initial request after retry generation advancement, hash/metadata/profile
  mismatch, UTC-year/profile changes and old receipts. Fill the queue before startup receipt
  recovery, then drain it → deferred receipts finalize without bytes resend; cover more than 100
  receipts, fair cursor progress, coalesced/lost-wakeup races, DB/finalization failure followed by
  explicit admin Rescan with no active encoder, and read-only repeated GETs. A delayed live writer
  cannot be reclaimed at any age; replacement cannot start while ownership lock is held.
  404/other-owner/restore invalidation never authorizes retry. #348 recovery stays intact.
- Mid-batch 401: no navigation/landed-record loss, explicit same-owner resume; account switch can
  transfer only unsent/refused items, not unknown originals; re-login A resolves A's retained IDs.
  Every inline upload caller has the same receipt contract. Browser storage contains no credentials.

**#306 AC1–AC7:**
- DraftGuard vm + editor DOM: B (author **or admin**) sees none of A's scoped/legacy content;
  legacy bytes survive quarantine and logout. No title/download/import disclosure.
- Same-user two tabs for **new post, existing post and About**: independent keys; B saving before
  its debounce cannot erase A; concurrent stashing cannot overwrite A; adopted source edited later
  survives B's save; unchanged exact saved/adopted records alone may be removed.
- About stale-base restoration conflicts; missing/malformed base cannot borrow loadPage's token;
  compare/reload retains recoverable local text, including both locales/images. Existing #345
  post behavior remains covered. Two saves against one base produce conflict without data loss.
- Offline banner and Save wording preserve dirty state; online/focus triggers no write.
- Conditional media: stale fields conflict, unrelated fields survive, canonical duplicate tags/
  controls/limits compare correctly; unknown outcome re-reads once and shows stored values.
  Cover single/bulk Media AI and no automatic replay. Old-server envelope performs no mutation;
  missing version acknowledgement preserves local edits; old client against new server is refused.
- Multi-user invariant note and documented Limits are updated; all new dictionary keys have DE/EN.

**Shared server/recovery gates:** writer-only receipt read; every non-save token bump clears it;
dump exclusion; explicit CLI/raw-procedure restore invalidation including v1 preserved pages;
`/auth/status` unchanged, `/auth/me` auth/no-store and one context request; selected-key lookup
auth/size/key validation; response redaction, required-ID refusal and media-envelope rejection.

**Acceptance wording requiring explicit owner amendment:** No named #305/#306 AC is weakened.
#305 scope's raw-equality mechanism is replaced by receipts to satisfy its own-landed-write AC.
#306 scope's “form text and image URLs only” must explicitly permit the non-secret recovery
envelope (captured owner/base/createKey/attempt IDs/context/generations and associated snapshots). It does
not permit credentials, queued actions or automatic replay. #304/#306's assumption that media
OCC necessarily needs a revision column/dump bump is corrected by field preconditions; the
owner's concurrency-versus-last-writer-wins policy choice remains. #279 needs no amendment.

Parent implementation verification: uploader typecheck/full suites including real Postgres,
site astro check/i18n tests, browser offline/request-drop and same-user two-tab cases, session
switch during upload and post/page save, qualified macOS/DHI filesystem-lock contention and
process-death recovery, bounded receipt drain/explicit-rescan recovery and mixed-version smoke.
No verification is run while editing this unapproved specification.

## 13. Self-review (devil's advocate)

- *Is a client-chosen primary identity dangerous?* It is accepted only as a fresh create, never
  as an update, is validated, and never reaches a path. The worst forged case (re-creating a
  deleted post's key) inherits no state. Residual: a forged key equal to a live post's key gives
  that author a 409 — no disclosure beyond what `GET /posts` already gives authors.
- *Could receipt adoption overwrite newer edits or cross accounts?* Only atomically returned
  content/token/receipt and matching form/attempt/response owners are used. Normal 2xx has the
  same fence; a startup lookup cannot prevent a changed cookie. Retained generations protect
  newer edits. A foreign later write requires compare, not adoption.
- *Can a timeout prove a writer is dead?* No. A qualified native lifetime lock is a prerequisite,
  not supplied by the current PG lock. Without that prerequisite, automatic upload reclamation
  cannot ship. Unresolved post attempts remain recognizable after a late commit.
- *Can full-queue pending receipts get stuck after startup?* #305 owns bounded drain-triggered
  reconciliation plus explicit admin Rescan for errors/no active jobs, with fair scan progress.
  GET is deliberately inert. Retained originals/profile evidence finalize without retransmission.
- *Does quarantine lose work?* Bytes remain intact. No account is granted unknown-owner text;
  manual private profile recovery/disposal is documented without an admin exception.
- *Field preconditions vs ABA*: if a field went A→B→A in another tab, the precondition passes.
  The author's view of that field was correct at save time, so no information is lost.
- *Stall watchdog false Unknowns*: a slow but progressing upload never trips it (progress
  resets the timer); an Unknown costs one probe.
- *Two tabs adopting the same record:* each gets a new context key and retains the immutable
  source identity. Their own subsequent edits and cleanup cannot erase a newer source record;
  create-only/OCC still serialize server mutations.

## Owner decisions

Explicit owner answers recorded 2026-10-29:

| ID | Approved decision | Remaining constraint |
|---|---|---|
| Auth context | Approve read-only context independently for #279. | Authenticated, no-store `GET /auth/me`; migrate the existing protected-page helper. Login/setup/`/auth/status` unchanged; network/5xx are not logout. |
| D1 | Approve the write contract. | Required create-only identities, captured-owner fences, writer-only receipts, consistent reads and fail-closed compatibility remain inseparable. |
| D2 | Approve qualified native locking. | Account-lifetime minimal upload identity retention; prove native API, packaging and development/CI mount/process-lifetime exclusion before dependent implementation. The approved sequencing amendment below retains actual deployment-mount qualification before deployment or enablement. No PG-only substitute, age-based takeover or expiry-as-failure. |
| D3 | Approve explicit resume. | Pause in place, second-tab login, explicit same-owner resume; another owner may take only known-unsent/definitely-refused files with new IDs. No persisted File queue. |
| D4 | **Always keep drafts.** | No logout deletion choice; logout and expiry delete nothing. Private browser-profile access remains a disclosed risk. |
| D5 | Approve private quarantine. | Unknown-owner legacy bytes stay unchanged and inaccessible to every account, including admins; recovery/disposal is private manual profile work. |
| D6 | Use field preconditions. | Canonical expected-value comparison and the fail-closed envelope apply to all Media PATCH consumers, including AI. |
| D7 | Approve recovery metadata. | Explicit #306 amendment permits non-secret owner/base/attempt/context/generation metadata and snapshots alongside form text/images; no credentials, executable queue or automatic replay. |

These approvals do not weaken #305/#306 acceptance criteria, authorize automatic writes, or
waive the implementation security changes in §9 and containment requirements in §10.


## Evidence sources

Read at `11e16d1` in this worktree: `uploader/public/{draft-guard.js,editor.html,about.html,
media-api.js,media-browser.js,media-picker.js,auth.js}`, `uploader/src/{server.ts,posts.ts,
pages.ts,post-pair-lock.ts,sessions.ts,authn.ts,users.ts,media-store.ts,storage.ts,db.ts,
backup.ts,gpx-store.ts,gpx-files.ts,gpx-routes.ts}`, `site/src/lib/postgres-loader.ts`,
`SECURITY.md` (sessions, AI keys), `docs/authoring-workflow.md`,
`docs/superpowers/specs/2026-10-23-gpx-route-import-design.md`; issue records #297, #299, #303,
#304, #305, #306, #344, #345, #362 and #279. No tests, builds or external scripts were run for
this proposal.

Repair evidence: full `CritiqueOnboardResilience` and cached #304/#305/#306 (including the
legacy-cleanup comment) and #348 were read, alongside the actual auth/DraftGuard/About/upload,
media PATCH/canonicalization/AI, atomic post-state read and restore consumers. These findings are
static source facts, not reproduced runtime failures. Critique finding 2 (onboarding restore
provenance) is owned by #278; this contract composes with its retire-before-restore rule and
independently invalidates receipts. Other critique corrections are incorporated above.

2026-10-28 repair evidence: read the complete proposal and archived
`ReviewOnboardingWrites-review.md`; inspected actual #348 `server.ts:490-618` and
`encode-queue.ts:250-288`, not just the older issue wording. Inspected this worktree's
`storage-owner.ts`, uploader dependency manifest/lockfile and Dockerfile, and the current #297/
#316 approval records including #316 §8.5. Native lock/API/platform sources are linked in §5.3.
These are static source/documentation findings only: no runtime, app code, dependency, test,
build, image inventory or filesystem-lock experiment was changed/run. Return this proposal for
independent full re-review; it is not implementation-ready until the specified prerequisite and
owner gates are satisfied.

## Approval

Owner approval was given in this execution session on **2026-10-29** through the eight explicit
answers recorded above. The selected D4 policy supersedes the earlier Keep/Delete recommendation
throughout this contract. The narrow authenticated-context approval permits #279 to reuse the
shared endpoint/helper before the broader write work.

The native filesystem-lock selection, packaging and development/CI mount/lifetime evidence
in §5.3 remain an implementation prerequisite; policy approval and static review do not
satisfy it. The separately approved sequencing amendment below moves only actual
deployment-mount qualification to the pre-deployment/pre-enablement gate.
Implementation must update `SECURITY.md` as specified in §9 and preserve §10's containment.
No merge, deployment, production restore or owner-data mutation is authorized by this approval.

## Native-lock qualification status (2026-10-29)

The earlier static-research limitations are supplemented, not silently waived, by retained
runtime evidence. Native macOS arm64/APFS proof is recorded in the execution ledger.
[Native CI run 40866450527](https://github.com/laboef1900/simonswanderlust/actions/runs/40866450527)
passed on native amd64 and arm64 Linux hosts at harness head
`df888364570079b87039eaa7823f7c1da9ba51ae`, using frozen product source
`57cd3cc517e1e5a964e85463b26529ae1a8aacc5`. Both local bind mounts and Docker local named
volumes had inspected ext4 backing. The pinned DHI Node 26.12.1/glibc 2.41 runtime ran
non-root, without the build-stage compiler or downgraded build-stage shared libraries.

Each mount/architecture report exercises live/stopped-owner contention, clean close,
process death, ordinary-child noninheritance, deliberate descriptor inheritance, actual
PostgreSQL backend termination without loss of filesystem exclusion, and app/restore
admission/release order. Independent-container peers contend on the same inode.
Independent review found no confirmed defect in those bounded results. Forced ENOLCK and
a deliberately non-CLOEXEC rejection probe were not exercised; no NFS/SMB/FUSE, musl,
Docker Desktop shared mount or uninspected deployment mount is qualified by these results.
Artifacts remain in the gitignored ledger's `issue-304-native-ci-40866450527/`.

**Owner-approved sequencing amendment, 2026-10-29.** The owner explicitly selected
“Approve sequencing amendment” after reviewing the proposal at PR #470 head `8d8b409`
and its operational, rather than mechanically enforced, deployment restriction.

### Approved sequencing amendment

#305 implementation and review may proceed against the already exercised native binding,
packaging and development/CI filesystem contract. Actual target-mount qualification remains
mandatory **before any deployment or enablement**. This changes only the timing of the
existing target-mount gate, not its tests or required outcome. It authorizes no merge,
release, deployment or enablement, and defines no deployable-but-disabled mode.

PR documentation must name the exact tested platforms/filesystems and
unqualified deployment target. The app/restore entry points must still hold the native lock
before admission, preserve the PG/session fence and lock order, fail closed on acquisition
or ownership failure, never unlink/replace a held lock inode, and never substitute receipt
age or PG availability for exclusion. No automatic-recovery deployment may be described
as supported until its actual mount passes the same process/descriptor/DB-loss/restore
matrix with the selected binary.

Risk: integration could otherwise be mistaken for production approval, or CI ext4 results
could be overgeneralized to different storage. The postponed qualification gate is
**operational, not mechanically enforced**: successful runtime lock acquisition does not
detect or approve an unqualified mount. Containment is explicit deployment restrictions,
platform-specific evidence and withheld deployment authorization, alongside the unchanged
runtime ownership safeguards. Before deployment qualification, the owner must provide an
authorized disposable target directory on the actual deployment filesystem; no existing
production content is a qualification fixture.

## #305 implementation integration and qualification handoff

Implementation notes, **not a passed qualification record**. The implementing worker did not
run builds, tests, typechecks, formatters, containers or browser sessions. The parent owns the
single combined qualification wave and subsequent independent review. The inherited #304
platform evidence above remains binding; it is not evidence that this integration or the
actual deployment mount passed.

### Source boundaries and acceptance map

| Acceptance | Implementation boundary | Added/updated regression evidence to execute |
|---|---|---|
| Create-only UUID post identity; empty slugs do not merge independent attempts | `server.ts` validates canonical create identity; `PostSaveOptions.createOnly` checks inside memory/PG serialization before slug collision checks | `write-receipts.test.ts`, raw protocol cases in `server.test.ts` |
| Required captured owner/save ID, writer-only latest receipt, atomic read projection | `posts.ts` repeatable-read projection and `pages.ts` single-query projection; owner fence before content/revision/build writes; no-store responses | `write-receipts.test.ts`, `server.test.ts`, `write-recovery.test.ts` |
| Every competing writer invalidates evidence | `touchPostPair`, receipt-less importer saves, publish/unpublish/language transitions, page saves; offline restore clears preserved v1 pages too | `write-receipts.test.ts`, real-main GPX receipt invalidation in `gpx-main-boot.integration.test.ts`, `backup.integration.test.ts` |
| One bounded probe, no automatic write replay, late own-save recognition | `write-recovery.js` retains unresolved attempts and exact snapshots; unavailable probes allow only manual Check again; ordinary acknowledgements use the same owner/generation gate | `write-recovery.test.ts`, `editor-dom.test.ts`, `language-admin-dom.test.ts`, `editor-gpx.test.ts` |
| Preserve-and-compare without cleaning newer edits | Shared controller compares current form, attempts and stored text; stored-version adoption creates a separate recovery context first and refuses if preservation fails | `write-recovery.test.ts` includes newer edits, older late attempt, A→B late acknowledgement retention, quota failure and private legacy bytes |
| All upload entry points use immutable account-scoped identities | `media-api.js` plus `upload-recovery.js`; Media, editor hero/body, About body and title-image consumers; newer hero selection/title alt/framing are preserved | `media-api.test.ts`, `upload-recovery.test.ts`, inline adoption cases in `editor-dom.test.ts`; real-browser all-caller gate below |
| Durable upload state, frozen hash/profile, account-lifetime identity, terminal deletion | `upload-receipts.ts`, `upload-service.ts`, user FK cascade, receipt/media deletion transaction and #348 same-key admission | `upload-receipts.integration.test.ts`, `upload-service.test.ts`, existing #348 server/queue regressions |
| Deferred recovery and crash boundaries | One startup page, coalesced capacity wakeups, keyset continuation, explicit Rescan after uncertainty; GET never enqueues; accepted and retryable counts are distinct | `upload-service.test.ts`: queue-full retained original, delayed finalization, positive absence, failed original write, corrupt original, ready-without-original and >100 receipts |
| Native lifetime ownership, filesystem-before-PG admission, no lease fallback | `data-owner.ts` wraps the qualified owned N-API binding; main and offline storage-writing CLI paths hold its descriptor until explicit quiescence/exit | `data-owner.integration.test.ts`, strengthened real-main PG-loss/restore test in `gpx-main-boot.integration.test.ts`; native production-image matrix below |
| Folder/move reconciliation independent of visible pagination | Bounded reads; one no-store, authenticated `/media/lookup` query for 1–100 keys; explicit missing entries; per-operation panels survive list refresh | `server.test.ts`, `media-browser-dom.test.ts` (lost create, incomplete lookup, malformed 2xx, later filter change) |
| Paused Media batch, explicit same-owner resume and no persisted Files | Queue pause is distinct from in-flight evidence; focus/login never replay; Unknown cannot transfer; page-exit warning remains active | `media-api.test.ts`, `upload-recovery.test.ts`, parent second-tab/browser scenarios |
| Strict bootstrap/restore compatibility | `onboarding-bootstrap.ts` extends the merged #280 catalog with exact receipt and actual #288 page/navigation types, defaults, nullability, CHECKs, indexes and FK semantics | `onboarding.integration.test.ts`, `backup.integration.test.ts`; parent supplied exact disposable PG18 receipt and page/navigation catalogs; unrelated journey tables are not admitted |

The local stack integrates the actual #348 queue-recovery branch and actual #280
empty-state/language-catalog branch (including #285 public-output work), rather than copying
their patches. #284's consent race fence is retained as
`PostSaveOptions.baseLanguageUpdatedAt`; there is no Date/options compatibility overload.
The actual #288 generic-page branch is integrated, not copied: all four registry keys use
the same page receipt/options contract, generic editor and upload identity. Publish,
unpublish, deletion and language activation invalidate receipts. Draft saves do not build;
committed actions use #297 HTTP 200/projected build outcomes, while real 5xx remain Unknown.
The merged generic-page lifecycle/DOM tests, `write-receipts.test.ts` and strict bootstrap
tests cover those integration boundaries; no worker execution is claimed.
The actual #369 dependency/proxy branch (including the #347 sharp security floor) is
also integrated. Every server construction chooses its immediate-peer trust policy;
native filesystem ownership is not a substitute for proxy/topology qualification.
The owned addon build and production packaging remain in place alongside those locks.
#306 retains ownership of conditional media PATCH/offline/full conflict-dialog work; it is
not a deferral of the preserve-and-compare behavior implemented here.

### Parent qualification commands and scenarios

Use Node 26 and the parent's isolated PostgreSQL 18 fixture, never a content database.
Keep the parent's already-qualified `pg_dump` wrapper on `PATH`. With the appropriate
`TEST_DATABASE_URL`/`DATABASE_URL` already exported:

```sh
# Working directory: uploader/
npm ci
npm run build:native
npm run typecheck
npm test

# Working directory: site/
npm ci
npm test
npx astro check
npm run build
```

`build:native` uses `.github/native-owner/` and pinned Node 26.12.1 headers; CI builds
the binding before uploader tests. The qualified `owned-flock.c`, `build-native.mjs`
and `container-toolchain.mjs` were moved byte-for-byte from the temporary #304 packet.
Their SHA-256 identities are respectively:

- `ac6ee84b387ff60b2d28f6dc8260f358f338eade17eaec207f27c05805d1ab47`
- `ee5a282642f000e07d02f2848c3a73fde07902ef7b9c13876f95399f88f5014c`
- `ecff9a333a190a33c2e06c2b72d8e7f7d40360eafde20d5a1b4876c976b9a77b`

Their historical qualification comments and `/proof` scratch path remain intentionally
unchanged. The production Dockerfile retains the qualified DHI index digests and Debian
snapshot, builds in a separate stage, and copies only the native artifact, ABI/build record,
header/license provenance and license into the runtime. It removes the uploader native
build driver and test tree before copying the uploader runtime.

The temporary #304 workflow, frozen-source harness, proof workers, image inventory and
diagnostic-export helpers have been removed from active source. Canonical private
qualification artifacts and historical PR #470 remain unchanged. Necessary descriptor
boundary/lifetime coverage now lives in `data-owner.integration.test.ts`: invalid arity,
types/ranges, closed/non-file descriptors, live and stopped contention, clean close,
SIGKILL, stable inode, ordinary-child noninheritance, explicit-inheritance last-close
negative control and cleanup after PG admission refusal. Existing real PG-loss and
main/offline-restore drain tests remain in the product suites. Forced ENOLCK and a
deliberately non-CLOEXEC rejection probe remain unexercised, as in the inherited record.

Permanent `owned flock · native amd64` and `owned flock · native arm64` jobs in `ci.yml`
use the current checkout, standard public native Ubuntu runners and their own disposable
Postgres service. They retain the public/same-repository guard, require no DHI credentials,
and upload no fixtures/logs/artifacts. Existing required uploader/site job names remain
unchanged. Host-runner results cannot qualify the packaged DHI runtime or a deployment
mount; production-image integration below remains a separate parent-owned gate.

The combined parent wave must additionally exercise:

1. Lost post-create, post-update and every registered page-key response (About, Contact,
   Privacy, Legal); older late commits after a missing read; malformed/failed reconciliation;
   normal acknowledgements arriving after newer text;
   another writer's save; explicit compare/Use stored and recovery-storage failure.
2. A→B in a second tab before sending and while a response is in flight; exact owner/receipt
   envelopes, preserved A-scoped copies and late A acknowledgement evidence; logout/expiry,
   two same-owner tabs, private legacy records and explicit same-owner resume.
3. Real multipart Media, hero, body, About and title-image uploads: lost response, 120-second
   no-progress/response watchdog, one receipt read, manual checks, retry generation, immutable
   profile/year identity, queue-full drain, account deletion and media deletion. Keep an Unknown
   file while switching accounts; no request may transfer it or persist its `File`.
4. Receipt/media transaction failures and process kills before/after original rename, enqueue
   and receipt commit; >100 pending receipts, blocked keyset continuation, coalesced wakeups,
   shutdown during issued I/O, missing/corrupt originals and a complete ready image without its
   original. GET must remain inert in every state.
5. Folder ensure and bulk move lost responses while changing folder/search/status/page;
   target/other/deleted/incomplete lookup outcomes and explicit-only retries.
6. Build the **actual production image** on each already-qualified native DHI architecture;
   rerun descriptor/inode/CLOEXEC/ordinary-child/SIGKILL/PG-loss/app-versus-offline-restore
   exclusion using the packaged binding and real main/CLI entry points. Do not replace this
   with a helper lease or infer deployment support from a successful local lock.

The actual deployment mount is still unqualified until its separately authorized disposable
directory passes that matrix. No release/deployment/enablement permission follows from these
source changes, tests being present, or a green combined CI run. Containment and rollback are
documented in `SECURITY.md` and `ARCHITECTURE.md`: stop writers first, keep backups and receipt
evidence, never delete the stable lock inode, and do not roll back only one side of this
fail-closed client/server protocol.
