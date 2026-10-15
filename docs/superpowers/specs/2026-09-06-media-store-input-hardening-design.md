# Media store input hardening (issue #133)

**Date:** 2026-09-06 · **Risk:** high (media store, path-traversal guard, `/upload` write path) ·
**Size:** large (four small defects, one shape)

## Why this exists

The memory media store accepts input that Postgres or the filesystem rejects, so the unit suite
never sees the resulting 500s. Four instances, all at the same boundary:

1. `/upload` wrote the original to `/data/images` **before** `cfg.media.upsert` validated the
   `folder` field. A bad folder (`trip/`, a non-NFC name from macOS) 500'd *after* the write,
   leaving an orphan `<key>-orig.jpg` with no row — which the next reconcile backfilled into the
   root folder as an anonymous `processing` row that the encoder then published into the library.
2. `cleanText` only sliced to 1000 characters; a NUL in `title`/`alt`/`caption` reached Postgres
   (`invalid byte sequence for encoding "UTF8": 0x00`) as a generic 500. `normalizeTags` and
   `cleanExifString` already strip control characters for exactly this reason.
3. A client-supplied storage key had no length or depth cap. `storeOriginal` does `mkdir -p` on the
   key's directories, so `a/a/a/…` (1000 segments) built a 1000-deep tree per upload and a 300 KB
   key failed with `ENAMETOOLONG` as a 500 — after passing the regex.
4. `renameFolder` / `deleteFolder` issued their check + two `UPDATE`s (+ `ensureFolders`) as
   separate pool queries, while `media_folders` is declared the single source of truth for the
   tree. A dropped connection or a concurrent `POST /media/folders {path: to}` between the two
   `UPDATE`s strands media rows in a folder the tree no longer lists.

## Decision

- **Validate before writing.** `POST /upload` runs `assertSafeFolder(folder)` (→ 400 with the
  store's message) and `assertSafeKey(versionedKey)` (→ 400) right after the `KEY_RE` check, before
  the disk-space probe, the probe, and `storeOriginal`. The write chokepoint is unchanged; the
  route merely refuses earlier.
- **`cleanText` mirrors `normalizeTags`:** strip `\p{C}` (NUL, C0/C1 controls, DEL, format
  characters) before the length cap. Titles, alt and captions are single-line inputs in the media
  browser and are emitted into gallery `alt="…"`/`caption="…"` attributes, so no control character
  is ever legitimate there. Blank-for-blank semantics (`''` keeps the stored value) are unchanged.
- **`assertSafeKey` caps length and depth** (numbers below), keeping the regex and the `..`/`//`
  checks exactly as they were. The error message for an over-long key does **not** echo the key
  (`DELETE /media/items/*` returns the message in a 400 body).
- **`renameFolder` and `deleteFolder` run in one transaction** on a checked-out client
  (`BEGIN … COMMIT`, `ROLLBACK` on any throw), including the existence / emptiness checks, so a
  concurrent folder create either happens-before (→ `exists`/`not_empty`, 409) or happens-after
  (sees the renamed tree). `ensureFolders` takes the client so the ancestor fill for a nested
  target is in the same transaction.

## The key cap — a cross-lane contract

|constant|value|where|
|---|---|---|
|`MAX_KEY_LEN`|**200** characters, measured on the **final** key (`storeOriginal`/`storeVariants` argument, i.e. after `contentHashKey` appends `-<hash8>` for uploads)|`uploader/src/storage.ts`|
|`MAX_KEY_DEPTH`|**8** path segments (7 slashes)|`uploader/src/storage.ts`|

Consequences for producers of keys:

- **`/upload`**: the client key may be at most **191** characters (200 − 9 for `-<hash8>`), and the
  route validates the versioned key, so the cap is enforced once at the route (400) and again at
  the write chokepoint (defence in depth).
- **`libraryKey`**: `library/<yyyy>/<base≤60>` + `-<hash8>` ≤ 82 characters, 3 segments — far inside.
- **WordPress import** (`trips/<slug>/<nameFromUrl>`, `trips/<slug>/hero`; un-hashed, see #85): the
  importer owns fitting inside the cap. `nameFromUrl` is unbounded today; #98 (import lane) MUST
  bound it so that `6 + slug.length + 1 + name.length ≤ 200`, deterministically (the disk-derived
  resume depends on the key being a pure function of the URL). Keys are exactly 3 segments, so the
  depth cap is never at play there.

Why 200 and not the folder cap's 6 segments: the folder tree is human-facing and bounded for
display; a key is a filesystem path whose per-component limit is 255 bytes on every target
filesystem and whose total is bounded by `PATH_MAX` (4096) — 200 leaves ample room under
`/data/images/…-1280.avif`. 8 segments is generous over every real producer (3) while keeping
`mkdir -p` shallow.

## Trust boundaries and invariants

- `assertSafeKey` stays the single write chokepoint (`storeOriginal`, `storeVariantFiles`) and is
  re-asserted at the read boundaries that build paths (`readOriginal`, `deleteMedia`, the WXR
  resume `lookup`). Tightening it tightens every path at once; nothing bypasses it.
- A key that passed the old check but fails the new cap could only exist on disk if written by a
  pre-#133 build. No production deployment exists (see `CLAUDE.md`, #68), and `walkStorageKeys`
  does not assert keys, so such a file would simply be unreachable for encode/delete rather than
  crash a reconcile.
- The folder-validation order in `/upload` is now: auth → multipart → image mime → `KEY_RE` →
  `assertSafeFolder` → `assertSafeKey(versionedKey)` → disk space → probe → duplicate check →
  `storeOriginal` → `upsert` → enqueue. Every input-validation 4xx precedes every write (the
  pre-existing backlog-full 429 still follows persistence; `encodeQueue.recover()` re-seeds it).
- Transactions use the same shape as `pgPostStore.upsertDraft`: `pool.connect()`, `BEGIN`, work,
  `COMMIT`; `ROLLBACK` in `catch`; `release()` in `finally`. Postgres' default READ COMMITTED gives
  atomic rollback, not serialization against every concurrent folder/media mutation — which is
  all this needs: the folder primary key makes a concurrent insert of `to` collide with the
  `UPDATE` (unique violation → the transaction rolls back, surfaced as a 500 that left nothing
  behind) or be seen by the pre-check (409).

## Misuse cases considered

- Deep or huge key via `/upload` or `/media/items/*`: 400 before any filesystem or database work;
  the message never echoes an over-long key.
- NUL / bidi override / zero-width joiner in title/alt/caption via `PATCH /media/items/*` or
  `/upload`: stripped; the row saves. Postgres never sees `0x00`.
- Bad folder via `/upload`: 400; no original written, no orphan for the reconcile to adopt.
- Folder rename racing a folder create: one of the two loses cleanly (409 or a rolled-back 500);
  media rows never point at a folder outside `media_folders`.

## Rollback

Revert the commit. No schema change; the transaction wrapper and caps are code-only. A key cap
rollback would re-admit deep/long keys but not invalidate anything written under the cap.
