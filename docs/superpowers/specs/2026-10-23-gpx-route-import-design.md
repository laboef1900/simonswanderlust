# GPX routes: privacy, storage and publication

**Date:** 2026-10-23  
**Issues:** [#312](https://github.com/laboef1900/simonswanderlust/issues/312), part of [#311](https://github.com/laboef1900/simonswanderlust/issues/311); implementation [#313](https://github.com/laboef1900/simonswanderlust/issues/313), then [#314](https://github.com/laboef1900/simonswanderlust/issues/314).  
**Risk:** HIGH — untrusted XML, location privacy, schema, backup/restore and publication.  
**Status:** Proposed; explicit owner approval of this completed specification is required before implementation. Issue labels and automated reviews do not grant approval. Each implementation PR also requires owner approval; merging, deployment and publishing real content require separate authorization.

## 1. Scope, decisions and baseline

An author imports a local GPX, inspects its tracks and waypoints, removes sensitive ends or whole segments, and explicitly attaches the remaining route to a saved story pair. An admin alone may Publish. Existing stories, URLs, manually entered stops and the free-text `route` label remain valid. No journeys, tracking, third-party upload/tiles, geocoding, elevation profiles or travel statistics are introduced.

Owner decisions recorded in #312 on 2026-10-23: separate per-pair route storage; privately retained original; private elevation/timestamps; author import/attach/read/original access; admin Publish; distance/point trimming with a self-hosted z8 context map and no-basemap fallback; explicit waypoint adoption; no private GPX data in the browser draft stash; public-artifact-only MDX; future journey reuse permitted but not implemented.

Additional owner answers during this assignment, 2026-10-23:

- Keep the **latest successfully attached original**, including after detach. A confirmed replacement removes the superseded original; deleting the post removes the current original. Rejected files are discarded. Cancel removes staged previews; crash/abandonment expires them after one hour. Existing backups expire normally.
- Private DB dumps include full-precision draft geometry, elevation and timestamps. A **dedicated, manifest-matched private route archive** carries originals, not the images archive or MDX.
- Public coordinates: **four decimal places**, with **25 metre** per-segment simplification. Neither is anonymization; sensitive locations must be deliberately removed.

These answers settle the choices, not the final specification/PR approval gates.

### Verified integration baseline

`origin/dev` at `59244728a88bd964e9740d92a108492a10b59eea`; related #271 has merged. Native dependencies remain #313 ← #312; #314 ← #312 and #313. No issue is marked `NO AI`.

| Existing contract | Consequence |
|---|---|
| `posts` is unique on `(translation_key, locale)` (`uploader/src/db.ts`); the key is arbitrary text | No foreign key to `posts.translation_key` alone. Never put a translation key directly in a filesystem path. |
| `PostShared.stops` is `{ name, lat, lng }[]` (`uploader/src/posts.ts`) | Names are shared, not independently editable per locale. Import exposes one editable name used by DE and EN; no locale fields are added. This corrects #312's ambiguous wording. |
| `route` is an existing free-text string | New geometry uses `track`, not `route`, in published content. |
| `RevisionSnapshot` captures `status/shared/de/en` once per pair, capped at 20 | A shared geometry column would produce two working copies and up to **20**, not 40, revision copies. Separate storage avoids these private copies, but not the two intentionally public locale snapshots. |
| `POST_SNAPSHOT_SQL` is also used by schema/legacy-restore backfills | Backfills must never join a current draft route. The route artifact is added only by explicit Publish. |
| `pgPostStore.publish()` currently copies current working columns; save's stale check precedes its transaction | Introduce a shared per-pair mutation lock and perform route-sensitive checks inside it; a separate table alone is not isolation. |
| `POST /export` exports working post content; the loader reads published snapshots | Route export needs an explicit snapshot projection. Never add private route fields to `PostPair` or generic object serialization. |
| `fast-xml-parser` 5.9.3; synchronous parser; WXR options are permissive | Use the existing package but a separate strict GPX boundary. An event-loop timer around synchronous parsing is not a deadline. |
| MapLibre fit-bounds uses `maxZoom: 8` | It limits initial framing, not coordinate disclosure or subsequent zoom. Anyone can decode embedded JSON. |

The earlier travel-map spec and `docs/superpowers/plans/2026-06-25-travel-map.md` remain authoritative for self-hosting and pin-only overview maps. This specification replaces their no-story-lines limitation only. The historical backend-rework implementation prompt is not a GPX plan.

## 2. Data classification and invariants

| Tier | Contents | Access / persistence |
|---|---|---|
| Import staging | Original bytes and bounded normalized preview, including untrimmed points/waypoints | Importing author only; authenticated `no-store`; one-hour expiry; no browser storage, revisions, exports or backups |
| Attached private state | Trimmed full-precision points with optional elevation/time; latest original still contains removed points and arbitrary source metadata | Any signed-in author may read, including the retained original; app files/DB and private backups only |
| Public artifact | Strict 2D, trimmed, simplified, rounded `MultiLineString` | Immutable copy at explicit admin Publish; both locale snapshots, build output and MDX projection |
| Existing post metadata | Manually entered or explicitly adopted stops and free-text route label | Existing shared-post/save/revision/publish rules; not automatically imported from GPX |

Invariants:

1. No original, untrimmed point array, elevation, GPX timestamp, filename, source identity, extension or private bounding box enters a published snapshot, Content Layer entry, HTML/JSON, sitemap, public asset or MDX.
2. The original and private backups **intentionally retain removed locations**. Trimming controls publication; it is not private erasure. A whole private dump cannot satisfy a blanket “no removed points/timestamps in any backup” assertion. #311/#314 acceptance is interpreted by tier: public projections are leak-tested; private route rows/archive bytes are preservation-tested and access-controlled. This does not relax public leak protection.
3. The server and browser make no third-party request because of GPX import, trim, preview, attach or public rendering. No reverse geocoding, AI submission, remote XML/schema/extension resolution, tiles, fonts, sprites or telemetry. The existing explicit waypoint-search feature is separate and is never invoked automatically.
4. Each retained contiguous run remains separate. Never connect tracks, routes, source segments, removed segments, antimeridian breaks or unrelated trips.
5. Only explicit Publish changes the public route, including attachment, edits and **detachment**. Rebuild, Save, backup and revision restore never promote a draft route.
6. Cancellation before Attach leaves the post and its attached route unchanged. A failed attach leaves the previously attached route intact. A successful attach is immediately durable draft state, not a promise to save later.
7. Route data is never added to `PostShared`, `RevisionSnapshot`, `buildPayload()` or the `DraftGuard` stash. Candidate waypoints, import tokens and trim selections are also memory-only. Once explicitly adopted, ordinary shared stops retain their existing metadata/stash contract; this is not storage of the GPX preview or private point arrays.
8. All private reads/writes have route-local authentication and `Cache-Control: no-store`, including errors and original downloads. No sensitive input in logs or exception details.

## 3. Bounded GPX input and parsing

### Limits (binary byte units)

| Resource | Limit / outcome |
|---|---|
| File | 5 MiB; `.gpx`, one multipart file, no extra fields/files; file bytes capped before parser allocation. Request cap 5 MiB + 16 KiB multipart overhead. Larger → 413. |
| Upload elapsed time | 15 seconds from admission; abort stream, close temporary handle and release slot on timeout/disconnect |
| Parsing / normalization | 2 seconds in a terminable worker, including decoding, validation and normalization; timeout → 422 `gpx_timeout` |
| Parser admission | One active parse/attach normalization worker process-wide, no queue; busy → 429 `gpx_busy` |
| Worker heap | `resourceLimits`: old generation 128 MiB, young generation 16 MiB, stack 4 MiB; worker failure → bounded sanitized error, never app crash |
| Nesting | 32 XML element levels, extensions included; reject rather than truncate |
| Route points | 50,000 total `trkpt` + `rtept`, counted across all source segments, before dropping short segments |
| Source segments | 100 total `trkseg` + `rte`, including empty segments; reject excess |
| Waypoints | 500 `wpt`; reject excess, not silent truncation |
| Point/waypoint values | Finite decimal lat/lng; optional bounded elevation/time; name max 200 Unicode code points after XML character-reference decoding |
| Staging | At most two imports per author, ten globally; at most 50 MiB original bytes globally; quota refusal does not evict someone else's preview |
| Attach JSON | 64 KiB route-specific `bodyLimit`; selection descriptor, not 50,000 client-supplied points; malformed/oversized input → 400/413 |
| Normalized private geometry | At most 12 MiB serialized UTF-8 JSON, plus original size above; reject before DB write or HTTP response |
| Public artifact | At most 100 emitted runs, 2,000 total vertices and 64 KiB compact JSON; no automatic tolerance increase or truncation |

The input byte cap, point/segment caps, bounded result size and single worker bound different resources. `worker_threads` heap limits alone do not bound external buffers; the explicit buffer/result caps do. Construct a transferable, exclusively owned bounded input buffer; avoid copying a pooled Buffer's unrelated backing memory. The parent terminates the worker on deadline/disconnect and waits for termination before admitting another. No synchronous parse/validator/normalizer fallback on the server event loop. A worker heartbeat test must demonstrate that the app remains responsive during hostile input.

### Encoding and declarations

Accept XML 1.0 as UTF-8 (optional UTF-8 BOM), UTF-16LE or UTF-16BE **with BOM**. Reject UTF-32 signatures first (before treating `FF FE` as UTF-16LE), BOM-less UTF-16, legacy encodings, invalid sequences, unpaired surrogates and embedded NUL. Use fatal `TextDecoder` decoding; check decoder support at feature initialization. Unsupported runtime decoding disables import with a clear service error, not lossy decoding.

If an XML declaration is present it is the first decoded construct, declares version 1.0, and its encoding must agree with the detected bytes: UTF-8; or UTF-16/the matching endian-specific name. An absent declaration is allowed. Reject conflicting/repeated declarations and unsupported processing instructions rather than interpreting them. Reject characters outside XML 1.0's allowed character ranges, including invalid numeric character references.

**Before validation or parsing**, inspect the exact strictly decoded string passed to both. Reject `<!DOCTYPE` and `<!ENTITY` case-insensitively anywhere, and all other `<!` declarations except XML comments and CDATA. A conservative refusal of declaration-looking text inside a comment/CDATA is acceptable and documented as unsupported input. An ASCII-byte scan alone is specifically prohibited; UTF-16 hostile fixtures exercise both endiannesses.

Use `XMLValidator.validate(text)` and reject any error without echoing its message, token, source line or value. Then `new XMLParser` with explicit options:

```ts
{
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  htmlEntities: false,
  removeNSPrefix: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  trimValues: false,
  maxNestedTags: 32,
  strictReservedNames: true
}
```

`processEntities: false` also disables predefined-entity decoding in this version. Decode only the five XML predefined references and valid decimal/hex numeric references in consumed scalar values, once, with no recursive expansion. Reject unknown entity references. No DTD/schema validation or resource resolution. The WXR parser is only an error-class precedent; do not reuse its options or log parser errors containing input.

### GPX namespaces and values

Require one `gpx` root in `http://www.topografix.com/GPX/1/0` or `/1/1`, with matching version `1.0`/`1.1`. Accept default and prefixed namespaces by resolving QName prefixes against an element-scoped namespace stack; do **not** strip prefixes globally. The validator does not enforce namespace correctness: reject unbound prefixes and duplicate expanded attribute names. Read only direct structural children with the GPX URI: `gpx/trk/trkseg/trkpt`, `gpx/rte/rtept`, `gpx/wpt`, and their scalar `ele`, `time`, `name` children. Extensions/foreign-namespace lookalikes never contribute coordinates or metadata, even if named `trkpt`/`time`. Unknown subtrees remain subject to XML/depth/byte/deadline limits but are not retained in normalized geometry.

- Preserve document order across tracks, routes and their segments. A file containing both `trk` and `rte` imports both; do not deduplicate or join them. Report both counts so an author can remove a duplicate route deliberately.
- Decimal lexemes only: `^[+-]?(\d+(\.\d*)?|\.\d+)$`; no empty values, hex, exponent notation, Infinity or NaN. Latitude [-90, 90], longitude [-180, 180] inclusive. `0,0` is valid, not a magic missing-point sentinel.
- Optional elevation is metres, finite decimal within [-12,000, 100,000]. Optional time is a valid calendar date/time with timezone in years 0001–9999, max 35 characters, normalized to UTC ISO form; no inference of missing timezones. Missing elevation/time is valid; malformed present values fail the file rather than silently changing retention. No chronological-order requirement.
- Any malformed consumed point fails the whole file. Return a safe code and invalid-point count (including waypoints), never coordinates/raw text; do not quietly skip a bad point and bridge its neighbors. Do not compute a count after a resource-limit refusal.
- Segments shorter than two points are omitted with an explicit count. Split any edge with absolute raw longitude difference >180° into separate runs before presentation/simplification; do not draw the long way round or interpolate a connection. This can produce short runs; report them. Polar coordinates remain valid; textual controls work where Mercator cannot display them.
- A `wpt`-only file succeeds as a waypoint preview; no route can be attached. Empty/non-GPX/malformed XML or a file with neither usable lines nor waypoints is rejected. No point-only route is invented.

Normalized private geometry is versioned `{ version: 1, segments: [{ points: [{ lng, lat, elevation?, time? }] }] }`. Waypoints are a separate preview-only `{ name, lng, lat }[]`; no arbitrary GPX attributes/properties survive. Every attach revalidates the complete normalized shape at the store boundary, including finite values, closed object keys and all limits.

## 4. Pure trimming and public artifact

A pure module shared by server and editor accepts normalized segments and a selection `{ startPoints, endPoints, removedSegments }`. Indices/counts are nonnegative safe integers; segment indices are unique/in range. Points retain source order. Starting from source data, exclude named segments, then remove the requested count from the beginning/end of the remaining ordered points, without merging segments. Remove resulting runs shorter than two points and report them. All-point removal is an error for Attach, never implicit Detach.

Distance controls convert metres into the same point counts with haversine distance using mean Earth radius 6,371,008.8 m. Only within-segment edges count; gaps contribute zero. Keep the first point whose within-run cumulative distance is at least the requested start distance, with the symmetric end rule; no interpolated boundary point. Switching controls shows the corresponding point counts. Reset/undo is implemented by changing the selection over an immutable preview, not by repeatedly cutting the already-cut array. Everything remains reversible until Attach. The map distinguishes removed and retained runs by line pattern plus a text legend, not color alone.

The **public artifact** has only:

```ts
interface PublicTrack {
  version: 1;
  type: 'MultiLineString';
  coordinates: [number, number][][]; // [longitude, latitude], never a third ordinate
}
```

For each retained run independently: iterative Ramer–Douglas–Peucker at 25 m using spherical shortest-point-to-minor-great-circle-segment distance (endpoints included); round to four decimal places; normalize negative zero; remove consecutive equal rounded positions. Never simplify across a run boundary. Emit no run with fewer than two distinct rounded positions, and report collapsed runs. Reject an all-collapsed result or the output caps; do not silently raise tolerance, join runs, publish empty geometry or retain precise coordinates as a fallback. Attach/public-candidate validation and Publish use the same deterministic function. The author sees the public candidate and collapse warnings before confirmation once #314 lands.

The result contains only positions derived from **retained** points. A repeated source position or a rounding collision can have the same tuple as a removed point; no implementation can promise global tuple inequality in that case. Privacy tests use distinct removed/retained rounded positions and also verify source-run provenance. Rounding and simplification can move endpoints/shortcut bends and are not an anonymity radius. A line may still reveal a home, hotel or trail. The UI explains this and offers inspection before attachment.

Only route maps use this artifact. `tripPins` and the homepage/full-map overview remain pin-only; no lines through unrelated trips.

## 5. Storage, identity and concurrency

### Database

`post_routes` has one row per `translation_key` (text primary key), not per locale:

- `version uuid NOT NULL`: random mutation token; compare-and-swap, not a wall-clock timestamp.
- `geometry jsonb NULL`: validated trimmed private geometry; NULL means detached.
- `source_id uuid NOT NULL`, `source_sha256 text NOT NULL` (64 lowercase hex), `source_bytes integer NOT NULL` (1–5 MiB): latest successfully attached original.
- `updated_at timestamptz NOT NULL`.

Detach retains the row/source, clears `geometry`, and changes `version`. This tombstone prevents absent→attached→absent ABA conflicts and allows recovery from the original. A post that never attached a route has no row and version `null`. The draft row is deliberately **unversioned**: the mutation token is not history. No private geometry or source pointer in post revisions. Restoring a text revision leaves the current route untouched and says so in the UI. Re-importing the current original is the explicit route recovery path; it never attaches/publishes automatically.

There is no invalid single-column foreign key to the two-locale `posts` table. All create/update/publish/unpublish/remove/route mutations use one transaction-scoped advisory lock keyed by `translation_key` (stable PostgreSQL hash; a collision only serializes unrelated pairs). Acquire it **before** reading/stale checks; then lock existing locale rows in `de`, `en` order. A route mutation requires both rows to exist. Save cannot resurrect a pair that was deleted after its existing-post check. Adopt the same ordering in memory-store test doubles. No network, worker parse or build while holding this transaction.

Route mutations bump both `posts.updated_at` values in the same transaction, keeping existing unpublished-change indicators honest. Return the resulting pair `updatedAt` plus route version so the current editor advances its save base token without marking unrelated form edits clean. Ensure timestamp monotonicity at the editor's millisecond precision for these writes and all cooperating post writes. Stale route version returns 409; stale form save keeps its existing conflict behavior. Publish and bulk actions cannot bypass the lock.

### Original files

Root: `join(dirname(STORAGE_DIR), 'routes')`, normally `/data/routes`; no new environment variable. It is a sibling of images, never inside images, static admin, map assets, site releases or MDX exports.

Paths: `originals/<sha256(translation_key)>/<source_id>.gpx`; staging `pending/<random-256-bit-id>.gpx`. No client filename/path is retained. Use generated identifiers, `assertSafeKey`/containment checks at **every** read/write/delete and reject symlink traversal. Private directories mode 0700 and files 0600. Original reads use a fixed download name, `application/octet-stream`, attachment disposition, `nosniff` and `no-store`; never render arbitrary original bytes as same-origin XML/HTML.

Write temp → fsync/close → atomic rename before committing a DB pointer. The previous pointer/file stays intact until commit. Filesystem and Postgres are not one transaction:

- Pre-commit failure: remove the newly written unreferenced file; keep old DB/file. If removal fails, record only a safe cleanup code and let reconciliation retry.
- Commit succeeds, response is lost: GET route state identifies success by new version/source/selection outcome; never automatically repeat a destructive replacement. The editor preserves its preview until it resolves the outcome.
- Commit succeeds, old-file unlink fails: the new route is still saved; return `cleanupPending: true`, never “nothing saved.” Reconciliation retries bounded cleanup.
- Missing/corrupt retained original: report `originalAvailable: false`; reading/re-importing it fails safely, but existing trimmed geometry and published snapshots remain usable. Do not replace missing data with the public artifact and call it the original.

One application-wide route-file lifecycle mutex serializes Attach/replacement, post deletion, original cleanup and backup archive capture. It is separate from the build/encode `workLock`. All paths use it, including bulk deletion and boot reconciliation; acquire file gate before the DB pair lock where both are required. The application is one process; CLI restore runs with the app stopped. DB pair locks still protect database races independently of the file gate. A backup cannot lose a referenced original halfway through capture.

Reconciliation inspects only the application-owned route root with strict filename checks: expire pending files after one hour; remove unreferenced finalized originals after a one-hour grace, while holding the file gate and rechecking DB references. Route files referenced by a manifest being captured are protected by the same gate. Never follow symlinks or sweep unrelated `/data` contents. Delete route rows orphaned from both locale rows transactionally, then reclaim their files. Unknown/malformed entries are reported without deletion. This scoped cleanup is part of the owner-approved lifecycle, not permission for general data cleanup.

## 6. Authenticated API and editor lifecycle

Every route below uses `requireAuth`; authors have the same route read/write access as admins. Session-store failure stays a sanitized error, not anonymous access. Publish remains `requireAdmin`. Responses/errors are `no-store`; request-body/XML/geometry logging is disabled and error classes carry codes/counts only. Reject foreign Origin on GPX mutations using same-origin equality when Origin is present, in addition to existing strict session cookies. No public route endpoint is introduced.

| Endpoint | Contract |
|---|---|
| `POST /gpx/imports` | One bounded multipart file. Validate in worker, stage valid original only, bind opaque import ID to author and one-hour expiry; return normalized preview, waypoints, counts and expiry. Does not create/save a post. |
| `DELETE /gpx/imports/:id` | Importing author only; cancel/delete pending file; idempotent 204. Unknown/other author's ID reveals no data. Abort active request on dialog close. |
| `GET /posts/:tk/route` | Any author; `{ version, geometry, originalAvailable }` plus bounded source byte count, no filesystem path. Missing post → 404; never-attached → version/geometry null. |
| `GET /posts/:tk/route/original` | Any author; guarded retained-original download, including after detach. Validate digest/length; missing/corrupt → safe error. |
| `POST /posts/:tk/route/import` | Any author; reparse retained original into a new author-bound preview. Explicit recovery; no route mutation. Same caps/worker/quota. |
| `PUT /posts/:tk/route` | 64 KiB JSON `{ importId, baseVersion, selection, confirmReplace }`. Strict closed shape; no arbitrary geometry, raw path or public artifact accepted. Resolve staged original, reparse/trim/revalidate server-side, then compare version and commit. Replacing an existing source/geometry requires `confirmReplace: true`; a UI dialog alone is insufficient. Return new route state, `updatedAt` and cleanup outcome. |
| `DELETE /posts/:tk/route` | Bounded JSON `{ baseVersion, confirmDetach: true }`; clear draft geometry, keep latest original, change version and bump post timestamps. Confirm scope; no change to published snapshot. |

A route attach body is small because it carries selection, not geometry. Full geometry validation remains mandatory on the server-derived result and at store/restore boundaries. #313's own-bodyLimit requirement is met without raising the ordinary 1 MiB post JSON limit. Staging quota and byte cap apply before accepting another preview, with a stable error and a way to cancel the previous preview. After restart, old pending previews are not attachable (no author binding in memory); they expire/reconcile, and the user reselects the local file.

### Operate-mode UI contract

Reuse `uploader/public/editor.html`, existing Story details/route controls, admin tokens, `AdminConfirm`, command-bar status and drawer focus behavior. No admin-shell redesign. A flat **GPX route** section gives attached/detached/none status and Import, Edit from original, Download original and Detach actions as applicable. Open a scoped native dialog for the large map/trim task; on small screens use its full available width with controls stacked below the map. Do not nest a second modal inside the mobile inspector: close/suspend the inspector before opening, then restore its state/focus on return.

- Sequence: choose file → bounded loading → map/segment list/trim controls → review selection → explicit Attach. File input remains keyboard-accessible; drag-and-drop is supplementary. Display point/segment/waypoint counts and kept/removed counts, retained-original warning and exact save scope.
- Map is context, not the privacy control. Number inputs for start/end distance or point count; per-segment checkboxes, Reset and textual status remain usable without WebGL. The blank-grid fallback still draws the route (local SVG if WebGL fails), never a request to another tile service. No-basemap status is visible, not an endless spinner.
- Show errors beside the input/action, focus the first actionable error, and announce concise status through a live region. No untrusted HTML. Labels, confirmation scope, 44px coarse-pointer targets, focus containment/Escape/return, zoom/reflow and reduced-motion behavior follow existing admin patterns. Disable duplicate submissions; cancel invalidates late responses via epoch/AbortController.
- All new copy lives in `site/src/i18n/ui.ts` in DE and EN. The admin receives a deterministic generated plain-JS projection using the existing generated-copy convention; no second hand-maintained dictionary. Admin remains in its current shell language; public text follows article locale.
- Candidate waypoints have unchecked selection and editable **shared** names. Confirm **Add selected stops to draft** separately; copy only confirmed `name/lat/lng` into existing rows, append without overwriting existing stops, and use existing Save draft. Name/coordinate validation occurs before adoption and save. No geocoder call, automatic adoption, locale split or elevation/time in stops. A wpt-only import uses this action without Attach. Cancelling the route dialog does not undo stops that the author separately confirmed; the action states this scope.
- GPX preview/selection stays out of `DraftGuard`. Navigation/401 warns that an unattached preview is not recoverable from the browser stash. Save, Publish, revision restoration and post switching never implicitly attach an open preview; require explicit Attach or Discard first. Cancel leaves a pre-existing attachment unchanged.

**Unsaved post:** preview is allowed before first save. The final action is labelled **Save draft and attach route** and explicitly states that current text/metadata will be saved first. Use the existing `doSaveDraft` path (including slug confirmation/conflict handling), obtain the returned key/token, then attach. If the first save fails/cancels, no attach occurs and preview remains. If save succeeds but attach fails, state **Draft saved; route not attached**, keep the new key and preview for retry, and never delete the draft as compensation. On an already saved post, Attach only saves the route; other unsaved text remains dirty and unchanged. Successful Attach updates the post timestamp base token without calling `guard.markClean` for the form. Route state is already durable; Cancel afterward does not undo it. Show **Route saved to draft; live route unchanged** when applicable.

### Map dependencies and vendoring

Pin new uploader dependencies to the site baseline's exact **`maplibre-gl@5.24.0`** and **`pmtiles@4.4.1`**. `copy-vendor.mjs` copies `maplibre-gl/dist/maplibre-gl.js`, `maplibre-gl/dist/maplibre-gl.css` and `pmtiles/dist/pmtiles.js` into ignored `public/vendor/`; Docker already runs this script. Load these only for the GPX editing surface. Retain package license notices.

Registry metadata and package file listings were inspected on 2026-10-23: both BSD-3-Clause; MapLibre points to the maintained MapLibre project and publishes a provenance attestation; PMTiles points to the Protomaps project and depends on `fflate`. Lock integrity matches the existing site lock. This is metadata/provenance discovery, not a claim of a completed vulnerability audit; #313 must audit the final lockfile and resolve relevant advisories before approval. MapLibre's transitive geometry/tile parsers and worker are the added browser surface. No new server XML dependency.

Do not add deprecated `protomaps-themes-base` to uploader. Use a small fixed local context style over the existing Protomaps `earth`, `water`, `boundaries`, `roads`, `places` layers, self-hosted glyphs and attribution; no sprites or external style document. This scoped editing style does not replace the public site's theme. PMTiles protocol registers once, all tile/font requests resolve to the app origin, and the map URL is fixed `/map/basemap.pmtiles`. Tile failure switches to a no-source grid style without discarding overlays. Camera fit z8 is a convenience; authors may inspect geometry at higher zoom without claiming more basemap detail. Never enable geolocation or map-position URL hashing.

Upstream references: [MapLibre Map API](https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/), [PMTiles MapLibre integration](https://docs.protomaps.com/pmtiles/maplibre), [Protomaps layer contract](https://docs.protomaps.com/basemaps/layers), [MapLibre repository](https://github.com/maplibre/maplibre-gl-js), [PMTiles repository](https://github.com/protomaps/PMTiles). Exact package entrypoints above were verified with `npm pack --dry-run --ignore-scripts`, not assumed from current unversioned documentation.

## 7. Explicit Publish and public read paths

Preflight reads both working locale rows and the route row, validates the post/route and derives the public artifact in the bounded worker **outside** transaction locks. Carry the pair's millisecond-safe `updatedAt` and route `version` as the validated input tokens. Under the pair lock, reread/lock both locale rows and the route row and require both tokens to match; otherwise return 409 without committing either locale. This closes the validation-to-publication race without holding a DB transaction during parsing, rendering, media checks or a build. For a single editor Publish also require the route version the admin reviewed; a changed token must not publish unseen route changes. Bulk Publish uses its existing explicit scope confirmation and captures/validates each pair with the same token check. Failure leaves both locale snapshots unchanged.

Do not put a live-route lookup inside `POST_SNAPSHOT_SQL`: boot and legacy-restore callers must remain route-free. Explicit `publish()` adds `track: artifact` to that expression in the transaction updating both locale rows; no attached geometry means **omit** `track` from the newly created snapshot, not merge with an older snapshot. Serialize the identical public artifact into both locales. This intentional small duplication is what isolates public output from subsequent edits/detachment. Migration order must create the route table before any explicit-publish query references it; migration/backfill never populates track from drafts.

All publish entry points (single and bulk, memory and PostgreSQL stores) follow this contract. Integrate route validation/version checking with existing publish gates so the validated route is the committed one. Builds read only the committed snapshots; a failed build leaves the existing release served, with the newer snapshot available for a deliberate rebuild retry. Do not claim a DB commit and a filesystem release switch are one transaction.

- `postgres-loader.ts`: select only `published_snapshot.track`; never join `post_routes`, even to fill a missing field.
- Zod content schema: optional strict `PublicTrack` with coordinate/range/run/size checks; existing entries without it are unchanged. Reject private/unknown keys or third ordinates, not a permissive cast.
- `tripGeometry`: optional public line under pin/stop circles; extend bounds over every emitted run. Keep each run separate and overview `tripPins` pin-only. The one line serialization is the story's `data-geometry`.
- Public text stays usable without JS, tiles or WebGL. Keep the existing map link and stop names; for a route add a localized section listing each public run's approximate length, start/end coordinates at public precision and route label if supplied. Compute only from the public artifact, with no cross-gap distance. This communicates the extent/discontinuities rather than labelling informative geometry decorative. No elevation, time, speed, original length or removed-point counts. Route-free stories receive no new empty section.
- Draft preview's deny-all CSP remains. It may show the same textual public-candidate description, never a map/script or private geometry dump.
- MDX export: retrieve `track` explicitly from the pair's last published snapshots, not the attached draft. Never-published drafts omit it. Edited/detached drafts keep the last published artifact until Publish; unpublishing may retain that previously public artifact in private exports/backups, as it retains the snapshot today. No source pointer, raw file, private geometry, time/elevation or candidate waypoint data. Validate both locale snapshot artifacts; inconsistent/corrupt pairs fail export rather than choose a live route.
- Pin duplicated artifact types in uploader, Zod-inferred site content and `TripGeometry` with a compile-time exact-shape check plus behavior/round-trip coverage. Do not rely on optional fields making both typechecks pass.

## 8. Backup, restore, deletion and recovery

### Paired private backup format

Bump `DUMP_VERSION` **9 → 10**. Add `post_routes` to the explicit typed column list and all counts/validation/restore reporting. Dump rows include the attached trimmed geometry and latest-original metadata, including detached rows. Revisions and pending previews remain excluded. Existing post rows retain their published snapshots; these are the public projection, not the private route source.

Every v10 dump with route rows carries a `routeArchive` manifest: format version, paired basename, archive SHA-256/byte count, and for each original its safe pair hash/source ID, byte count and SHA-256. The full, nonincremental `routes-<same-backup-stamp>.tar` contains a strict manifest and exactly those originals (including detached-route sources), never pending/unreferenced files. No path supplied by an uploaded GPX or a DB row is trusted without validation. Restrict archive entries to regular files with exact expected names; no symlinks, hardlinks, devices, absolute paths or `..`.

While holding the route-file lifecycle gate, take the existing DB `REPEATABLE READ` snapshot, capture routes and all other dump tables consistently, verify every referenced original, and write the corresponding full archive. Missing/hash-mismatched originals fail the backup explicitly; do not label an incomplete backup recoverable. Estimate archive space plus the existing reserve before writing. Reuse atomic/no-clobber backup publication: finish archive temp first; finalize its hash/manifest; publish archive; publish the matching dump **last**, as the completion marker. Failures remove owned temporaries; a crash-left archive without a committed matching dump is recognized as incomplete, not listed as a complete recovery set. Do not overwrite a same-second filename. Existing image archives keep their separate chain and policy.

List/status/download APIs stay admin-only and expose paired-complete status, not file content. Both artifacts are sensitive and never served under public static roots. Retention prunes a dump and its matching full route archive together; never prune an archive still referenced by a retained dump. The source-retention warning explicitly says old private backups can contain replaced/deleted originals until expiry. No retroactive backup editing or false “secure erasure” promise.

### Restore

Extend the existing CLI-only restore, retaining target/count display, literal confirmation or `--yes`, and a **verified pre-restore recovery set** before destructive statements. Stop the app during restore; never perform this against the owner's content during implementation. Report route-row/original counts and detached sources without coordinates.

For v10 with routes, require the matching archive beside the dump (manifest basename only), validate its hash/entries/sizes and the complete route geometry **before any database replacement**. Stage originals under the private route root using newly allocated source IDs and rewrite restored row references accordingly. This copy-on-restore rule prevents overwriting a currently referenced original even when restoring an older version. Verify/fsync staged files, then restore all DB tables and route rows in one transaction. Route rows are restored after posts, with no orphan keys; a missing required locale is invalid. On rollback the pre-existing DB/files remain; newly staged unreferenced files are reclaimed. On successful commit clean old unreferenced files through reconciliation; interruption is recoverable from DB references and the pre-restore set. No raw file extraction to a public root.

For v1–9, restore route state as **empty** (never keep an unrelated present-day route under a restored translation key). The pre-restore v10 set preserves current private routes for undo. Legacy snapshot backfill remains route-free; it must not derive artifacts from any working geometry. Never backfill an existing snapshot from a draft. Dry restore validation refuses unsupported versions before writes.

`post_routes` joins single/bulk post deletion in the same DB transaction as both locale rows/revisions/comments. Keep its returned source metadata until after commit, then remove its original through the file gate. If unlink fails, report deletion committed with cleanup pending, and retry via reconciliation. No private route read remains possible once the post is deleted. Retained public snapshots disappear with the post, but the currently served static release changes only through the existing rebuild behavior. Old release directories/backups remain private operational history until their normal retention; they are not exposed as alternate public paths.

## 9. Threat cases and required proof

| Case | Required behavior / evidence |
|---|---|
| Billion laughs, internal/external entities, lower-case declarations | Refused before parser in UTF-8 and both supported UTF-16 encodings; no file/network resolution; safe error/logs |
| UTF-32, invalid UTF-8/UTF-16, BOM/declaration conflict, deep nesting, extension namespace spoof | Defined rejection; correctly namespaced prefixed GPX succeeds; extensions cannot contribute data |
| 1M points; 50,001 points below byte cap; 101 segments; 501 waypoints | Earliest applicable bounded refusal, no partial route or retained rejected original |
| File >5 MiB but <25 MiB; attach JSON >64 KiB; slow upload; worker hang/heap exhaustion | Dedicated caps/deadlines, slot cleanup, app responsiveness, next valid request succeeds |
| Empty/non-GPX; rte-only; wpt-only; mixed trk/rte; singleton; NaN/out-of-range; malformed optional metadata | Exact outcomes from §3; no quiet bridge across a rejected point |
| Start/end trims, removed middle segment, all points removed, antimeridian, rounding collapse | Pure deterministic tests, preserved discontinuities, refusal of empty output, no all-trip line |
| Cancel, expire, restart, wrong author import ID, re-import replacement confirmation | No unintended attachment or permanent rejected/cancelled original; explicit partial-failure behavior |
| Missing original, interrupted file/DB commit, failed unlink, stale tabs, attach vs delete/publish/save | Old state intact before commit; committed state honestly reported; recoverable cleanup; no orphan/read-after-delete or stale overwrite |
| Raw path traversal/symlink/static URL, unauthenticated original/route/dump/archive read | Guarded refusal; no original bytes on public hosts or static roots; author/admin distinctions tested |
| Timestamps/elevation in ordinary tags, extensions or client extra keys | Private accepted fields round-trip only in private tier; strict public allow-list and two-ordinate validation |
| Route A published, draft B attached, unrelated rebuild; then detach/rebuild; then Publish | Public remains A through both draft changes; after Publish it is B or absent as appropriate, identically in DE/EN |
| Text revision restore | Current route unchanged; private geometry absent from every revision and browser stash |
| Private dump/archive mismatch, missing file, interrupted restore, old v9 restore | Refusal before destructive restore; pre-restore set; consistent round-trip; no stale route retained on old restore |
| Export after draft route edits/detach; routeless stories; overview map | Snapshot artifact only; no route defaults or URL changes; overview remains pin-only |

Permanent tests exercise behavior/boundaries/failure recovery, not wording/source text/wiring. Extend existing parser/route/editor DOM, post-store, backup, export, i18n and map-data suites; add focused GPX suites and real PostgreSQL integration tests. Use synthetic locations only. `TEST_DATABASE_URL` must point at an isolated initialized database; skipped integration tests are not a pass. Run uploader full `npm test` and `npx tsc --noEmit`; site full `npm test`, `npx astro check`, and full `npm run build` with a reachable isolated DB. Add a real-main boot exercise to cover production store wiring, not just injected stores.

Decode built HTML `data-geometry`, map `data-geojson`, Content Layer/build JSON, MDX frontmatter and DB dump JSON; inspect route archive bytes through the validated archive reader. Compare decoded artifacts against the exact expected simplified/rounded runs, reject third ordinates/unknown fields, and assert removed fixture positions/private times/elevation absent from **public projections** across escape/number encodings. Independently assert those values are retained where expected in private route rows/originals. A text grep alone is not proof. Inspect all emitted public files, not merely the visible line; no private route geometry in source maps or ancillary assets.

Exercise the actual feature-worktree server with synthetic valid/malformed/hostile/over-limit GPX, cancellation, replacement, trim-to-empty, author/admin/anonymous access, backup/restore and publish/edit/detach scenarios. Confirm which head the process serves. Browser proof on desktop/mobile includes keyboard/focus, DE/EN public text, route-free story, no JS/WebGL/basemap, removed overlay and touch/reflow. Record network activity with third-party requests blocked/observed; GPX must trigger only same-origin resources and never `/geocode` or AI. Use self-hosted map data for the basemap-present pass; synthetic tracks, not personal tracks, in evidence. Batch inspection/fixes and one confirmation pass; no cosmetic redesign.

## 10. Delivery, containment and rollback

- **#312:** this spec plus planned security/architecture impact. Proportionate checks: resolve cited baseline contracts/dependencies, trace each acceptance criterion, independently review the actual PR/head, verify documentation links and final-head CI. No claim of parser/UI/runtime verification before code exists. Record explicit owner approval by PR comment/review before #313.
- **#313:** parser/worker, private APIs/store/schema, original lifecycle, pure trimming/editor, vendored map dependencies, author access, delete/reconciliation, v10 paired backups/restore and all private-tier failure tests. No public route rendering. The public-generation function and publication UI projection land in #314; #313's attach validates only the private result and states that public rendering is not yet available. No user data is published during verification.
- **#314:** public-generation and pre-attach public-candidate validation, atomic snapshot integration, Content Layer/types, story line/text, snapshot-only MDX and decoded privacy proof. Retest affected #313 paths and both complete suites. No silent omission of detachment or routeless cases.

Prefer sequential PRs into `dev`. If the owner approves specification/implementation but withholds merge authorization, preserve the PR/worktree and use explicit stacked dependencies only when authorized by the applicable issue gates. Retarget child PRs to `dev` before a parent merges. The epic is not complete while any child/acceptance/gate remains open.

**Containment:** stop accepting route imports/attachments by reverting the feature routes/UI, without deleting persistent data. For a public leak, reverting code alone does not remove already-built HTML: an owner-authorized corrected build and atomic release switch is required, with any external cache invalidation and assessment of already-downloaded copies. No operation can recall readers' copies. Keep the previous safe release if a rebuild fails.

**Rollback:** keep additive route tables/files inert; do not drop schema or rewrite originals. Reverting #314 removes track from rendering while earlier snapshots lacking it still work; rebuild explicitly when authorized. Do not promote working routes or manually patch live snapshots as a shortcut. Reverting #313 makes route state unavailable to older code; preserve v10 backup tools/recovery sets, because v9-only restore tools reject v10. Roll forward or use the verified pre-change recovery set under the existing confirmed restore procedure. Deletion of stored private routes is a separate owner-authorized erasure, never rollback scaffolding.

## Approval record

- Specific retention, private-backup classification and public precision choices: owner answers recorded 2026-10-23, as above.
- Completed specification approval: **pending explicit owner approval on the reviewed PR/head**.
- Implementation PR approvals and merge authorizations: **not granted by this document**.
