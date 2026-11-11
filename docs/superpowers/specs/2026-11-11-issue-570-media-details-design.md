# #570 — Media details: exposure metadata, fullscreen viewer, versions, no storage path

**Status:** Approved for implementation by independent AI design review (round 2, 2026-11-11;
see *Approval exception* and *Independent AI design review record*).
**Risk:** High (CLAUDE.md): `media` schema, backup/restore, EXIF handling, file lookups that
build paths from database content.
**Extends:** `2026-07-26-media-library-and-galleries-design.md` (data model, *EXIF extraction*,
*Backups*, *Reconciliation*) and `2026-10-27-issue-371-exif-rational-precision.md` (public EXIF
writer — unchanged here).
**Baseline:** `origin/dev` 894effb.

## Scope

The four parts of issue #570, nothing else:

1. Store and show focal length (plus 35 mm equivalent), aperture, ISO and shutter speed.
2. A fullscreen viewer on the details preview.
3. A Versions section listing the variant files that exist.
4. Remove the storage key from Photo details; the discard confirm names the photo.

Not in scope: the optional format comparison, any change to `allowedExif()` / the public variant
allow-list, the Fullscreen API, swipe gestures, a `--dry-run` for the backfill, a DB-level CHECK
for the new columns (see *Value storage*), public-site rendering changes.

## Contracts (fixed before implementation)

### `MediaExif` (`uploader/src/exif.ts`)

```ts
export interface MediaExif {
  takenAt: Date | null; camera: string | null; lens: string | null;
  lat: number | null; lng: number | null;          // unchanged; redacted for non-admins
  focalLength: number | null;       // mm, as recorded (FocalLength)
  focalLength35mm: number | null;   // integer mm (FocalLengthIn35mmFilm; 0 = unknown → null)
  fNumber: number | null;           // FNumber, e.g. 2.8
  iso: number | null;               // integer (ISOSpeedRatings)
  exposureTime: number | null;      // seconds (ExposureTime), e.g. 0.004
}
export type MediaExposure = Pick<MediaExif, 'focalLength' | 'focalLength35mm' | 'fNumber' | 'iso' | 'exposureTime'>;
export function emptyMediaExif(): MediaExif;           // every field null; replaces the private EMPTY_EXIF
export function emptyExposure(): MediaExposure;        // the five fields null
/** null unless `v` is a finite number (typeof 'number') inside the field's bounds; integer fields are rounded first. */
export function exposureValue(field: keyof MediaExposure, v: unknown): number | null;
/** Applies exposureValue to all five fields. */
export function normalizeExposure(e: Partial<Record<keyof MediaExposure, unknown>>): MediaExposure;
```

`parseExif()` fills the five fields from `tags.Photo?.FocalLength`, `FocalLengthIn35mmFilm`,
`FNumber`, `ISOSpeedRatings`, `ExposureTime`. **Only `parseExif` unwraps arrays**: exif-reader
returns a scalar for count 1 and an array otherwise (`[]` for count 0), so an `ISOSpeedRatings`
array contributes its first element when that element is a number; strings, Buffers and empty
arrays give null. `exposureValue` itself accepts only `typeof v === 'number'`. `parseExif` still
never throws.

### Value storage and bounds

Numbers, never formatted strings. exif-reader delivers rationals pre-divided; malformed rationals
arrive as `NaN` (`0/0`), `Infinity` (`n/0`), huge unsigned values (a negative SRATIONAL written
into an unsigned slot reads as 4294967291), or non-numbers. Anything outside these closed ranges
becomes `null`:

| Field | Column | Rounding | Accepted range |
|---|---|---|---|
| `focalLength` | `focal_length double precision` | none | 0.5 – 5000 mm |
| `focalLength35mm` | `focal_length_35mm integer` | `Math.round` | 1 – 10000 mm (0 = unknown → null) |
| `fNumber` | `f_number double precision` | none | 0.5 – 512 |
| `iso` | `iso integer` | `Math.round` | 1 – 10 000 000 |
| `exposureTime` | `exposure_time double precision` | none | > 0 and ≤ 86 400 s |

**The bounds are a compatibility contract: widen only, or ship a data migration** — narrowing a
range later would make existing rows fail backup read-back and existing dumps unrestorable.
No DB CHECK: CHECKs here are write-once (`db.ts` @ai-warning) and every CHECK would also need a
byte-exact mirror in `onboarding-bootstrap.ts BOOTSTRAP_CHECKS`. Instead the bound is applied at
**every write point**, not only at the producers: the pg and memory stores pass the five values
through `normalizeExposure()` inside `upsert` and `setExposure` (as they already validate
`format`/`encoding`), and the restore validates and binds `exposureValue()`'s result. So no code
path can store `NaN` (which `double precision` would accept) or an out-of-range value, and no
stored row can later make `readDump` reject a backup.

### Schema (`uploader/src/db.ts`)

Five nullable columns, added to `CREATE TABLE media` (fresh installs) **and** appended as
`ALTER TABLE media ADD COLUMN IF NOT EXISTS …` (existing installs). No default, no index, no
backfill in the migration, no rewrite of existing rows. Every column-listing site follows:
`media-store.ts` (`MediaRow`, `COLS`, `rowToItem`, pg `upsert` INSERT + `ON CONFLICT` =
`EXCLUDED.*` like `taken_at`, memory store), `backup.ts` restore INSERT, `onboarding-bootstrap.ts`
(`BOOTSTRAP_COLUMNS`, `ADDITIVE_COLUMNS.media`, `NULLABLE_COLUMNS.media`; no defaults/CHECK
entries), `media-sync.ts` (reconciled rows insert `emptyMediaExif()` — reconcile does not parse
originals; the backfill does).

### `MediaStore` addition

```ts
/** Writes ONLY the five exposure columns (normalized); resolves true when a stored value changed. */
setExposure(key: string, exposure: MediaExposure): Promise<boolean>;
```

pg: `UPDATE media SET focal_length=$2, focal_length_35mm=$3, f_number=$4, iso=$5,
exposure_time=$6 WHERE key=$1 AND (focal_length, focal_length_35mm, f_number, iso, exposure_time)
IS DISTINCT FROM ($2::double precision, $3::integer, $4::double precision, $5::integer,
$6::double precision)`; result `rowCount > 0` (verified on PG 18.6 by the reviewer: NULL-safe,
second identical write 0 rows, other columns untouched). Memory store mirrors it. Unknown key →
`false`.

### `MediaItem.fullSrc`

```ts
fullSrc: string | null;   // `${baseUrl}/${key}-${width}.${webp|jpeg}`; null unless status 'ready' and width > 0
```

Server-derived beside `thumbSrc` (the client must not become a third copy of the width contract).
`variantWidths()` always appends the intrinsic width (`variants.ts:31-32`), so this is the largest
variant; `.webp` for modern rows, `.jpeg` for JPEG-only rows. The viewer needs it for every photo
it steps to; a per-step `GET /media/items/*` would run the usage-corpus scan per arrow key.

### `GET /media/items/*` — `versions`

Only `GET /media/items/*?versions=1` adds `versions` (not without the parameter, not `PATCH`, not
`GET /media`). The only caller passing it is the details panel's observation read
(`detailRefresh.read`); gallery lookups, the bulk AI run, the encoding poll and recovery reads keep
today's cost:

```ts
versions:
  | { availability: 'available'; items: MediaVersion[] }   // [] when the key has no variant files
  | { availability: 'processing' }                          // status 'processing': set in flux, not read
  | { availability: 'unavailable' };                        // unsafe key or a storage error other than ENOENT
interface MediaVersion {
  format: 'avif' | 'webp' | 'jpeg';
  width: number;            // from the filename (the variant contract)
  height: number | null;    // from the file header (sharp metadata); null when unreadable
  bytes: number;            // lstat size
  src: string;              // `${item.src}-${width}.${format}` — the public image URL
}
```

Authoritative source is **the disk**: `listVariantFiles(storageDir, key)` in `media-files.ts`
re-asserts `assertSafeKey(key)` before building any path, reads the key's directory exactly like
`deleteMedia` (same `VARIANT_FILE_RE`, same exact-base match so `hero` never lists `hero-b`),
takes regular files only (`Dirent.isFile()` and then `lstat().isFile()`, so symlinks are never
followed), and reads `sharp(file).metadata()` (header only) for the height. A missing directory
(ENOENT) is an empty list; any other error is `unavailable`, logged without the path. Sorted by
width ascending, then avif, webp, jpeg. Legacy, partial (`missing`, `failed`) and JPEG-only sets
therefore list exactly what exists. The original (`-orig.*`) never matches `VARIANT_FILE_RE` and
is never listed. Rows still `processing` are not read: the encoding poll GETs exactly those keys
every 3 s, library keys share one directory per year, and their set is in flux. Visible to
authors and admins alike: these are the public files.

### Original file decision

**Size only, no link** (the existing "Original" row). Originals carry full EXIF including GPS and
are deliberately excluded from the public mount; a link — even admin-only and `no-store` — adds a
new route that serves GPS-bearing bytes and a new authorization surface for no stated need (the
author already has the source file). Reversible later without a schema change.

### Display rules (`uploader/public/media-api.js`, unit-tested)

`api.formatExposure(exif, equivalentLabel)` returns the parts joined by ` · `, omitting every
missing part; `''` for `null`/`undefined`/all-missing. `equivalentLabel` is passed in from
`copy` (`editor.chrome.mediaExposureEquivalent`, EN `equiv.`), so `media-api.js` stays DOM- and
dictionary-free; units (`mm`, `s`, `f/`, `ISO`) are notation. Format names (AVIF, WebP, JPEG) are
data, not dictionary keys:

- Focal: `24 mm`; with a 35 mm value that differs from the rounded focal length,
  `4.3 mm (24 mm equiv.)`; only 35 mm: `24 mm equiv.`. Focal values ≥ 10 round to integers, below
  10 to one decimal; trailing `.0` dropped.
- Aperture: `f/` + up to two decimals with trailing zeros dropped (`f/2.8`, `f/8`, `f/0.95`,
  `f/1.25`).
- Shutter: below 1 s, `1/N s` with `N = round(1/t)` **only when N ≥ 2 and
  `|1/N − t| ≤ 1 % · t`** (the #371 reciprocal rule), else a decimal with up to two decimals
  (`0.8 s`); 1 s and above up to one decimal (`2 s`, `1.5 s`, `30 s`).
- ISO: `ISO 200`.

## UI (Admin Studio, Editorial Desk)

**Copy.** Every new chrome string is an `editor.chrome.media*` key in `site/src/i18n/ui.ts`
(EN and DE), read through `copy` like the neighbouring hint (`media-browser.js:551`) — Golden
Rule 7. That makes `site/` (dictionary only) part of this change: `npm test` + `astro check`.

**Photo details.** The `<p class="media-key">` is removed. The File list shows **Lens** (omitted
when missing), **Exposure** (`formatExposure`, omitted when empty), **Original**, **Variants**,
**GPS** (admin only, unchanged). A **Versions** section follows, rendered from the item
observation: one row per version — `AVIF · 1920 × 1280 · 412 KB` (height `—` when null) — each a
link to the public file, `target="_blank" rel="noopener noreferrer"`, announced as opening a new
tab. States: before the first observation "Reading versions…"; `available` with no items "No
variant files are stored for this photo."; `processing` "Versions appear once encoding
finishes."; `unavailable` "Versions could not be read." Focus on a version link survives the 30 s
observation refresh (re-focus by format+width, the `media-impact.js` pattern). The observation
(`detailRefresh.apply`) stores `versions` and keeps the previous value when a payload has none
(PATCH responses, 409 `current`, poll reads); `detailRefresh.unavailable` keeps the last
`versions` too, and only a panel that never had one shows "Versions could not be read.". When the
poll flips the open panel's photo from processing to ready, `applyEncoded` triggers
`detailRefresh.refresh()` so the Versions section fills without waiting for the 30 s cycle.

**Viewer trigger.** A **View fullscreen** `.btn-secondary` under the preview (`id="dViewer"`).
The `F` shortcut works **only** in the grid's keydown handler (`onGridKey`) on a focused tile,
matched case-insensitively on `event.key` (Caps Lock), unmodified (no Ctrl/Meta/Alt/Shift) and not
`event.repeat`; never in the panel (where `F` is
`<select>` type-ahead and text input). `aria-keyshortcuts="f"` is set on the grid tiles, not on
the button. The hint "F opens the focused photo fullscreen." joins the existing shortcut hints.

**Viewer.** A native `<dialog id="mediaViewer" class="media-viewer">` in `media.html`, opened with
`showModal()`, named by `aria-labelledby` the caption title. It fills the viewport on a solid dark
backdrop; the stage shows `<img src=fullSrc>` at `object-fit: contain`. The caption bar sits on an
**opaque navy plate** with white text (no gradient scrim, no blur): title (falling back to the
file name), the alt texts that exist each prefixed with its code (`DE`/`EN`) and marked with that
`lang`, and "Photo n of N on this page". The `<img>` alt is the EN alt else the DE alt, with the
matching `lang`. Controls: Previous, Next, Close — focus ring white on the plate (the default
`--studio-accent` ring is ~1.9:1 on navy), ≥ 2.75 rem on coarse pointers, all on screen at
320 px. A polite live region announces "Photo n of N: title" after each step. Transitions only
under `prefers-reduced-motion: no-preference`.

**Viewer state.** The viewer tracks `{ currentKey, openerKey, openerKind: 'button' | 'tile' }`,
never DOM nodes or indexes. Each step re-derives the index from `state.items` (grid order of the
current view/filter/page), no wrap. At the ends Previous/Next become `aria-disabled="true"` and
ignore activation — never the `disabled` attribute, which would drop a keyboard user's focus to
`<body>` inside the modal (`admin-ui.js:99-102`). After any background `render()` the open viewer
re-derives its position, "n of N" and end states. If `currentKey` leaves
`state.items` (background reload), the viewer keeps showing its last snapshot of that photo with
stepping disabled and "n of N" hidden; Close still works. `applyEncoded` also copies `fullSrc`,
and if the viewer shows that key it re-renders, so a photo that finishes encoding while open
appears without a reload. Stage states: not `ready` → its status label (`statusLabel`); ready but
`fullSrc` null (width 0) → "No preview", as `fillPreview` does; image `error` → "This version
could not be loaded." — never a broken image.

**Close and focus.** Escape (native `cancel`) and Close both close the dialog; on
close the viewer explicitly focuses the re-resolved opener — `#dViewer` when `openerKind` is
`button` and the panel still shows `openerKey`, else the grid tile of `openerKey` (`focusCell`),
else the detail panel, else the roving (or first) grid tile via `focusCell` — mirroring
`AdminFocus.hold`'s fallback chain (`#grid` itself is not focusable). It never
changes the selection, the detail key or dirty state.

**Discard confirm.** `title || last key segment` (already); the no-item fallback uses the last key
segment instead of the raw key. `.media-detail .media-key` CSS is removed; the global `.media-key`
stays (the AI dialog's failure list uses it).

## Backfill (`uploader/src/exif-backfill.ts`, CLI `backfill-exif`)

`backfillExif(store, storageDir, log)` → `{ scanned, updated, unchanged, missingOriginal,
ambiguousOriginal, unreadable, invalidKey }`. For each `store.allKeys()`:

1. `assertSafeKey(key)` fails → `invalidKey`; counted only, the key is never echoed (it may be
   attacker-sized), nothing is read.
2. Regular files `${base}-orig.<ext>` (`ORIGINAL_FILE_RE`, exact base) in the key's directory.
   Each directory is listed once per run and cached (library keys share `library/<year>/`, so a
   per-key `readdir` would scale with keys × directory size). None (or ENOENT) →
   `missingOriginal`; more than one → `ambiguousOriginal`, skipped; any other directory error →
   `unreadable`.
3. `lstat` must say regular file; `sharp(path, { failOn: 'none' }).metadata()`; any error →
   `unreadable`.
4. `parseExif(meta.exif)` → `setExposure(key, exposure)` → `updated` / `unchanged`.

It writes nothing else: no status, no text, no GPS, no camera/lens/date (it computes them but only
the five exposure fields are passed on). Logs: one line per skipped safe key with its fixed reason
category, and the counts — never metadata values, coordinates, filesystem paths or the libvips
error message (which embeds paths). Before the loop the CLI checks `information_schema.columns`
(scoped `table_schema = current_schema()`, as `main.ts:88` does) for the five columns; if any is
missing it exits 1 with
"Start the upgraded app once (it migrates the schema), then re-run backfill-exif." Exit code 0
when the run completes with only `missingOriginal` skips (legacy keys without originals are
normal); 2 when any key was `ambiguousOriginal`, `unreadable` or `invalidKey`, so an operator
notices. Usage: `docker compose exec app node --import tsx src/cli.ts backfill-exif`, listed in
`cli.ts` usage text.

## Trust boundaries and misuse cases

| Input | Boundary | Misuse | Control |
|---|---|---|---|
| Photo EXIF bytes (upload, original on disk) | `readExif` / `parseExif` | NaN/Infinity/huge rationals, strings/Buffers/arrays where numbers belong, corrupt IFDs that throw | `try/catch` in `readExif`; array unwrap only in `parseExif`; `exposureValue` type + finiteness + bounds; null on failure; upload never fails on EXIF |
| Any store write | `upsert`, `setExposure` (pg + memory) | a future caller passing NaN/out-of-range | `normalizeExposure` at the write point |
| Dump JSON (CLI restore, backup read-back, prune, undo dump) | `readDump` + restore INSERT | non-numeric / out-of-range values, absent keys (old dumps) | present non-null value must be a number and pass `exposureValue`, else `BackupError` before any write; bind `exposureValue()`'s result; absent/null → NULL |
| Key in `GET /media/items/*` and in DB rows | `listVariantFiles`, backfill | `../`, absolute or over-long keys from a hand-edited/restored row; symlinks in storage | `assertSafeKey` re-asserted before any path is built; `Dirent.isFile()` + `lstat().isFile()`; `versions: unavailable` / `invalidKey` without echo |
| Authenticated non-admin author | `serializeMedia` | reading location through the new fields | the five fields are non-location camera settings, shown to authenticated users (authors and admins) only, never public via the API; `allowedExif()` is not widened (two of the fields — `FocalLengthIn35mmFilm` and an array-valued ISO — are not in public variants and stay out); `redactForNonAdmin` unchanged and still nulls `lat`/`lng`/`uploadedBy` |
| Private originals | backfill reads them | GPS reaching logs or new columns | backfill passes only the five exposure fields to the store and logs no values; no route serves originals |

## Invariants

1. `allowedExif()` output is byte-for-byte unchanged; the existing fixture gains
   `FocalLengthIn35mmFilm` so the exact eight-tag assertion proves it is still not published.
2. `redactForNonAdmin` source is unchanged; non-admin responses keep `lat`/`lng`/`uploadedBy` null.
3. The backfill writes only the five new columns and is idempotent: a second run reports
   `updated: 0`; no other column changes even when the original's camera/lens/date/GPS differ
   from the stored row.
4. Malformed or missing EXIF never fails an upload; it yields nulls.
5. No published-site slug, route, rendering or file changes. `site/` changes only
   `ui.ts` admin-chrome keys.
6. Old dumps (no new keys) restore with NULLs. `DUMP_VERSION` stays 15 (see *Backup format*).

## Backup format

`SELECT * FROM media` already carries the new columns into dumps; the restore INSERT names them
with `?? null`. **No `DUMP_VERSION` bump**, a deliberate deviation from the v7/v9 precedent
("older application versions reject v9 rather than silently dropping the new selection",
`ARCHITECTURE.md:1123`): those fields carried author intent that a silent drop would lose; these
five are derived metadata, fully re-derivable from the retained originals by `backfill-exif`.
Recorded in the `DUMP_VERSION` comment and `ARCHITECTURE.md`. Restoring a new dump with older
code is not a supported recovery path (recovery is roll-forward); it merely loses re-derivable
values rather than failing.

## Failure and recovery

- **Missing/unreadable/ambiguous original during backfill:** skipped and counted; that row's
  columns stay as they are (NULL if never filled). Re-runnable after fixing the file.
- **Partial backfill** (crash, ^C, DB drop): each row is one independent UPDATE; completed rows
  keep correct values, the rest stay NULL; re-running converges. No lock, no state file.
- **Storage error on `GET /media/items/*`:** `versions: { availability: 'unavailable' }`, logged
  without the path; the rest of the response is unaffected.
- **Restore into a database the new app has not migrated:** the INSERT fails inside the restore
  transaction and rolls back, as the existing `format`/`encoding` columns already require; the
  documented order is start-upgraded-app-once (migrates) before restore. Tested.

## Rollback

Schema compatibility, not a supported downgrade path: the columns are additive and nullable, and
old code neither selects nor writes them (it lists columns explicitly), so redeploying the
previous image needs no data change; its upserts leave the columns untouched. Dropping the
columns is never part of rollback (Golden Rule 3).

## Documentation

- `SECURITY.md`: the five non-location fields visible to authenticated authors; allow-list
  reconfirmed unchanged (and `FocalLengthIn35mmFilm` not published); backfill reads private
  originals and logs no values; the versions read boundary (`assertSafeKey`, regular files only);
  original-file decision.
- `ARCHITECTURE.md`: media columns, `backfill-exif` in the CLI list, the no-bump dump note.
- `uploader/README.md`: `backfill-exif` usage, exit codes and "run once after upgrading".
- `DESIGN.md`: Media detail bullet (no key; Exposure, Versions, viewer, `F`).
- `cli.ts` usage text; this spec.
- `docs/claude/project-status.md` entry, carrying the release facts so they reach the release
  notes: five nullable `media` columns added automatically on boot, run `backfill-exif` once after
  upgrading, dumps stay v15 with optional keys, roll-forward only.
- Upgrade notes are written into `README.md` at release time by repo convention, not here.

## Verification plan

- **Unit**
  - `exif.test.ts`: real generated JPEG with ExposureTime/FNumber/ISO/FocalLength/
    FocalLengthIn35mmFilm extracts numbers; sharp-written malformed rationals (`1/0`, `0/0`,
    `-5/1`) → null; hand-built IFD bytes for array ISO, count-0 ISO and ASCII ISO; corrupt EXIF →
    nulls; `exposureValue` table at both bounds ± one step for every field, NaN, ±Infinity,
    strings, arrays; `allowedExif` exact eight-tag assertion with `FocalLengthIn35mmFilm` present
    in the source.
  - `media-api.test.ts`: `formatExposure` table incl. `null`, `t` in [0.99, 1), f/1.25, 35 mm
    variants.
  - `media-store.test.ts` (memory): round-trip, `setExposure` changed/unchanged/unknown key,
    normalization of NaN/out-of-range on `upsert` and `setExposure`, `fullSrc` per status/format.
  - `media-files.test.ts`: `listVariantFiles` — modern, JPEG-only, partial, sibling prefix,
    symlinked variant skipped, unsafe key rejected before any read, ENOENT → [].
  - `media-routes.test.ts`: GET versions (available/processing/unavailable), `fullSrc`, admin vs
    author (`lat`/`lng`/`uploadedBy` null for author; exposure fields present for both); PATCH has
    no `versions`.
  - `exif-backfill.test.ts`: updates, second run `updated: 0`, original whose camera/lens/date/GPS
    differ from the row leaves those untouched, missing/ambiguous/unreadable originals, invalid
    key not echoed, interrupted run (store throws mid-way) then re-run converges, captured logs
    contain no coordinates, values or paths.
  - `backup.test.ts`: `readDump` rejects non-number/out-of-range per field, accepts absent keys.
  - `media-browser-dom.test.ts`: key not rendered; Lens/Exposure omission; Versions states and
    links; `F` on a tile opens the viewer, `F` in `dFolder`/text inputs/panel buttons does
    nothing, Ctrl/Meta+F not intercepted; ←/→ stepping and end-disable; not-ready/no-preview stage;
    processing → ready via the poll updates an open viewer; close after a background rebuild
    focuses the re-resolved tile, and `#dViewer` after a panel rebuild; at an end the step
    control keeps focus (`aria-disabled`); discard confirm names the title.
- **Integration (real Postgres 18, `TEST_DATABASE_URL`)**: `media-store.integration.test.ts`
  round-trip at range extremes, `setExposure`, NaN/out-of-range/fractional-integer normalization
  on `upsert` and `setExposure` (the control exists for Postgres, whose `double precision`
  accepts NaN), migration idempotence on a pre-#570 table; `backup.integration.test.ts` new-field
  round-trip, `iso: 100.4` restored as 100, an old dump without the keys, restore into a database
  without the columns rolls back; onboarding bootstrap admits a pre-#570 `media` shape.
- `npx tsc --noEmit` and full `npm test` in `uploader/` with integration suites confirmed running;
  `npm test` and `npx astro check` in `site/`.
- **Running app** on a disposable DB and data dir, real browser at desktop and 320 px, admin and
  author: uploads with full EXIF + GPS, malformed EXIF, no EXIF, JPEG-only; exposure line and
  lens; GPS admin-only; Versions vs a directory listing, opening each; viewer (←/→, Escape, focus
  return, not-ready photo, keyboard-only, reduced motion); key absent; discard confirm by title;
  backfill twice; backup → restore round-trip.

## Approval exception (scoped to #570)

- **Waived rule:** explicit human approval of the high-risk design before implementation
  (CLAUDE.md, *Change Risk and Required Rigor*, High row).
- **Reason:** the repo owner delegated design approval for this issue to an independent AI
  reviewer to avoid an interactive pause.
- **Risks:** a reviewer blind spot on schema/backup/EXIF/GPS boundaries ships into `dev`.
- **Compensating controls:** independent adversarial AI design review (re-review on material
  change); full uploader suite including integration suites against a real Postgres 18; real
  browser verification as admin and author; `/review` on the PR until no substantiated findings;
  the agent neither merges nor deploys, so merge remains a human act.
- **Approver:** the repository owner, authorizing in the #570 implementation prompt
  (2026-11-11).
- **Expiry:** when the #570 PR is merged or abandoned. No other policy is waived.

## Independent AI design review record

- **Reviewer:** `reviewer` subagent running `anthropic/claude-fable-5-2` (high effort; identifier
  from the harness's `task.agentModelOverrides.reviewer` setting and reported by the reviewer's
  runtime).
- **Round 1 (2026-11-11):** CHANGES REQUIRED. Blocking: (1) `F` shortcut scope conflicted with
  `<select>` type-ahead and WCAG 2.1.4 → grid-tile-only, unmodified, non-repeating; (2) viewer
  assumed stable `state.items`/opener under background re-renders → key-based state, `fullSrc`
  copied by `applyEncoded`, explicit focus re-resolution, observation keeps `versions`;
  (3) "same tags already public" was false for `FocalLengthIn35mmFilm` and array ISO, and no
  SECURITY.md plan → rationale restated, *Documentation* section added. Non-blocking findings
  adopted: write-point normalization, array unwrap in `parseExif` only, documented no-bump
  deviation, backfill echo/tie-break/exit code/unmigrated check, explicit test list, versions
  only on GET and not for `processing`, ENOENT vs error, `lstat`, `noreferrer`, focus
  preservation, viewer edge states and accessible name, white focus ring, page-scoped count,
  `ui.ts` keys instead of literals, `N ≥ 2`, two-decimal apertures, `formatExposure(null)`,
  shared `emptyMediaExif()` fixture, 320 px check.
- **Round 2 (2026-11-11): APPROVED** by the same reviewer (`anthropic/claude-fable-5-2`), no
  blocking findings. Non-blocking findings adopted into this revision without changing the
  approved design: pg integration tests for write-point normalization and restore rounding;
  `aria-disabled` step buttons; `versions` opt-in via `?versions=1` from the panel's observation
  read, with a refresh on processing → ready; focus fallback to a tile, the button case tested,
  `unavailable` keeps the last `versions`, viewer re-derives after background renders; per-run
  directory cache, schema-scoped column check, fixed log categories for the backfill;
  widen-only bounds; `equiv.` passed from `copy`, case-insensitive `F`, format names as data;
  release facts in the project-status entry.
