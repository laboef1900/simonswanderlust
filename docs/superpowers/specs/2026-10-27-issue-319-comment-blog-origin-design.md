# Comment submissions on separate blog and image origins (#319)

Date: 2026-10-27. Risk: **High — public unauthenticated write boundary.**
Status: **OWNER APPROVED 2026-10-28** — temporary fallback and exclusions approved with #369's immediate-peer trust policy. Implementation and runtime verification remain required; no deployment or owner-data mutation is authorized.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Evidence and decision

`main.ts:76` supplies `PUBLIC_BASE_URL` as the image base URL; it never supplies
`commentsOrigin`. `server.ts:1859` consequently compares submissions to the image origin.
The island submits to relative `/comments`. The issue's split-host failure is source-derived,
not a recorded reproduction; this proposal does not claim the requested before/after run exists.

There is **no existing bootstrap setting containing the blog origin**. `IMG_HOST` is also an
image-host setting. Reinterpreting either would break image URLs/routing. No new env knob,
hardcoded owner domain, stripping `img.` from a hostname, or trusting the submitted Origin as
the expected origin is permitted.

Use a request-authority equality fallback until the approved identity origin is available.
This is explicitly permitted for #319 by approved #273 §7.3, despite §7.4 rejecting it as the
*permanent configured default*. It preserves #319 → #276 ordering without inventing a setting.
The tradeoff requiring approval is that, while unconfigured, any non-image blog authority the
trusted proxy deliberately forwards can accept its own same-origin comments. It is not an
allow-list of deployment domains and does not claim to authenticate non-browser clients.

## Smallest implementation contract

1. Keep `ServerConfig.commentsOrigin` as the explicit server/test override. Resolve the allowed
   origin per request rather than at registration: explicit override, then (when #276 lands)
   current validated `identity.canonicalOrigin`, then request-authority fallback. An invalid
   explicitly configured value fails closed; it must not silently fall through. The callback
   seam in `PublicCommentsOptions` returns a serialized origin or null, never an origin set.
2. Fallback uses `req.protocol` and **verbatim `req.headers.host`** under #369's approved,
   required `ServerConfig.trustProxy` policy. Integrate that policy first: explicitly trusted
   immediate peer, fail-closed Docker-gateway discovery for the approved host-proxy topology,
   and its shared test policy. The baseline's numeric `trustProxy: 1` is obsolete, not a
   reusable security convention. Never add another proxy setting or broaden trust here.
   Never use `X-Forwarded-Host`, the submitted Origin, Referer, or `PUBLIC_BASE_URL` as the
   source. Accept only http/https and a nonempty well-formed authority; reject userinfo,
   whitespace, path/query/fragment and ambiguous authorities before serialization.
   Missing/invalid authority yields null and 403, never a permissive default.
3. Exclude the configured image origin and image-host authority from the fallback, including
   alternate schemes on that host. Preserve the existing single-origin **loopback development**
   topology (`isLoopbackAuthority` / `imgHostServesBlog`): only that documented topology may use
   the same serving and image origin. This matches #273 §7.2's loopback exception; “image origin
   never accepted” means a distinct production image origin, not disabling local comments.
4. Compare the submitted origin by URL-origin equality. Origin wins when present; Referer is
   fallback only when Origin is absent/empty, as today. Reject credentials in either input;
   Origin must be an origin URL (no path other than `/`, query or fragment), while Referer may
   have a page path/query. Null/malformed/non-http(s), mismatch and prefix/userinfo tricks →
   existing 403 `forbidden`. A malformed Origin cannot be rescued by a valid Referer.
5. Keep the route's existing order: limiter → honeypot → origin → validation → published pair →
   enablement → pending insert. No CORS widening, session resolution, new persistence or rebuild.

Affected implementation: `uploader/src/comments-public.ts` (resolver and parsing), `server.ts`
(wiring and image-host exclusion); public route fixtures and `test/main-boot.integration.test.ts`.
`main.ts` continues passing the image configuration, not an invented blog value. Reuse the
existing loopback helper; do not change GPX policy or general host routing.

## Integration with #273 / #276

#273 is approved, not re-opened here. #276 consumes this fallback and retains the split-domain
regression unchanged, adding configured-origin precedence and immediate origin-change cases.
No request exists during boot: the request-derived fallback **cannot seed** canonical identity.
Under #273 §7.3/§12, legacy evidence still gets its approved legacy canonical seed and a fresh
install stays unset; never seed identity from the image env or a first visitor's Host. #276 must
read identity per request (or its approved current in-memory store), not capture a boot snapshot.

## Required evidence after approval

- Before editing, record the issue-required split-domain baseline once using disposable Postgres
  and two hostnames through the existing trusted-proxy topology: blog Origin currently 403.
  This is pending evidence, not a claim that this run was performed here.
- Boot real `src/main.ts` with `TEST_DATABASE_URL`, distinct blog/image hosts and a published
  synthetic post. Blog-origin POST → 201, pending row, not yet in GET. Same URL with image,
  third-party, prefix-lookalike and both userinfo directions → 403, no row. Keep limiter budgets
  intact by isolating cases/windows rather than letting incidental 429 hide the assertion.
- Matching Referer fallback succeeds; missing headers, malformed Origin plus good Referer,
  malformed/missing Host, spoofed X-Forwarded-Host and wrong scheme/port fail appropriately.
- Through #369's actual trusted immediate peer, forwarded HTTPS supplies the expected
  protocol; the same forwarded headers from an untrusted peer cannot change protocol,
  client identity or the allowed comment origin. Keep raw Host authority in both cases.
  Image-host-targeted same-origin POST fails; documented loopback topology still works.
- Real browser smoke through two proxy hostnames: submit on the blog, approve in admin, read
  through the island. Record before 403 / after 201 without reader-data logs.
- Run affected full suites/typecheck and Postgres integration; preserve no-session, honeypot,
  404/409, output-key and body-cap tests. No tests were run for this proposal.

## Security, documentation and recovery

Implementation updates `SECURITY.md` Public comments and the original comments spec D8/misuse 3,
plus `ARCHITECTURE.md` origin/configuration and deployment topology notes. Document preserved
Host/trusted protocol, proxy rejection of unintended public hostnames, the temporary fallback,
loopback exception and #276 precedence. The CSRF origin check remains equality, not authorization.
No ASVS exception expansion, owner content mutation, slug change or env addition.

Rollback code only; pending comments and settings survive. Reverting restores the broken
image-origin check, so disable new comments with the existing global switch during containment
and do not proceed with DNS cutover until the split-domain test passes again. The switch does
not hide already approved comments.

**Exact owner approval requested:** “Approve #319's request-authority same-origin fallback,
excluding the production image host, with the existing loopback exception and no new env setting;
retain explicit > canonical identity > fallback precedence for #276, and the tests and recovery
contract in this proposal.” The owner approved this contract on 2026-10-28, including #369's explicit trust-policy integration.
