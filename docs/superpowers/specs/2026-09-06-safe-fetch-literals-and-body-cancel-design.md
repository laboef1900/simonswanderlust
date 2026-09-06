# `safeFetch` — Remaining IPv4-embedding Literals and Abandoned Response Bodies — Design

**Date:** 2026-09-06
**Status:** Proposed (implements issue #144)
**Risk:** **High.** `safeFetch` is the SSRF chokepoint named in CLAUDE.md's Change Risk table.
Requires this spec, misuse cases, the affected suite, explicit human approval, and a rollback plan.
**Repos touched:** blog repo — `uploader/src/safe-fetch.ts`, `uploader/test/safe-fetch.test.ts`,
`SECURITY.md`. No import-path change, no `site/` change, no dependency.
**Builds on:** `2026-09-05-safe-fetch-redirects-design.md` (#93), which replaced the hand-written
prefix checks #144 was filed against with one `net.BlockList` and a pre-connect DNS check.
**Closes:** #144.

## Why this exists

Issue #144 was filed against the pre-#93 `isBlockedHost`, which missed IPv4-mapped IPv6 literals
(`[::ffff:127.0.0.1]` serialises as `[::ffff:7f00:1]`), `0.0.0.0` and `[::]`. #93 closed those:
`BLOCKED` holds `0.0.0.0/8` and `::`, and `net.BlockList` judges an IPv4-mapped address against
the IPv4 rules itself. Measured on the current tree, all of the issue's part-1 literals are refused.
Two things remain:

1. **Other IPv6 forms that embed or stand in for an IPv4 address** are still accepted because
   `BlockList` does not unpack them: the deprecated IPv4-compatible `::/96` (`[::7f00:1]`), 6to4
   `2002::/16` (`[2002:7f00:1::]` carries 127.0.0.1 in its second and third hextets), site-local
   `fec0::/10` (deprecated but still routed by some stacks), documentation `2001:db8::/32`, and the
   discard prefix `100::/64`. None is a routable public destination for a WordPress media URL, and
   `64:ff9b::/96` (NAT64) is already blocked wholesale for the same reason.
2. **A non-2xx response body is never cancelled.** `safeFetch` throws on `!res.ok` while the
   `Response` still holds its stream; undici keeps the socket until the object is collected. An
   export whose photos mostly 404 — exactly the situation #85 designed for — leaks one held
   connection per failed attempt, up to `hostFailureLimit × (retries + 1)` per host, for the length
   of a multi-minute import inside a `mem_limit`'d container. Redirect bodies already are cancelled
   (#93); the non-2xx path was left out.

## Decision

1. Extend `BLOCKED` with `::/96`, `2002::/16`, `fec0::/10`, `2001:db8::/32` and `100::/64`. The
   list remains the single source of truth (`@ai-warning` in `safe-fetch.ts`); both the literal
   check and the post-resolution check consult it, so a hostname resolving to `2002:7f00:1::` is
   refused too.
2. Cancel the body of every response `safeFetch` does not read: one `discard(res)` helper used on
   the redirect hop (already) and on the non-2xx path (new). A failing `cancel()` is swallowed —
   the socket is closing either way, and the caller's error must stay the HTTP status, not a
   `network` failure #85's retry classifier would misread.

## Trust boundaries and misuse cases

- The URL comes from an attacker-influenced export (admin-only since #97, but the residual
  open/closed oracle through `failureReason` is real). Literal checks are synchronous and
  string-only; every added range is a prefix the WHATWG parser preserves, so there is no new
  canonicalisation to get wrong.
- Could a legitimate WordPress media host live in one of the new ranges? No: they are
  deprecated/transition, documentation or discard space, never public unicast.
- Could `discard` change an error's `kind`? No — it swallows its own failure and runs before the
  `FetchError` is thrown; `kind` and `status` are unchanged, so #85's retry classifier is untouched.
- Does cancelling a non-2xx body alter the timeout semantics? No — the timer still spans the whole
  call; cancellation only releases the connection sooner.

## Invariants (pinned by tests)

1. `assertFetchableUrl` refuses `[::7f00:1]`, `[2002:7f00:1::]`, `[fec0::1]`, `[2001:db8::1]`,
   `[100::1]` with `kind: 'blocked'`, and still accepts public IPv6 (`[2606:4700::1111]`).
2. A non-2xx response's body is cancelled before `safeFetch` rejects; the rejection still carries
   `kind: 'http'` and the status. A redirect hop's body is cancelled (already pinned).
3. A `cancel()` that throws does not change the error the caller sees.

## Rollback

Revert the PR. No state, no schema, no data.
