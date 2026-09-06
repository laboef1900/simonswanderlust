# Page saves: optimistic concurrency + revisions (issue #141)

**Date:** 2026-09-06 · **Risk:** high (`db.ts` schema, publish pipeline) · **Size:** large

## Problem

`PUT /pages/:key` accepted `{ de, en }` unconditionally and rebuilt the live site. Two admin
tabs — or one tab whose DraftGuard stash was restored over a newer server state — wrote the About
page last-writer-wins, and the overwritten text was gone: pages had no revisions. Posts have had
both halves since #28 (`updatedAt` echo → 409 `conflict`; `post_revisions`).

## Decision

Pages get exactly what posts have, with the same shapes, so the editor code and the operator's
mental model carry over unchanged.

1. **`updatedAt` on the pair.** `PageStore.get` returns `StoredPagePair` — a `PagePair` plus
   `updatedAt: Date | null` (the newer of the two locale rows; `null` for a key never saved).
   Structurally still a `PagePair`, so `usageCorpus`/`media-sync` consumers are untouched.
2. **Optimistic concurrency at the store.** `PageStore.save(pair, baseUpdatedAt?)` throws
   `PageError` with `code: 'conflict'` when the stored `updatedAt` is newer than the echo. The
   route maps it to **409 `{ error, code: 'conflict' }`** and does **not** rebuild. Omitting the
   echo skips the check (first save of a new key; scripted callers) — same rule as posts.
3. **Revisions.** Every save that overwrites an existing page first snapshots the pre-save pair
   (`{ de, en }`, the PUT-payload shape, camelCase) into **`page_revisions`**
   (`id uuid PK, key text, snapshot jsonb, saved_at timestamptz`, index `(key, saved_at DESC)`),
   pruned to the newest `REVISION_CAP` (20, shared with posts) per key, inside the same
   transaction as the locale writes. `GET /pages/:key/revisions` lists summaries
   (`id, savedAt, titleDe`), `GET /pages/:key/revisions/:id` returns one snapshot; both
   `requireAuth`, the same trust boundary as `GET /pages/:key`. Restoring is client-side — the
   snapshot fills the form and goes through the normal Save, so validation applies and the
   overwritten state gets its own revision.
4. **`about.html`** keeps `loadedUpdatedAt` from the load and from each successful save, echoes
   it on `PUT`, and on a 409 `conflict` offers the same reload-or-keep choice the post editor
   does. A revisions card lists snapshots with "Restore into editor".

## Trust boundaries

- Admin → `PUT /pages/:key` (unchanged authorization). The `updatedAt` echo is untrusted input:
  a non-date → 400, absent → no check. It can only make a save *fail*, never bypass validation.
- Any session → `GET /pages/:key/revisions[/:id]`: the same data `GET /pages/:key` already
  hands out, older. The revision `id` is validated as a UUID before it reaches the query, so a
  malformed id is a 404, not a logged 22P02 500 (the #128 rule).
- `page_revisions` is operational state: excluded from `dumpDatabase`'s fixed table list, like
  `post_revisions`. A restore rewrites `pages.updated_at = now()`, so a tab open across a restore
  correctly 409s.

## Invariants

- A save never rebuilds the site unless it was stored; a conflict rebuilds nothing.
- The snapshot and both locale writes commit together or not at all (pg: one transaction).
- At most `REVISION_CAP` revisions per key; the first save of a key produces no revision.
- `updatedAt` is monotonic per key: any accepted save strictly advances it (pg: `now()` inside
  the transaction is later than the `updated_at` the stale check read).
- Residual, accepted as for posts: the read → compare → write is not serialized, so two saves
  racing inside one millisecond can both pass the check; the loser's state is in its revision.

## Misuse cases

- Stale tab restores a DraftGuard stash and saves: the tab loaded the current `updatedAt`, so
  the save is accepted — the author was asked "Restore?" and pressed Save. The pre-save page is
  in the revisions list, one click from restored. (The check is about *server* changes since load.)
- Two admin tabs: the second saver gets 409, nothing written, no rebuild.
- Attacker with an author session enumerates `/pages/about/revisions`: reads what
  `GET /pages/about` already gives them.

## Rollback

Revert the commit. `page_revisions` is additive (`CREATE TABLE IF NOT EXISTS`) and unreferenced
by the reverted code; it can stay or be dropped by hand. No change to `pages` rows.
