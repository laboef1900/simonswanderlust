# Issue #513: route stops along streets when no GPX track is published

- **Status:** implemented in the same PR as this spec; owner approves spec and code together at merge.
- **Risk:** **High** (`CLAUDE.md`): a new outbound fetch, a schema change, the published snapshot and
  build input, and the backup format.
- **Issue:** #513. Related: #512 / PR #516 (Route caption scoped to the GPX section; unchanged here).
- **Aligns with:** `2026-10-23-gpx-route-import-design.md` (public track limits, precedence),
  `2026-06-25-travel-map-design.md` (mini-map), `2026-10-27-issue-365-gpx-conflict-reload.md`.

## Owner decisions (2026-11-03)

| # | Decision |
|---|---|
| 1 | **Provider:** OSRM-compatible HTTPS endpoints in Settings, modelled on `geocodingSearchUrl`. **Default empty = routing disabled.** No API key, no `app_secrets` slot. No public demo server (`router.project-osrm.org` or other) is ever shipped as a default. |
| 2 | **Travel profile per leg:** car / bike / foot / straight; default car (fastest). Settings holds one optional OSRM base URL per routed profile; an empty URL makes that profile unavailable. `straight` never makes a network request and is always available. |
| 3 | **Unroutable legs** (sea, islands, no road, provider error or timeout for that leg) fall back to a **straight segment**, dashed on the public map and flagged per leg in the editor. The route is still saved. |
| 4 | **Via:** optional `via: boolean` on the existing stop row, one ordered list. Via points shape the route, are never pins, never listed, never named publicly, and get the same validation as stops. |
| 5 | **High-risk gate:** this spec ships in the same PR; the owner approves spec and code together. |

### Why one URL per profile (verified)

The OSRM HTTP API documents the `{profile}` URL segment as "Mode of transportation, is determined
statically by the Lua profile that is used to prepare the data using `osrm-extract`"
([OSRM HTTP API, v26.5.0, "General options"](https://project-osrm.org/docs/v26.5.0/http)).
`osrm-routed` serves exactly one prepared dataset, so the segment does not select a profile on a
self-hosted server; a car graph answers `/route/v1/foot/...` with car routes. Multi-profile
deployments (for example FOSSGIS, `https://routing.openstreetmap.de/routed-{car,bike,foot}`) run one
`osrm-routed` per profile behind different path prefixes. Settings therefore stores a **base URL per
profile**, and the client appends `/route/v1/{driving|cycling|walking}/…` for documentation only.

## Scope

In: per-leg routing at authoring time, via flag, per-leg profile, stored route with fingerprint and
staleness, Publish copying only a fresh route, public rendering when no GPX track is published, stop
list visible without a track, OSM attribution, Settings fields, backup/restore and MDX export.

Out: journey maps (they draw published GPX runs only and stay unchanged), route optimisation or
reordering, alternatives, turn-by-turn, distances/durations on the public page, private-network
routing endpoints (see *Left for owner decision*), the Route caption (#512/#516).

## Data model

### Stops (`posts.stops`, shared by DE and EN)

```ts
interface RouteStop {
  name: string; lat: number; lng: number;   // unchanged
  via?: true;                                // absent = a normal stop
  profile?: 'bike' | 'foot' | 'straight';    // leg i → i+1; absent = car
}
```

- **Normalization** (`normalizeStopRoutingFields`, `uploader/public/stop-route.js`) runs on every
  draft save: `via: false` and `profile: 'car'` become absent keys; the **last stop's profile is
  dropped** (it has no outgoing leg). One canonical form keeps fingerprints and draft-diff stable,
  and removing the final stop can never leave a dangling leg setting that later changes meaning
  silently: the new last stop's profile is dropped and the editor shows "Last stop".
- **Validation:** a non-boolean `via` or a profile outside `car|bike|foot|straight` is rejected at
  draft save (`400`). Name/lat/lng keep their existing Publish-time checks, applied to via rows
  identically. Other legacy keys pass through (they were never key-checked; the public schema
  strips them).

### Stored route (`posts.stop_route jsonb NULL`)

```ts
interface StoredStopRoute {
  version: 1;
  fingerprint: string;          // sha256 hex of stopRouteBasis(stops)
  computedAt: string;           // ISO 8601 UTC, milliseconds
  legs: { profile: 'car'|'bike'|'foot'|'straight'; kind: 'road'|'straight'; fallback?: 'no_route'|'provider_error' }[];
  route: PublicStopRoute;       // already the public projection
}
```

- **Column, not a table.** The value is written identically to both rows of the pair, like `stops`.
  A `post_routes`-style table keyed by `translation_key` was rejected: a column inherits pair
  deletion, locale omission, revision exclusion and restore ordering for free, needs no orphan
  sweep, cleanup queue or new bootstrap table, and rolls back as an inert nullable column. The
  only cost is the DE/EN duplication, which the single writer (one `UPDATE … WHERE
  translation_key=$1`) keeps identical. A pair whose two values differ (manual repair) is never
  published (Publish treats it as stale and `GET` reports no route), and restore refuses it.
- **Fingerprint basis** (`stopRouteBasis`): `'stop-route-v1:' + JSON.stringify(stops.map((s, i) =>
  [s.lat, s.lng, s.via === true, i === last ? null : (s.profile ?? 'car')]))`. Names are excluded:
  renaming a stop does not change geometry. Browser (`SubtleCrypto`) and server (`node:crypto`) hash
  the same string; a test pins equality.
- The stored route keeps only the public projection plus per-leg metadata. No raw provider geometry,
  distances, durations, OSM node ids or provider URLs are stored.
- `post_revisions` snapshots `{status, shared, de, en}`; the stored route is not part of it, so a
  revision restore that changes stops makes the route stale by fingerprint. This is intended.

### Public projection (`published_snapshot.stop_route`, build entry `stopRoute`)

```ts
interface PublicStopRoute {
  version: 1;
  runs: { kind: 'road' | 'straight'; coordinates: [lng: number, lat: number][] }[];
}
```

Limits are exactly `publicTrackSchema`'s: 4-decimal ordinates, no `-0`, ≤ 2,000 vertices, 1–100 runs,
≥ 2 distinct consecutive positions per run, `|Δlng| ≤ 180` between consecutive positions, ≤ 64 KiB
compact JSON. Unknown keys are rejected (strict). It lives under its **own snapshot key**, so the GPX
`track`, `publishedTrackOf`, `publicTrackSummary` and the "Published route" section never see it.
Validators: `validatePublicStopRoute` (uploader/browser) and `publicStopRouteSchema`
(`site/src/lib/public-stop-route.ts`, Zod); shared fixtures pin both.

## Flows

### Calculate (authoring time only)

`POST /posts/:tk/stop-route` — session required (`requireAuth`, same audience as GPX attach and
`/geocode`), `bodyLimit` 16 KiB, `Cache-Control: no-store`. Body `{ stops: RouteStop[] }` (the
editor's current rows; they need not be saved yet).

1. Validate with `validateRouteStops` (strict: names, ranges, via, profile). `2 ≤ stops ≤ 25`
   (`STOP_ROUTE_LIMITS.stops`); else `400 {code}`.
2. The pair must exist (`404`). Storage must be writable (`503`).
3. Per-user fixed-window limiter (20 calculations / 10 min) → `429 stop_route_rate_limited`; one
   calculation in flight app-wide → `429 stop_route_busy` (`Retry-After`).
4. Every routed profile used by a leg must have a configured URL, else `409
   stop_route_profile_unavailable {profiles}` **before any network request**.
5. Legs run **sequentially in stop order**, one OSRM request per routed leg:
   `GET {base}/route/v1/{segment}/{lng1},{lat1};{lng2},{lat2}?overview=full&geometries=geojson&alternatives=false&steps=false`
   through `safeFetch` (`maxRedirects: 0`, `timeoutMs: 10_000`, `maxBytes: 4 MiB`, identifying
   `User-Agent` like the geocoder). Outbound requests are spaced ≥ 1.1 s app-wide (FOSSGIS policy:
   ≤ 1 request/s; harmless for self-hosted). An overall 60 s budget bounds a calculation; legs not
   started in time become `provider_error` fallbacks.
6. Per-leg outcome: valid `code: "Ok"` with a `LineString` of finite, in-range positions (≤ 100,000)
   → `road`. HTTP 400 or OSRM `NoRoute`/`NoSegment` → straight fallback `no_route`. Any other HTTP
   status, network/timeout/size error, `safeFetch` block or malformed body → straight fallback
   `provider_error`. `straight` legs never touch the network.
7. **Whole-provider failure:** if no leg came back `road` and at least one leg is `provider_error`,
   the provider is treated as unreachable: `502 stop_route_failed`, **nothing is stored** and the
   previous stored/published route is unchanged.
8. Project: split each leg at the antimeridian (interpolated boundary vertices at ±180), thin a
   pathological line to ≤ 10,000 positions per run (bounds Douglas–Peucker work), simplify with
   the GPX great-circle Douglas–Peucker (25 m first, then doubling progressively on the previous
   pass until all limits hold), round to 4 decimals, drop consecutive duplicates and runs shorter
   than 2 positions. A straight leg is its two stop positions. Consecutive runs of the same kind
   that share an endpoint are merged. If no run survives → `422 stop_route_empty`; if the limits
   cannot be met (e.g. a line weaving across the antimeridian into > 100 runs) →
   `422 stop_route_too_complex`. Nothing is stored in either case.
9. Re-validate with `validateStoredStopRoute`, then write both rows (`UPDATE posts SET
   stop_route=$2 WHERE translation_key=$1`). `posts.updated_at` is **not** touched, so the editor's
   save token stays valid. Response: the editor view (below).

`GET /posts/:tk/stop-route` (`requireAuth`, `no-store`) returns
`{ profiles: { car: boolean, bike: boolean, foot: boolean }, route: StoredStopRoute | null }`.
URLs are never returned to authors.

### Staleness

`fresh ⇔ stored.fingerprint === sha256(stopRouteBasis(normalize(current stops)))`. Any edit of lat/lng,
add, remove, reorder, via toggle, profile change or revision restore changes the basis. The editor
computes it live from the form; the server recomputes it from the **locked saved stops** inside the
Publish transaction. Renaming alone is not stale.

### Publish

Inside the existing Publish transaction, after `lockPostPair`:

- `track` present (attached GPX that passes the public projection) → `stop_route` is **not**
  written (GPX precedence; at most one geometry per snapshot).
- else stored route present, both rows equal, `validateStoredStopRoute` passes, `≥ 2` stops and
  fingerprint fresh → merge `{ stop_route: stored.route }` into the snapshot.
- else omitted. Publish is **never blocked** by a stale or missing stop route.
- The result carries `stopRoute: 'published' | 'stale' | 'none' | 'superseded'`; the editor warns on
  `stale` (`editor.stopRoute.publishOmittedStale`).
- `draft_differs` ignores the `stop_route` key like it ignores `track`; the publication fact adds
  "stop route changed" = the publish candidate (fresh route and no attached GPX geometry, else
  none) differs from `published_snapshot.stop_route`.

Detaching GPX and publishing reveals a fresh stored stop route. Unpublish keeps the snapshot as
today.

### Build and public site

- `postgres-loader.ts` passes `published_snapshot.stop_route` as `stopRoute`; it never reads
  `posts.stop_route`, never calls a network API (pinned by test). `content.config.ts` validates
  `stopRoute: publicStopRouteSchema.optional()` and `stops[].via/profile` optional.
- `tripGeometry`: `track` wins; `stopRoute` is exposed only when there is no `track`. Via stops are
  removed from `stops` (pins, list, and the serialized `data-geometry`), so their names never reach
  HTML.
- Mini-map: road runs in the GPX line style; straight runs dashed. Frame includes the runs. The
  route source carries OSM attribution (`map.routeAttribution`), which stays visible even when the
  basemap falls back.
- `StoryMiniMap.astro`: the non-via stops list renders in order **with or without** a track; the
  Route caption stays inside the GPX-track section (#516). With a stop route, a short note explains
  the line and, if any straight run exists, the dashed sections.
- One route serves every enabled locale (stops are shared).

## Trust boundaries

| Boundary | Control |
|---|---|
| Editor → `POST /posts/:tk/stop-route` | session auth, 16 KiB body, strict stop validation, ≤ 25 stops, per-user limiter, app-wide single flight |
| Server → routing provider | `safeFetch` only (HTTPS by settings validation; loopback/RFC1918/link-local/CGNAT/etc. blocked after DNS resolution; no redirects; 10 s; 4 MiB), ≥ 1.1 s spacing, 60 s budget |
| Provider response → storage | JSON parse inside try; `code`, `routes[0].geometry.type`, position count, finiteness and ranges checked; projection re-validated by `validateStoredStopRoute` |
| Admin → Settings | admin-only `POST /settings`; HTTPS, no credentials/query/fragment/control characters; empty disables |
| Storage → snapshot | Publish re-validates and fingerprints against locked saved stops |
| Snapshot/dump → build | Zod strict schema at load (`content.config.ts`), restore-time strict validation |
| Stop names → HTML | Astro text interpolation only (no `set:html`); via names are dropped before render/serialization |

## Misuse cases

| Misuse | Outcome |
|---|---|
| Admin sets `https://127.0.0.1/…`, an internal hostname, or a public name resolving to a private IP | `safeFetch` refuses every leg → all `provider_error`, no `road` → `502`, nothing stored. `safeFetch` is unchanged; there is no private-network opt-in. |
| Redirect to an internal host | `maxRedirects: 0` → `provider_error`. |
| Huge or slow provider response | 4 MiB stream cap, 10 s per leg, 60 s budget. |
| Malicious geometry (NaN, out of range, 10⁶ points, non-JSON) | rejected per leg → `provider_error` fallback. |
| Author floods Calculate | per-user window + app-wide single flight + request spacing. |
| Author posts > 25 stops or deep JSON | `400` / 16 KiB body limit. |
| Stale route published by racing an edit | Publish fingerprints the locked saved stops; stale ⇒ omitted. |
| Via name leaks publicly | via rows removed in `tripGeometry` before both render and `data-geometry`; tests assert absence in built HTML. |
| XSS via stop name | text interpolation; existing escape test extended for the stops list without a track. |
| Tampered dump (`stop_route` shape, DE/EN mismatch, oversize snapshot) | restore refuses before any write. |
| Stop route impersonating a GPX track | separate key and strict shape; `publishedTrackOf` and `publicTrackSummary` never read it. |
| Disabled/unreachable provider | stored and published routes untouched; editor explains (`disabled`, `profileMissing`, `failed`). |

## Invariants

1. The build and readers make no routing request; the public site renders stored geometry only.
2. A published snapshot carries at most one of `track` / `stop_route`; `track` wins.
3. A published `stop_route` was fresh against the published `stops` at Publish time.
4. Stop order is never changed by the server.
5. Every stored or published stop route satisfies the public track limits.
6. Via stops never appear in public HTML (pins, lists, serialized geometry).
7. `safeFetch` is not weakened; routing endpoints are public HTTPS hosts.
8. A failed calculation never modifies `posts.stop_route` or any snapshot.
9. No slug or URL changes.

## Privacy and licensing

- Calculating sends the ordered coordinates of all rows (including via points and unpublished drafts)
  to the configured service. The editor discloses this next to the geocoding privacy note
  (`editor.stopRoute.privacy`); Settings repeats it. Coordinates are never logged.
- Routed geometry derives from OpenStreetMap: the editor route panel and every public map showing a
  stop route carry OSM attribution. No demo server is configured by default; the owner must choose
  a service whose policy permits the use.

## Backup, restore and export

- Dump **v15** adds `posts.stop_route` (validated strictly, both rows of a pair equal, legs count
  consistent) and validates any `published_snapshot.stop_route`. Dumps ≤ v14 restore it as `NULL`.
  `SUPPORTED_DUMP_VERSIONS` gains 15 (allow-list guard widened deliberately).
- MDX export writes `stops` including `via`/`profile` and the published `stopRoute` (validated) next
  to `track`.
- `onboarding-bootstrap.ts` lists `stop_route` as an additive, nullable `jsonb` column of `posts`.

## Rollback and containment

- **Containment without a deploy:** clear the three routing URLs in Settings. No new requests are
  made; stored and published routes stay; Publish keeps working.
- **Revert the PR:** `posts.stop_route` stays as an unused nullable column (additive migrations are
  never reverted). Older code ignores `published_snapshot.stop_route` (the old loader reads
  `track` only), so public pages lose the stop line on the next build; no published URL changes.
  Older code would **refuse v15 dumps** (allow-list), so take any pre-rollback backup with the new
  code and restore it only with the new code, or create a fresh dump after rollback. Stops keep
  `via`/`profile` keys; old code's Zod schema strips them, so via points would render as ordinary
  stops after a rollback build. Before reverting, remove via rows or accept that exposure.

## Verification

Behavioral tests: GPX precedence (track only, stop route only, both, detach), via excluded from pins
and list but included in the line, order preserved, per-leg profile dispatch and unavailable
profile, unroutable leg fallback, projection within all limits incl. antimeridian, staleness
transitions, Publish never ships a stale route, disabled/failing provider leaves data unchanged,
`safeFetch` refuses loopback, rate limit, MDX export and backup round-trip, the loader makes no
network request, `ui.ts` completeness. Smoke: browser editor flow, disposable DB build, DE/EN pages.

## Left for owner decision

- **Private-network routing endpoints** (self-hosted OSRM on the compose network or LAN) are refused
  by `safeFetch`. Supporting them needs an explicit, separately reviewed opt-in; not implemented.
- **Defaults chosen in this spec:** 25-stop calculation cap; 1.1 s request spacing; 60 s budget;
  20 calculations per user per 10 minutes; Publish omits (not blocks) a stale route; the last
  stop's profile is dropped on save.
