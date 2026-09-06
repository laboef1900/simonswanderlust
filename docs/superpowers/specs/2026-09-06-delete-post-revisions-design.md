# Deleting a post deletes its revisions (issue #137)

**Date:** 2026-09-06 · **Risk:** high (data deletion in `db.ts`/`posts.ts`) · **Size:** medium

## Decision

1. **`remove()` deletes the revisions with the post, atomically.** `pgPostStore.remove` runs
   two statements in one transaction — `DELETE FROM posts`, then, only if that deleted a row,
   `DELETE FROM post_revisions` for the same `translation_key` — so there is no window in which
   the post is gone and its snapshots are not, and a crash between the two rolls both back.
   Deliberately **not** one data-modifying CTE: every sub-statement of a CTE shares the
   statement's snapshot, so a revision committed by a concurrent save while the `posts` DELETE
   waited on that save's row locks would be invisible to the revisions DELETE and survive; in
   READ COMMITTED the second statement takes a fresh snapshot and sees it. `memoryPostStore.remove`
   drops its `revisionsByKey` entry. Both `DELETE /posts/:tk` and the bulk `delete` action go
   through the store, so both are covered without touching the routes.
2. **A one-time orphan sweep at boot.** `ensureSchema` runs
   `DELETE FROM post_revisions WHERE translation_key NOT IN (SELECT translation_key FROM posts)`
   after creating the table. Posts deleted before this change left their snapshots behind; the
   sweep removes them on the next start and is a no-op afterwards (idempotent, indexed on
   `translation_key`).
3. **`GET /posts/:tk/revisions/:id` 404s when the post is gone**, exactly like the list route
   beside it. Defence in depth: after 1 and 2 no orphan can exist in Postgres, but the route
   should not depend on that (the memory store, a restored dump, a future writer).

## Why

`post_revisions` has no foreign key to `posts` — `posts` is keyed `(translation_key, locale)`, so
there is no single-column target for one — and `remove()` deleted only `posts`. Revisions are
excluded from backups by design (a convenience net, not content of record), so after a delete
they were neither pruned nor preserved anywhere else: up to 20 full-body snapshots of a post an
admin removed for being wrong or sensitive stayed readable by any authenticated author who kept a
revision URL. The list route already 404'd (it checks `posts.get` first); the item route did not.

## Trust boundaries

- Deletion is admin-only (`DELETE /posts/:tk`, `POST /posts/bulk` are `requireAdmin`); the
  revision reads are `requireAuth`. Nothing changes about who may do what — only what remains
  readable after an admin deletes.
- The boot sweep runs with the app's own database role inside `ensureSchema`, where every other
  migration already runs. It deletes only rows whose `translation_key` matches no post.

## Invariants

- After `remove(tk)` resolves, `listRevisions(tk)` is empty and `getRevision(tk, id)` is `null`
  for every former revision id (both stores).
- `remove(tk)` on an unknown key still throws `PostError('post not found')` and deletes nothing.
- A revision's `translation_key` always names an existing post once `ensureSchema` has run.
- `GET /posts/:tk/revisions/:id` → 404 when `posts.get(tk)` is null, regardless of store contents.

## Misuse / failure cases

- Crash between the `posts` delete and the revisions delete → the transaction rolls back; the
  post and its revisions are both still there and the delete can be repeated.
- Restoring a `db-*.json.gz` dump (which has no revisions) over a database that still has them
  → the sweep on the next boot removes revisions of posts the dump does not contain. Until that
  boot, `remove(<key the dump lacks>)` throws `post not found` and leaves those orphans alone —
  cleanup is the sweep's job, never a side effect of a failed delete.
- Concurrent save and delete. Save committed first (the delete's `posts` DELETE waits on the
  save's row locks, then proceeds): the revision that save inserted is committed by the time the
  revisions DELETE takes its snapshot, so it is deleted with the post — this is why `remove()`
  is two statements, not one CTE. Delete committed first: `updateLocale` throws `post not found`
  inside the save's transaction, which rolls back the revision it had inserted; no orphan.

## Rollback

Revert the commit. The sweep and the cascading delete remove only rows that were, by design,
never backed up and never intended to outlive their post; there is nothing to restore.

## Tests

- `uploader/test/pg.integration.test.ts`: `remove()` deletes the post's revisions and no other
  post's; the boot sweep deletes orphans and keeps live posts' revisions; `remove()` of an unknown
  key deletes nothing.
- `uploader/test/posts.test.ts`: memory store mirrors the pg semantics.
- `uploader/test/server.test.ts`: `GET /posts/:tk/revisions/:id` 404s once the post is deleted,
  and the bulk delete path leaves no revisions behind.
