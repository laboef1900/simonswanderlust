# 2026-09-03 — High-risk fix notes: write-by-identity (#106) and trustProxy (#108)

Two of the four priority-high fixes from the 2026-09-03 CMS code review are **High risk** per
CLAUDE.md ("Change Risk and Required Rigor"): #106 touches the `posts` schema and the SEO slug
contract, #108 touches authentication. This note records the invariant each one introduces, how
the migration behaves on existing data, and the rollback. Branches: `feature/106-write-by-identity`,
`feature/108-trust-proxy`.

## #106 — `pgPostStore` writes locale rows by `(translation_key, locale)`

### Defect

`writeLocale` was `INSERT … ON CONFLICT (locale, slug) DO UPDATE`. A draft save whose slug had
changed (the editor re-derives the slug from the title until publish) matched no conflict target and
**inserted a second row** for the same `(translation_key, locale)`; nothing deleted the old one.
`get()` then returned an arbitrary DE row, `list()` deterministically showed the oldest, the old slug
stayed locked, and `publish()` stamped both rows published — so the site built `/rom/` **and**
`/drei-tage-in-rom/` for one translation key (Golden Rule 2 violation). The `DO UPDATE` also set
`translation_key = EXCLUDED.translation_key`, so two concurrent creates with the same slug could
re-assign a row from one pair to another.

### Invariant (new)

- **A `(translation_key, locale)` pair identifies exactly one row.** Enforced by the unique index
  `posts_tk_locale_idx ON posts (translation_key, locale)`.
- `upsertDraft` **updates by identity** (`UPDATE … WHERE translation_key = $1 AND locale = $2`) when
  the pair exists and **inserts only for new pairs**. It never sets `translation_key` in an UPDATE
  and never uses `ON CONFLICT … DO UPDATE` across keys.
- The revision snapshot and both locale writes run in **one transaction** on a checked-out client.
  The `(locale, slug)` unique index is the race-safe backstop: a 23505 on `posts_locale_slug_idx`
  is mapped to `PostError('duplicate_slug')` after ROLLBACK. The pre-write slug check is kept only
  for its friendlier message.
- `PUT /posts/:tk` returns **404** when the key does not exist. A stale tab can no longer resurrect
  a post an admin deleted meanwhile; creation goes through `POST /posts` only.
- Still **not** serialized: the `get()` → `assertNotStale` read-then-check. Two saves racing within
  the same millisecond can both pass it (single-admin deployment; the loser is recoverable from its
  revision). `SELECT … FOR UPDATE` inside the transaction is the next step if that ever matters.

### Migration behaviour on existing data

`ensureSchema` (runs on every boot) now, at the end of its additive section:

1. Selects `(translation_key, locale)` groups with more than one row.
2. If any exist, it **logs** every group to stderr with a resolution hint and **skips** creating
   the index. It never deletes rows (Golden Rule 3). The app boots; saving an affected post fails
   with `duplicate_slug` until the duplicates are resolved by hand (`DELETE /posts/:tk` drops
   every row for a key, or SQL keeping the row with the newest `updated_at`), after which the next
   boot creates the index.
3. Otherwise it runs `CREATE UNIQUE INDEX IF NOT EXISTS posts_tk_locale_idx …`.

Checked 2026-09-03: the local compose database has no `posts` rows, so the index is created cleanly
there. There is no production deployment yet (CLAUDE.md, Phase 4 pending).

### Rollback

- `DROP INDEX IF EXISTS posts_tk_locale_idx;` — the only schema change; no data is rewritten by
  the migration.
- Revert the `feature/106-write-by-identity` commit. The pre-fix code tolerates the index (it only
  ever inserted duplicates by accident), so the index may stay in place after a code rollback.

## #108 — `trustProxy: 1`, lockout before scrypt, per-account limiter on password change

### Defect

`trustProxy: true` trusts every hop, so `req.ip` became the **leftmost** `X-Forwarded-For` entry —
client-supplied even behind a correct proxy, because nginx/Traefik append rather than overwrite.
`rateLimitPreHandler` keys on `req.ip`, so the 10-per-15-min limit on `/login`, `/setup` and
`/users/me/password` was bypassable by rotating the header. `POST /login` also ran scrypt before
the account-lockout check (unbounded CPU for a locked account), `/users/me/password` had no
per-account limiter, and compose published `3000:3000` on all interfaces.

### Invariant (new)

- **Exactly one trusted hop.** `Fastify({ trustProxy: 1 })`: `req.ip` is the rightmost
  `X-Forwarded-For` entry — the one the reverse proxy appended. Client-supplied entries are ignored.
  A second proxy layer (e.g. a CDN in front of nginx) requires raising this to `2`, never to `true`.
- Port 3000 is published on **loopback only** (`127.0.0.1:3000:3000`), so the host's reverse proxy
  is the sole ingress — which is the one hop the setting trusts.
- `/login` checks `accountLimiter.isLocked` **before** `verifyPassword`.
- `/users/me/password` has an account-scoped lockout limiter keyed on the session's user id, in
  addition to the shared per-IP limiter.
- Not changed: the lockout design itself (#109), limiter persistence (in-memory, per process).

### Rollback

- Revert the `feature/108-trust-proxy` commit (`trustProxy: true`, original handler order, port
  binding). No data or schema involved.
- If a deployment sits behind two proxy hops and logins start 429-ing for everyone (all clients
  collapse onto the inner proxy's address), set `trustProxy: 2` rather than reverting to `true`.
