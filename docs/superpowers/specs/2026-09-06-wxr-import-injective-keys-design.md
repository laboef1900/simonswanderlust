# WXR Importer — Injective Storage Keys — Design

**Date:** 2026-09-06
**Status:** Proposed (implements issue #98)
**Risk:** **High.** CLAUDE.md's Change Risk table names WXR import and the `/data` layout
explicitly, and this change decides *which file on disk a re-hosted photo lands in* — the
disk-derived resume of #85 depends on that mapping being stable. Requires this spec, misuse-case
analysis, the full affected suite, explicit human approval, and a documented rollback plan.
**Repos touched:** blog repo — `uploader/src/wp-import.ts`, `uploader/src/wp-images.ts`,
`uploader/test/wp-import.test.ts`, `uploader/test/wp-images.test.ts`, `uploader/test/server.test.ts`,
`ARCHITECTURE.md`. No `site/` change, no schema change, no endpoint change, no new dependency.
**Builds on:** `2026-07-30-wxr-import-hardening-design.md` (#85, whose §Scope table recorded this
bug as pre-existing and out of scope, and whose resume is the constraint), `2026-09-05-wxr-import-
merge-existing-drafts-design.md` (#126, which makes a re-run a URL substitution and therefore
decides what a key change costs an already-imported post).
**Closes:** #98.

## Why this exists

`nameFromUrl` derives the last key segment of a re-hosted photo from the URL's filename: strip the
query string and the extension, lowercase, collapse every non-`[a-z0-9]` run to `-`. It is not
injective. `foo.jpg` / `foo.png`, `x.jpg?v=1` / `X.JPG` / `x.png`, `a_b.jpg` / `a-b.jpg`, and
`2019/07/beach.jpg` / `2021/09/beach.jpeg` all become the same `trips/<slug>/<name>`. All are
realistic in a 665-photo uploads tree.

Within one pair the two URLs are both fetched (the per-pair cache is keyed by URL), and the second
`storeVariants` overwrites the first's deterministic filenames; `images[r.src]` is clobbered and
both body references point at one photo. One photo is silently lost, with no warning and
`hosted === total`.

## Constraints

1. **Keys stay a pure function of (slug, URL).** `storage.ts`'s `contentHashKey` carries an
   `@ai-warning` that the re-host path deliberately does not content-hash: deterministic names are
   what make re-imports idempotent and what #85's disk-derived resume (`createRehostResume`) reads.
   Nothing in the fix may depend on the other URLs in the export, on fetch order, or on bytes.
2. **Keys fit the cap #133 puts on `assertSafeKey`** (total length ≈ 200, bounded segment count).
   The importer's keys keep exactly three segments, and the last one is bounded.
3. **Body-URL shapes are unchanged** for #91's `foreignImageUrls`: a re-hosted photo is still
   `<baseUrl>/<key>`, written into `![alt](src)` and gallery-fence lines exactly as before.
4. **An already-imported post must not be re-fetched wholesale** on its next re-run. The
   2026-07-29 import wrote 665 photos (~11 GB) under the old keys; a merge re-run (#126) resolves
   every export URL again, and a resume miss on all of them would re-download and re-encode the
   whole corpus into duplicate files that `media-sync` would then backfill into the library.

## Decision

**The last key segment is `<name>-<h8>`, where `h8` is the first 8 hex characters of SHA-256 over
the URL string the importer re-hosts, and `<name>` is the pre-#98 filename slug truncated to 48
characters.**

```
trips/<slug>/<name≤48>-<h8>        # body and gallery photos (#98)
trips/<slug>/hero                  # featured image — unchanged, never resumed (HERO_KEY_RE)
```

- Two distinct URLs get two distinct keys (up to a 2⁻³² hash collision on *equal* names, which is
  the same order as the content-hash namespace every other write path already accepts).
- The hash is over the URL **after** `markdownImages` decodes Turndown's escaping, i.e. the exact
  string `safeFetch` is given — so DE and EN, which reference one URL, still share one key via the
  pair cache, and `x.jpg?v=1` vs `x.jpg` are two photos (they may be).
- `nameFromUrl` (the old segment) remains as `legacyNameFromUrl`, used only by the migration rule
  below. Its truncation-free form is what is on disk today.

### Migration: legacy keys are resumed when unambiguous

`createRehostResume` is not changed; the importer's `lookupResume(key)` gains a fallback. Every
pair's `rehostPlan` now records, per URL, the new key and the **legacy key** the pre-#98 importer
would have used — but only when **exactly one URL in that pair's plan maps to that legacy key**.
On a resume miss for the new key the importer looks the legacy key up; a hit is used as-is (its
`src` is the legacy URL the stored body already carries).

- A photo imported before #98 whose name was unique in its pair costs nothing on a re-run and the
  stored body keeps pointing at the file it always did. This is the whole 2026-07-29 corpus,
  minus any pair that actually hit the bug.
- A pair whose export contains two URLs with one legacy name has **no** legacy fallback for
  either: both are fetched under their new keys. A merge re-run leaves the stored body alone (it
  carries our URLs, not WordPress ones), so the repair is `overwriteDrafts` — the documented
  "rebuild from the export" mode — which then writes both new URLs. The legacy file stays on disk
  and stays referenced until then; nothing is deleted.
- The hero slot is unchanged and never resumed.

Why in the importer and not in `createRehostResume`: the ambiguity rule needs the pair's URL set,
which only the plan has; the resume index is a pure "is this key complete on disk" oracle and
stays that way.

## Trust boundaries and misuse cases

- The URL is attacker-influenced (it comes from the export). The hash only ever appears as 8 hex
  characters, inside `SAFE_KEY_RE`; the name is truncated *after* slugifying so it cannot end in a
  character the regex refuses (a trailing `-` is trimmed). `assertSafeKey` is still asserted at
  both write and read boundaries, exactly as before.
- Could an export be crafted so a new key equals another trip's photo? No — the slug segment is
  the pair's own, validated by `isSafeSlug` before any fetch, and the pair-identity rule (#99)
  refuses a group whose slug another post owns.
- Could the legacy fallback resume the *wrong* photo? Only for a pair that hit the bug before
  #98 **and** whose export since dropped one of the two colliding URLs, so the survivor looks
  unambiguous and adopts whichever photo won the old overwrite. That is the pre-#98 state of that
  pair, unchanged, and `overwriteDrafts` after deleting the legacy files repairs it. Recorded as
  residual.
- Key length: `trips/` + slug + `/` + 57 ≤ 200 holds for any slug ≤ 136 characters. WordPress caps
  `post_name` at 200; a longer slug is refused by `assertSafeKey` at write time (a 400-class
  per-image failure reported through `failureReason`, never a traversal).

## Invariants (pinned by tests)

1. `imageKey(slug, url)` is a pure function; equal inputs give equal keys across runs.
2. Distinct URLs with equal legacy names in one pair get distinct keys, both photos are hosted,
   and both body references point at their own photo.
3. The last segment is ≤ 57 characters and matches `SAFE_KEY_RE`.
4. A legacy file under `trips/<slug>/<legacy name>` is resumed when its name is unique in the
   pair's plan, and is NOT consulted when two URLs in the plan share that name.
5. The #94 free-space estimate and the run agree on what a resume hit is (both go through the same
   `lookupResume`).

## Rollback

Revert the PR. New-key files written meanwhile stay on disk under `trips/<slug>/<name>-<h8>` and
are still served; posts imported with them keep working; the next import after the revert resumes
nothing for them and re-fetches (the pre-#98 behaviour, with the collision back). No schema, no
data migration, nothing to undo in Postgres.
