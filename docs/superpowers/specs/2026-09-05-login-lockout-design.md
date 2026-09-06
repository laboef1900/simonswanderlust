# Login Lockout Redesign and Single Password Policy — Design

**Date:** 2026-09-05
**Status:** Proposed (implementation on `feature/109-login-lockout`, awaiting owner approval)
**Risk:** **High.** CLAUDE.md's Change Risk table names authn explicitly. Requires this spec,
trust-boundary and misuse-case analysis, the full affected suite, explicit human approval, and a
documented rollback plan.
**Repos touched:** blog repo — `uploader/` only. No `site/` change, no schema change, no new
endpoint, no new runtime dependency, no new persistent file.
**Closes:** #109.

## Why this exists

Issue #109 names three weaknesses in `uploader/src/rate-limit.ts` and the auth handlers in
`uploader/src/server.ts`:

1. **Unbounded limiter maps on attacker-chosen keys.** `accountLockoutLimiter.recordFailure` ran
   for every failed login with a non-empty username — existing or not — keyed on the raw string
   after `lower().trim()`, and nothing capped username length anywhere (the multipart/JSON body
   limit is 1 MiB). Both maps swept only *expired* entries, and only once `size > 10 000`, so
   within a 15-minute window they held `rate × 900 s` entries of arbitrary size.
2. **Self-service denial of service.** Five failures on a username locked it for 15 minutes, from
   any source, and the lock was enforced even when the submitted password was correct. An
   unauthenticated third party could keep the (public) admin username locked forever with five
   requests every 15 minutes. State is in-memory with no unlock path other than a restart.
3. **Password policy copied three times, skipped by the CLI.** The 12–1024 rule was inlined in
   `/setup`, `POST /users` and `POST /users/me/password`; `cli.ts set-password` only rejected an
   *empty* password, so the documented lockout-recovery path could set a one-character admin
   password.

## Decision

### 1. Bounded window maps

Both limiters share one `windowMap(windowMs, maxKeys)` (default `maxKeys = 10 000`). Every window
in a limiter has the same length, so **insertion order is expiry order**: opening a window deletes
and re-inserts the key at the back; expired entries are swept from the front; when the cap is
reached, the front (earliest-expiring, live) entry is evicted. All of it is amortised O(1) — there
is no full-map sweep an attacker can trigger per request, which the old `size > 10 000` sweep was.

Eviction is *safe by construction*: forgetting a counter can only ever admit a request, never
refuse one. A flood of distinct usernames therefore cannot lock anyone out; at worst it resets the
attacker's own progress against the account budget. Reaching the cap costs 10 000 requests inside
one window, and the per-IP limiter admits 10 per address, so it takes ≥ 1 000 addresses per
15 minutes — at which point the account budget below is the relevant control anyway.

Key length is bounded twice. At the boundary, `MAX_USERNAME_LENGTH = 64` (`users.ts`): `/setup`
and `POST /users` reject a longer **new** username with 400. Inside the limiter, any account key
longer than `MAX_KEY_LENGTH` (64) is stored as its SHA-256 hex, so a 1 MiB submitted name costs
the map 64 characters. `/login` therefore looks every submitted name up and counts every failure
regardless of length: an account created before the cap (the column is unrestricted `text`, and a
backup restore re-inserts names unchanged) keeps signing in and keeps its own lockout budget —
the first draft of this change skipped the lookup for long names, which the review caught as a
regression that neither the CLI reset nor a restart could repair. `req.ip` is bounded by the proxy
under `trustProxy: 1`.

### 2. Account lockout scoped so one source cannot trigger it

Three designs were considered against ASVS 5.0 L1 (§6.1.1 — document how rate limiting prevents
brute force **and** malicious account lockout; §6.3.1 — implement those controls as documented)
and NIST SP 800-63B §5.2.2 (limit consecutive failed attempts on an account to **no more than
100**; offer IP-based limiting and delays as mitigations):

| option | brute force (distributed) | malicious lockout | verdict |
|---|---|---|---|
| (a) key the lock on `(IP, username)` | *no* protection — a distributed attacker gets a fresh budget per address, exactly as it does from the per-IP limiter; the tier is redundant with `limitAuth` (10 requests/IP < 5 failures) | closed | rejected: adds a map for no new guarantee |
| (b) progressive per-account delay / "1 attempt per N s" | bounded | **not** closed — an attacker sending continuously occupies every admitted slot, so the owner's attempt still loses the race; delays also hold connections open | rejected |
| (c) **per-account failure budget across all sources, set 10× the per-IP budget** | bounded to 100 guesses / 15 min against a ≥ 12-character password — negligible | closed for a *single* source: one address is cut off by the per-IP limiter at 10 requests, long before 100 failures; forcing the lock needs ≥ 10 addresses sustaining 100 failures every 15 minutes | **chosen** |

So `/login`'s `accountLimiter` is `accountLockoutLimiter({ max: 100 })` (window unchanged at
15 minutes). The lock is still checked **before** scrypt, and a successful login still clears the
counter — an attacker's progress is discarded the moment the owner proves the password, which is
what NIST's "reset on success" permits. The per-IP `fixedWindowLimiter` stays at 10 / 15 minutes and
the `POST /users/me/password` limiter keeps `max: 5` (its key is the caller's own session user id,
so only the caller can ever fill it).

**Residual, accepted:** a sustained distributed attacker (≥ 10 addresses, ≥ 100 failures every
15 minutes) can still keep the account locked. Every per-account lock has this property; the
alternatives that do not (CAPTCHA, MFA) are beyond L1 for a single-admin deployment. Recovery is a
container restart (`docker compose restart app`) — the lock is process memory — and it expires on
its own 15 minutes after the last failure. A CLI unlock was considered and rejected: the CLI runs
in a separate process and would need a new IPC channel or a database-backed lock table to reach
the limiter's state, which is more surface than the residual risk justifies.

**Enumeration:** the lock is still recorded for unknown usernames too, so the 429 does not reveal
which usernames exist (ASVS 5.0 §6.3.8 is L3, but the property was already held and is cheap to
keep). The map bound (1) is what makes recording unknown names safe.

### 3. One password policy, enforced where hashes are minted

`users.ts` gains `passwordPolicyViolation(password): string | null` (the user-facing message) and
`assertPasswordPolicy(password)` (throws `PasswordPolicyError`). **`hashPassword` calls
`assertPasswordPolicy`**, so every path that mints a hash — `memoryUserStore`/`pgUserStore`
`create` and `setPassword`, and through them `POST /setup`, `POST /users`,
`POST /users/me/password`, and `cli.ts resetPassword` — shares the rule with no way around it.
The routes and the CLI call `passwordPolicyViolation` first only to produce a friendly 400 / exit 1
instead of a 500 / stack trace. The rule is length-only (12–1024), which ASVS 5.0 §6.2.5 requires
(no composition rules) and §6.2.1 permits (≥ 8, 15 recommended). `verifyPassword` is unchanged:
an existing hash of a shorter password (none exist — every creation path already enforced 12) would
still verify.

## Trust boundaries

- **Unauthenticated network → `/login`, `/setup`:** the only inputs are `username` and
  `password` strings. Both are attacker-controlled up to the body limit; the username is now capped
  at 64 before it reaches the store or the limiter, the password at 1024 before scrypt (unchanged).
- **Authenticated session → `POST /users/me/password`:** limiter key is the *server-side* user id.
- **Host operator → `cli.ts set-password`:** trusted operator, but the policy is now enforced there
  too so the recovery path cannot silently weaken the admin credential.
- **Process memory:** all limiter state; no persistence, no cross-replica sharing (single container).

## Misuse cases

| attack | before | after |
|---|---|---|
| lock the admin out with 5 requests from one address | works, repeatable every 15 min | per-IP limiter refuses at 10 requests; 100-failure budget unreachable from one address (route test) |
| distributed guess against the admin password | locked after 5 — but see previous row | locked after 100 failures / 15 min across all sources; 100 guesses against a 12+ char password is no threat (route test with an injected small budget) |
| grow limiter memory with distinct or huge usernames | unbounded within the window | 10 000-entry cap with O(1) eviction; keys > 64 chars stored as a 64-char hash (limiter tests); new usernames > 64 rejected at creation (route test) |
| set a 1-character admin password via the CLI | accepted | `PasswordPolicyError`, exit 1 before a pool is opened; old hash and sessions untouched (CLI tests) |
| bypass the policy via a store call | possible for any new caller | impossible — `hashPassword` enforces it (store test) |
| username enumeration via the lock | 429 only for names that failed before | unchanged |

## Invariants

1. No limiter map ever holds more than `maxKeys` entries (default 10 000); eviction removes the
   earliest-expiring window first.
2. Eviction never causes a refusal — it only forgets failures.
3. A username longer than `MAX_USERNAME_LENGTH` cannot be created; a limiter key is never longer
   than `MAX_KEY_LENGTH`; and no existing account is refused because of its name's length.
4. `/login`'s account budget is strictly greater than the per-IP budget × 1, so a single
   proxy-appended address cannot lock any account.
5. The lock is checked before scrypt; a successful login clears it.
6. `hashPassword` throws `PasswordPolicyError` for any password outside 12–1024 characters, so no
   hash of a policy-violating password can be minted by any path.

## Rollback

Revert the single commit. There is no schema, file-layout, or settings change; the only runtime
state is process memory, which the restart on redeploy discards anyway. Reverting restores the
5-failure lock (and with it the single-source lockout DoS), so a revert should be paired with
re-opening #109.

## Scope table

| in | out |
|---|---|
| `rate-limit.ts` bounded maps; `/login` budget 100; username cap; `assertPasswordPolicy` in `hashPassword`; CLI policy; tests; `SECURITY.md`, `ARCHITECTURE.md`, `uploader/README.md`, `CLAUDE.md` | breached-password list (ASVS §6.2.4, L1 — filed separately if desired; not in #109); MFA/CAPTCHA; a persistent or CLI-reachable unlock; changing the per-IP budget; UI changes |
