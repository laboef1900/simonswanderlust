# Return the limiter refusal through Fastify's async hook contract (#372)

Date: 2026-10-27. Risk: **High — authentication rate-limit boundary.**
Status: **OWNER-APPROVED contract; implemented and runtime-verified in the isolated issue worktree.**
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Evidence and smallest fix

The issue reports a conditional defect, **not a bypass of the current production hook chain**.
Its present-chain probe kept handlers blocked; its isolated async-onSend probe returned 200/429
but counted two handler runs. Treat both supplied observations as ground truth.

`rate-limit.ts:99–104` returns an async `Promise<void>` hook which calls `reply.send` without
returning it. `authn.ts:48–66` documents precisely why that settles before an asynchronous
onSend chain finishes. `authn.test.ts:116–146` already exercises the correct return contract.

Change only the limiter wrapper's refusal completion semantics:

- Hook return type becomes `Promise<void | FastifyReply>`.
- Refusal branch becomes `return reply.code(429).send({ error: 'too many attempts, please wait and try again' })`.
- Admission still falls through with no response. Invoke `limiter.check(req.ip)` once per
  request, in the same position as before.
- Add a concise invariant comment pointing to the existing AuthGuard async-onSend rationale.
  Do not change compression or force onSend to be synchronous as a workaround.

No new dependency, API, env field, retry, timer, store, limiter algorithm or response copy.
Affected runtime file: `uploader/src/rate-limit.ts`. Existing `server.ts` use sites are
`limitAuth` on `/setup`, `/login`, and `[limitAuth, requireAuth]` on `/users/me/password`.
No production authn/server rewrite is required unless type propagation exposes a test double.

## Preserved boundaries

- Per-IP authentication budget remains 10 requests / 15 minutes, shared across those three
  endpoints; key remains `req.ip` under the existing trusted-proxy contract.
- Login's per-account budget remains 100 failures / 15 minutes, checked before scrypt;
  password-change account budget remains 5 / 15 minutes keyed by session user id.
- Existing 10,000-key cap, expiry/eviction, long-key hashing and success/failure bookkeeping
  are untouched. Comment rate-limit maps remain completely separate.
- A denied request reaches neither later preHandlers nor route side effects: no user lookup
  by the login handler, scrypt, account-failure increment, session minting, password change,
  or first-admin creation. Client still receives the identical 429 status/body.
- Allowed requests retain existing requireAuth/requireAdmin behavior, current-password proof,
  account lockout, setup serialization and credential/session rules. Never bypass them merely
  to make an async-hook regression test pass.

## Required tests and runtime scenarios after approval

Use `test/rate-limit.test.ts` for the wrapper regression and existing server/authn test fixtures
for real route behavior. Reuse the exact asynchronous no-op hook already present in
`test/authn.test.ts`: await a resolved promise, then return payload. Register it **before app
readiness**; do not add a production configuration knob solely to install a test hook.

1. Minimal real Fastify instance, max=1 fixed-window limiter, counting handler and async onSend.
   First request succeeds and runs once. Second returns the exact 429 and handler count stays
   one, after the full injection completes. A following fake-clock window admits again. Cover
   the wrapper in a preHandler array with a counting subsequent hook as well.
2. Real `buildServer` routes plus that onSend hook: exhaust the shared IP budget, then attempt
   valid `/login`. Assert 429, no handler user lookup/session creation and no Set-Cookie. With
   a wrong password under the same refusal, account failure count must not increase. Assert
   side effects, not only HTTP status—the defect can still send 429 while performing work.
3. Authenticated `/users/me/password` over budget: valid current/new passwords still give 429,
   stored hash unchanged, no destroyAllForUser/session-create, and no account-limiter mutation.
   An under-budget request still enforces authentication and current-password verification.
4. Empty-user fixture with exhausted budget: valid `/setup` remains 429 with zero users and no
   sessions. Obtain the exhausted bucket with disallowed login attempts or a controlled limiter,
   not by creating the first admin; an allowed fresh-fixture setup still succeeds once only.
5. Keep all existing limiter normalization/cap/window/proxy-key tests and present-chain auth
   tests. The new async hook test is synthetic coverage of the explicitly conditional trigger;
   do not describe it as a newly observed production exploit.
6. Main agent runs uploader full tests and typecheck after implementation. Exercise the actual
   three routes against a disposable app under the injected async hook and normal hook chain,
   verifying persisted side effects are absent. This narrow hook fix needs no data migration or
   new Postgres concurrency fixture; existing DB integration coverage remains unchanged.

## Security notes, dependencies and recovery

Implementation reconfirms `SECURITY.md` Rate limiting and adds that a refusal returns the
Fastify reply so downstream handlers cannot execute while async onSend work is pending. Update
the existing auth/limiter design note, not the budgets or trust-proxy policy. No new UI copy is
introduced; the existing error body is byte-identical.

#369's approved proxy/dependency work retains ownership of client-IP trust and upgraded package
versions. Run this regression on the eventual integrated dependency set; do not duplicate or
change that work. #368's atomic user deletion is independent. No dependency on comment changes.

Code-only rollback leaves users, sessions and limits untouched but restores the latent defect.
Prefer roll-forward (the correction is the documented Fastify contract). Do not accept a new
asynchronous send hook/plugin on a version lacking this fix; if such a combination is already
exposed, contain the affected auth mutations at the existing proxy until the fixed version is
restored. No account-data rewrites or weakened rate limits are authorized as recovery.

## Owner approval record

- Approver/date: repository owner, interactive implementation session, 2026-10-27.
- Exact answer: **“Approve narrow hook fix”**.
- Approved: returned Fastify refusal reply, matching async return type, and async-onSend
  side-effect regressions for login, password change and setup, with every budget, key,
  authentication check and response unchanged.
- Not authorized: proxy-trust or limiter-policy changes, merge, release or deployment.

## Runtime verification — 2026-10-27

The actual `buildServer` listened on `127.0.0.1:33472`, using `pgUserStore` and
`pgSessionStore` against the disposable `swl_372_dev` PostgreSQL database. Other configured
stores/services were real application implementations; no handler, authentication guard,
limiter or store was replaced. No build was triggered. Settings and data stayed within the
issue worktree's ignored `.issue-runtime` directory.

**Explicit conditional fault fixture:** one extra async `onSend` hook awaited a 5ms timer
before returning its payload, registered before listening. Synthetic `X-Forwarded-For`
addresses modeled the existing single trusted reverse proxy; no proxy configuration or
limiter budget was changed. Listener restarts reset only the normal in-memory budgets.
This exercises the future asynchronous-hook trigger, not a current-production exploit.

| Scenario | Observed result |
| --- | --- |
| Empty database, ten admitted wrong logins, then valid setup from the exhausted address | 10 × 401, setup 429; zero users and zero sessions, no cookie. Passed under normal and injected hook chains. |
| Fresh-address setup, followed by another setup | 200 then 409; exactly one user and one session. |
| 100 wrong logins from one address, then correct credentials from that address | 10 × 401 + 90 × 429; correct login 429, no cookie and identical stored user/session rows. Passed under both chains. |
| Wrong and correct current-password changes from that exhausted address | Both 429; original hash and every session row unchanged. Passed under both chains. |
| Fresh-address login after the IP refusals | Proposed replacement password 401; original password 200. The one-source refusal flood did not lock the account. Passed under both chains. |
| Fresh-address password checks | Unauthenticated request 401; five authenticated wrong-current-password requests each 400, then valid-current-password request from another address 429. Persisted hash/sessions unchanged; the earlier IP-refused wrong password did not consume this account budget. Passed under both chains. |
| 100 wrong logins across ten proxy-modeled addresses, then correct credentials from an eleventh | 100 × 401, then account-lock 429; no cookie or persisted changes under the injected hook. |

All refusal responses matched their existing error bodies exactly. Side-effect checks compared
complete user and session rows in memory after response completion plus a 250ms settling
interval; neither credentials, hashes nor session identifiers were emitted to evidence.
All **226 injected hook invocations settled**, all 12 recorded scenarios passed, and the
listener, services and database pool were closed.

Evidence: `.issue-runtime/runtime-rate-limit-evidence.json`. An initial probe encountered
`fetch failed` on the first request after a listener restart; its partial report is preserved
as `.issue-runtime/runtime-rate-limit-initial-transport-failure.json`. The probe transport
was changed to request `Connection: close`, avoiding pooled sockets across intentional
restarts; no application change was made, and the complete runtime exercise then passed.
The throwaway probe was removed; synthetic credentials remain in a mode-0600 fixture file.

Limits: persisted side effects and observable limiter behavior were checked, not instrumented
handler/scrypt/user-lookup counts. The direct handler-count acceptance criterion belongs to
the automated regression suite. This worker ran no test suites, typechecks, formatters or
standalone builds; those checks remain the main agent's responsibility. No browser screenshot
is relevant to this HTTP/authentication boundary, and no deployment or physical-device claim
is made. `SECURITY.md` Rate limiting is reconfirmed; no security-policy change was introduced.
