# Bundled OSRM street routing and the private-network routing opt-in

- **Status:** implemented; owner approves spec and code together at merge.
- **Risk:** **High** (`CLAUDE.md`): changes `safeFetch` (the SSRF chokepoint), the routing
  settings validation, the compose topology, and resolves the private-network item the #513 spec
  left for the owner.
- **Builds on:** `2026-11-03-issue-513-stop-routing-design.md` (stop routing, Settings fields,
  request pacing, privacy disclosure).

## Owner decisions (2026-11-03)

| # | Decision |
|---|---|
| 1 | **Modes:** the stack ships three OSRM servers: car, bike, foot. |
| 2 | **Map data:** auto-downloaded from `OSRM_PBF_URLS` in `.env` (one or more HTTPS `.osm.pbf`, e.g. Geofabrik), merged into **one** graph per mode (follow-up decision, same day). |
| 3 | **Default:** always on, part of every `docker compose up -d`; `OSRM_PBF_URLS` is required like `IMAGE_TAG`. |
| 4 | **Private access:** an operator env allow-list of exact origins, `ROUTING_INTERNAL_ORIGINS`; Settings can never widen it. |
| 5 | **First region on the owner's machine:** Berlin (small test region); then Mexico + Costa Rica + Ecuador. |
| 6 | **Servers memory-map the graph** (`osrm-routed --mmap=1`): only queried areas become resident, evictable page cache. |
| 7 | **Snap bound:** every leg sends `radiuses` = 5 km, so out-of-coverage stops become flagged straight `no_route` legs. |

## Compose topology

| Service | Image | Role |
|---|---|---|
| `osrm-fetch` | `debian:trixie-slim` (digest-pinned) | One-shot. When work is due, installs `curl` + `osmium-tool` from Debian's signed archive, downloads each `OSRM_PBF_URLS` entry (HTTPS only, also for redirects), merges more than one with `osmium merge` into `/osrm/region.osm.pbf` via a `.part` rename; writes a per-download `region.stamp` (UTC time + list), then `region.url`; skips when the list is unchanged and a stamp exists. Removing `region.url` forces a refresh. |
| `osrm-prepare` | `osrm-backend:v26.11.0-debian` (digest-pinned) | One-shot after `osrm-fetch` succeeded, bounded by `mem_limit` = `memswap_limit` = `OSRM_PREPARE_MEM_LIMIT` (default `4g`). Per mode **sequentially** (peak RAM = one extract): `osrm-extract -p /opt/{car,bicycle,foot}.lua`, `osrm-partition`, `osrm-customize` into `<mode>.tmp`, then swaps it in. Skips a mode whose `ready` marker equals `region.stamp`, so both a new list and a refresh rebuild. |
| `osrm-car` / `osrm-bike` / `osrm-foot` | same OSRM image | `osrm-routed --algorithm mld --mmap=1` on port 5000, `osrm` volume read-only, no host port, TCP healthcheck. Start only after `osrm-prepare` succeeded. |

- OSRM containers run with `cap_drop: [ALL]` and `no-new-privileges`. `osrm-fetch` adds back
  exactly `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID` for apt/dpkg; osmium has no
  official image and no third-party image is trusted. Package versions float within Debian 13.
- The `osrm` volume is rebuildable (extract + graphs) and is not part of backups.
- `app` does **not** depend on any OSRM service: a failed download or build leaves routing
  unavailable (the editor reports "no routing service") while the blog, admin and images run.
- Changing `OSRM_PBF_URLS` re-downloads and rebuilds on the next `docker compose up -d`; the
  routed servers must then be recreated to load the new graph
  (`docker compose up -d --force-recreate osrm-car osrm-bike osrm-foot`). Refreshing the same
  list: remove `/osrm/region.url` (`docker compose run --rm --no-deps --entrypoint rm osrm-fetch
  -f /osrm/region.url`), then the same sequence (`docs/install.md` §4g).
- **Several regions, one graph:** OSRM builds one graph per profile, never per region, so any
  number of regions stays three servers. Regions need not touch: a leg between unconnected
  regions is `NoRoute` → flagged straight leg. Merge residual: `osmium merge` keeps one copy of
  identical objects (border overlap); extracts downloaded across a Geofabrik update boundary
  could carry two versions of an object.
- **Memory model:** `--mmap=1` keeps the graph file-backed. Measured on the Berlin car graph
  (162 MB on disk) after one route: default 116 MB RSS (110 MB anonymous), mmap 30 MB
  (29 MB file-backed page cache). The build, not serving, sizes the host.
- **Memory bound** (issue #71 reasoning): an oversized list must OOM the one-shot build
  (exit 137, servers keep the previous graph), never the host's Postgres or app. Measured
  peaks (arm64): Berlin 95 MB → 1.06 GB; Costa Rica + Ecuador 158 MB → 3.5 GB (car; bike 3.2,
  foot 3.1), 1.1 GB graph per mode; Mexico + Costa Rica + Ecuador 780 MB → killed at 12 GB
  (car, with 10 and with 4 threads). Peak grows faster than file size; the 4 GiB default is a
  ceiling, not a minimum. Extrapolated, not measured: a 32 GB host is not expected to build
  every story country at once (≈ 3.5 GB of extracts); pick the list against a measured build.
- **Upgrade/recovery:** `OSRM_PBF_URLS` is interpolated for every Compose command; installs
  must set it before any command, including the restore runbook (`ARCHITECTURE.md`).
- **Pacing:** the #513 ≥ 1.1 s spacing honours public-service policy (FOSSGIS); legs to an
  operator-listed internal origin are not paced. Single flight and the 60 s budget still apply,
  and public legs in the same calculation stay paced against each other.
- Default bridge network unchanged: the trusted-proxy gateway (#108/#369) is unaffected.

## Private-network opt-in

`uploader/src/routing-origins.ts` parses `ROUTING_INTERNAL_ORIGINS` at boot (comma-separated;
each entry an `http(s)` origin with no path, query, fragment or credentials; normalized with
`URL.origin`). An invalid entry refuses boot, naming the entry index. The compose file sets
`http://osrm-car:5000,http://osrm-bike:5000,http://osrm-foot:5000`.

Invariants:

1. `safeFetch` exempts an origin from the literal-IP and DNS internal-address checks only when
   the caller passes `allowedInternalOrigins` **and** the first hop's `URL.origin` is listed.
   Scheme and credential rules still apply. Every redirect hop is judged in full, even one back
   to the listed origin; routing additionally sets `maxRedirects: 0`.
2. Only the stop router passes the set. Geocoding and WXR import keep the full guard.
3. Settings stores routing URLs as HTTPS or HTTP shape; `POST /settings` refuses (400, fixed
   message without the URL) a changed plain-HTTP routing URL whose origin is not listed. A stale
   stored value never blocks an unrelated save.
4. At run time the router treats a plain-HTTP URL whose origin is not listed as unconfigured
   (profile unavailable, no request).
5. Settings can select a listed origin but never add one: the list lives only in the operator
   environment.

## Misuse cases

- **Admin points routing at `db:5432` or another container:** not listed → refused on save and
  at run time.
- **Admin points routing at a listed origin that is not OSRM:** reachable by design (operator
  listed it); the response is parsed as untrusted provider output and never echoed.
- **Listed origin redirects to metadata/RFC1918/another listed origin:** refused (no redirects
  for routing; every hop re-judged regardless).
- **Hostile `.pbf` URL:** operator-controlled `.env` value; HTTPS-only download; OSRM parses it
  in an isolated container with no capabilities and no access to app data.

## Verification

- Vitest: `routing-origins.test.ts` (parse/normalize/refuse, usability), `safe-fetch.test.ts`
  (listed private origin fetched; unlisted port/scheme/host/db refused; redirect hops judged in
  full; credentials still refused), `stop-routing.test.ts` (listed compose origin routes through
  the real `safeFetch`; unlisted plain HTTP is unconfigured), `stop-route-api.test.ts` (save
  accepts only listed plain-HTTP origins; stale stored values do not block saves).
- `stop-routing.test.ts` also pins the snap bound: an OSRM double that answers NoSegment only
  when `radiuses` ≤ 5 km turns the Yucatán stops into flagged straight legs (fails without the
  bound with `stop_route_empty`, the owner-reported error).
- Smoke: Berlin extract, three graphs built, editor Calculate returns road legs per mode.
- Smoke (multi-region, `--mmap=1`): Costa Rica + Ecuador merged with `osmium merge`; in `app`:
  Costa Rica car → road, Ecuador foot → road, Costa Rica → Ecuador → straight `no_route`,
  Yucatán → two straight `no_route` legs. Car server RSS 92 MB (86 MB file-backed).

## Rollback and containment

- Withdraw the exemption: remove `ROUTING_INTERNAL_ORIGINS` from `docker-compose.yml`; the app
  then treats the compose URLs as unconfigured.
- Disable routing: clear the three Settings URLs, or stop the OSRM services.
- Full revert: revert the PR. With owner authorization only, the `osrm` volume may then be
  removed (`docker volume rm <project>_osrm`): it holds rebuildable map data only. Never
  apply this to `pgdata` or `uploader/data` (Golden Rule 3).
