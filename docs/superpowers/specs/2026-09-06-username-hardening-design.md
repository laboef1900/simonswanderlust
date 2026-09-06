# Username allow-list and a `textContent`-only user badge (issue #131)

**Date:** 2026-09-06 · **Risk:** high (authn payloads) · **Size:** medium

## Decision

1. **One username rule, defined in `users.ts`.** `usernamePolicyViolation(username)` returns the
   user-facing violation (or `null`) for a *new* username: 1–64 characters, drawn from
   `[A-Za-z0-9._-]`. `POST /setup` and `POST /users` call it and answer 400 — the same shape as
   `passwordPolicyViolation` (#109), so the two rules sit side by side and any future creation
   path (a CLI `add-user`, say) has exactly one function to call.
2. **The rule applies to creation only.** `/login`, `findByUsername`, `set-password` and the
   stores' `create` are untouched: an account created before the rule may carry a name that
   violates it and must keep signing in and stay lockable (the #109 review invariant, tested).
   That is also why the rule is not pushed into the stores' `create` the way the password rule is
   pushed into `hashPassword`: the memory store is how the test suite seeds such a legacy account.
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
  whitespace inside, `<`, `@`, non-ASCII.
- `server.test.ts`: `/setup` and `/users` reject a disallowed name with 400 and create nothing;
  the pre-existing "legacy 96-char account still signs in" test stays green.

## Rollback

Revert the commit: one exported function, two route checks, one client render change, a hint in
`users.html`, docs. No data or schema change.
