# Implementation prompt — priority-high findings from the 2026-09-03 CMS review

Paste the block below into a fresh Claude Code session in this repo. It covers the four
`priority-high` issues filed from the review: **#105, #106, #107, #108**. The issue bodies were
verified against the source before filing and contain file:line evidence, a scenario, and a
suggested fix — the implementer should not need to rediscover any of it.

---

## The prompt

> You are the **architect** for this batch. You own decomposition, cross-slice contracts,
> integration and final verification. Sub-agents do the reading and editing. Optimise for
> **minimum tokens**: read issues, not files; delegate slices with exact file:line targets so
> workers open only the ranges they change; never run the full test suite mid-flight.
>
> **Scope:** the four `priority-high` issues #105, #106, #107, #108 — nothing else. Related
> lower-priority items are mentioned inside those issues as "also in this module"; **skip them**
> unless the fix is a one-liner on a line you are already editing.
>
> **Read first (you, not a worker):** `CLAUDE.md` Golden Rules 1–4, 8, 11 and the
> "Change Risk" table; then `issue://105`, `issue://106`, `issue://107`, `issue://108`. Do not read
> `ARCHITECTURE.md` or `SECURITY.md` in full — grep them only for the sections each issue names.
>
> **Branching:** one branch per issue off `origin/dev`, `feature/<n>-<slug>`, worktrees for the
> parallel ones. `git fetch origin && git worktree add ../<slug> -b feature/<n>-<slug> origin/dev`.
> Conventional commits, `Closes #<n>`. Do not push; do not open PRs unless asked.
>
> ### Dependency graph and dispatch
>
> Independent → run in **one** `task` batch, four workers, each in its own worktree:
>
> | Issue | Worker slice | Files it may touch | Risk class |
> |---|---|---|---|
> | #105 | editor regressions | `uploader/public/editor.html`, `uploader/test/admin-pages.test.ts` (+ a new DOM-level test file) | Normal |
> | #106 | write-by-identity in `pgPostStore` | `uploader/src/posts.ts`, `uploader/src/db.ts`, `uploader/src/server.ts` (PUT 404 only), `uploader/test/pg.integration.test.ts`, `uploader/test/posts.test.ts` | **High** (schema + slug contract) |
> | #107 | backup column fidelity | `uploader/src/backup.ts`, `uploader/test/backup.integration.test.ts`, `ARCHITECTURE.md` (the "full column fidelity" sentence) | Normal |
> | #108 | trustProxy / limiter / compose port | `uploader/src/server.ts` (Fastify options + login handler order + `/users/me/password`), `uploader/src/rate-limit.ts`, `docker-compose.yml`, `SECURITY.md`, `uploader/test/server.test.ts`, `uploader/test/rate-limit.test.ts` | **High** (authn) |
>
> `server.ts` is shared between #106 (one route) and #108. Tell both workers up front: #106
> changes only the `PUT /posts/:tk` handler; #108 changes only the `Fastify({...})` options, the
> `POST /login` handler and the `POST /users/me/password` handler. No other `server.ts` edits.
> Merge #106 after #108 and resolve by hand if needed.
>
> ### Contracts to state in the batch `context` (decide these yourself, don't let workers negotiate)
>
> - **#105:** the model from #87 stands — `country` is **per-locale** (`PostLocale.country`),
>   so *restore* the `deCountry`/`enCountry` inputs (one per locale tab, next to the title; see
>   `git show ea17b12 -- uploader/public/editor.html` for the removed markup). Do **not** drop the
>   field from `validateForPublish`. Replace the substring assertions in `admin-pages.test.ts:373-388`
>   with a test that evaluates the editor's inline script against the real markup (jsdom is not a
>   dependency — use `node:vm` with a minimal DOM stub, or add `jsdom` as a devDependency only if
>   the stub exceeds ~60 lines) and calls `populateForm(fixture)` then `buildPayload()` once.
> - **#106:** write by `(translation_key, locale)`. `upsertDraft`: `UPDATE … WHERE
>   translation_key=$1 AND locale=$2` when `existing` is set, INSERT only for new pairs, both
>   writes inside one transaction on a checked-out client. Let `posts_locale_slug_idx` raise
>   23505 and map it to `PostError('duplicate_slug')` — remove the `DO UPDATE` across keys
>   entirely. Add `CREATE UNIQUE INDEX IF NOT EXISTS posts_tk_locale_idx ON posts
>   (translation_key, locale)` in `db.ts`'s additive-migration section, **preceded by** a
>   migration that logs (not deletes) any existing duplicate `(translation_key, locale)` rows
>   and skips index creation if there are any — Golden Rule 3 forbids an automatic delete.
>   `PUT /posts/:tk` → 404 when `existing` is null. Keep the memory store's behaviour identical
>   (it already writes by key) and add the pg integration test named in the issue.
> - **#107:** add `categories, tags, scheduled_at` to both column lists, bind arrays as
>   `$n::text[]`, `DUMP_VERSION = 4`, allow-list `[1,2,3,4]`, restore of v≤3 dumps leaves the
>   three columns at their defaults. Add the `REPEATABLE READ` transaction around the five
>   SELECTs. Extend the integration test to set and assert all three. Add a unit test that
>   compares the dump column list against `information_schema.columns` for `posts` when
>   `TEST_DATABASE_URL` is set.
> - **#108:** `trustProxy: 1`; compose `"127.0.0.1:3000:3000"`; move the
>   `accountLimiter.isLocked` check **before** `verifyPassword` in `POST /login`; add an
>   account-scoped limiter (same shape as `accountLockoutLimiter`, keyed on the session's user id)
>   to `POST /users/me/password`. Do **not** redesign the lockout (that is #109). Update the
>   `@ai-warning` at `server.ts:110-113` and the SECURITY.md port/rate-limit paragraphs. Test:
>   two requests with different `X-Forwarded-For` first entries from one socket must share a
>   bucket under `trustProxy: 1`.
>
> ### Worker instructions (put in every task)
>
> - Read only the issue (`issue://<n>`) and the line ranges it cites, plus the immediate
>   surrounding function. Do not read whole files; `uploader/src/server.ts` is 1,276 lines and
>   `editor.html` is 1,105 — open ranges.
> - Skip formatters, linters, `astro check` and the project-wide suite. Run **only** the test
>   file(s) named in your slice (`npx vitest run test/<file>`), plus `npx tsc --noEmit` once at
>   the end. Integration suites need `TEST_DATABASE_URL`; if it is unset, say so explicitly in
>   your report instead of claiming they passed.
> - Report back: files changed, the test commands you ran with their pass/fail counts, and any
>   deviation from the contract above with the reason.
>
> ### After the batch (you)
>
> 1. In each worktree: `npx tsc --noEmit` and `npm test` in `uploader/`. If `TEST_DATABASE_URL`
>    is available, run the integration suites for #106 and #107 — they are the only proof those
>    two fixes work.
> 2. Smoke #105 by hand: `npm run dev` in `uploader/` (needs `DATABASE_URL`), open
>    `/admin/editor.html?tk=<existing>` and a new post, confirm the form fills and Save Draft
>    succeeds. This is a UI regression; a passing unit test is not sufficient evidence.
> 3. #106 and #108 are **High** risk: add a dated note to
>    `docs/superpowers/specs/` (one file, both issues) stating the invariant, the migration
>    behaviour on duplicates, and the rollback (drop the new index / revert `trustProxy`).
> 4. Report per issue: branch name, commit hash, tests run, anything left open.
>
> Do not touch #109–#145.
