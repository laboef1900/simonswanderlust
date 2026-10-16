# Waypoint location lookup

## Scope and approval

Owner request: enter a waypoint location such as Cancun and resolve latitude/longitude.
On 2026-10-16 the owner approved an external lookup in the editor rather than a
self-hosted geocoder. This is an editor-only exception to self-hosted independence;
public maps remain unchanged. Provider: OpenStreetMap Nominatim.

## Design

Each stop keeps its editable name and coordinates. An explicit **Find coordinates**
button searches the name. Results show full location names; choosing one replaces
only that row's latitude/longitude, preserves the author's waypoint name, and marks
the draft dirty. No autocomplete, automatic selection, saving, or publishing.
Changing the name/coordinates or removing the row invalidates an in-flight search
and any previous results. Failure or no results leaves coordinates untouched.

The authenticated `POST /geocode` accepts `{ query: string }` (2–200 trimmed
characters, no control characters), returning `{ results: [{ label, lat, lng }] }`
(up to five). The app proxies the lookup to enforce a single application-wide
request budget across users, tabs and devices. The provider sees the query and
server IP, not the editor's session or browser IP. No queries or provider errors
are logged. Responses have `Cache-Control: no-store`.

The single-app process admits at most one upstream request at a time and spaces
starts by at least 1100ms. No queue or retries; busy callers receive 429. Successful
results (including empty lists) are cached in memory, bounded to 100 queries for
24h, keyed by endpoint and normalized query. On restart the cache is cold; the
first outgoing request waits out a 1100ms startup cooldown. This policy assumes
the project's one app container, not independently scaled replicas.

`geocodingSearchUrl` in the existing admin-only settings API switches a
Nominatim-compatible HTTPS search endpoint without a software update; blank
disables lookup. Default `https://nominatim.openstreetmap.org/search`.
Use `safeFetch` for DNS/redirect SSRF protection, a 10s deadline, a 256KiB cap,
no redirects (one admitted lookup must equal one provider request), and an
identifying User-Agent. No changes to safeFetch's security contract.

## Trust boundaries and recovery

High risk: new authenticated route performing an external request. Author input
is query text, never a URL. Only admins control the endpoint. Settings reject
credentials, query strings and fragments, non-HTTPS URLs, and control characters.
`safeFetch` additionally rejects internal addresses at request time. Existing
DNS check/connect rebinding limitation remains (SECURITY.md).
Provider data is untrusted: accept only non-empty bounded labels and finite,
in-range coordinates; render labels via textContent, never HTML. Error responses
use stable codes (invalid_query, lookup_busy, lookup_disabled, lookup_failed),
never upstream content. Authentication failure remains 401.

Rollback/containment: set `geocodingSearchUrl` to an empty string via the admin
settings API; manual coordinates continue working. No migrations, saved stop
shape changes, slug changes, or data rewrites. Removing the feature requires no
content rollback. Human security review is required before merge.

## Verification

Automated coverage: authentication and request validation, request spacing,
concurrency, cache and endpoint change, timeout/provider/malformed-response
failure, result validation, selection updates the saved stop payload, no-results
and failure preserve coordinates, stale responses cannot change a modified row.
Browser smoke: real Cancun lookup, explicit selection, dirty state and numeric
fields, desktop/mobile layout. Run uploader tests/typecheck and site tests/Astro
check; identify any environment limitations explicitly.

## Provider policy

https://operations.osmfoundation.org/policies/nominatim/ — explicit searches only,
at most one request/second across the application, cache results, identify the
app, show OpenStreetMap attribution, and allow switching providers. Do not send
personal or confidential data. Availability is not guaranteed; manual entry is
always available.

## Verification result (2026-10-16)

- Live browser lookup returned Cancún, Quintana Roo, Mexico. Selecting it populated
  `21.1527467, -86.8425761`, preserving `Cancun` as the name. Save draft and reload
  through the real app retained both coordinates (isolated in-memory stores,
  not the owner's content). Desktop and 390px mobile controls exercised; mobile
  document and row widths showed no horizontal overflow.
- Uploader typecheck and all 1,597 tests passed, including integration suites
  against a disposable Postgres instance. Site: all 290 tests passed; Astro
  check reported zero errors, warnings or hints with a real disposable schema.
- No deployment, publish, production content changes, or CI run performed.
  Human security review remains a merge requirement.
