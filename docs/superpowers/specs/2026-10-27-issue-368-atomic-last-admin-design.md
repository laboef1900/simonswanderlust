# Atomic last-administrator removal guard (#368)

Date: 2026-10-27. Risk: **High — authorization, sessions and first-run setup invariant.**
Status: **OWNER-APPROVED contract; implemented and isolated real-runtime verification passed.**
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Root cause and scope

Accept the issue's deterministic real-Postgres cross-delete result as ground truth: both
requests returned 200, no users/admins remained, and anonymous auth status reopened setup.
`server.ts:1291–1296` checks target/count separately from `users.remove`; the latter performs
an unconditional DELETE. A route-local mutex would not protect other store clients/processes.

Make the **store's check-and-delete atomic**. Preserve self-delete refusal, admin authorization,
account/session privacy, existing setup behavior and data. No migration, setup-completed marker,
role management feature, repair of existing databases or destructive cleanup is included.

## Store contract and serialization

Replace `UserStore.remove(id): Promise<void>` with the discriminated outcome
`Promise<'removed' | 'not_found' | 'last_admin'>`. Every production deletion caller must use this
single guarded operation; do not retain an exported unchecked delete method. `countAdmins` can
remain for observation/tests but is no longer an authorization decision in the route.

Postgres implementation in `uploader/src/users.ts`:

1. Reject malformed UUID ids as `not_found`, matching the existing route's 404 behavior.
2. Acquire one client and `BEGIN` at the existing default READ COMMITTED isolation.
3. **Before reading target or administrator count**, acquire
   `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`. This mode serializes competing removals
   (including ordinary SQL DELETE writers) and other account writes, but permits ordinary
   account/authentication SELECTs. Account mutations are rare and the transaction is short.
4. Read target under the lock. Missing → `not_found`. For an admin target, issue a fresh count
   statement under that same lock; count ≤ 1 → `last_admin`, without deleting anything.
5. Otherwise DELETE the target, then COMMIT. Release the client in finally; on exceptions
   ROLLBACK and rethrow for the existing sanitized error boundary. Do not perform password
   hashing, session creation, HTTP work or external calls while holding the lock.

A waiter acquires the lock **before** its reads and therefore sees the winner's committed delete.
Do not pre-read a target for UPDATE before taking the table lock, use independent pool queries
inside the transaction, or combine the count and delete in a shared-snapshot CTE. No retries,
advisory-lock namespace or schema change are needed. The brief serialization of other users-table
writes is the explicit conservative tradeoff being approved, not a general application lock.

Memory implementation performs target lookup, count and deletion in one synchronous section
inside its async method with **no await between them**. It returns the same outcomes and does not
mutate on `last_admin`/`not_found`. Concurrent Promise calls then obey the same store invariant.
No separate async count/pre-check and no new queue abstraction.

## Route, sessions and setup

`DELETE /users/:id` retains `requireAdmin` and the existing self-id comparison first (409
`you cannot delete your own account`). Replace target/count/remove sequence with one store call:

- `not_found` → 404 `user not found`;
- `last_admin` → 409 `cannot remove the last admin`;
- `removed` → existing 200 `{ ok:true }` after session invalidation.

Postgres already deletes the removed account's sessions atomically through
`db.ts:89`'s `REFERENCES users(id) ON DELETE CASCADE`; retain this, no DDL change. Call the existing
`sessions.destroyAllForUser(id)` **only after `removed`**, making memory-backed route behavior
match Postgres and not invalidating the surviving administrator. For Postgres this is an
idempotent no-op after the cascade. If this follow-up fails, do not pretend to roll back a
committed deletion: the existing sanitized failure path applies; `authn.loadUser` independently
refuses sessions whose user no longer exists. Never invalidate sessions before the guarded delete.

For two requests already authenticated before either removal commits, exactly one succeeds and
the loser is the documented 409. A request arriving only after its own account/session has been
deleted normally gets 401 from `requireAdmin`; do not weaken authorization merely to manufacture
a 409 in that different timing. No reauthorization policy change is part of this fix.

Starting from a valid configured state with ≥1 administrator, guarded removals retain ≥1, hence
≥1 user: `/auth/status` continues reporting `needsSetup:false`, `/setup` stays 409. The existing
per-app setup serialization remains untouched. Fresh zero-user setup still works. Offline restore
is a separately authorized operation, not an unchecked account-deletion API to retrofit here.
An already-broken zero-admin database is not automatically seeded or repaired by this change.

## Affected files and verification after approval

Implementation: `uploader/src/users.ts`, account deletion in `server.ts`, and store/route tests.
Known production caller is the users route; migrate injected `UserStore` doubles as required.
`authn.ts`, `sessions.ts` and `db.ts` provide existing safeguards and need no policy/schema change.
Use `test/users.test.ts`, `test/server.test.ts` (existing self/last-admin tests), and real
Postgres integration following `test/pg.integration.test.ts`/main-boot fixtures.

Required evidence (runtime results recorded below; automated suites are main-agent-owned):

- Memory: concurrently remove two admin ids directly; one `removed`, one `last_admin`, exactly
  one administrator remains. Unknown/malformed id is not_found; non-admin deletion succeeds;
  single-admin direct removal is refused. Repeated removal of the same deleted id is not_found.
- Real Postgres: two independently acquired clients/store instances, two admins and sessions;
  hold a conflicting table lock, start both removals, then release the barrier and assert one
  removal / one refusal. Synchronize before the new lock, not by waiting for two DELETEs as in
  the old reproduction (that would deadlock the test against the repaired design).
- Concurrent authenticated cross-delete routes with a barrier ensuring both preHandlers have
  resolved before deletion: 200 + 409, survivor can authenticate, only deleted user's sessions
  disappear, anonymous `needsSetup:false`, subsequent `/setup` → 409. Repeat with extra authors.
- A late request using the deleted user's cookie → 401; self-delete still 409 and leaves every
  account/session unchanged. Anonymous/non-admin DELETE remains 401/403 before id validation.
- Force a transaction failure before COMMIT: no deleted account/session, lock/client released,
  later permitted removal can proceed. A failed/nonexistent/conflicting removal never calls
  session invalidation. Cover memory-route session behavior too.
- Main-agent full uploader tests/typecheck plus real Postgres concurrent route/store tests with
  `TEST_DATABASE_URL`; skipped integration runs are not evidence. Runtime smoke only on disposable
  accounts/database, never cross-delete the owner's live administrators.

## Isolated runtime verification — 2026-10-27

- Exercised the real `src/main.ts` process (`swl-issue-368-app`, TCP port 33468) against only
  synthetic `swl_368_dev` on loopback port 55427. Initial `/setup` returned 200; subsequent
  accounts came through `/users`, with real Postgres stores supplying the additional sessions.
  No fake application/store/renderer, owner accounts, deployment or schema change was involved.
- **Intentional scheduling injection:** a separate connection held `BEGIN; LOCK TABLE users
  IN SHARE MODE`. Both authenticated cross-delete requests reached two distinct **ungranted
  `ShareRowExclusiveLock`** requests scoped to this database's `public.users` relation before
  the blocker committed in `finally`. The barrier did not wait for DELETE statements.
- With exactly two admins and two sessions each: A→B returned 200 `{ok:true}`, B→A returned
  409 `cannot remove the last admin`. One admin remained with both sessions; the removed
  account had zero sessions. Repeated with two additional authors, each with two sessions:
  the same 200/409 outcome left one admin and both authors, all six surviving sessions unchanged.
- In both runs, both survivor cookies authenticated successfully, survivor password login
  returned 200, both deleted cookies returned 401, and a late DELETE using a deleted cookie
  returned 401. Self-delete returned 409 `you cannot delete your own account` without changing
  any account/session. Anonymous `/auth/status` returned `{authenticated:false,needsSetup:false}`;
  `POST /setup` returned 409 `setup already complete`.
- Anonymous DELETE returned 401 and author DELETE returned 403 before malformed-id handling;
  authenticated-admin deletion of that missing id returned 404. The setup/login and
  session/authentication policies were not bypassed or modified.
- Exact responses, before/after account/session counts and both lock snapshots are preserved
  in ignored `.issue-runtime/last-admin-runtime-report.json`. Generated credentials are
  separately mode-0600; the throwaway probe was removed after proof. This API/state scenario
  does not require screenshots. Memory parity, transaction-failure regression and full
  suite/typecheck evidence remain the main agent's checks; they were not rerun by the smoke.

## Security, rollback and approval

Implementation updates `SECURITY.md` Accounts/First-admin setup: last-admin protection is a
store-level serialized operation, sessions cascade only on successful deletion, and a configured
installation cannot reopen setup through concurrent removals. Reconfirm password policy, lazy
auth resolution and setup limiter unchanged. Update the existing auth design with this invariant.

No data/schema migration to roll back. Prefer roll-forward; reverting reintroduces a path to
anonymous setup takeover. If rollback is unavoidable, block the DELETE `/users/*` method/path
at the existing trusted reverse proxy for the rollback window until a fixed app is restored;
do not disable all authentication or run manual account deletions. If an operator discovers the
preexisting zero-user failure, contain public `/setup` immediately and use separately authorized
recovery from verified backups—this proposal neither performs nor preauthorizes that restoration.

## Owner approval record

- Approver/date: repository owner, interactive implementation session, 2026-10-27.
- Exact answer: **“Approve narrow atomic fix”**.
- Approved: the store-level transaction and short users-table write lock above, memory parity,
  unchanged self-delete/auth rules, session invalidation only after successful removal, and
  real-Postgres verification plus SECURITY.md update.
- Not authorized: migration, owner-account repair/mutation, merge, release or deployment.
