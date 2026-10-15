# Username allow-list and a `textContent`-only user badge (issue #131)

**Date:** 2026-09-06 · **Risk:** high (authn payloads) · **Size:** medium

## Decision

1. **One username rule, defined and enforced in `users.ts`.** `usernamePolicyViolation(username)`
   returns the user-facing violation (or `null`) for a *new* username: 1–64 characters, drawn
   from `[A-Za-z0-9._-]`. Both stores' `create` call `assertUsernamePolicy` (throws
   `UsernamePolicyError`), so any creation path — the two routes today, a CLI `add-user` tomorrow —
   inherits it, exactly as `hashPassword` carries the password rule (#109). `POST /setup` and
   `POST /users` also check it up front to answer a clean 400.
2. **The rule applies to creation only.** `/login`, `findByUsername` and `set-password` are
   untouched: an account created before the rule may carry a name that violates it and must keep
   signing in and stay lockable (the #109 review invariant). The test for that invariant seeds
   the legacy row through a store whose *lookup* answers with it, not through `create`.
3. **The sidebar badge is built with `textContent`.** `auth.js` renders the CMS shell from one
   template literal into `shell.innerHTML`; the username and its initial were interpolated into
   that string. The template now leaves both slots empty and fills them with `textContent` after
   the parse, restoring the codebase's own rule that user-controlled text never reaches `innerHTML`.
4. `users.html` mirrors the rule with `maxlength="64"`, `pattern`, and a hint under the field, so
   an admin sees the constraint before the 400 does.

## Why 64, not the 32 the issue proposed

#109 chose 64 as the creation cap ("generous for a login name") and encoded it in the lockout
limiter's key-hashing threshold and in `SECURITY.md`. Halving it would be a second, unmotivated
decision on the same knob; the allow-list is the part of #131 that carries the risk reduction.

## Trust boundaries

- Anonymous → `/setup` (only while zero users exist) → the username is validated before `create`.
- Admin → `POST /users` → validated before `create`. The admin already has every power the
  payload could buy them; the point is to keep the invariant "usernames are plain identifiers"
  true everywhere downstream (limiter keys, `lower(username)` lookups, `aria-label`s, logs).
- Browser: `GET /auth` returns the session's own username, which `auth.js` now sets as text.

## Misuse cases considered

- Admin creates `<img src=x onerror=…>` → 400 at the boundary; and even a legacy row with such a
  name renders inert in the badge (`textContent`). Both halves are needed: the first keeps the
  data clean, the second makes the renderer safe regardless of the data.
- A 1 MiB username on `/setup` → 400 before scrypt runs (already true since #109; unchanged).
- Unicode/homoglyph names (`аdmin` with a Cyrillic а) → 400; the allow-list is ASCII-only, so no
  two distinct usernames can be confusable under `lower()`.

## Invariants (tested)

- `users.test.ts`: the rule accepts `simon`, `s.imon-1_`, 64 chars; rejects empty, 65 chars,
  whitespace inside, `<`, `@`, non-ASCII; `memoryUserStore.create` throws `UsernamePolicyError`
  and stores nothing. `pg.integration.test.ts`: `pgUserStore.create` does the same.
- `server.test.ts`: `/setup` and `/users` reject a disallowed name with 400 and create nothing;
  the "legacy 96-char account still signs in and is lockable" invariant stays green.
- `admin-pages.test.ts`: the shell template never interpolates `s.username`.

## Rollback

Revert the commit: one rule and one assertion in `users.ts` (two `create` call sites), two
route checks, one client render change, a hint in `users.html`, docs. No data or schema change.
