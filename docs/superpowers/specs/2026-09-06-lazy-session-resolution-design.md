# Session resolution only on routes that need it (issue #129)

**Date:** 2026-09-06 · **Risk:** high (authn/sessions, blog serving path) · **Size:** medium

## Decision

1. **The global `onRequest` session hook is gone.** `buildServer` no longer resolves the session
   cookie for every request. `req.authUser` is still decorated (`null` by default) but is only
   populated by an auth preHandler on the route that declares one.
2. **`createAuthn(users, sessions)` in `authn.ts` returns the three preHandlers** a route can
   declare: `optionalAuth` (resolve the cookie if present; never refuse), `requireAuth`
   (resolve, then 401 when anonymous) and `requireAdmin` (resolve, then 401 / 403). `requireAuth`
   and `requireAdmin` keep their names and their exact status semantics; the only change is that
   they do the lookup themselves instead of reading a field the hook filled.
3. **Routes that read `req.authUser` without refusing anonymous callers declare
   `optionalAuth`**: `GET /auth/status` (the admin pages' "who am I"). Any future route that
   reports different things to a session than to an anonymous caller (e.g. `/health`'s
   admin-only disk figure, #132, which lives on `dev` and is not on this branch) declares it too.
4. **Nothing else touches the session store per request.** The public blog (`/*`), the image
   host, the `/map/*` basemap, the `/admin/*` static pages, `/login`, `/setup`, the legacy
   redirects and the not-found handler run zero session queries — with or without a cookie.

## Why

`app.addHook('onRequest', …)` awaited `loadUser` on **every** request, and `pgSessionStore.find`
queries Postgres whenever a `sid` cookie is present. The owner's cookie has `path=/` on the public
host (after Phase 4's DNS cutover by construction: admin and blog share the domain), so while
Postgres was down or hung every blog page and image *they* loaded returned
`500 {"error":"internal server error"}` and logged a `console.error` — while anonymous readers were
fine. That contradicted the stated design that blog serving is DB-independent
(`/health`'s rationale, `SECURITY.md` *Single app container*) and made an outage confusing to
debug from the one browser that would be used to debug it. It also cost a Postgres round trip on
every cookie-bearing public request for nothing: the blog never reads `req.authUser`.

The alternative in the issue — catch store errors in `loadUser` and treat the request as
anonymous — was rejected: it keeps the DB on the public request path (a *hung* Postgres would
still stall every cookie-bearing blog request until the query timed out), and on auth routes it
would turn "database down" into "401 — you are logged out", which sends the admin to a login form
that cannot work either. Not resolving what nobody reads removes the dependency instead of
masking it.

## Trust boundaries

- **Unchanged:** which routes are anonymous, author-level or admin-only. Every route that had
  `requireAuth` / `requireAdmin` keeps it; the guard now performs the lookup, so a guarded handler
  still sees a fully resolved `req.authUser` before it runs.
- **Unchanged:** the session store failure mode on guarded routes. A rejected `sessions.find` or
  `users.findById` propagates out of the preHandler to the global error handler → sanitized 500,
  logged once server-side. Failing closed (no session ⇒ no access) is preserved; a store failure
  is never interpreted as "anonymous".
- **New invariant:** a request to a route without an auth preHandler never calls `sessions.find`
  or `users.findById`, regardless of cookies. This is what makes blog serving DB-independent.
- `req.authUser` is `null` on any route that declares no auth preHandler. A handler that reads it
  without declaring one is a bug: it would treat every caller as anonymous. There are two ways a
  reviewer catches that — the field is only ever assigned inside `createAuthn`, and the route
  tests for such a handler assert on the session-dependent output (as #132's `/health` test on
  `dev` does).

## Misuse / failure cases

- **Postgres down, owner browses the blog with a live cookie** → 200s from the release on disk,
  no log lines; `/admin/*` pages still load and their `/auth/status` call fails (500) → the
  page redirects to `/login`, whose `POST` fails the same way. That is the honest picture: the
  CMS is down, the blog is up.
- **Postgres down, `curl -b sid=… /posts`** → 500 (unchanged from before). Not 401: the caller
  may well be authenticated, and the server does not know.
- **Forged or expired cookie on a public page** → served as anonymous with no lookup at all.
  Before, the same request cost a `sessions.find` that returned nothing.
- **A handler reads `req.authUser` without a guard** (the drift case) → it sees `null` for
  everyone. Not a privilege escalation — the failure direction is *less* access — but a silent
  functional regression; see the invariant above for how it is caught.
- **`/users/me/password`** keeps `[limitAuth, requireAuth]`: the per-IP limiter now runs before
  the session lookup, so a flood of cookie-bearing requests is throttled before it costs a query.

## Rollback

Revert the commit: the hook returns and every route sees `req.authUser` populated again. No
schema or data involved.

## Tests

- `uploader/test/authn.test.ts`: `requireAuth` / `requireAdmin` status semantics unchanged
  (401 / 403 / 200) with the guards resolving the session themselves; a route without a guard
  never calls `sessions.find` even when a cookie is sent; a rejecting session store surfaces as
  an error from the guard (never as anonymous).
- `uploader/test/server.test.ts`: with a session store whose `find` rejects, a cookie-bearing
  request for a public blog page, an image-host miss, an `/admin/*` static file and the blog 404
  page all succeed exactly as without the cookie and log nothing, while `/auth/status` and a
  guarded route on the same server fail with the sanitized 500.
