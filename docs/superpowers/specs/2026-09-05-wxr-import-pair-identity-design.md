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

**Pair identity is the (DE slug, EN slug) tuple, matched as a unit.** The lookup is keyed per locale
(`de:<slug>` / `en:<slug>`), and a group is bound to an existing pair only when **both** of its
slugs resolve to **the same** `translationKey`. Every other overlap is a **conflict**: the group is
counted as `rejected`, a warning names the existing post(s) each slug belongs to, and nothing is
fetched or written for it.

Why "reject" rather than "bind on whichever slug matches":

- **Partial match (one slug matches, the other does not).** Binding would make `upsertDraft` rename
  the *other* locale's stored slug to the export's value. That is exactly the slug change Golden
  Rule 2 forbids without authorization, and it would silently undo an author's deliberate rename in
  the editor. If the other slug is already taken by a third pair the write fails with
  `duplicate_slug` instead — after the images were fetched. Either way, wrong.
- **Split match (the two slugs belong to two different pairs).** No binding is correct; whichever
  pair we picked, the other one's slug would be stolen or the write would fail.
- **Cross-locale namesake only** (the issue's case: incoming EN slug equals an unrelated post's DE
  slug, no same-locale match). With locale-keyed lookup this is simply *no prior*: the group
  imports as a **new** pair, which the store permits because the uniqueness index is per locale.
  Nothing existing is touched.

The `rejected` bucket already means "refused at the import boundary; nothing was fetched or
written", and the buckets still sum to the group count (#100's invariant), so no new bucket is
added and `import.html` needs no change — the per-group warning, which the page already renders
line by line, carries the reason.

## Misuse cases

| Case | Before | After |
| --- | --- | --- |
| Export group `(rhodos-2, rhodos)`; stored pair `(rhodos, rhodes-adventure)` | Binds to the stored pair via `bySlug.get('rhodos')`; overwrites its content and changes its slugs | No prior; imports as a new pair. Stored pair untouched. |
| Same, but the stored pair is **published** | `skippedPublished` for the wrong reason — the group silently never imports | Imports as a new pair; the published post is never consulted. |
| Export group `(rhodos, crete)`; stored `(rhodos, rhodes-adventure)` and `(kreta, crete)` | Binds to the first; `upsertDraft` throws `duplicate_slug` on `crete` after fetching every image → `failed` | `rejected` before any fetch; warning names both owners. |
| Export group `(rhodos, rhodes)`; stored `(rhodos, rhodes-adventure)` | Binds via DE and **renames the live EN slug** to `rhodes` | `rejected`; warning names the owner. Author resolves in the editor. |
| Export group identical to a stored pair | `updated` | `updated` — unchanged behaviour, pinned by a test. |
| A stranded single-locale row (empty `slugDe`/`slugEn` from `pgPostStore.list()`) | `bySlug.set('', row)` — inert only because `isSafeSlug('')` is false | Empty slugs are not indexed at all. |

## Invariants (each has a test in `test/wp-import.test.ts`, `describe('importWxr pair identity')`)

1. A group whose EN slug equals an unrelated post's DE slug imports as a **new** pair; the existing
   post's slugs and body are unchanged.
2. The published-skip is judged against the pair the group actually matches, never a cross-locale
   namesake.
3. A group whose two slugs both match one existing pair is an **update** of that pair (no
   duplicate, same `translationKey`).
4. A group whose two slugs belong to two different existing pairs is `rejected`, makes **zero**
   re-host calls, and leaves both pairs unchanged.
5. A partial match (one slug matches, the other differs) is `rejected`; the stored pair keeps both
   of its slugs.

## Definition of done

- `npx tsc --noEmit` and `npm test` green in `uploader/` with `TEST_DATABASE_URL` set; CI green.
- Every invariant above has a test that fails on the pre-#99 code (verified: 4 of the 5 fail
  against the flat map; the 5th pins the preserved update path).
- `docs/authoring-workflow.md`'s "idempotent by slug" note says *by slug pair* and names the
  conflict outcome.
- Explicit human approval before merge, per CLAUDE.md's High-risk row.

## Rollback

Revert the single commit. No schema, no migration, no persistent state. The importer returns to the
flat-map binding — the pre-#99, documented state, with its overwrite risk.

## Not included here

- **#126 (re-import wipes author edits on existing drafts)** — what happens *after* a correct
  binding is a separate decision (merge vs. skip vs. overwrite flag) and follows in its own PR.
