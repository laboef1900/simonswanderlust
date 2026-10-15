# 2026-09-05 — Empty slug means "unset" (#119)

**Risk: High** per CLAUDE.md ("Change Risk") — it edits the `posts` schema in `uploader/src/db.ts`
and the slug uniqueness rule that underpins the SEO slug contract (Golden Rule 2). Branch:
`feature/119-empty-en-slug`.

## Defect

`validateDraft` deliberately accepts a draft without an EN slug (write-DE-first workflow; the
editor sends `slug: ''` whenever the EN title is blank), but every duplicate check treated `''` as a
real slug: `memoryPostStore.slugTaken`, `pgPostStore`'s pre-check `SELECT … WHERE locale=$1 AND
slug=$2`, and the unique index `posts_locale_slug_idx ON posts (locale, slug)`. The second DE-first
draft therefore failed with `duplicate_slug` ("slug "" already in use for en"). `exportPost` also
wrote `trips/en/.mdx` for such a post.

## Invariants

- **`''` is the "no slug yet" sentinel, per locale.** It is never a URL, never a storage path
  segment, and never participates in uniqueness. Only `''` is exempt: `' '` or any other string that
  fails `SLUG_RE` is still rejected by `validateDraft`.
- **Uniqueness of real slugs is unchanged**: `posts_locale_slug_idx` is now
  `UNIQUE (locale, slug) WHERE slug <> ''`; both stores skip the duplicate pre-check for `''` and
  keep it for everything else. The pg 23505 → `duplicate_slug` mapping (`isSlugCollision`) keys on
  the index name, which is preserved.
- **A post cannot go live with an unset slug**: `validateForPublish` → `validateLocale` →
  `checkSlug` rejects `''` for either locale, so the site never builds a `/en//` route.
  `slug_locked` (no slug change on a published post) is unaffected — published rows always carry a
  real slug.
- **Export never emits a nameless file**: `exportPost` skips a locale whose slug is `''` and returns
  only the paths it wrote.

## Trust boundaries / misuse

- The slug value comes from an authenticated author (session cookie). This change widens what a
  draft may hold (`''`), not who may write it. Path-traversal guards are untouched: `''` never
  reaches `join()` in `export.ts`, and `isSafeSlug` still gates every real slug.
- WXR import (`wp-import.ts`) requires `isSafeSlug` for both locales before `upsertDraft`, so it
  cannot create an empty-slug row; its `bySlug` map may hold a `''` key from an existing DE-first
  draft, but it is only probed with safe (non-empty) slugs.

## Migration behaviour on existing data

`ensureSchema` (every boot) reads `pg_indexes.indexdef` for `posts_locale_slug_idx`; if the
definition carries no `WHERE`, it runs `DROP INDEX` + `CREATE UNIQUE INDEX … WHERE slug <> ''` in
**one transaction**, so a crash mid-way cannot leave the slug backstop missing. No rows are
touched — the old non-partial index already guaranteed at most one `''` row per locale, so the
partial index always builds. The step is idempotent (a partial index is left alone), and fresh
installs create the partial form directly.

## Rollback

Revert the PR; on next boot `CREATE UNIQUE INDEX IF NOT EXISTS` no-ops, leaving the **partial**
index in place, which the reverted code tolerates (it only becomes stricter again for `''`). If
more than one DE-first draft exists at that point, the reverted duplicate pre-check refuses further
DE-first saves until those drafts get EN slugs — data is never lost. To restore the exact old index
by hand: `DROP INDEX posts_locale_slug_idx; CREATE UNIQUE INDEX posts_locale_slug_idx ON posts
(locale, slug);` — this fails (23505) while two `''` rows exist per locale, which is the correct
signal that those drafts need a slug first.

## Verification

- `uploader/test/posts.test.ts` — two DE-first drafts coexist in the memory store, a real EN slug
  still collides, `validateForPublish` refuses the unset slug; `validateDraft` accepts `''` but not
  `' '`.
- `uploader/test/pg.integration.test.ts` — rewinds to the pre-#119 index, saves one DE-first draft,
  runs `ensureSchema`, asserts the partial definition, saves a second DE-first draft, asserts the
  pre-check and the index still reject a real duplicate, and that a second `ensureSchema` is a no-op.
- `uploader/test/export.test.ts` — `exportPost` writes only `trips/de/<slug>.mdx` for a DE-first
  draft.
