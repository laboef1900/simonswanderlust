# Design — Username/Password Auth for the Uploader

**Date:** 2026-06-23
**Status:** Approved (brainstorming) — ready for implementation planning
**Relates to:** `uploader/` self-hosted image service. Supersedes the "No multi-user
accounts" non-goal from `2026-06-18-image-hosting-uploader-design.md` — the uploader
now has real accounts. The blog static site (`site/`) is unaffected.

## Problem

The uploader authenticates every admin request with a **single shared bearer token**
(`AUTH_TOKEN` env var), typed/pasted into an "Auth token" field on each admin page and
sent as `authorization: Bearer <token>`. This has three problems:

1. **No real users** — one shared secret for everyone; no per-person access, no roles,
   no way to revoke one person without rotating the secret for all.
2. **Fragile manual header** — building the header in client JS just caused a
   Safari-only failure (`SyntaxError: The string did not match the expected pattern.`)
   when the token field was empty, because `'Bearer ' + '' ` is an invalid HTTP
   header value that WebKit rejects before the request is sent.
3. **Awkward UX** — the secret must be re-pasted into a field on every page load.

We want **username + password login** with proper sessions instead.

## Goals

- Replace the shared token with **named accounts** (username + password).
- **Login page + session cookie** UX: log in once, no secret re-typed, real logout.
- **Roles**: `admin` (manages accounts) vs `author` (uploads/captions/settings).
- Accounts persisted in **Postgres** (new container), passwords stored only as
  salted hashes.
- Remove the manual `Authorization` header path entirely (also fixes the Safari bug).
- Keep the CLI (`npm run upload`) working — it processes images **in-process** and
  never used the token, so it is unaffected.

## Non-Goals (YAGNI)

- No self-service signup, email verification, or password-reset-by-email.
- No OAuth/SSO/2FA.
- No login rate-limiting in v1 (single-tenant private tool). A `@ai-note` marks where
  it would slot in.
- No session "remember me" toggle or sliding expiry — a fixed 30-day session.
- No audit log of logins.

## Key Decisions

1. **Postgres in a separate container** (user's explicit choice; they already run
   Postgres on this host). Adds a `db` service to the root `docker-compose.yml` and a
   `pg` dependency to the uploader.
2. **Login page + HttpOnly session cookie**, not Basic Auth and not a localStorage
   token. Cookies are auto-sent same-origin, so the fragile client header is removed.
3. **Server-side sessions table** (not a stateless signed cookie) so logout and
   account removal revoke access immediately.
4. **scrypt via Node's built-in `crypto`** (no hashing dependency). argon2 rejected as
   marginal benefit + native build cost at this scale.
5. **First-run setup page** for the first admin (chosen over env-seed / CLI): when the
   users table is empty, `/login` offers "create the first admin"; `POST /setup` is
   guarded to only work while zero users exist.
6. **Remove `AUTH_TOKEN` entirely** — login-only. README's `curl` example is updated to
   authenticate via `/login` and a cookie jar.
7. **No new app secret required** — session tokens are 256-bit random and stored
   **hashed (sha256)** in the DB; the cookie carries the raw token. A DB leak cannot be
   replayed as a session.

## Architecture

Auth is split into small, independently testable units. Each store is defined by an
**interface** with a **Postgres implementation** (prod) and an **in-memory
implementation** (tests), so unit tests stay fast and need no live DB — matching the
existing "tests need no live LM Studio" approach.

| Unit | Responsibility | Depends on |
|------|----------------|-----------|
| `src/db.ts` | pg `Pool`; idempotent schema creation on boot (`ensureSchema`) | `pg`, `DATABASE_URL` |
| `src/users.ts` | `UserStore` interface (create/findByUsername/list/remove/count) + scrypt `hashPassword`/`verifyPassword` | `db` (pg impl) / none (memory impl) |
| `src/sessions.ts` | `SessionStore` interface (create/find/destroy/sweepExpired) | `db` (pg impl) / none (memory impl) |
| `src/authn.ts` | Fastify hooks `requireAuth`, `requireAdmin`; cookie read/issue/clear helpers | `users`, `sessions`, `@fastify/cookie` |
| `src/server.ts` | Wires hooks onto routes; new `/auth/status` `/login` `/logout` `/setup` `/users*` routes; existing routes switch from bearer to session auth | the above |
| `src/main.ts` | Reads `DATABASE_URL`, builds stores, calls `ensureSchema`, builds server | `db`, stores |

### Data model (Postgres)

ids and session tokens are generated in Node (`crypto.randomUUID`, `crypto.randomBytes`)
so **no Postgres extension** (pgcrypto/uuid-ossp) is required.

```sql
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY,
  username      text NOT NULL,
  password_hash text NOT NULL,
  is_admin      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- case-insensitive uniqueness without the citext extension
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  id         text PRIMARY KEY,            -- sha256(raw cookie token), hex
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
```

`ensureSchema()` runs these `IF NOT EXISTS` statements on every boot (cheap, idempotent).

### Password hashing (scrypt)

- Stored format: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>` (params embedded so they can
  evolve). Defaults: `N=16384, r=8, p=1`, 16-byte salt, 64-byte key.
- `verifyPassword` parses params from the stored string and compares with
  `crypto.timingSafeEqual`.

### Session & cookie

- On login/setup: `token = randomBytes(32).toString('hex')`; store `sha256(token)` as the
  session row id with `expires_at = now() + 30 days`; set cookie:
  `sid=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` and `Secure` **iff**
  the request is HTTPS.
- `Secure` detection: Fastify built with `trustProxy: true`; treat the request as secure
  when `req.protocol === 'https'` (covers `X-Forwarded-Proto: https` behind the reverse
  proxy) so production gets `Secure` while `http://localhost:3000` still works in dev.
- `SameSite=Strict` is the CSRF defense; the admin UI and API are same-origin.
- Each request: read `sid` → `sha256` → `SessionStore.find` → reject if missing/expired
  → load user, attach `req.user = {id, username, isAdmin}`. Expired rows are deleted on
  encounter; a periodic `sweepExpired` runs on an interval.

## Auth & Authorization flow

- **First run** (`UserStore.count() === 0`): the login page sees `needsSetup:true` from
  `GET /auth/status` and renders the "create first admin" form. `POST /setup
  {username,password}` creates an admin and logs in. `/setup` returns `409` if any user
  already exists (guarded server-side, independent of the client).
- **Login**: `POST /login {username,password}` → case-insensitive `findByUsername` →
  `verifyPassword` → on success create session + set cookie, return `{username,isAdmin}`;
  on failure return `401 {error:'invalid username or password'}` (generic — no
  user enumeration; same response for unknown user and wrong password).
- **Logout**: `POST /logout` → `SessionStore.destroy` + clear cookie.
- **Protection model** — the true gate is on **data and actions**, not on serving HTML:
  - **Static admin pages, CSS, JS, fonts contain no secrets and are served publicly.**
    This avoids a bootstrap wrinkle (a gated `/admin/*` couldn't serve the login page's
    own CSS/fonts) and keeps serving simple.
  - **Every sensitive read or write endpoint enforces `requireAuth`/`requireAdmin`** and
    returns `401` (or `403` for non-admins) when unauthorized. No data is exposed without
    a valid session, so public HTML is safe.
  - On load, each admin page calls **`GET /auth/status`**; if `authenticated` is false it
    redirects to `/login`, and `users.html` additionally redirects non-admins to `/admin/`.
    Client `fetch` wrappers also redirect to `/login` on any `401`.
- **Roles**:
  - `requireAuth`: `/upload`, `/suggest`, `/settings` (GET/POST), `/settings/models`,
    `/settings/test`, `POST /logout`.
  - `requireAdmin`: `GET /users`, `POST /users`, `DELETE /users/:id`.
  - `GET /auth/status` and `GET /login` are **public** (status drives first-run + redirects).
  - Guards: cannot delete **yourself**, cannot delete the **last admin** (→ `409`).

## HTTP endpoints (new/changed)

| Method | Path | Auth | Body / notes |
|--------|------|------|--------------|
| GET | `/auth/status` | public | `{authenticated, username?, isAdmin?, needsSetup}` — drives first-run + redirects |
| GET | `/login` | public | serves `login.html` |
| POST | `/setup` | public, only if 0 users | `{username,password}` → creates admin, logs in |
| POST | `/login` | public | `{username,password}` → sets cookie |
| POST | `/logout` | auth | clears session+cookie |
| GET | `/users` | admin | `[{id,username,isAdmin,createdAt}]` |
| POST | `/users` | admin | `{username,password,isAdmin}` |
| DELETE | `/users/:id` | admin | guarded (self / last admin) |
| GET | `/`, `/admin/*`, assets | public | static pages/CSS/JS/fonts (no secrets); client redirects via `/auth/status` |
| POST | `/upload`, `/suggest`; GET/POST `/settings`, `/settings/models`, `/settings/test` | auth | **switched from bearer to session** |

## Client changes

- **Remove** the `id="token"` password field and **every** `authorization: 'Bearer ' + …`
  header from `index.html`, `batch.html`, `settings.html`. Same-origin fetches send the
  cookie automatically; on `401`, redirect to `/login`.
- New **`public/login.html`** — Expedition-Log styled; renders the login form, or the
  "create first admin" form when `GET /auth/status` reports `needsSetup:true`.
- New **`public/users.html`** — admin only: list users, add (username/password/is_admin),
  remove. On load, non-admins (per `/auth/status`) are redirected to `/admin/`.
- Shared header affordance on admin pages: "Logged in as `<username>` · Logout", plus a
  "Users" nav link shown only to admins (both from `GET /auth/status`).

## Config / Docker / docs

- **Remove** `AUTH_TOKEN` from: `main.ts` startup guard, `docker-compose.yml` (root +
  `uploader/`), `.env.example`, README.
- **Add** `DATABASE_URL` (e.g. `postgres://images:<pw>@db:5432/images`).
- Root `docker-compose.yml`: add a `db` service —
  `image: postgres:17-alpine`, env `POSTGRES_USER/PASSWORD/DB`, named volume `pgdata`,
  a `pg_isready` healthcheck; `images.depends_on: { db: { condition: service_healthy } }`
  and `DATABASE_URL` wired in. Mirror minimally in `uploader/docker-compose.yml`.
- `uploader/Dockerfile` unchanged in shape (the `pg` dep is pure JS; no native build).

## Error handling

- Missing/invalid `DATABASE_URL` or unreachable DB at boot → log and exit non-zero
  (fail fast, like the old `AUTH_TOKEN` guard).
- Login failures are generic and timing-safe.
- Duplicate username on create → `409 {error:'username already exists'}`.
- All protected JSON routes return `401 {error:'unauthorized'}` when anonymous; HTML
  routes redirect to `/login`.
- Client `fetch` wrappers treat `401` as "session expired" → redirect to `/login`.

## Testing (Vitest, in-memory stores — no live DB)

- `users`: scrypt hash≠plaintext, verify true/false, params round-trip; create/list/remove;
  case-insensitive duplicate rejection; `count`.
- `sessions`: create→find round-trip; expired session not found; destroy; sweepExpired.
- `authn`: `requireAuth` allows with valid cookie, `401`/redirect without; `requireAdmin`
  rejects authors; self-delete and last-admin guards.
- endpoints: `/setup` works at 0 users and `409`s after; `/login` happy + wrong password +
  unknown user (generic error); `/logout` clears session; **regression** — `/upload`,
  `/suggest`, `/settings*` all reject anonymous requests (previously token-gated).
- `npm run typecheck` clean; existing suites still green.

## Rollout / migration notes

- No data migration needed (no existing users). On first deploy with an empty DB, the
  operator visits `/login` and creates the first admin via the setup form.
- Because `AUTH_TOKEN` is removed, the `/data`-persisted `settings.json` is unaffected;
  only the auth mechanism changes.

## Open items deferred (not in v1)

- Login rate-limiting / lockout (mark insertion point with `@ai-note`).
- Password change / reset UI for the logged-in user.
- "Remember me" / sliding sessions.
