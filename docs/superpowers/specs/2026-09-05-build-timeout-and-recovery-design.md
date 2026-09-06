# Site Build — Deadline, Diagnostics, Cleanup and Boot Recovery — Design

**Date:** 2026-09-05
**Status:** Proposed (implements issue #110; awaiting owner approval per CLAUDE.md's High-risk row)
**Risk:** **High.** CLAUDE.md's Change Risk table names the build/publish pipeline explicitly.
Requires this spec, trust-boundary and misuse-case analysis, full affected suite, explicit human
approval, and a documented rollback plan.
**Repos touched:** blog repo — `uploader/src/build.ts`, `uploader/src/main.ts`,
`uploader/src/server.ts` (`GET /health` body only), `site/src/lib/loader-pool.ts` (new; used by
both Content Layer loaders). No schema change, no new endpoint, no new runtime dependency, no
`/data` layout change beyond a dot-prefixed staging directory that never survives a completed run.
**Builds on:** `2026-07-03-single-app-container-design.md` (in-process `astro build`,
`releases/<stamp>` + `current` symlink) and the shared build/encode mutex of
`2026-07-26-media-library-and-galleries-design.md` §Encode worker (`work-lock.ts`).
**Closes:** #110.

## Why this exists

`runAstroBuild` spawns `astro build` and settles only on the child's `exit`. Nothing bounds the
child. The build runs under `lock.runExclusive`, so a child that never exits holds the shared
work-lock forever: every later `build()` attaches to the same never-settling queued promise, every
publish/page-save/`POST /rebuild` request hangs, and every encode (`runShared`) queues behind the
waiting exclusive. The container stays "running" — `/health` still answers `ok: true` because the
*parent's* DB probe is bounded (`health.ts`) — so nothing restarts it. Only a manual restart
recovers.

The realistic trigger is the same one `health.ts` already guards the parent against: a silently
hung Postgres (dropped packets, not a refused connection). The child's Content Layer loader opens
`new pg.Pool({ connectionString })` with no `connectionTimeoutMillis` / `statement_timeout`, so
its `SELECT` can wait forever.

Three smaller defects share the file and are fixed in the same change (each named in #110):

- `stdio: 'inherit'` means the only thing a failed publish reports is `astro build exited 1`. The
  reason (which post failed the schema) is in the container log, not in the admin's hands.
- A failed `cp` (ENOSPC) leaves a half-populated `releases/<stamp>` that is never symlinked and
  never cleaned; it counts toward `keep`, displacing a good rollback candidate. A SIGKILL mid-run
  additionally leaves `.build-tmp/<stamp>` behind in the (writable) site tree.
- The boot-time initial build fires once; if it fails, blog routes serve 503 forever while
  `/health` reports `ok: true` with no hint that no release exists.

## Design

### 1. Child deadline (`build.ts` `runChildBuild`)

The spawn is factored into `runChildBuild(command, args, cwd, timeoutMs)` (exported for tests);
`runAstroBuild` is the astro-specific caller. It races the child against a timer:

- On expiry, `child.kill('SIGKILL')` and reject with **`BuildTimeoutError`** (message
  `astro build timed out after <n> min and was killed`). SIGKILL, not SIGTERM: the child is by
  definition not responding, and a hung `astro build` has nothing to flush. `init: true` (tini) in
  compose reaps anything the child leaves. esbuild's service process exits when its stdin pipe
  (owned by the astro process) closes.
- The rejection is delivered on the child's **`close`** event, not `exit`, so it is emitted only
  once the process has exited and its stdio has drained. In the timeout path the stderr stream is
  destroyed after the kill so `close` cannot be held open by a grandchild that inherited the fd.
- The timer is cleared on every settle path (exit, close, spawn error); a fast build leaves nothing
  behind.
- Default `BUILD_TIMEOUT_MS = 15 min`, overridable via `SiteBuilderOptions.timeoutMs`. The
  measured build is well under a minute (19 pages, ~0.47 GB RSS — see `docker-compose.yml`); 15
  minutes leaves an order of magnitude for a large corpus while still bounding the wedge.

The error flows through the existing `runOnce` catch into `BuildOutcome.error`, so
`POST /rebuild`, publish, page save and bulk publish all report it with no route or UI change —
the message says "timed out", which is what the UI already shows.

### 2. stderr tail in the rejection

`stdio` becomes `['ignore', 'inherit', 'pipe']`: stdout still streams to the container log;
stderr is **tee'd** — every chunk is written to `process.stderr` (so the container log is
unchanged) and appended to a bounded tail (`STDERR_TAIL_BYTES = 4096`). On a non-zero exit the
rejection is `astro build exited <code>` followed by the trimmed, ANSI-stripped tail. Astro
writes its content-schema and Vite errors to stderr, so the admin now reads *which* post failed.

The tail is bounded by bytes, not lines, so a pathological stderr cannot grow the message or the
in-memory buffer. It is never persisted.

### 3. Release-directory hygiene (`buildAndDeploy`)

- The `cp` targets a dot-prefixed staging dir `releases/.<stamp>.partial`; a successful copy is
  then `rename`d to `releases/<stamp>` (same filesystem, atomic). A release directory therefore
  **either does not exist or is complete** — a crash mid-copy can only leave a dot-prefixed
  staging dir.
- Any failure in build or copy `rm`s the staging dir in the same `catch` (best-effort); the
  `finally` still removes `.build-tmp/<stamp>`.
- At the start of every run — inside the exclusive lock, so nothing else is mid-build — the
  builder sweeps `.build-tmp/` entirely and every dot-prefixed entry under `releases/`. This heals
  what a SIGKILLed previous process left behind.
- Retention pruning ignores dot-prefixed entries, so a staging dir can never count toward `keep`.

### 4. Loader pool timeouts (`site/src/lib/loader-pool.ts`)

Both Content Layer loaders (`postgres-loader.ts`, `pages-loader.ts`) now build their pool through
`loaderPool(url)`, which sets `connectionTimeoutMillis` (10 s), `statement_timeout` (60 s, server
side) and `query_timeout` (60 s, client side — covers the case where the server never answers at
all). A build against a hung Postgres therefore fails within about a minute with a real error
instead of hitting the 15-minute deadline. The child's own failure is still bounded by §1 for
anything the pool cannot see (a hang inside Vite, a stuck fs).

### 5. Boot recovery (`build.ts` `bootstrapRelease`, called from `main.ts`)

On a volume with no `current` release, `main.ts` calls `bootstrapRelease(builder, { log })`
instead of firing `build()` once. It retries a failed initial build with exponential backoff
(30 s → 1 → 2 → 4 → 8 min, 6 attempts total, ~15.5 min of waiting plus the builds themselves),
stops as soon as a release exists — including one produced by an admin's publish in the meantime,
which `hasRelease()` reflects — and after the last attempt logs that it is giving up. Each attempt
still goes through the builder's coalescing and the exclusive lock, so a retry never runs beside
an admin-triggered build. Retries are bounded because a persistent failure (a post that fails the
schema) is not healed by time; the admin heals it by publishing a fix, which triggers a build
anyway.

The sleep timer is `unref`'d so a pending retry never keeps the process alive during shutdown.

### 6. `/health` exposes whether a release exists

`GET /health` gains `release: boolean` (from `builder.hasRelease()`). It is **information, not a
verdict** — the same rule `SECURITY.md` records for free space: a fresh volume legitimately has no
release for the first minutes, and a persistent build failure is healed by an admin action, not by
a container restart. Flipping the container unhealthy would achieve nothing (compose does not
restart on unhealthy) while hiding a DB outage behind a build problem.

## Trust boundaries

| Boundary | Control | Effect of this change |
| --- | --- | --- |
| Admin request → `astro build` child | exclusive work-lock, single-flight coalescing | **Bounded.** A child can now hold the lock for at most `timeoutMs`; the lock is released on the timeout path exactly as on failure. |
| Child → Postgres | `loader-pool.ts` timeouts | **New.** The loader's connection and statement are bounded; a hung DB surfaces as a build error, not a hang. |
| Child stderr → admin UI | bounded tail, `String` message, existing `textContent` rendering in the admin pages | **New surface, bounded.** The tail is at most 4 KiB, ANSI-stripped, shown to an authenticated admin/author only (every route that returns `build` requires a session, and the routes that trigger a build require admin). It contains build diagnostics (post ids, schema paths), never credentials: `DATABASE_URL` is read from env by the child and is not echoed by astro or pg on a query error. |
| `/data/site/releases` | staging + rename, dot-prefix sweep, pruning filter | **Strengthened.** A release dir is either complete or absent; leftovers cannot displace a rollback candidate. |
| `/health` → public | `release` boolean | Reveals whether the blog has been built. The blog itself answers 503 "site is building" in that state, so nothing new is disclosed. Unauthenticated, like the rest of `/health`. |

## Misuse cases

- **An author crafts content that makes the build hang** (e.g. a pathological Markdown body). Before:
  a permanent wedge needing a manual restart. After: the child is killed at the deadline, the
  lock is released, the admin sees "timed out", and the previous release keeps serving. The
  author cannot extend the deadline (it is not request-controlled).
- **An author crafts content that makes the build emit a huge stderr.** The tail is capped at
  4 KiB; the container log receives the full stream exactly as before (`inherit` behaviour
  preserved by the tee).
- **Repeated timeouts as a denial of service.** Each timed-out build costs at most 15 minutes of
  exclusive lock, triggered only by admin actions (publish/rebuild/page save are `requireAdmin`;
  `POST /posts/bulk` likewise). No unauthenticated caller can start a build.
- **Boot retry against a permanently broken corpus.** Bounded to 6 attempts; a loop of 15-minute
  builds forever would otherwise starve the encode queue on every boot.

## Invariants (each has a test)

1. A child that does not exit within `timeoutMs` is killed and the run rejects with
   `BuildTimeoutError`; the rejection arrives only after the process has actually exited.
2. A child that exits non-zero rejects with a message that carries the **tail** of its stderr,
   bounded to `STDERR_TAIL_BYTES` — the end of a long stream is present, the beginning is not.
3. A child that exits 0 resolves and leaves no pending timer (the test completes without waiting
   for the deadline).
4. A run that fails after the build wrote output leaves neither `.build-tmp/<stamp>` nor any
   entry under `releases/` (partial staging dir removed), and `current` still points at the
   previous release.
5. Stale `.build-tmp/*` and `releases/.*` entries from a crashed run are swept at the start of the
   next run, and never count toward `keep`.
6. `bootstrapRelease` retries a failed initial build with growing delays and stops on the first
   success; it stops without building when a release appears between attempts; it gives up after
   the last attempt and says so.
7. `GET /health` reports `release: false` with `ok: true` when no release exists (information,
   not a verdict) and `release: true` once one does.
8. The loader pool fails fast against a Postgres that accepts the TCP connection and never
   answers (black-hole server), instead of hanging.

## Definition of done

- `npx tsc --noEmit` and `npm test` green in `uploader/` (with `TEST_DATABASE_URL` so the
  integration suites run); `npm test` and `npx astro check` green in `site/`; CI green.
- Every invariant above has a test.
- Smoke: a real `astro build` spawned through the builder against a local Postgres — once with a
  row that fails the Zod schema (stderr tail names it), once with the loader pointed at a
  black-hole port (fails within the pool timeout), once with a tiny `timeoutMs` (killed, lock
  released, a follow-up build succeeds).
- `ARCHITECTURE.md` build/release section describes the deadline, staging dir, sweep and boot
  retry; `SECURITY.md` records the `/health` `release` field beside the free-space rule and the
  bounded stderr surface.
- Explicit human approval before merge, per CLAUDE.md's High-risk row.

## Rollback

Revert the single commit. No schema, no migration, no settings key, no persistent state: the only
on-disk artefact is a `releases/.<stamp>.partial` staging dir during a copy, which the pre-change
code never creates and which a reverted build would simply ignore (its `readdir` sort would count
it toward `keep` until it is removed by hand — bounded, and only if the revert happens mid-copy).
The pre-change behaviour returns in full: unbounded child, `astro build exited N` messages,
single-shot initial build, `/health` without `release`.

## Not included here

- **Making `/health` fail on a missing release.** Rejected above: a fresh volume legitimately has
  none, compose does not restart on unhealthy, and it would mask a DB outage.
- **Moving publish off the request path** (an async build job with a progress endpoint). The
  deadline bounds the wedge; the reverse proxy still bounds the request (CLAUDE.md, Resilience).
- **A `/health`-driven restart.** Compose's healthcheck does not restart containers; that is an
  orchestrator decision outside this repo.
