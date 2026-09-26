# Reader comments (design spec)

**Date:** 2026-09-14 · **Risk:** high (first untrusted-user write surface, reader data in
Postgres, public output of untrusted text) · **Size:** large · **Status:** design only —
**awaiting explicit owner approval**. No schema, route, UI or `DUMP_VERSION` change lands with
this document; the implementation issues wait for that approval.

## Why this exists

The WordPress site had comments; the Astro rebuild shipped without them. Adding them changes the
project's risk profile in three ways that `CLAUDE.md` names explicitly:

- the app gains **untrusted users** who can write (every other write surface is session-gated);
- Postgres starts storing **reader data** (names, optional email, comment text, IP-derived rate
  counters) — `CLAUDE.md` says to raise the ASVS target to L2 when that happens;
- reader text reaches **public output** on a static site whose XSS guards were built for one
  trusted author.

The blog stays static: pages are pre-rendered by `astro build`, so comments must either be baked
into a rebuild or loaded separately. The decisions below settle that and everything that follows
from it.

## Decisions

Each decision names the alternative it rejected and why.

1. **Comments are first-party, stored in the app's own Postgres.**
   *Rejected:* a third-party widget (Disqus, Commento hosted, giscus). It violates Product
   Principle 4 (no third-party runtime services), ships reader tracking to every page, and needs a
   CSP hole for foreign script. *Also rejected:* an ActivityPub/Webmention-only model — no reader
   of this blog has a fediverse site to reply from.
2. **Every comment is pre-moderated: nothing is public until an admin approves it.**
   *Rejected:* post-moderation (publish immediately, delete on report). With one admin and no
   on-call, spam or abuse could sit on a public page for days; pre-moderation makes the public
   surface admin-controlled content, which is what keeps it inside the existing trust model.
3. **Approved comments are rendered into the static page at build time**, read by a Content
   Layer loader through `loader-pool.ts`; approving or deleting a comment schedules a debounced
   rebuild (not a synchronous Publish).
   *Rejected:* a client-side `fetch` of a public JSON endpoint on every page view. It puts the
   database back on the public read path that #129 removed, needs JavaScript for content, and
   exposes an enumeration endpoint. *Rejected:* synchronous rebuild per approval — a moderation
   burst would queue N full builds under the build lock.
4. **Comment bodies are plain text only.** Stored verbatim (after `\p{C}` stripping and length
   caps), rendered with Astro's default escaping — never `set:html`, never Markdown, never
   linkified. Line breaks become paragraphs by splitting text, not by producing HTML strings.
   *Rejected:* a Markdown subset through `rehype-sanitize`. The sanitize path is load-bearing for
   the author's body (#124, #91); feeding it anonymous input doubles its attack surface for the
   sake of bold text. Links in reader text are a spam magnet anyway.
5. **Reader identity is a display name plus an optional email; no reader accounts.** Email is
   never rendered, never exported to the static output, and used only to notify the reader of a
   reply if they tick an explicit opt-in (deferred; see Scope). *Rejected:* reader accounts /
   magic-link login — a second auth population, password reset flows and session handling for
   readers, which would force ASVS L2 without exception.
6. **Submission is `POST /comments`, the single new unauthenticated write route**, rate limited
   per IP (5 / 15 min) and globally (200 / hour, bounded maps as in #109), body capped at 4 KiB of
   JSON, fields validated explicitly (name 1–80, email ≤ 254 and syntactic, body 1–2000 chars,
   `translationKey` + `locale` must name a **published** post with comments enabled). The route
   answers `202` with no comment id and no echo of the input.
   *Rejected:* accepting form-encoded posts from a no-JS `<form>` directly — see decision 7 for
   how no-JS readers are served; a second body parser on a public route is not worth it.
7. **Spam control is a honeypot field plus a server-side minimum fill time (signed timestamp
   token issued with the page), with no CAPTCHA.** *Rejected:* reCAPTCHA / hCaptcha / Turnstile
   (third-party runtime service and tracking; Product Principle 4). *Rejected:* proof-of-work in
   the browser — hurts slow devices and screen-reader users more than bots. Pre-moderation
   (decision 2) is the real control; these only keep the queue readable. The form is progressive
   enhancement: without JavaScript the page shows the "comments are moderated" note and a
   `mailto:` fallback, not a broken form.
8. **Moderation lives in a new admin page (`/admin/comments.html`) and every moderation action is
   `requireAdmin`**: approve, reject (hard delete), delete an approved comment, and toggle
   comments per post. Delete requires confirmation naming the scope (`CLAUDE.md`
   high-impact actions). *Rejected:* allowing author-level (non-admin) users to moderate —
   deletion of reader data is irreversible, and reversibility decides admin-only.
9. **Retention and privacy: pending comments expire after 30 days; rejected comments are deleted
   immediately; the IP address is never stored** — rate limiting uses the in-memory limiter and a
   pending row keeps only a keyed HMAC of the IP (rotating key, 30-day life) so the admin can
   bulk-reject one sender. Comments are included in DB backups (they are content) but the email
   column is excluded from MDX export. *Rejected:* storing raw IPs for abuse handling (personal
   data with no reader-facing benefit); *rejected:* excluding comments from backups (approved
   comments are published content and must survive a restore).
10. **Comments are per locale, not shared across a translation pair**, and off by default per
    post (`comments_enabled` false until the author opts in). *Rejected:* one thread shared by DE
    and EN — mixed-language threads under a single-language page, and the slug contract gives each
    locale its own URL. *Rejected:* on by default — turning a public write surface on for 20
    existing stories at deploy time is a scope the owner should choose post by post.

## Requirement exception: ASVS level

`CLAUDE.md` (*Security verification target*) says to raise the target from ASVS 5.0 L1 to L2 "if
the app ever gains multi-tenant accounts or stores reader data". Decisions 5 and 9 store reader
data, so this spec needs an exception, recorded here per *Requirement Language and Exceptions*.

| Field | Record |
| --- | --- |
| **Waived rule** | `CLAUDE.md` *Security verification target*: "Raise to L2 if the app … stores reader data." The comments feature is verified against **ASVS 5.0 L1**, not L2. |
| **Reason** | The only reader data is a self-chosen display name, an optional email and comment text, submitted voluntarily. There are no reader accounts, sessions, credentials or payments (decision 5), so the L2 requirements that dominate the delta (authentication, session management, credential storage for the new population) have nothing to apply to. |
| **Risk** | Disclosure of reader emails via a DB/backup leak or an admin-route bug; stored XSS from reader text; spam/abuse volume exhausting the moderation queue or disk; residual personal data in backups past its purpose. |
| **Compensating controls** | Pre-moderation (2); plain-text-only rendering with default escaping (4); emails never rendered, never in static output or MDX export, redacted from any non-admin response (5, 9); one unauthenticated route with per-IP + global limits and size caps (6); honeypot + fill-time token (7); every moderation route `requireAdmin` (8); no stored raw IP, 30-day pending expiry (9); off by default per post (10); misuse table below covered by tests. |
| **Approver** | Simon (owner). **Not yet approved** — this spec is not effective and no implementation starts until the owner records approval here (name + date). |
| **Review / expiry** | Expires **2027-03-26** (six months from drafting) or earlier at the first of: reader accounts, reply notifications by email, or any public endpoint that returns comment data — each of those re-opens the L2 question. |

## Trust boundaries

- **Reader → `POST /comments`:** fully untrusted. Validated immediately; the only effect is a
  `pending` row. Nothing the reader sends is echoed back.
- **Pending row → admin page:** untrusted text shown to the admin. Admin UI renders it with
  `textContent`, never `innerHTML` (an XSS here would run with an admin session).
- **Approved row → static build:** admin-approved but still reader-authored; escaped by Astro at
  render time. Email never selected by the loader.
- **Unchanged:** every existing route's authz; blog serving never touches the session store or the
  comments table at request time.

## Misuse and failure table

| # | Misuse / failure | Expected behaviour | Control |
| --- | --- | --- | --- |
| M1 | Script / HTML in name or body (`<script>`, `<img onerror>`, `javascript:`) | Stored as text; rendered escaped in admin (`textContent`) and on the page | D4, trust boundaries |
| M2 | Comment on an unpublished, deleted or comments-disabled post, or unknown locale | `404`, no row | D6, D10 |
| M3 | Oversized payload / overlong field / control characters | `413` / `400`; `\p{C}` stripped before length check | D6 |
| M4 | Flood from one IP | `429` after 5 / 15 min; limiter map bounded | D6 |
| M5 | Distributed flood | Global `429` after 200 / hour; moderation queue cannot exceed it | D6 |
| M6 | Bot fills honeypot or submits faster than the minimum fill time / replays a token | `202` (indistinguishable), no row | D7 |
| M7 | Anonymous or author-level call to approve / reject / delete / toggle | `401` / `403` | D8 |
| M8 | Enumerating comments or emails via API | No public read endpoint exists; admin list redacts nothing but is `requireAdmin` | D3, D8 |
| M9 | Email leaks to page, sitemap, RSS or MDX export | Loader never selects the column; export test asserts absence | D5, D9 |
| M10 | Approval burst triggers N rebuilds | Debounced single rebuild; build lock unchanged | D3 |
| M11 | Postgres down while readers browse | Blog serves the last release with its baked comments; `POST /comments` → sanitized 500 | D3, #129 |
| M12 | Postgres down during rebuild | Existing build timeout / failure path; previous release stays live | D3, #110 |
| M13 | Deleting a post | Its comments deleted in the same transaction (the #137 lesson) | Implementation |
| M14 | Restore of an older dump | Comments restored with posts; `DUMP_VERSION` bump in the schema phase makes old dumps restorable with an empty comments table | D9 |
| M15 | Reader asks for erasure | Admin deletes by HMAC'd sender or by row; next rebuild removes it from the page | D8, D9 |
| M16 | Pending queue left unattended | Rows expire after 30 days | D9 |
| M17 | Admin-page XSS via pending comment | Rendered with `textContent`; test asserts no HTML parsing | Trust boundaries |

## Scope

In: decisions 1–10 across the phases below. Out (each re-opens the ASVS exception): reply
notification emails, reader accounts, threaded replies, reactions, a public comments API.

## Phases and doc edits

Implementation is split into sibling issues that **wait for owner approval of this spec**.

| Phase | Work | Doc edits assigned to it |
| --- | --- | --- |
| 0 (this issue) | This spec; `CLAUDE.md` status lists comments as remaining | `CLAUDE.md` *Project Status* |
| 1 Schema | `comments` table, per-post `comments_enabled`, cascade on post delete, expiry sweep, backup inclusion, `DUMP_VERSION` bump | `ARCHITECTURE.md` (schema, backup contents), `SECURITY.md` (data inventory: reader data, retention) |
| 2 Submission route | `POST /comments`, limiters, honeypot/fill-time token | `SECURITY.md` (new unauthenticated route, rate limits, ASVS exception pointer), `uploader/README.md` (routes) |
| 3 Moderation | Admin page + `requireAdmin` routes, debounced rebuild | `docs/authoring-workflow.md` (moderation), `PRODUCT.md` (Pages, Capabilities) |
| 4 Rendering | Loader + escaped rendering + form UI strings in `site/src/i18n/ui.ts` | `DESIGN.md` (comments block), `ARCHITECTURE.md` (loader) |
| 5 Close-out | Move to Done in `CLAUDE.md`; re-confirm the exception | `CLAUDE.md` *Project Status* |

## Rollback

Phase 0 is documentation only. Later phases: disable comments on every post (one `UPDATE`) and
rebuild removes them from the public site without dropping data; code reverts per phase. Dropping
the table is never a rollback step (Golden Rule 3).

## Tests (for the implementation phases)

Each misuse row M1–M17 gets a test in the phase that introduces its control; DB-backed ones run
under `TEST_DATABASE_URL` and must be non-skipped.
