# `safeFetch` — Re-validated Redirect Hops and a Pre-connect DNS Check — Design

**Date:** 2026-09-05
**Status:** Proposed (implements the shape recorded on issue #93; awaiting owner approval)
**Risk:** **High.** CLAUDE.md's Change Risk table names `safeFetch`/WXR import explicitly.
Requires this spec, trust-boundary and misuse-case analysis, full affected suite, explicit human
approval, and a documented rollback plan.
**Repos touched:** blog repo — `uploader/` only. No `site/` change, no schema change, no new
endpoint, no new runtime dependency (`node:dns`, `node:net` are platform), no new persistent file.
**Builds on:** `2026-07-30-wxr-import-hardening-design.md` (#85), whose §Scope table declined
exactly this change and whose retry classifier depends on `FetchError`'s `kind`/`status`/`code` tags.
**Closes:** #93.

## Why this exists

`safeFetch` is the SSRF chokepoint for the only outbound-fetch surface in the app, the WordPress
importer. Until now it had two accepted holes, both recorded in `SECURITY.md`:

1. It asked undici to follow redirects (`redirect: 'follow'`), so `assertFetchableUrl` judged only
   the URL the export supplied — never a `Location` header. A public host that answered
   `302 Location: http://169.254.169.254/latest/meta-data/` was followed straight into the metadata
   endpoint.
2. `assertFetchableUrl` is a synchronous **string** check. A hostname whose A record points at
   `127.0.0.1`, `10.x`, or the compose network (`db`, `172.17.x`) was never caught, and the literal
   check itself covered only loopback and link-local — RFC1918 literals passed too.

Both were accepted for a single-tenant deployment. #85 then changed their shape: bounded retry
gives a redirecting or rebinding attacker `importRetries + 1` attempts per URL instead of one, and
"run the import again" became the documented recovery path. The gap did not widen in kind, but it
widened in count, and `SECURITY.md` says so.

### The #90 decision, and why it no longer holds

PR #90 (#85) considered `redirect: 'manual'` and declined it: WordPress media URLs legitimately
redirect (CDN fronting, HTTP→HTTPS upgrade, resized-variant handlers), and breaking the importer to
narrow an already-accepted gap was the wrong trade for a drive-by inside a larger change. The
decision was "not there, not then" — the issue records the intended shape: manual redirects, a hop
loop with a cap, the full assertion on every hop, timeout and byte cap preserved across the chain,
and a DNS check for the rebinding half. This spec implements that shape. Legitimate redirects keep
working because the hops are **followed**, not refused — they are merely judged first.

## Design

Everything lives in `uploader/src/safe-fetch.ts`; `wp-images.ts` gains one optional pass-through.

1. **`redirect: 'manual'` with a hand-rolled hop loop.** `safeFetch` fetches the validated URL,
   and while the response status is one of `301 302 303 307 308` **and** carries a `Location`,
   it cancels that response body, resolves `Location` against the current URL (relative
   `Location` values are common), runs the same validation the first URL got, and fetches again.
   Undici's Node implementation returns the real 3xx response under `redirect: 'manual'` (not a
   browser-style `opaqueredirect`), which the smoke test against a live `node:http` server
   confirmed. Every request is a `GET`, so the 303 method-change rule needs no handling.
2. **Hop cap.** `maxRedirects` (default **5**; option on `SafeFetchOptions`). The original request
   plus five hops; the sixth 3xx throws. Five comfortably covers `http → https → CDN → variant
   handler` and is far below undici's own default of 20.
3. **Every hop is judged twice.** First the string: `assertFetchableUrl` (scheme, credentials,
   literal host). Then the network: `assertResolvesPublic` resolves the hostname with
   `dns.lookup(host, { all: true })` and refuses if **any** returned address is internal, or if the
   resolver returns nothing or garbage. A literal IP host skips the lookup — the string check
   already judged it, and the resolver would only echo it back.
4. **One address policy.** A `net.BlockList` is the single source of truth for "internal": IPv4
   `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`,
   `198.18/15`, `224/4`, `240/4`; IPv6 `::`, `::1`, `fe80::/10`, `fc00::/7`, `ff00::/8`, and the
   NAT64 prefixes `64:ff9b::/96` + `64:ff9b:1::/48` wholesale (the embedded IPv4 is not unpacked;
   a DNS64-only host is out of scope for this deployment). `BlockList` checks IPv4-mapped IPv6
   (`::ffff:127.0.0.1`) against the IPv4 rules itself. The WHATWG `URL` parser canonicalises the
   decimal/hex/octal IPv4 spellings (`2130706433`, `0x7f.1`, `0251.0376.0251.0376`) before the
   check sees them.
5. **One timeout spans the chain.** A single `AbortController` and one timer cover every lookup
   and every hop. `dns.lookup` takes no signal, so the lookup is raced against the signal
   (`abortable`); a hanging resolver counts against the same budget as a hanging socket.
6. **Byte cap where the bytes are.** Redirect bodies are cancelled unread; the streamed
   `maxBytes` cap applies to the final body exactly as before.
7. **`FetchError` tags are unchanged in meaning.** No new `kind`. A refused hop or refused
   resolution is `blocked`; an unusable `Location` (bad scheme, credentials, unparseable) is
   `invalid-url`; the hop cap is `http` with the last 3xx's `status` (non-retryable under #85's
   classifier: not 429, not ≥ 500); a resolver failure is `network` with the resolver's `code`
   (`ENOTFOUND` stays non-retryable, `EAI_AGAIN` stays retryable); an abort anywhere in the chain
   is `timeout`. Every pre-existing message string is byte-identical; new throw sites append the
   hop number and the original URL for stdout diagnostics.
8. **Test seam.** `SafeFetchOptions.lookup?: LookupFn` (the `dns.lookup(host, { all: true })`
   shape), threaded through `rehostImage`'s opts beside `fetchImpl`. Every existing test that
   stubbed `fetchImpl` for a made-up host now also stubs `lookup` — production code never sets it.

`wp-import.ts` and its retry policy are **untouched**: the classifier keeps working because the
tags kept their meaning (§7), which the classification tests pin.

## Trust boundaries

| Boundary | Control | Effect of this change |
| --- | --- | --- |
| Export-supplied URL → first request | `assertFetchableUrl` + `assertResolvesPublic` | **Tightened.** RFC1918/CGNAT/multicast/reserved literals and IPv4-mapped IPv6 are now refused; a hostname is refused when any address it resolves to is internal. |
| 3xx `Location` → next request | The same two checks, per hop, before the hop is fetched | **New.** Previously undici followed the hop with no inspection at all. Relative `Location` resolves against the current hop, so `/etc/passwd`-style paths cannot change scheme or host. |
| Redirect chain length | `maxRedirects` (5) | **New.** A loop or a long chain fails as `http` after six requests instead of undici's twenty. |
| Chain duration | One `AbortController` over lookups and hops | **Preserved.** A chain cannot outlast `timeoutMs` by splitting time across hops. |
| Final body size | Streamed `maxBytes` | **Preserved.** Redirect bodies are cancelled, never buffered. |
| `FetchError` → importer retry policy | `kind`/`status`/`code` | **Preserved.** No new kind; every new throw site maps onto an existing, correctly-classified tag. |
| DNS answer → TCP connect | none (see residual) | **Narrowed, not closed.** See below. |

### Misuse cases

- **Redirect into loopback / RFC1918 / link-local / metadata.** Refused as `blocked` before the hop
  is fetched — the internal host never sees a packet from this process. Tested per range.
- **Redirect to a hostname whose record is internal** (`302 → http://db/` on the compose network,
  or an attacker's `internal.example` A record `10.0.0.5`). Refused by the resolution check.
- **Redirect to `ftp:`, `file:`, `data:`, or a credentialled URL.** `invalid-url`, not fetched.
- **Redirect loop / long chain.** Six requests then `http/3xx`; `reasonFor` renders it as
  "download failed" for the author; the status is logged server-side only.
- **Slow-loris across hops** (each hop answers just inside the timeout). One timer spans the chain,
  so the total is still `timeoutMs`.
- **Split record** (one public A plus one private AAAA, hoping the connect picks the private one).
  Refused: the policy is "any internal address refuses", so the attacker does not choose.
- **DNS rebinding proper** (TTL 0, public on the check, private on the connect). **Residual** —
  see below.

## Invariants (each has a test)

1. `safeFetch` requests `redirect: 'manual'`; no hop is ever followed by undici.
2. A relative same-origin redirect and a cross-origin public redirect both succeed and return the
   final body; each hop's hostname is resolved before it is fetched.
3. A redirect to loopback, RFC1918, link-local, `::1`, or an IPv4-mapped internal literal is
   refused as `blocked` **before** the hop is fetched (fetch call count stays at one).
4. A redirect to a hostname that resolves to an internal address is refused as `blocked` before the
   hop is fetched.
5. A redirect to an unsupported scheme or a credentialled URL is refused as `invalid-url`.
6. The hop cap is enforced: with `maxRedirects: 3`, exactly four requests are made and the failure
   is `http` carrying the 3xx status.
7. A 3xx without `Location` is an ordinary non-2xx (`http`).
8. One timeout spans the chain: a redirect followed by a hanging hop fails as `timeout` inside
   `timeoutMs`; so does a hanging resolver.
9. The byte cap applies to the body behind a redirect (`too-large`).
10. A hostname resolving to an internal address — or to any internal address among several, or to
    nothing, or to garbage — is refused as `blocked` without fetching; a literal IP host is not
    resolved at all.
11. A resolver failure is `network` carrying the resolver's `code`.
12. `assertFetchableUrl` refuses RFC1918, CGNAT, unspecified, multicast, IPv6 ULA/link-local/NAT64,
    and IPv4-mapped internal literals, and sees through decimal/hex/octal IPv4 spellings.
13. Every pre-existing `FetchError` classification test still passes unchanged.

## Residual risk (accepted)

**DNS rebinding proper is narrowed, not closed.** `assertResolvesPublic` resolves the name, then
undici resolves it **again** when it connects. A zero-TTL record that answers public to the first
lookup and private to the second still lands one connection. Closing this requires pinning the
already-validated address into the connection — a custom `Agent` with `connect.lookup`, which the
platform `fetch` does not expose without adding `undici` as a dependency. That is a deliberate
non-goal here: the small-dependency rule, and the fact that the attacker also needs the OS
resolver's cache to miss between two lookups milliseconds apart (glibc/musl `getaddrinfo` does not
cache, but Docker's embedded DNS and most upstream resolvers clamp very low TTLs). The residual is
recorded in `SECURITY.md`'s Known limitations, replacing the former "does not resolve DNS" line.

**Redirect bodies are cancelled, not drained.** Undici may close the socket rather than reuse it;
that costs a reconnect per hop, which is invisible next to a sharp encode.

## Definition of done

- `npx tsc --noEmit` and `npm test` green in `uploader/` (integration suites included via
  `TEST_DATABASE_URL`); CI green.
- Every invariant above has a test; the live smoke (real `node:http` server, real undici `fetch`,
  real `dns.lookup` for `localhost` and an `.invalid` name) was run and its output is in the PR.
- `SECURITY.md`'s SSRF section rewritten: redirect hops and the resolution check are documented as
  controls, the #85 "two accepted gaps" paragraph is reduced to the rebinding residual, and Known
  limitations names that residual precisely.
- `CLAUDE.md`'s #93 status moved from "Filed… excluded" to "Done".
- Explicit human approval before merge, per CLAUDE.md's High-risk row.

## Rollback

Revert the single squash commit. It touches `uploader/src/safe-fetch.ts`, one pass-through line in
`uploader/src/wp-images.ts`, four test files, and the docs. No schema, no migration, no persistent
state, no dependency. After a revert the importer follows redirects blind and skips DNS again — the
pre-#93, documented state.

**Containment without a revert:** if a legitimate WordPress export fails on a redirect this change
refuses, the failure is per-image (`blocked` / `invalid-url` in the import summary, the hop and
target on stdout), the rest of the import completes, and the author's recovery is the same as for
any un-hosted photo: fix the source URL and re-run — #85's disk-derived resume skips everything
already hosted.

## Not included here

- **Pinning the resolved address into the connection** (closing rebinding) — needs `undici` as a
  dependency; revisit if the app ever gains untrusted users.
- **Honouring `Retry-After` or 3xx caching semantics** — #85 already declined `Retry-After`; a 304
  is treated as a plain non-2xx because the importer sends no validators.
- **Anything in `wp-import.ts`** — the retry classifier is unchanged and was deliberately not
  widened with a new `kind`; the hop cap rides on `http` with the 3xx status, which the existing
  policy already classifies as permanent.
