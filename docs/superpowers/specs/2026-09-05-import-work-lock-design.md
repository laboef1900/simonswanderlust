# Import encodes take the shared work-lock (issue #95)

**Date:** 2026-09-05 · **Risk:** high (build/publish pipeline interaction) · **Size:** medium

## Decision

Option 2 from the issue: every per-image encode the WordPress importer performs runs inside
`workLock.runShared()`, exactly as the encode queue's jobs do. The lock is threaded
`main.ts` → `buildServer({ workLock })` → `importWxr({ lock })` → `rehostImage(…, { lock })`; the
`runShared` call itself lives in `rehostImage` (`uploader/src/wp-images.ts`) around
`processImage` + `storeVariants`. The fetch stays **outside** the lock.

Option 1 (refuse to start while a build runs) was rejected: it leaves a multi-minute import able
to encode beside a Publish that starts one second later, which is the actual failure mode. And
the single-flight 409 that would host it is slated for removal by #92 (async import job).

## Why the fetch is outside

Holding the lock across a `safeFetch` would let a slow or stalling source host delay a Publish by
up to the fetch timeout per photo, for nothing — network I/O costs no memory worth guarding. The
downloaded buffer is bounded by `maxBytes` and simply waits for the lock if a build is running.

## Trust boundaries and invariants

- `work-lock.ts` is unchanged. Its priority rule holds: a *waiting* build blocks new shared
  acquisitions and takes the lock once running ones finish, so an import is preempted at the next
  photo boundary — worst case one encode (~19 s for a 24 MP frame). Publish never queues behind
  the whole import.
- Encodes are never cancelled mid-flight (same as the queue): a half-written variant set is worse
  than a slow build, and `createRehostResume` would fail closed on it anyway.
- The pacing gate (#85) is elapsed-time based, so time spent waiting for the lock counts as
  delay: the import does not add a sleep after being preempted.
- `sharedRehost` memoises the promise per (pair, url); `runShared` sits below it and below retry,
  so a preempted encode that later fails is retried under the lock like any other attempt.
- `lock` is optional in `rehostImage`/`importWxr`. Without it behaviour is byte-identical to
  today — that keeps the CLI and unit tests instant. The route ALWAYS passes it when the server
  was built with one; `main.ts` always builds it with the single process-wide lock.

## Misuse cases considered

- A build that never ends (hung `astro build`) would hold the import off indefinitely. That is the
  same exposure the encode queue already has, and #110 (build timeout) bounds it.
- An import cannot starve a build: shared holders only delay an exclusive acquisition until the
  currently running encode finishes.
- No new outbound-fetch or path surface.

## Rollback

Revert the commit: the lock becomes un-threaded and the importer encodes outside the mutex again
(the pre-#95 state). No data or schema change.
