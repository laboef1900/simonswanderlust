# Truthful failed-publish and failed-rebuild reporting (#297)

Date: 2026-10-27. Risk: **High** (publish pipeline, `/data` layout, admin-visible build data).
Status: **OWNER APPROVED 2026-10-28 — durable attempt history.** The owner approved the corrected
high-risk contract, security and containment plan in this implementation conversation. Implementation,
integration and verification remain required; no deployment or owner-data mutation is authorized.
Parent epic: #294. Natively blocks #316, #317 and #318. Consumes independently implemented #361
(unpublish token echo). Requires separately approved and landed #397 first; related: #303/#305 (lost responses).
Baseline: `origin/dev` @ `11e16d1`.

This spec defines the **last-build/last-attempt record** (fields, durability, redaction) that #316
consumes without redefining. It also defines what every admin action says about *persisted*
state (Postgres) versus *promoted* state (the `current` release). It adds no publication behavior.
A failed build never rolls back a database publish, and nobody gains permission to publish.

## 1. Verified current behavior

All references are to `11e16d1`.

- `POST /posts/:tk/publish` commits `posts.publish()` (`uploader/src/server.ts:1647`), then
  awaits `builder.build()` (`:1653`) and answers `{ published: true, build, updatedAt, altAudit }`.
  The builder never rejects. At this baseline `runOnce` turns every failure into
  `{ ok: false, error: message }` (`uploader/src/build.ts:247-249`), and `buildAndDeploy`
  flips `current` after a complete release exists (`build.ts:191-208`). Failures **before**
  that flip preserve the previous release, if any. Post-flip pruning can currently report
  failure despite promotion; independently approved #397 must correct that before #297 lands.
- `editor.html:1856-1860` returns on `build.ok === false` **before** `isPublished = true` and
  `loadedUpdatedAt = body.updatedAt` (`:1863-1864`). The publish bumped `updated_at` through
  `touchPostPair` (`posts.ts:1004`), so the next Save sends a stale token and gets a false 409.
- `about.html:174` returns before `guard.markClean(snap)` and `loadedUpdatedAt = saved.updatedAt`
  (`:176-177`). The page persisted (`server.ts:1965`), so the result is a ghost dirty state and a
  false 409.
- The editor's Unpublish handler (`editor.html:1893-1901`) ignores `build` entirely, so a failed
  unpublish rebuild reads "Unpublished" without explaining that the CMS change may not be
  reflected on the live site. The story was not necessarily live beforehand. Its separate
  stale-token defect is **#361**, independently implemented; this spec consumes its token
  contract (§8) and does not redesign or re-gate it.
- `posts.html:171-174` `describeBuild` prints `' Rebuild failed: ' + build.error` without saying
  what persisted. Unpublish, delete and bulk all use it (`:257`, `:286`, `:366`).
- `settings.html:1437-1441` prints `r.error`. `cli.ts:319` throws `outcome.error`.
- `build.error` carries up to 4 KiB of ANSI-stripped child stderr (`build.ts:112-117,137-139`).
  `SECURITY.md:859-862` documents this as intentional, returned "to the authenticated caller".
  #297 requires that this tail **not** reach browsers.
- Nothing records an attempt. `/health` exposes only `release: boolean`
  (`server.ts:1842-1847`), and the Desk shows only "View live site" or "No live release yet"
  (`index.html:204-217`, `desk.js:25-35`). After a reload or restart, a failed build leaves no
  trace beyond the container log.
- Builds start from publish, bulk, unpublish, delete-of-published, `PUT /pages/:key`,
  `POST /rebuild` (also driven by `cli.ts rebuild` over loopback) and `bootstrapRelease` on a
  fresh volume (`main.ts:213`). Every HTTP trigger is already `requireAdmin`.
- Storage-lease loss or shutdown (`quiesce`) aborts the build through `work-cancellation.ts`. The
  build then rejects with `StorageReadOnlyError`, and lease loss forbids every later mutation,
  including cleanup (`build.ts:199,202`).

## 2. Scope

**In scope:** a builder-side failure classification; one action-response `build` report used by
every route that starts a build; a durable, admin-only last-attempt record; an admin-only status
route; Desk and Settings display of that record; client token and dirty-state sync on every
successful mutation acknowledgement; persisted-versus-live wording on publish, unpublish, delete, bulk, About and Rebuild; the
route-level failing-build test; the `SECURITY.md` and `ARCHITECTURE.md` updates.

**Out of scope:** rolling back the database publish; new publish semantics; per-post or Media
publication-state indicators (#315/#316/#317/#318); lost-response reconciliation (#303/#305);
the post-flip prune misreport (#397); the unpublish token echo (#361); any change to `/health`;
public-page markup or copy; retrying builds automatically. Shared admin copy in
`site/src/i18n/ui.ts` changes in both DE and EN; the public page design remains unchanged.

## 3. Approvals and resolved design points

### 3.1 Material owner approvals (exactly these)

1. **This high-risk spec as a whole**, including the rollback/containment plan (§13) and the
   `SECURITY.md` reconfirmation (§14). The reconfirmation changes one documented property:
   `SECURITY.md:859-862` says the stderr tail is returned to the authenticated admin, and #297's
   scope requires that it no longer reach any browser. The tail stays in the container log.
2. **Durable last-attempt state on `/data`** (§5.4): one new file, `/data/site/build-state.json`.
   It is an addition to the `/data` layout, which repository policy classes as high risk. The
   issue requires the spec to choose between durable state and explicit unknown-after-restart.
   **Recommended: durable**, because a container OOM or restart mid-build is otherwise invisible
   and that is the failure this record exists to show. The one alternative is **in memory with a
   defined "no rebuild attempted since the app started at {bootAt}" state**; §5.4, §6.2 and §12
   specify it completely, so approving it changes no other section.

### 3.2 Resolved from the issue and repository (not owner questions)

- **Browser diagnostics:** fixed code plus localized dictionary copy (§4 and §6.1). The issue forbids exposing the raw
  stderr tail; a parsed `de/<slug>` hint is rejected in §9 (it would reintroduce parsing of
  untrusted build output, the #91 lesson).
- **Exposure:** a new admin-only `GET /rebuild/status`, following the existing `GET /import/status`
  pattern. `/health` is public and stays unchanged (§9).
- **Copy:** §6.1/§6.2, approved as part of item 1. The issue fixes which facts each
  message must name; its example wording is qualified where no previous release/story exists.
- **`triggers` field:** included (§5.1); small enum, no new trust boundary.
- **CLI output:** code plus fixed copy plus a `docker compose logs app` pointer; it is a consumer of
  `POST /rebuild` and inherits the same redaction.
- **Unpublish token echo:** owned by **#361** (normal risk, no design gate). This spec consumes its
  contract and adds only the build reporting.

### 3.3 Explicit gated dependency: #397

#397 (post-flip prune reported as failure) is a separate high-risk prerequisite, **owner-approved
on 2026-10-28** in this implementation conversation. Its approval is recorded in
`2026-10-27-issue-397-promoted-release-pruning.md` in the #397 worktree. It must be implemented
and integrated before #297; no second approval of #397 is required. This spec neither implements
nor broadens it. Successful `rename(tmpLink, current)` is the irreversible promotion boundary.
After it resolves, pruning, lease loss, record persistence or optional status-read failure
cannot turn that promotion into `ok: false` or a `failed` attempt. #397's cleanup warning is
**log-only**; no warning payload, UI warning, new retention policy or cleanup retry is added here.

## 4. Builder failure classification (internal)

For failures **before successful promotion**, `runOnce` maps the thrown error to a code using
the **error class and errno only**, never the message text. A refusal before a run starts is
also a failure, but does not replace the last attempt (§5.5). Post-promotion housekeeping and
observation errors never enter this classification.

| Code | Source | Fixed copy (`message`) |
|---|---|---|
| `build_timeout` | `BuildTimeoutError` | "The site build exceeded its time limit and was stopped." |
| `build_failed` | New `BuildChildError` (child exited non-zero or was killed by a signal); it carries `exitCode`, `signal` and `stderrTail` for the server log only | "The site generator stopped with an error. The server log has the details." |
| `build_unavailable` | Child `error` event (spawn failure, e.g. `ENOENT`) | "The site generator could not be started." |
| `no_space` | Any errno `ENOSPC`/`EDQUOT` raised during staging, copy, rename or symlink | "The data volume is full; the new release could not be written." |
| `release_write_failed` | Any other errno raised during staging, copy, rename or symlink | "The new release could not be written to the data volume." |
| `build_stopped` | `StorageReadOnlyError` (lease lost or shutdown `quiesce`) | "The rebuild was stopped because the app is shutting down or lost storage ownership." |
| `internal` | Anything else | "The rebuild failed unexpectedly. The server log has the details." |

These English examples identify the meaning, not a second copy registry. All failure-code
messages live under shared DE/EN keys in `site/src/i18n/ui.ts`. The server's bounded `error`
and persisted `failure.message` use the English entry from that same registry; browser consumers
select their locale's entry by the validated `code`, never display raw diagnostics or parse
the fallback English sentence. CLI output uses the same English dictionary entry.

`runChildBuild` keeps tee-ing stderr to the container log unchanged. It now rejects with
`BuildChildError` instead of an `Error` whose message embeds the tail. `runOnce` logs one line,
`site build <attemptId> failed (<code>)`, then the internal message and tail, to `console.error`.
That is the only place the tail goes after streaming. The internal `BuildOutcome` keeps a
server-only `cause` for `bootstrapRelease`'s log and is **never serialized**. Routes serialize only
the explicit shape in §5.2.

## 5. Contract

### 5.1 Types

```ts
type BuildTrigger = 'publish' | 'bulk' | 'unpublish' | 'delete' | 'page' | 'rebuild' | 'boot';
type BuildFailureCode = 'build_timeout' | 'build_failed' | 'build_unavailable' | 'no_space'
  | 'release_write_failed' | 'build_stopped' | 'internal';
```

Trigger mapping: single publish → `publish`; any `POST /posts/bulk` action → `bulk`;
`POST /posts/:tk/unpublish` → `unpublish`; `DELETE /posts/:tk` of a published post → `delete`;
`PUT /pages/:key` → `page`; `POST /rebuild` (including `cli.ts rebuild`) → `rebuild`;
`bootstrapRelease` → `boot`.

### 5.2 Action response `build` report (every build-starting route)

```ts
interface BuildReport {
  ok: boolean;
  attemptId: string | null;   // null only when refused before starting (storage read-only)
  release?: string;           // present iff ok; === attemptId
  liveRelease?: string | null; // readlink(current) AFTER settling; null = confirmed absent; omitted = unavailable
  code?: BuildFailureCode;    // present iff !ok
  error?: string;             // present iff !ok; the fixed copy from §4, never stderr
}
```

Routes: `POST /posts/:tk/publish` (`{ published: true, build, updatedAt, altAudit }`, unchanged
apart from `build`); `POST /posts/:tk/unpublish` (`{ unpublished: true, updatedAt, build }`,
where `updatedAt` is #361's addition, consumed here unchanged); `DELETE /posts/:tk` (`build` only when the post was published;
unchanged rule); `POST /posts/bulk` (`build` only when `liveChanged`); `PUT /pages/:key`
(`{ saved, build }`); `POST /rebuild` (the bare `BuildReport`, keeping the `ok`, `release` and
`error` keys `cli.ts` reads). The `error` key is kept deliberately, so every in-repo consumer reads
a sanitized string without a rename. Its *meaning* changes to the fixed copy, and every consumer
is migrated in the same change.

### 5.3 Last-attempt record

```ts
interface LastBuildAttempt {
  attemptId: string;              // `${ms}-${pid}-${seq4}`, the release-stamp candidate
  startedAt: string;              // ISO; ms of attemptId, taken inside the exclusive lock
  finishedAt: string | null;      // null only for 'interrupted'
  result: 'succeeded' | 'failed' | 'interrupted';
  release: string | null;         // === attemptId iff result === 'succeeded'
  liveReleaseAfter?: string | null; // observed at finish; null = confirmed absent; omitted = unavailable/interrupted
  failure: { code: BuildFailureCode; message: string } | null; // non-null iff 'failed'
  triggers: BuildTrigger[];       // deduplicated, sorted; every caller this run served
  beforeBoot: boolean;            // computed on read: loaded from disk at this process's boot
}

interface BuildStatusResponse {   // GET /rebuild/status (admin only)
  live?: { release: string; stampedAt: string } | null; // per-request read; null = confirmed absent; omitted = unavailable
  running: { attemptId: string; startedAt: string; queued: boolean; owner: 'this_process' | 'unverified' } | null;
  last: LastBuildAttempt | null;
  record: 'ok' | 'missing' | 'unreadable' | 'not_persisted';
}
```

`live` is **never** derived from `last`, and `last` is **never** derived from `live`. A live
release proves only that *some* attempt promoted, not that the latest attempt finished or was
recorded successfully. `stampedAt` is the build *start* time encoded in the release name.
Copy calls it "release of <time>", never "built at", and never "last rebuild succeeded".

For all three live-observation fields, only a confirmed missing `current` produces `null`;
an unreadable or invalid link omits the field and yields "Live release status is unavailable."
Observation failure never changes the build outcome or discards an acknowledged mutation/token.
Optional fields are validated when present; their absence is valid in the durable record.

Invariants:

- **I1** `result === 'succeeded'` ⇔ `release !== null` ⇔ `failure === null && finishedAt !== null`.
- **I2** `result === 'failed'` ⇒ `failure.message` is a §4 table entry (the copy is bounded by
  construction).
- **I3** `liveReleaseAfter` is read from disk, not inferred from `result`. A successful flip
  makes the in-process attempt `succeeded`, even if subsequent pruning, lease loss or record
  persistence fails. A crash after the flip but before completion is recorded can instead leave
  `last.interrupted` after restart beside a known live release/manifest; these are independent facts.
- **I4** Runs never overlap (exclusive lock plus one-deep coalescing), so "last started" equals
  "last finished" whenever `running === null`.
- **I5** The record holds no stderr, path, SQL, slug, post title, username, GPS, EXIF or secret.
  Its fields are timestamps, stamps, enums and fixed copy.

### 5.4 Durability and storage protocol (approval item 2; durable recommended)

The file is `${SITE_DIR}/build-state.json` (`/data/site/build-state.json`):
`{ "schema": 1, "running": {attemptId, startedAt, triggers} | null, "last": <LastBuildAttempt without beforeBoot> | null }`.
The static root is `${SITE_DIR}/current` (`server.ts:372-374`), so the file is never served. It
lies outside `releases/`, so pruning and `sweepLeftovers` never touch it. It is distinct from
#316's approved `${SITE_DIR}/manifests/`. It is not in any backup: it is operational state, like
`import_jobs`.

1. **Start.** Inside `lock.runExclusive`, assert storage writability and recursively create the
   record's parent `${SITE_DIR}` **before the first start write**. Reassert ownership immediately
   before each subsequent filesystem mutation, including temp cleanup and stale-file unlink;
   never rely only on the earlier lock or check. Mint the stamp in `runOnce` and pass it into
   `buildAndDeploy`. Write `running = {attemptId, startedAt, triggers}`, keeping the previous
   `last`, using temp `build-state.json.<pid>.tmp`, `fsync`, then atomic `rename`.
2. **Finish.** Capture successful promotion as an in-memory `succeeded` outcome immediately
   after the flip resolves, before best-effort housekeeping. Set `running = null` and
   `last = <completed record>` in memory; persist them the same way only while writable.
   A live-link observation failure omits `liveReleaseAfter`; it cannot downgrade promotion.
3. **Write failures are best-effort.** Directory creation or record-write errors are logged and
   never change the `BuildOutcome`. Memory holds this process's attempt, and the status route
   reports `record: 'not_persisted'` until the next successful write. If the *start* record
   cannot be written, try once to unlink the stale file **only while still writable**. A stale
   `last` must not intentionally stand in for the newest attempt after restart; inability to
   remove it remains the explicit residual in §10.
4. **Lease loss or shutdown.** Admit no new write after loss is observed, including cleanup.
   Loss **before promotion** yields in-memory `failed/build_stopped`; loss **after promotion**
   preserves in-memory `succeeded` and its `release`. If completion cannot be persisted, use
   `record: 'not_persisted'`; the disk may retain `running`. Do not invent a failed promotion
   or bypass the lease to improve the record.
5. **Boot (owning process).** Read with a 64 KiB cap and validate every field like
   `backup.ts readState`: an invalid field invalidates the record. A persisted `running` is
   surfaced as `last = {...running, result: 'interrupted', finishedAt: null, release: null,
   failure: null}` (no `liveReleaseAfter`) with `beforeBoot: true`. The file is **not** rewritten
   at boot; the next attempt's start write supersedes it. Missing file: `record: 'missing'`,
   `last: null`. Unparseable or invalid file: `record: 'unreadable'`, `last: null`, one
   `console.error` line. A leftover `build-state.json.*.tmp` is swept by the next start write,
   inside the lock.
6. **Read-only (non-owning) instance.** It never writes. A persisted `running` is reported as
   `running.owner: 'unverified'` and is not declared interrupted, because the owner may really be
   building.
7. **Fresh volume.** `bootstrapRelease` attempts are ordinary runs with trigger `'boot'`.
   The guarded parent creation in item 1 makes their start record durable before the generator
   begins; a crash during that first build can therefore recover as `interrupted`.
8. **Flip then crash.** If promotion succeeds and the process dies before its completion write,
   boot reports the retained `running` as `interrupted/result unknown`. The independently read
   `current` and, when #316 lands, its manifest still establish the release/content being served.
   Do not rewrite the attempt to success from that evidence or downgrade the manifest to unknown
   because the attempt is interrupted.

Under the in-memory alternative (approval item 2), §5.4 has no record-file reads or writes:
keep the same in-process promotion boundary and records, but discard them on restart. On boot,
`record` is `'missing'`, `running`/`last` are null, and the UI shows "No rebuild attempted since
the app started at {bootAt}" plus the independent live observation (§6.2).
`BuildStatusResponse` then gains `bootAt: string`. Fresh-volume crash recovery and durable
interrupted-state tests apply only to the durable choice.

### 5.5 Coalescing

A record describes a **run**, not a request. Every caller attached to a run receives that run's
`attemptId` in its `BuildReport`. Callers that join a queued run add their trigger to that run's
`triggers` before it starts. The existing guarantee is unchanged: a queued run's loader `SELECT`
happens after each attached caller's commit (`build.ts:226-233`). `running.queued` reports
whether a follow-up run is already queued. A build refused before starting (storage read-only,
`build.ts:264`) returns `attemptId: null, code: 'build_stopped'` and does **not** replace `last`.

### 5.6 Status route

`GET /rebuild/status`: `preHandler: requireAdmin` (authors get 403, anonymous callers 401),
`cache-control: no-store`, and allowed while storage is read-only (it is a GET). It reads
`readlink(current)` on every request, so `live` survives restarts and manual rollbacks by
construction.

## 6. Client behavior

A valid successful mutation acknowledgement establishes **what that operation persisted**,
not the latest state after another writer. Apply its mutation-owned token and acknowledged
clean snapshot before reporting the build outcome. For bulk, apply only the explicitly
successful items/counts; HTTP 2xx is not a promise that every item succeeded.

Only a **known pre-commit rejection** (for example validation, authorization or an OCC conflict
whose handler guarantees no write) proves the attempted mutation changed nothing. A generic
non-2xx, broken/missing response or failed COMMIT acknowledgement does not. Preserve local work,
say "Outcome unknown" rather than "nothing was saved", and do not automatically replay.
Lost-response checking/reconciliation remains #304/#305/#306's contract and implementation;
#297 adds no new request id, probe loop, queue or reconciliation mechanism.

Optional post-commit enrichment must not turn an acknowledged commit into a 500 or erase its
token. Return the successful mutation acknowledgement with its own `updatedAt` (or
`saved.updatedAt`) and build report; #316 supplies an explicit unavailable publication projection
if its fresh read fails. Never replace the mutation token with a later writer's read token.
Likewise a revisions-list refresh failure cannot undo About's clean snapshot or token.

- **Editor Publish** (`editor.html`). On acknowledgement, apply its `updatedAt`, the acknowledged
  published flag and `altAudit`, then update the chip and report the build. Per-locale slug locks
  follow #283's retained publication history, not pair status: lock only locales actually published;
  never blanket-lock an unpublished secondary. The action
  flag is not a fresh current-state read: once #316/#317 land, their available
  `publication.status` replaces it; unavailable enrichment must not fabricate current state.
  Replace `setPublishedLive`'s unconditional per-story live claim with §6.1's operation/release
  copy; build success alone never proves this story's current liveness. On build failure show a
  text-named warning, not colour alone, with a link to `/admin/settings.html#site`.
- **Editor Unpublish.** Token sync (`loadedUpdatedAt = body.updatedAt`) is independently
  implemented #361 behavior. #297 preserves it, applies the acknowledged draft flag, and reports
  `build` per §6.1; #316's fresh status takes precedence when available. Unpublish retains
  publication history and therefore does not unlock any previously published locale's slug.
  Include primary-only Publish and Unpublish-with-retained-history in the editor regressions.
- **About** (`about.html`). On acknowledgement, always `guard.markClean(snap)` and set
  `loadedUpdatedAt = body.saved.updatedAt` before reporting `build`; refresh revisions separately
  as best-effort. The clean snapshot is the submitted snapshot, not edits made while waiting.
- **Posts list** (`posts.html`). `describeBuild` becomes `describeOutcome(action, body)`, which
  names the persisted count or state and the live consequence. The list reloads as today, with no
  tokens held.
- **Settings.** A "Last rebuild" `section-label` plus a `role="status"` paragraph under the
  buttons, mirroring "Last backup", filled from `/rebuild/status` on load and after
  **Rebuild site now**.
- **Desk** (`index.html`). Admins only (`s.isAdmin`): a `deskBuild` list item beside
  `deskRelease`, loaded through `Desk.resilientLoader` with a Retry control. A `failed` or
  `interrupted` last attempt links to Settings. Authors never request the route, so they see no
  403 noise and no change.
- **CLI** (`cli.ts`). It prints `rebuild failed (<code>): <error> — details: docker compose logs app`.

### 6.1 Copy (shared DE/EN admin dictionary; approved with the spec)

Messages separate the acknowledged CMS action, the attempt's promotion outcome and an independent
live-release observation. Neither a build's success nor failure proves a particular story is
present or absent now; another mutation may have preceded its loader read or followed promotion.
Only #316's per-post evidence may make that claim. Links to the public site are navigation,
not proof that this action's content is live.

Every new action message, status, qualifier, label, Retry instruction and accessible name in
§6.1–6.2 must have DE and EN entries in `site/src/i18n/ui.ts`, delivered through the existing
`/admin/editor-image-copy.js` pattern. The English examples below specify facts and placeholders;
the German entries must convey those same facts. Do not introduce inline UI strings or a second
server-only message table. The existing admin locale convention is unchanged.

| Surface | Build OK | Build failed before promotion |
|---|---|---|
| Publish | "Publish saved in the CMS. Release {release} was promoted." | "Publish saved in the CMS. This change may not yet be reflected on the live site — the rebuild failed: {error}" |
| Unpublish | "Unpublish saved for ‘{title}’ in the CMS. Release {release} was promoted." | "Unpublish saved for ‘{title}’ in the CMS. This change may not yet be reflected on the live site — the rebuild failed: {error}" |
| Delete (was published) | "Deleted ‘{title}’ from the CMS. Release {release} was promoted." | "Deleted ‘{title}’ from the CMS. This change may not yet be reflected on the live site — the rebuild failed: {error}" |
| Delete (draft) | "Deleted draft ‘{title}’ from the CMS. The site was not rebuilt." | n/a |
| Bulk | "{action}: {n} saved in the CMS, {m} failed. Release {release} was promoted." / "…No rebuild was needed." | "{action}: {n} saved in the CMS, {m} failed. Saved changes may not yet be reflected on the live site — the rebuild failed: {error}" |
| About | "Saved in the CMS. Release {release} was promoted." | "Saved in the CMS. This change may not yet be reflected on the live site — the rebuild failed: {error}" |
| Rebuild | "Release {release} was promoted." | "Rebuild failed before a release was promoted: {error}" |

Append the independent release observation on both success and failure:
- `liveRelease` is a stamp: "The live site was observed serving the release of {stampedAt}."
- `liveRelease === null`: "No live release yet." This covers a failed first Publish/About save/
  Rebuild without inventing a previous release.
- omitted `liveRelease`: "Live release status is unavailable."

Failed mutation-triggered builds and manual Rebuild offer "Retry with Rebuild site now in
Settings." For `code: 'build_stopped'`, instead point to the existing storage/shutdown recovery
procedure before retrying; do not advise blind restart or bypassing a restore/ownership guard.
An unknown mutation outcome uses the separate §6 rule, not any persisted-action sentence here.

### 6.2 Desk/Settings states

| State | Copy |
|---|---|
| `running` | "Rebuild in progress since {startedAt}." (+ " Another rebuild is queued." if `queued`; " Reported by another app instance." if `owner: 'unverified'`) |
| `last.succeeded` | "Last rebuild succeeded {finishedAt}." |
| `last.failed` | "Last rebuild failed {finishedAt}: {failure.message}" + Rebuild link |
| `last.interrupted` | "The last rebuild (started {startedAt}) was interrupted by a restart; its result is unknown." |
| `record: 'missing'` | "No rebuild attempt on record." |
| `record: 'unreadable'` | "The rebuild record could not be read." |
| `record: 'not_persisted'` | append " This record could not be saved and is lost on restart." |
| `beforeBoot` | append " (before the last restart)" |
| In-memory alternative only | "No rebuild attempted since the app started {bootAt}." |

Each state is followed by the independent live observation: "The live site was observed serving
the release of {stampedAt}.", `live === null` → "No live release yet.", or omitted `live` →
"Live release status is unavailable." An interrupted attempt may accompany a known live release;
the UI must not replace either fact with the other.

## 7. Trust boundaries and misuse cases

- **Author reads build diagnostics.** The status route is `requireAdmin`, and every
  build-starting route already is. No author-visible payload gains a field. Authors' per-post
  liveness is #316's design and exposes neither a stamp nor a failure.
- **Leak via stderr.** Entry ids, schema paths, filesystem paths and pg host names could leak.
  The browser sees §4 copy only; the tail goes to stdout/stderr only, never to the record file.
  `DATABASE_URL` handling is unchanged.
- **Forged or corrupt record file** (anyone with `/data` write access already owns the release
  directory, `SECURITY.md:837-840`). Strict validation means an invalid record yields
  `unreadable`, never rendering of attacker text: the copy is chosen by code, never read from the
  file. `failure.message` in the file is ignored on read and re-derived from `code`.
  Rendering uses `textContent` only.
- **Status-route amplification.** The route does one `readlink` and serves memory. It takes no
  lock and starts no build.
- **Lease confusion.** A non-owner never writes and never declares "interrupted" (§5.4.6).
- **Stale-success misreading.** Prevented by the separate `live` and `last` fields, I1–I3, and
  "no attempt on record" copy that never says "succeeded".
- **Retry storms.** Recovery stays manual (**Rebuild site now** / `POST /rebuild`). Coalescing
  bounds concurrent requests to one in flight plus one queued.

## 8. Dependency contracts

- **#316 (consumer):** reads `LastBuildAttempt`, `BuildStatusResponse` and `BuildReport` as
  specified, read-only. It must not add fields to them. Its per-release manifests live in
  `${SITE_DIR}/manifests/` (its own spec); this spec neither reads nor sweeps them. Agreed with the
  #316 drafter: `attemptId` is the Node clock at run start, the DB's `published_at` comes from a
  different clock, so #316 does not compare the two.
  The coordinated #316 response projection is
  `{ availability: 'available', status: 'draft' | 'published', draftDiffers: boolean,
  requestedLocales: ('de' | 'en')[], committedLocales: ('de' | 'en')[],
  live: { de: LiveState, en: LiveState } } | { availability: 'unavailable' } |
  { availability: 'missing' }`, where `LiveState` is `live | older-version-live | not-live |
  unknown`. `unavailable` means the optional read failed; `missing` means a fresh read confirms
  deletion (ordinary GET retains its 404 contract). Neither includes guessed status/liveness.
  An available projection's fresh `status` corrects the UI's acknowledged action flag, but never
  replaces the mutation-owned token. Enrichment failure preserves the action acknowledgement,
  build report and token. This is #316's projection, not a second last-attempt record.
- **#317/#318:** consume #316's states, not this record directly. Admin-only data stays admin-only.
- **#361 (independently implemented input, normal risk, no duplicate gate):** `PostStore.unpublish` returns
  `{ updatedAt }` (the touched timestamp, as `publish` does), `POST /posts/:tk/unpublish` echoes
  it, and the editor sets `loadedUpdatedAt` from it. #297 relies on that exact field and does not
  change it; #297's editor Unpublish edit is rebased on #361's.
- **#397 (owner-approved, high-risk prerequisite):** must be integrated before #297.
  Owns irreversible promotion and log-only post-flip cleanup diagnostics. No browser warning
  field is reserved or added. #297's attempt persistence follows that boundary (§3.3).
- **#303/#304/#305/#306:** own ambiguous-write classification and reconciliation; #297 consumes
  their handling without adding request ids, replays or status-check loops. The build status
  route is an admin's manual cross-check, not proof a particular mutation committed.
- **#110:** keeps its timeout and staging; it changes only where the stderr tail goes (§4).

## 9. Alternatives rejected

- **A Postgres `build_attempts` table.** Schema change plus dump exclusion. It couples the
  release truth to the database, which the blog deliberately does not depend on (#129), and it
  describes files that live on `/data`, not in the DB.
- **Deriving "last attempt" from the `current` symlink.** This is exactly what #297 forbids.
- **Rolling back the publish on a failed build.** Out of scope. It would also make a transient
  build failure destroy an admin's intended state.
- **Deriving the last attempt's success from an existing release.** It may belong to a different
  attempt; even a matching live manifest cannot establish that a crashed process recorded completion.
- **Adding the record to `/health`.** That route is public.
- **Adding the record to `GET /settings`.** It would couple build state to the settings payload
  and its partial-commit semantics; a status route follows the existing `/import/status` pattern.
- **A `de/<slug>` hint parsed from stderr.** Even if checked against stored post ids, it parses
  untrusted build output in a second parser, the pattern #91 retired. The container log has the
  full tail.

## 10. Residual risks (accepted if approved)

- If both the start write and the stale-file unlink fail, a restart can surface an older `last`.
  It is labelled `beforeBoot`, not guaranteed to be the latest pre-boot attempt; the record path
  may fail independently of the release path. No status line claims complete history.
- `interrupted` cannot distinguish an OOM kill from a host reboot or prove whether promotion
  occurred before the crash. Independent live evidence remains usable.
- A queued-but-unstarted run lost in a restart leaves no record. The affected posts surface
  through #316's per-post state, and their HTTP callers saw the connection drop.
- An admin who needs the failing content entry must read the container log (§9).

## 11. Compatibility and migration

- This feature adds no schema, dump-version or settings change. Version 10 is the inspected
  baseline, not a requirement to undo approved #273/#283 format increments. The only new file
  here is `site/build-state.json`, created by the first attempt; initially `record: 'missing'`.
- `SiteBuilder` gains `build(trigger)` and `status()`; test fakes are updated. The
  `PostStore.unpublish` return change is #361's, not this spec's.
- The meaning of `BuildReport.error` changes from raw to fixed copy, with every in-repo consumer
  migrated (`editor.html`, `about.html`, `posts.html`, `settings.html`, `cli.ts`). There are no
  external API consumers.
- A compatible, security-supported image without this feature ignores the inert, unserved
  `build-state.json`; compatibility still includes approved identity/language schema and codec floors.

## 12. Acceptance verification

| AC | Evidence |
|---|---|
| Next Save succeeds after a failed build (editor, About) | Editor DOM test: publish acknowledges with `build.ok: false`; next Save uses that mutation's `updatedAt` against a stale-token-rejecting fake. About likewise adopts `saved.updatedAt` and cleans only the submitted snapshot. Preserve #361's independently implemented unpublish token test; add failed-build reporting without losing that token. Inject post-commit optional projection/revisions-read failure: acknowledged success, token and snapshot survive; a later writer's token is never adopted as this mutation's token. |
| Persisted versus live messages | DOM tests cover every action's success/failure/no-build/stopped paths. Include no prior release, a never-live story whose publish fails followed by unpublish whose build also fails, and a concurrent mutation included by the build. Assert acknowledged CMS facts and release evidence separately; no generic per-story liveness inference. Test unavailable live inspection separately from absent `current`. Exact sentences are reviewed, not pinned. |
| Admin-only, no stack traces or secrets | Route tests: status gives 401 anonymous, 403 author, 200 admin with `no-store`; action/status bodies exclude injected stderr/path/secret sentinels while the existing server log retains diagnostics. |
| Route-level failing publish | Real builder on a disposable `SITE_DIR`: v1 succeeds, subsequent publish runner fails before promotion; response has `published: true`, `build.ok: false`, `liveRelease === v1`, and `GET /` serves v1 bytes. Repeat with `pgPostStore` under `TEST_DATABASE_URL`. This AC concerns pre-promotion failure; #397 post-promotion pruning is success, not an exception to the AC. |
| Record lifecycle and promotion boundary | Fresh volume: parent exists and `running` is durably written before the first generator starts; crash there recovers interrupted. Cover completion, coalescing, invalid/oversized records, and failure classification. Pre-flip lease loss leaves memory failed/stopped; post-flip lease loss leaves memory succeeded plus not-persisted, with no newly admitted write. Record or live-read failure cannot downgrade success. Crash after flip before completion yields interrupted plus the new live release; joint #316 fixture keeps its manifest liveness. No duplicate pruning implementation/test suite: integrate #397's separately approved boundary. |
| Known rejection versus unknown outcome | Known pre-commit rejection does not apply success state. Generic 5xx, failed COMMIT acknowledgement, or lost response never claims "nothing saved" or silently replays. Consume #305's own-landed-write coverage rather than building another reconciliation path. |
| Defined "no attempt" state | Desk/Settings tests cover missing/unreadable and in-memory-only bootAt, each paired independently with present, absent or unavailable live observation and never implying last-attempt success. |
| Desk is admin-only | Desk DOM test: an author session never calls `/rebuild/status`. |
| Full suites and i18n | uploader `npx tsc --noEmit` and `npm test` with `TEST_DATABASE_URL`; site `npx astro check`, `npm test` and `npm run build`. Existing dictionary completeness coverage includes all new keys; browser smoke checks both locales without pinning incidental sentence wording. |
| Browser smoke | On a disposable stack with a bind-mount copy (never the production `uploader/data`), `chmod 0555` the host `site/releases`, then publish, unpublish, bulk, edit About and Rebuild. Each shows the failure copy; the next Save succeeds; Settings and the Desk show `failed`. Restore permissions, Rebuild, and see `succeeded`. Restart mid-rebuild and see `interrupted`. |

## 13. Rollback and containment

Containment/rollback is a targeted code revert on a security-supported image or a roll-forward
fix; never downgrade to codecs prohibited by #347 or undo #397's separately landed promotion
boundary. `build-state.json` can remain inert. No database, dump or settings migration needs
undoing, and no published content is rolled back. Record writes are best-effort and outside the
promotion outcome path; a broken status route degrades to the existing unavailable/Retry display.
Container logs retain diagnostics if fixed browser copy is insufficient.

## 14. Documentation that changes with implementation

- `SECURITY.md` *Single app container → Bounded build*: replace the stderr-to-caller sentence
  with the code-plus-log contract. *Authorization*: add `GET /rebuild/status` to the
  `requireAdmin` list. State that `build-state.json` is never served and holds no diagnostics.
- `ARCHITECTURE.md`: add `site/build-state.json` to the `/data` layout (`:28`); describe the
  record and status route in *Release* (`:148-171`).
- `CLAUDE.md` *Project Status*: a Done entry when implemented.

## 15. Approval record

Owner approval recorded **2026-10-28** in this implementation conversation: **Approve durable
history**. This approves the corrected high-risk contract, security and containment (§3.1.1),
and durable `/data/site/build-state.json` attempt history (§3.1.2). The boot-local alternative was
not selected. Best-effort metadata cannot downgrade successful promotion or undo a committed
mutation; missing/unavailable evidence remains explicit.

#397 is independently owner-approved and must be integrated first; #361 is consumed without a
duplicate gate. #297 supplies #316's status contract; #317 integrates it after #305's reconciliation
work and the approved identity/language dependencies. No named AC is reduced: failed-build retention
covers pre-promotion failure; post-promotion cleanup failure is success. Implementation and failure/
recovery evidence remain required. This approval authorizes no deployment or owner-data changes.

## 16. Implementation qualification (2026-10-29)

The approved durable record, fixed failure classification, admin-only status endpoint and
mutation acknowledgements are implemented. The snapshot-export deadline has its own typed
error: the pool-backed production build reports `build_timeout`, not `internal`, while
retaining the previous release. PostgreSQL integration coverage exercises this boundary.

Parent-executed checks in `wave-two-results-1793274294153_14963.json` passed uploader
typechecking, all 125 uploader files / 2,879 tests with isolated PostgreSQL integration,
all 30 site files / 420 tests, Astro check (zero errors/warnings/hints), and a real Astro
build. Evidence is retained in the gitignored execution ledger under
`.local/backlog-execution-2026-10-27/`; these are local results, not GitHub CI claims.

The real issue-worktree `main.ts` ran on loopback with separate synthetic development/test
databases and absolute writable paths. Its actual Astro child first produced a release,
then failed through an isolated configuration fault containing diagnostic sentinels.
Publish, unpublish, bulk publication, deletion, About save and manual Rebuild retained
the previous live release while acknowledging the committed CMS mutation. Editor and
About immediately saved again without stale-token or ghost-dirty-state errors. Public
page hashes remained unchanged through failed generation and restart; explicit Rebuild
later promoted the published snapshot, not newer unpublished working text.

The same UI paths were exercised with the owned `site/releases` directory at `0555`:
they reported `release_write_failed`, not a generic internal failure. Permissions were
restored to their original `0755`, and explicit Rebuild recovered. A controlled SIGKILL
of the owned app/build process group left a durable running record; restart displayed
`interrupted` with independently observed live-release evidence, and explicit recovery
succeeded. These native local-filesystem checks do not claim physical power-loss or
an uninspected production mount's durability.

Managed Chromium covered desktop/mobile failure and recovery displays, keyboard access
to the recovery link, both public story locales, and a German dictionary-render probe
(not an offered admin language switch). The author Desk neither displayed build state
nor requested `/rebuild/status`. Real HTTP checks observed anonymous 401, author 403,
admin 200/no-store, unserved record paths (404), bounded responses and no diagnostic
sentinel leakage into status, action, health or durable-record payloads.

The actual `node --import tsx src/cli.ts rebuild` failed with exit 1, fixed
`build_failed` copy and the operator log hint, then succeeded with exit 0 and the promoted
release. Its temporary session was removed in both cases. Runtime artifacts, screenshots,
authorization observations and `cli-proof.json` are retained under the ledger's
`issue-297-runtime/`. No owner content or environment was used.

Actual-PR final review, exact-head GitHub CI, completion of prerequisite PRs and retargeted
integration qualification remain separate readiness gates. This evidence does not claim
#305 reconciliation or #316 content-manifest liveness before those dependent implementations.

## Current-dev integration (2026-11-01)

Merged `dev` after the language (#284/#285), identity (#275/#276), gallery-warning and
promotion-commit (#397 cancellation) changes landed. Decisions:

- `build.ts` keeps this change's attempt lifecycle (attempt id as release stamp, durable
  start/finish records, `promoted` set at the `current` rename). Dev's separate
  `onPromoted(stamp)` path for the same #397 rule is not carried twice; dev's `originRoles`
  is passed to the build snapshot unchanged.
- `pages.ts` keeps dev's in-transaction acknowledgement read (`saved` + `galleryWarnings`),
  which already satisfies this change's "acknowledgement belongs to the commit" rule.
- Page and unpublish routes project the build report and still return dev's
  `galleryWarnings`; the About page keeps the 5xx-is-unknown handling and shows gallery
  warnings for an acknowledged save before the build outcome.
- Dev tests written against `{ ok, release }` / `{ ok, error }` builder stubs and
  argument-less `build()` now use the attempt contract (`attemptId`, `code`, trigger).
  DOM harnesses that drive publish/unpublish/page saves load `build-reporting.js`; their
  mocked acknowledgements carry `published`/`unpublished: true`, and the 5xx unpublish case
  now expects the generic unknown-outcome text instead of the raw server error.

Verification at the merge: uploader `tsc` 0 and the PostgreSQL-enabled suite 3732/3732;
site 689/689, `astro check` 0 errors, `astro build` OK. The real app from this worktree
recorded a `boot` then a `publish` attempt (`no-store` status, matching live release);
with the synthetic `releases/` made read-only, an About save returned 200 with the saved
pair and `build: { ok: false, code: 'release_write_failed' }`, status recorded the failed
`page` attempt and the previous live release kept serving; after restoring permissions an
explicit rebuild succeeded and served the saved title. Logout ended the session (401).
