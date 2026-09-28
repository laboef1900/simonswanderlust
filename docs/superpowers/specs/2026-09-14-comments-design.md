# Reader comments on trip reports (issue #203, epic #202)

**Date:** 2026-09-14 · **Risk:** high (first public write surface, first reader-authored durable
data, untrusted text on public and admin pages, schema + dump change) · **Size:** large ·
**Status:** design only — **awaiting explicit owner approval** (`needs-human` on #203).
No schema, route, UI or `DUMP_VERSION` change lands with this document. Implementation of every
sibling (#204, #206, #205, #208, #207) is blocked until the owner records approval below.

## Problem

Published trip reports have no way for a reader to leave a comment. The 2026-06-11 redesign
(`2026-06-11-blog-redesign-design.md` §7) deferred comments with Giscus as the candidate. Since
then the stack became a self-hosted Fastify + Postgres app that already serves the blog from one
`app` container, and `PRODUCT.md` Principle 4 forbids third-party runtime services. The map
already self-hosts PMTiles so a story page makes zero third-party requests; a GitHub widget would
reintroduce foreign script, GitHub accounts (which excludes most readers of a DE/EN travel journal)
and a referrer leak on every story page.

Adding comments changes the risk profile: the app gains **untrusted writers** (every other write
surface is session-gated), Postgres stores **reader data** (`CLAUDE.md` says raise ASVS to L2 when
that happens — see the exception record), and reader text reaches the public page and the admin
UI. `CLAUDE.md` *Change Risk* classifies this as **high risk**: written spec, trust boundaries,
misuse cases, explicit invariants, human approval, rollback/containment.

## Decisions

Each decision records the rejected alternative and why. These are locked here so the siblings do
not re-litigate product behaviour.

1. **Self-hosted in the app's own Postgres, served by the existing `app` container.**
   *Rejected:* Giscus (and Utterances, Disqus, Isso, any third-party host) — third-party JS on
   every story page, GitHub accounts as a precondition to comment, referrer leak, and a direct
   violation of `PRODUCT.md` Principle 4.
2. **ASVS 5.0 L1 with an explicit recorded exception** (record below), relying on the epic's
   compensating controls. *Rejected:* raising the target to L2 — the L2 delta is dominated by
   authentication, session and credential requirements for a user population that does not
   exist here (no reader accounts, decision 3); verifying against it would cost the single owner
   real effort for requirements with nothing to apply to.
3. **What is stored: `id`, `translation_key`, `posted_locale`, `author_name`, `body`, `status`,
   `is_author`, `created_at`. Nothing else.** No email, no website, no raw IP, no IP hash, no
   user-agent. Rate limiting is **in-memory only**, the same shape as `/login`
   (`rate-limit.ts`, #109 bounded maps). *Rejected:* an optional email for reply notifications —
   there is no mailer and adding one is an epic non-goal; storing an email with no use is
   personal data with no reader benefit. *Rejected:* a keyed HMAC of the IP for bulk-reject — it
   is still IP-derived personal data at rest; hold-for-moderation plus `spam` already gives the
   admin the tool.
4. **One thread per `translation_key`, visible on both locales.** `posted_locale` is stored so
   the island can label a comment written under the other locale; form copy is localized.
   *Rejected:* per-locale threads — the two rows are one story; splitting the thread halves an
   already small readership and doubles moderation for the same content.
5. **Hold-for-moderation.** `POST` creates a row with `status = 'pending'`; public `GET` returns
   `approved` only; admin actions are `approve` / `reject` / `spam` / `delete`. An **author reply**
   posted from the admin moderation page is auto-approved and stored with `is_author = true`.
   *Rejected:* post-moderation (publish immediately, delete on report) — one admin, no on-call;
   abuse could sit on a public page for days. *Rejected:* no author-reply path — the owner would
   have to comment as an anonymous reader and then approve it, losing the `is_author` marker.
6. **Runtime, never baked.** The static story page hosts a small island that `GET`s JSON from
   Fastify; a comment MUST NOT spawn `astro build`, take `workLock`, or trigger a rebuild.
   *Rejected:* baking approved comments into the release with a debounced rebuild — every
   approval becomes a multi-minute build under the work lock, competing with Publish and encodes
   (#95), and a moderation burst queues builds. The runtime read path is bounded (decision 9
   caps, no session lookup) and the static article stays up when it fails (misuse 12).
7. **Defaults: `settings.commentsEnabled: false` (global kill switch); `posts.comments_enabled:
   true` per post.** The per-post flag is a **`PostShared`** field written on both locale rows
   like `date` / `region` (not a `PostLocale` field; see #87). Fail closed: global off OR per-post
   off → form hidden, `POST` 409, approved comments still listed. *Rejected:* per-post default
   off with no global switch — no single containment lever, and the owner would have to opt in
   twenty stories one by one. *Rejected:* global default on — a public write surface must be an
   explicit act of enablement (Phase 4 UI), never a side effect of deploying the schema.
8. **CSRF: public `POST` checks the `Origin` header (fallback `Referer`) against the origin of
   `PUBLIC_BASE_URL` by origin equality — never a prefix match.** Missing `Origin` **and**
   `Referer` → 403. *Rejected:* a per-request CSRF token — the story page is a static file and
   cannot mint one; a token fetched at runtime would just be another Origin-gated request.
   *Rejected:* `SameSite` cookies as the control — there is no cookie on the public route.
9. **Output safety: store plain text only, render with `textContent`.** `author_name` and `body`
   are NFC-normalized, `\p{C}` stripped (`cleanText` shape, #133), length-capped
   (name 1–80, body 1–2000) at the boundary; the island paints them with `textContent` /
   `document.createTextNode`, the admin UI likewise — never `innerHTML`, never `set:html`. No
   markdown, no autolink. *Rejected:* a Markdown subset via `rehype-sanitize` — that path is
   load-bearing for the author's body (#124, #91); feeding it anonymous input doubles its attack
   surface for bold text, and links in reader text are a spam magnet.
10. **Session isolation: public comment routes declare no authn preHandler; admin routes
    `requireAdmin`.** `GET /comments` and `POST /comments` never call `sessions.find` (#129).
    Every mutating moderation route, the author reply and the enablement flags are
    `requireAdmin`. *Rejected:* `optionalAuth` on the public routes so an admin could see pending
    comments inline — it puts Postgres session lookups back on the public story path (#129) and
    makes a forged `sid` able to 500 the island. *Rejected:* `requireAuth` (author-level) for
    moderation — an approved comment is public content, and publishing what the public sees is
    admin-only (`SECURITY.md` §Authorization reversibility test).

## Requirement exception: ASVS L1 kept while storing reader data

`CLAUDE.md` (*Security verification target*): "Raise to L2 if the app ever gains multi-tenant
accounts or stores reader data." Decision 3 stores reader-authored data, so this exception is
recorded next to decision 2 per *Requirement Language and Exceptions*.

| Field | Record |
| --- | --- |
| **Waived rule** | `CLAUDE.md` *Security verification target*: raise to ASVS 5.0 L2 when the app stores reader data. Comments are verified against **ASVS 5.0 L1**. |
| **Reason** | The only reader data is a self-chosen display name and a comment body, both voluntarily submitted for publication. No accounts, credentials, sessions, email, IP or device data exist for readers, so the L2 delta (authentication, session management, credential storage for a second user population) has nothing to apply to. |
| **Risk** | Stored XSS through reader text on the public page or in the admin UI (admin-session impact); spam/abuse volume filling the moderation queue or disk; a pending comment leaking before moderation; reader data in `/data/backup/db` dumps outliving its purpose; CSRF-driven posting from a third-party page. |
| **Compensating controls** | No accounts, no email, no persisted IP (D3); hold-for-moderation, nothing public until an admin approves (D5); `Origin`/`Referer` origin-equality check (D8); bounded in-memory per-IP limiter plus honeypot (misuse 1); plain text at rest and `textContent` on every surface (D9); no session lookup on public routes (D10); admin deletion as erasure (`delete` removes the row; the next dump no longer contains it); global kill switch off by default (D7). |
| **Approver** | Simon (owner). **Not yet approved** — this spec is not effective and no sibling starts until the owner records approval here (name + date) or removes `needs-human` on #203. |
| **Review / expiry** | Review by **2027-03-14** (six months) or earlier at the first of: reader accounts, email/notifications, any comment data returned to a non-admin beyond `approved` rows, or a non-trip surface gaining comments. Each re-opens the L2 question. |

## Trust boundaries

- **Unauthenticated internet → `POST /comments`** (write) and **`GET /comments`** (read `approved`
  only). Fully untrusted. Validated immediately; the only durable effect of a `POST` is one
  `pending` row. Neither route declares an authn preHandler; a `sid` cookie is ignored.
- **Admin session → moderation, author reply, enablement flags.** `requireAdmin` on every
  mutating route and the pending list.
- **Author session (`requireAuth` without admin) → no comment powers.** An approved comment is
  public content; publishing what the public sees is admin-only (`SECURITY.md` §Authorization).
- **Comment body and name are untrusted at rest, in dumps, in admin HTML and in the public
  island.** Same class as author body HTML but with a stricter allow-list: none. Every surface
  paints them as text.
- **`/data/backup/db` dumps contain comment bodies** (content of record, unlike `post_revisions`
  and `import_jobs`). A dump is as sensitive as the comments in it.
- **Unchanged:** every existing route's authz; blog static serving never touches the session
  store or the `comments` table.

## Misuse cases

Phase 2 (#206) and 3b (#208) write their tests from this table without inventing behaviour.

| # | Case | Required handling |
| --- | --- | --- |
| 1 | Spam flood | Bounded per-IP limiter (`rate-limit.ts` shape, #109 caps) → 429; honeypot field filled → **204**, empty body, no row, no log; every accepted comment is `pending` |
| 2 | XSS in name or body | Plain text at rest (D9); island and admin UI paint with `textContent`, never `innerHTML` (#131 username lesson) |
| 3 | CSRF from a third-party form | `Origin` (fallback `Referer`) must equal `PUBLIC_BASE_URL`'s origin; missing both → 403; mismatch → 403 |
| 4 | Enumerate unpublished `translation_key`s | `GET` and `POST` → 404 unless a **published** pair exists for the key; same response for unknown and unpublished keys |
| 5 | Pending leak via admin cookie on a public route | No session lookup on `GET`/`POST /comments`; the response never depends on cookies |
| 6 | `javascript:` / HTML in body painted with `innerHTML` | Forbidden by construction in the island (`textContent` / `createTextNode` only); tests pin it |
| 7 | Comment outlives a deleted post | `pgPostStore.remove` deletes comments in the same transaction as revisions (#137 shape: separate statements, not a data-modifying CTE) |
| 8 | Dump v5 unrestorable / v4 restore mishandles comments | `readDump` allow-list widened in the same PR as `DUMP_VERSION`; v1–v4 restore leaves `comments` empty (table exists, zero rows) — it does not `DELETE` and then skip |
| 9 | Resource exhaustion (1 MiB body, 10k comments per `GET`) | Body-size cap → 413; field caps name 1–80 / body 1–2000 → 400; `GET` hard cap on rows returned |
| 10 | Author (non-admin) approves their own sockpuppet | `requireAdmin` on every mutating moderation route and the author reply → 403 |
| 11 | Global or per-post off still accepts `POST` | 409 `comments_disabled`; the island hides the form; approved comments still listed |
| 12 | Story page 500s when Postgres is down | The static article is served from the release on disk; the island shows an i18n error string; `GET`/`POST` answer a sanitized 500 |

## Invariants (tests in later issues pin these)

From the epic:

1. A `pending` (or `rejected` / `spam`) comment is never in a public response, a static file, a
   log line, or an RSS feed.
2. Public comment routes never resolve a session (#129). A forged `sid` on `GET`/`POST /comments`
   costs no lookup and cannot 500 the story page.
3. `pgPostStore.remove` deletes comments with the post, in the same transaction as revisions
   (#137 shape: two statements, not a data-modifying CTE).
4. Dump **v5** includes `comments`. v1–v4 dumps remain restorable and leave `comments` empty.
   `readDump`'s version allow-list is widened in the same PR as `DUMP_VERSION`.
5. Comment bodies are stored and returned as plain text. The island paints them with
   `textContent` / `document.createTextNode`, never `innerHTML` / `set:html`.
6. Global off OR per-post off → form hidden, `POST` 409 `comments_disabled`, existing
   **approved** comments still listed.
7. Approval is admin-only. Authors (`requireAuth` without admin) cannot approve, reject, mark
   spam, delete, or reply as author.

Added by this issue:

8. Honeypot filled → **204** with an empty body, no row, no log of the body. Never 400 — that
   trains the bot.
9. `author_name` 1–80 and `body` 1–2000 characters, both NFC-normalized and `\p{C}`-stripped
   (#133 `cleanText` shape) before the length check. Empty after stripping → 400.
10. `posted_locale` ∈ {`de`, `en`}, otherwise 400.
11. No `console.log` / stdout of comment body, name, or `translation_key` on the public path
    (`translation_key` is not secret; bodies are reader data and the rule is one rule).
12. A comment never spawns `astro build`, takes `workLock`, or triggers a rebuild.
13. Rollback is `settings.commentsEnabled = false`: `POST` 409s, the form hides, existing
    approved comments remain listed. Dropping the table is **not** the rollback.

## Recovery and rollback

- **Containment:** flip `settings.commentsEnabled` off (admin settings page from Phase 4; the
  JSON settings store by hand before that). Approved comments stay visible, no new ones arrive.
- **Per post:** `comments_enabled = false` on the pair (Phase 4 editor checkbox).
- **Bad data:** admin `delete` on the row; it is gone from the next `GET` and the next dump.
- **Postgres down:** the static article serves from disk; the island degrades to an i18n error
  string; nothing on the public path retries or queues.
- **Code rollback:** revert per phase. The `comments` table stays (Golden Rule 3); a v5 dump
  restores into any build that knows v5.
- Dropping the table, `TRUNCATE`, or deleting `/data/backup/db` is never a rollback step.

## Delivery plan (1:1 onto the siblings; one PR each, no extra phases)

| Phase | Issue | Work | Depends on | Doc edits assigned |
| --- | --- | --- | --- | --- |
| 0 | #203 (this) | This spec; `CLAUDE.md` *Project Status* lists comments as remaining | human approval | `CLAUDE.md` (status; link to this spec) |
| 1 | #204 | `comments` table, store, `DUMP_VERSION` 5 + `readDump` allow-list, delete-with-post in `pgPostStore.remove`, `settings.commentsEnabled` + `PostShared.comments_enabled` flags | #203 | `ARCHITECTURE.md` (schema, dump v5, comments are not in the build) |
| 2 | #206 | Public `GET`/`POST /comments` with Origin check, limiter, honeypot, caps, 404/409 rules, no authn preHandler | #204 | `SECURITY.md` (public write surface, Origin check, rate limit, no session on public comment routes, output safety); `CLAUDE.md` (high-risk bullet, PII sentence, ASVS decision pointer) |
| 3a | #205 | Admin moderation page (`textContent` rendering), `approve`/`reject`/`spam`/`delete`, author reply with `is_author` | #204 | `PRODUCT.md` (capability; Principle 4 still holds); `uploader/README.md` (admin page) |
| 3b | #208 | Story-page island: `GET` + form, `textContent` painting, i18n strings, a11y, Postgres-down degradation, form hidden when disabled | #206 | `site/src/i18n/ui.ts` completeness (no hardcoded strings) |
| 4 | #207 | Enablement UI: global switch on the settings page, per-post checkbox in the editor | #204 | `docs/authoring-workflow.md` (moderation + per-post toggle) |

3a ∥ 3b after their blockers; overlap is `server.ts` route registration (merge conflicts, not
design conflicts). The `CLAUDE.md` high-risk bullet, PII sentence and ASVS decision are
deliberately deferred to Phase 2 — that is the PR that makes them true. Moving this feature to
Done in `CLAUDE.md` happens in whichever sibling lands last; it is not a phase.

## Non-goals (whole epic)

Giscus/Utterances/Disqus/Isso or any third-party host; reader accounts, OAuth, magic links;
email/SMTP notifications (no mailer exists; do not add one); nested threading, votes, reactions,
markdown/HTML, autolinked URLs; Gravatar or any third-party avatar; comments on About, home, map
or region indexes; WordPress comment import; a comments RSS feed (existing `/comments/feed` →
post RSS redirects stay); JSON-LD `Comment` markup; captcha, Akismet or any outbound spam API;
commenter edit/delete (no identity); baking comments into the static release.

## Tests (for the implementation phases)

Each misuse row and invariant gets a test in the phase that introduces its control: 1, 3, 4, 5,
9, 11 and invariants 2, 8–12 in Phase 2; 7, 8 and invariants 3–4 in Phase 1; 10 in Phase 3a;
2, 6, 12 and invariants 5–6 in Phase 3b (both DOM painting and the disabled/error states); the
enablement round-trip in Phase 4. DB-backed tests run under `TEST_DATABASE_URL` and must be
non-skipped in CI.
