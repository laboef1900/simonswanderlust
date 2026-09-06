# WXR Importer — Locale-Keyed Pair Identity — Design

**Date:** 2026-09-05
**Status:** Proposed (implements the "Shape" on issue #99)
**Risk:** **High.** CLAUDE.md's Change Risk table names WXR import explicitly, and this change
decides *which stored post an import overwrites* — the SEO slug contract (Golden Rule 2) is one
wrong binding away. Requires this spec, misuse-case analysis, the full affected suite, explicit
human approval, and a documented rollback plan.
**Repos touched:** blog repo — `uploader/src/wp-import.ts` and `uploader/test/wp-import.test.ts`,
plus `docs/authoring-workflow.md`. No `site/` change, no schema change, no new endpoint, no new
runtime dependency, no UI change.
**Builds on:** `2026-07-30-wxr-import-hardening-design.md` (#85, whose §Scope table recorded this
bug as pre-existing and out of scope) and `2026-08-25-wxr-import-image-cap-design.md` (#96, the
validate → count → import structure this slots into).
**Closes:** #99.

## Why this exists

`importWxr` decides whether an incoming DE/EN group is *new* or *an update of an existing pair* by
looking its slugs up in one flat map built from **both** slugs of every stored post:

```ts
for (const s of existing) { bySlug.set(s.slugDe, s); bySlug.set(s.slugEn, s); }
…
const prior = bySlug.get(de.slug) ?? bySlug.get(en.slug);
```

DE and EN slugs are separate namespaces in the store (`posts_locale_slug_idx` is on
`(locale, slug)`), so the same word may legitimately be one trip's DE slug and an unrelated trip's
EN slug. The flat map erases that distinction: a group whose **EN** slug equals some other post's
**DE** slug binds to that post's `translationKey`, and `upsertDraft` — whose `ON CONFLICT` writes
every column — overwrites the wrong post. The published-skip guard reads the same wrong row, so a
published post's protection can be applied to (or withheld from) the wrong group too.

This is plausible for this blog: DE and EN slugs are often near-identical or identical
(`rhodos` / `rhodes`, place names that do not translate).

## Decision

**Pair identity is the (DE slug, EN slug) tuple, matched as a unit, and a slug is one namespace
across locales.** `importWxr` indexes every stored post under each of its slugs (any locale). A
group is bound to an existing pair only when **exactly one** stored post touches either of its
slugs **and that post owns both**. Every other overlap — one slug matches, the two slugs belong to
two different posts, or a slug matches an unrelated post's *other-locale* slug — is a **conflict**:
the group is counted as `rejected`, a warning names the existing post(s), and nothing is fetched or
written for it. The same rule applies *within* one export: a group whose slug was already claimed
by an earlier group of the same export is rejected too.

Why "reject" rather than "bind on whichever slug matches", and why a cross-locale namesake is not
simply admitted as a new pair:

- **Partial match (one slug matches, the other does not).** Binding would make `upsertDraft` rename
  the *other* locale's stored slug to the export's value. That is exactly the slug change Golden
  Rule 2 forbids without authorization, and it would silently undo an author's deliberate rename in
  the editor. If the other slug is already taken by a third pair the write fails with
  `duplicate_slug` instead — after the images were fetched. Either way, wrong.
- **Split match (the two slugs belong to two different pairs).** No binding is correct; whichever
  pair we picked, the other one's slug would be stolen or the write would fail.
- **Cross-locale namesake** (the issue's case: incoming EN slug equals an unrelated post's DE slug,
  no same-locale match). The database would accept it as a new pair — `posts_locale_slug_idx` is
  per `(locale, slug)` — but the importer's **image storage keys are `trips/<slug>/…` with no
  locale segment** (#85 depends on them staying deterministic and un-hashed for its disk-derived
  resume). Admitting the group would write its hero and body photos over the existing post's
  variant files — `storeVariants` overwrites in place, and the hero slot is never resumed — so the
  existing row would stay intact while its live photographs changed. Until the key scheme carries
  the locale (a #98-class change, out of scope here), the namesake is a conflict. (Review finding
  on PR #152.)

The `rejected` bucket already means "refused at the import boundary; nothing was fetched or
written", and the buckets still sum to the group count (#100's invariant), so no new bucket is
added and `import.html` needs no change — the per-group warning, which the page already renders
line by line, carries the reason.

## Misuse cases

| Case | Before | After |
| --- | --- | --- |
| Export group `(rhodos-2, rhodos)`; stored pair `(rhodos, rhodes-adventure)` | Binds to the stored pair via `bySlug.get('rhodos')`; overwrites its content and changes its slugs | `rejected` before any fetch; warning names `rhodos/rhodes-adventure`. Stored pair and its photos untouched. |
| Same, but the stored pair is **published** | `skippedPublished` for the wrong reason — the group silently never imports | `rejected` with the same warning; the published post is never consulted, and its `trips/rhodos/…` photos are never written. |
| Export group `(rhodos, crete)`; stored `(rhodos, rhodes-adventure)` and `(kreta, crete)` | Binds to the first; `upsertDraft` throws `duplicate_slug` on `crete` after fetching every image → `failed` | `rejected` before any fetch; warning names both owners. |
| Export group `(rhodos, rhodes)`; stored `(rhodos, rhodes-adventure)` | Binds via DE and **renames the live EN slug** to `rhodes` | `rejected`; warning names the owner. Author resolves in the editor. |
| Two groups in one export, `(rhodos, rhodes)` then `(kreta, rhodos)` | Both import; the second's EN photos land under `trips/rhodos/…` over the first's DE photos | Second `rejected` ("slug conflict within this export"). |
| Export group identical to a stored pair | `updated` | `updated` — unchanged behaviour, pinned by a test. |
| A pair whose DE and EN slugs are the same word | imports | imports — one trip, one namespace; pinned by a test. |
| A stranded single-locale row (empty `slugDe`/`slugEn` from `pgPostStore.list()`) | `bySlug.set('', row)` — inert only because `isSafeSlug('')` is false | Empty slugs are not indexed at all. |

## Invariants (each has a test in `test/wp-import.test.ts`, `describe('importWxr pair identity')`)

1. A group whose EN slug equals an unrelated post's DE slug is `rejected`, makes **zero** re-host
   calls, and leaves the existing post's slugs and body unchanged.
2. The same holds when that existing post is published: `rejected`, not `skippedPublished` — the
   published post's protection is never bound to a namesake.
3. A group whose slug was already claimed by an earlier group in the same export is `rejected`,
   naming the earlier group.
4. A pair whose DE and EN slugs are the same word imports, and re-imports as an update.
5. A group whose two slugs both match one existing pair is an **update** of that pair (no
   duplicate, same `translationKey`).
6. A group whose two slugs belong to two different existing pairs is `rejected`, makes **zero**
   re-host calls, and leaves both pairs unchanged.
7. A partial match (one slug matches, the other differs) is `rejected`; the stored pair keeps both
   of its slugs.

## Definition of done

- `npx tsc --noEmit` and `npm test` green in `uploader/` with `TEST_DATABASE_URL` set; CI green.
- Every invariant above has a test; the conflict cases fail on the pre-#99 flat map, and the update
  path is pinned so the fix cannot regress idempotency.
- `docs/authoring-workflow.md`'s "idempotent by slug" note says *by slug pair* and names the
  conflict outcome.
- Explicit human approval before merge, per CLAUDE.md's High-risk row.

## Rollback

Revert the single commit. No schema, no migration, no persistent state. The importer returns to the
flat-map binding — the pre-#99, documented state, with its overwrite risk.

## Not included here

- **Locale-carrying storage keys** (`trips/<locale>/<slug>/…`), which would let a cross-locale
  namesake import as its own pair. It changes the deterministic-key contract #85's resume relies on
  and belongs with #98.
- **#126 (re-import wipes author edits on existing drafts)** — what happens *after* a correct
  binding is a separate decision (merge vs. skip vs. overwrite flag) and follows in its own PR.
