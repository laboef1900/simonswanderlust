# WXR Importer — Per-Import Cap on Distinct Images — Design

**Date:** 2026-08-25
**Status:** Approved (decision made on issue #96)
**Risk:** **High.** CLAUDE.md's Change Risk table names `safeFetch`/WXR import explicitly.
Requires this spec, trust-boundary and misuse-case analysis, full affected suite, explicit human
approval, and a documented rollback plan.
**Repos touched:** blog repo — `uploader/` only. No `site/` change, no schema change, no new
endpoint, no new runtime dependency, no new persistent file.
**Builds on:** `2026-07-30-wxr-import-hardening-design.md` (#85: `retryBudget`, the per-host
consecutive-failure breaker, single-flight, and the explicit *exclusion* of a first-attempt cap —
recorded in its §Scope table and in `SECURITY.md`'s SSRF section).
**Closes:** #96.

## Why this exists

#85 bounded the amplification its own retry feature added (`retryBudget`, default 200 retries per
import) and added a per-host consecutive-failure breaker that bounds first attempts **when the host
is failing**. Neither bounds first attempts against a host that keeps answering.

The re-host cache is scoped to one translation pair, deliberately (deleting one trip must not strip
another's images). So one attachment URL declared **once** and referenced from N distinct
translation groups is fetched N times. A minimal accepted DE/EN group is ~634 bytes and the
multipart cap is 25 MiB, so a single upload reaches roughly **40,400 fetches against one
third-party URL**.

Against a *failing* target the breaker cuts that to ~20. Against a target that answers 200, all
40,400 happen — now politely paced at 1200 ms apiece (~13.5 h), but they still happen.

## Decision

Issue #96 asked for a decision, not just a number, because any cap must not break a legitimate
large export (the real one was 665 photos; a bigger blog could be several thousand).

Three options were on the table: (a) a cap on distinct **URLs**, (b) a cap on distinct **translation
groups**, (c) refusing an export whose attachment-to-group ratio is implausible.

**Chosen: a pre-flight cap on the number of distinct (pair, url) re-host operations** — the exact
quantity the importer would otherwise perform.

Why this over the alternatives:

- **It is the quantity that maps 1:1 to fetches.** The re-host cache is per-pair, so the number of
  fetches a clean run performs is the sum, over pending groups, of the distinct https?:// image
  URLs each pair would re-host (its hero plus body/gallery URLs, deduplicated within the pair).
  Capping that number caps the work directly. Capping distinct *URLs* (option a) would under-count
  a legitimate large export (665 distinct photos → 1,338 fetches across two locales) and over-count
  the attack relative to the actual cost; capping *groups* (option b) misses the amplification
  entirely, since the attack is many groups.
- **It is checkable BEFORE any fetch.** The same extraction `buildLocale` uses (the same
  `htmlToMarkdown` + fence rewrite) runs over the parsed posts with no network, no disk writes, and
  no DB writes. A rejected import therefore performs no work and leaves no partial state.
- **The count is exact for the groups that will import.** `importWxr` is restructured to validate
  every group first (missing translation, unsafe slug, already-published → skipped) and collect the
  importable groups into `pending`, and only then count. So a group that will be *skipped* does not
  inflate the count, and a group that will import is never counted without also being imported.
  This is the invariant that makes the cap safe to trust: the pre-flight count equals
  `images.total` for a clean run.

### Cap value

`DEFAULT_MAX_IMAGES = 20_000` distinct (pair, url) re-host operations per import.

- Well **above** a legitimate export: 665 photos → ~1,338 operations; several thousand photos on a
  big blog still lands under 20,000.
- Well **below** the attack: ~40,400 operations for one URL across ~40,400 groups.
- Override via `ImportDeps.maxImages`, the same seam as `retryBudget`/`hostFailureLimit`, so a
  deployment with a genuinely larger corpus can raise it deliberately rather than edit a constant.

The bound is **inclusive**: an import at exactly the cap proceeds; one above it is rejected.

## Design

Three additive pieces in `uploader/src/wp-import.ts`, one wiring change in `uploader/src/server.ts`.
No change to `safeFetch`, `wp-images.ts`, `posts.ts`, or the re-host cache's per-pair scoping.

1. **`ImportDeps.maxImages?: number`** — optional cap; defaults to `DEFAULT_MAX_IMAGES`.

2. **`ImportTooLargeError`** — `Error` subclass carrying `count` and `cap`, with a message naming
   both: `import rejected: would re-host <count> distinct images, which exceeds the cap of <cap>`.
   It is thrown BEFORE any fetch, so it signals "no work was done."

3. **`rehostUrlSet(post, attachments)`** — the distinct https?:// image URLs one post would
   re-host: its hero (featured image, via `_thumbnail_id` → `attachments`) plus every body-image and
   gallery-fence URL. It mirrors `buildLocale`'s extraction EXACTLY — the same `htmlToMarkdown`,
   the same fence rewrite, the same `https?://` filter — so the pre-flight count cannot disagree
   with what `buildLocale` actually fetches.

4. **`importWxr` restructured into validate → count → import.** The former single loop that
   validated *and* imported each group is split:
   - **Validate** every group, pushing importable ones onto `pending` (with their `prior`
     `translationKey`/status). Skipped groups still produce their warnings and `skipped++` exactly
     as before.
   - **Count** the distinct (pair, url) operations over `pending` (per-pair union of de + en
     `rehostUrlSet`). If the total exceeds the cap, log to stdout and throw `ImportTooLargeError`.
   - **Import** `pending` with the unchanged per-pair `sharedRehost`, `buildLocale`, and
     `upsertDraft` logic.

5. **Route wiring.** The `/import` handler wraps the runner call in a `try/catch`; an
   `ImportTooLargeError` becomes a **400** with the error message (naming the count), while every
   other error is re-thrown to the existing handler (500). A rejected import is a client-side
   "this export is too large" outcome, not a server fault.

## Trust boundaries

| Boundary | Control | Effect of this change |
| --- | --- | --- |
| WXR upload → network fetch count | `maxImages` pre-flight count | **New, fail-closed.** The total number of fetch+encode operations is bounded before the first fetch, so a 25 MiB upload can no longer trigger ~40,400 requests against one answering third-party URL. |
| Pre-flight count → actual work | `rehostUrlSet` mirrors `buildLocale` | **Pinned by tests.** The count uses the identical extraction as the import, so the count equals `images.total` for a clean run and a rejected import performs no work. |
| Rejected import → client | `ImportTooLargeError` → 400 | **New.** A rejected import performs no work and leaves no partial state; the author sees a 400 naming the count, not a 500. |

The SSRF surface is unchanged: `assertFetchableUrl` still runs inside `safeFetch` on every attempt,
and a rejected import never reaches a fetch at all.

## Invariants (each has a test)

1. An import whose distinct (pair, url) count exceeds the cap is rejected with `ImportTooLargeError`
   and makes **zero** re-host calls.
2. The rejection names both the count and the cap, and is logged to stdout (not only to the absent
   response).
3. The bound is inclusive: an import at exactly the cap proceeds.
4. A URL shared by both locales of a pair counts **once**, not twice (per-pair dedup, matching
   `sharedRehost`).
5. The hero (featured image) counts toward the cap.
6. Images in groups that will be **skipped** (missing translation, unsafe slug, already published)
   do not count.
7. The default cap is above any legitimate export (a 100-group import proceeds under the default).
8. The `/import` route maps `ImportTooLargeError` to a **400** naming the count, and re-throws every
   other error (still 500).

## Definition of done

- `npx tsc --noEmit` and `npm test` green in `uploader/`; CI green (CI is authoritative for the
  Postgres-backed suites, which skip locally without `TEST_DATABASE_URL`).
- Every invariant above has a test.
- `SECURITY.md`'s SSRF section updated: the per-host breaker is now "bounds a **failing** host", a
  new bullet documents the per-import cap, and the former "Not bounded: successful fetches against a
  host that keeps answering" line is replaced with the bound.
- `CLAUDE.md`'s #96 status moved from "Filed… excluded" to "Done".
- Explicit human approval before merge, per CLAUDE.md's High-risk row.

## Rollback

Revert the single commit (it touches `uploader/src/wp-import.ts`, `uploader/src/server.ts`, and the
two test files, plus the two docs). No schema, no migration, no persistent state, so rollback is a
plain `git revert`. The importer behaves exactly as it did after #85: a large export is paced but
uncapped, and the ~40,400-fetch exposure against an answering host returns — the pre-#96, documented
state.

## Not included here

- **#97 `/import` → `requireAdmin`** is the auth pairing the issue mentions ("worth pairing with
  `requireAdmin`"); it is a separate, auth-gated change and is deliberately out of scope here.
