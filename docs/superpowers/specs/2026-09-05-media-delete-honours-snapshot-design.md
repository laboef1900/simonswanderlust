# Media Delete Honours the Published Snapshot — Design

**Date:** 2026-09-05
**Status:** Proposed (implementation on `feature/115-delete-honours-snapshot`, stacked on #150)
**Risk:** **High** — the media delete path is irreversible (`deleteMedia` removes variants **and**
the retained original) and the change reads the `published_snapshot` column the build pipeline
depends on.
**Repos touched:** `uploader/` only. No schema change, no new endpoint, no new dependency.
**Closes:** #115.

## Why this exists

`DELETE /media/items/*` refuses while `imageUsage()` finds a reference in `posts.usageRows()` or
any page. `pgPostStore.usageRows()` read only the working columns. The blog, however, is built
from `published_snapshot` (`site/src/lib/postgres-loader.ts`: `status = 'published' AND
published_snapshot IS NOT NULL`), which `publish()` freezes separately so a draft save cannot leak
live (#20).

So: post P is published with photo X; the author swaps X for Y and saves (not republished); an
admin deletes X. The usage check passed because the working copy no longer names X, every variant
and the original were unlinked, and the live site — plus every rebuild until P is republished —
kept rendering P from a snapshot whose `<picture>` for X now 404s. Nothing could re-encode it.

## Decision

`usageRows()` emits, for every row that the site loader would build, a second row per locale
derived from the snapshot, tagged `source: 'published'` (working rows are `source: 'working'`).
The pg store does this as a `UNION ALL` whose second SELECT uses **the loader's exact filter**;
the memory store mirrors it from `publishedSnapshot`. `imageUsage()` merges both sources per
translation key (one `usedIn` entry per post, as before) and flags each ref with
`published`/`working`. Pages have no snapshot — the working copy is what gets built — so a page
ref is `published: true, working: true`.

The delete route is unchanged in structure; when a ref is `published && !working` the 409 says
"republish (or unpublish) that post first" instead of "remove those references", and the library
grid appends "(published version)" to that post's title in its "used in:" line.

Republishing promotes the swap into the snapshot, after which the delete succeeds; unpublishing
drops the snapshot rows because the loader's filter no longer matches.

## Trust boundaries and misuse

- No new input surface: the corpus is read from Postgres, the request still passes `assertSafeKey`,
  and the route stays `requireAdmin`.
- `imageUsage` matches the snapshot's `hero_image`, `images` keys and `body_markdown` with the same
  boundary-safe, variant-tolerant matcher as the working copy — no prefix matches.
- Alt harvest (`media-sync`): working rows sort before snapshot rows per locale, so an author's
  current alt wins; a snapshot-only alt is still harvested rather than lost.
- A published post whose snapshot references a photo that also has no working reference anywhere
  can never be deleted by mistake — the admin must consciously republish or unpublish first. That
  is the intended friction for an irreversible action.

## Invariants

1. A photo referenced by any `status = 'published'` row's snapshot is not deletable
   (`server.test.ts`: publish → draft swap → `DELETE` 409 with `published: true, working: false`;
   republish → 200).
2. `usageRows()` snapshot rows exist exactly when the loader would build the post
   (`pg.integration.test.ts`, `posts.test.ts`: none for drafts, present after publish, gone after
   unpublish).
3. `usedIn` still lists each post once.

## Rollback

Revert the single commit; stateless. The old behaviour (delete ignores the snapshot) returns.
