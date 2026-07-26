# Implementation prompt — approved backend-rework issues

Paste the block below into a fresh Claude Code session in this repo. It covers the five issues
carrying `ApprovedByAI` as of 2026-07-26 (#63, #65, #64+#73, #70).

Everything the implementer needs is in the issue bodies — they were reviewed twice against the
code, and the second pass corrected real errors in the first. **Read the issue and its review
comments before writing code**; several findings exist only in the comments.

---

## The prompt

> Implement the approved issues from the backend-rework epic (#69) in this repo. Only work on
> issues carrying the `ApprovedByAI` label: **#63, #65, #64, #73, #70**.
>
> **Read first, in this order:** `CLAUDE.md` (the Golden Rules are binding), `ARCHITECTURE.md`,
> `SECURITY.md`, and `docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md`.
> Then read each issue with `gh issue view <n> --comments`. The AI review comments contain
> findings that are **not** in the issue bodies — treat them as part of the spec.
>
> **Work one issue per branch**, in this order:
>
> 1. **#65** — galleries: fenced block, render pipeline, body-image validation. **Do this first.**
>    It closes two holes that are live in the current codebase (unvalidated `images`, and a
>    `javascript:` URL that reaches an `<a href>` on an author-level same-origin route with no CSP).
>    Independent of everything else.
> 2. **#63** — posts list: thumbnails, search/filter/sort, bulk actions. Smallest phase (~350 LOC).
> 3. **#64 + #73** — media library, plus the `/data` free-space guard. Largest by far (~2,000 LOC
>    server + ~1,500 lines of vanilla client JS). #73's upload precondition belongs on the new
>    async upload path, so build them together. Also fold in #71's acceptance step: measure Astro
>    build peak RSS, then set `mem_limit` **and** `memswap_limit` sized as
>    `max(build, encode peak) + baseline` — not the sum, because the shared lock makes builds and
>    encodes mutually exclusive.
> 4. **#70** — duplicate post. Independent, plausibly zero server change.
>
> **#63 and #64 both touch `server.ts` and `posts.ts`** — land them in sequence, not in parallel
> worktrees.
>
> **Settle before writing #64's queue:** the shared build/encode mutex does not exist as a
> shareable primitive. `createSiteBuilder` serialises through a private closure and `SiteBuilder`
> exposes only `{build, hasRelease}`, so this means a new mutex module injected into both, plus a
> `SiteBuilderOptions` change and re-wiring in `main.ts`. Decide the priority direction explicitly:
> a build must preempt the encode backlog at the next job boundary and must never queue behind 50
> pending encodes — Publish awaits the rebuild synchronously in the UI, so getting this wrong is a
> user-visible regression, not just a bug.
>
> **Non-negotiables** (from the Golden Rules and the reviews):
> - Never rename a slug or route (Golden Rule 2, SEO contract).
> - Never wipe persistent data — no `docker volume rm`, no `DROP`/`TRUNCATE`, no deleting
>   `uploader/data`. Propose targeted `UPDATE`/`DELETE` instead.
> - All user-facing copy goes in `site/src/i18n/ui.ts` for **both** locales (completeness-tested).
> - No `any`, no `@ts-ignore`, no suppressions to force a pass. Fix the root cause.
> - Gallery URLs: compare **origins for equality**. Never prefix-match — see the `@ai-warning` in
>   the spec's §Galleries for the two working bypasses.
> - Validate at the `posts.ts` chokepoint, not only in `validateDraft` — the WXR importer calls
>   `upsertDraft` directly and would otherwise bypass validation entirely.
>
> **Verify before claiming done**, per issue:
> - `npx astro check` in `site/` (needs a reachable Postgres — `DATABASE_URL`)
> - `npm test` in whichever app changed
> - **Set `TEST_DATABASE_URL`** when touching `posts.ts`: `pgPostStore` is covered only by
>   `pg.integration.test.ts`, which is `describe.skip` without it, so a pg-only regression passes a
>   default `npm test`.
> - For visual changes, run the dev server and look at the rendered page.
>
> Commit in conventional style (`type(scope): description`). Do not push — leave commits local
> unless I ask.
>
> If you hit something the issue or spec gets wrong, say so and stop rather than working around
> it. Two review rounds already corrected several such errors; a third is likely.

---

## Not approved — do not start these

| Issue | Why not |
|---|---|
| #66 gallery polish | Blocked on #65 shipping **and** an explicit human look at a real gallery — the plain grid may suffice. |
| #75 gallery picker | Blocked on #64's `media` table. |
| #67 AI authoring | Architecture decided (Claude agent CLI, own container, non-admin drafts-only, one write per run) but no spec written yet. |
| #68 production EXIF audit | Ops task — a command to run on the server, not code. `strip-gps` stays gated on its result. |
| #71 `mem_limit` | Folded into #64 as an acceptance step (see above). |
| #72 Traefik timeouts | Host-side; Traefik's timeouts default to `0`, so verify there is a problem before changing anything. |
| #74 spec/variants.ts | Fixed in `c184ef8`; close on merge. |
| #69 | Tracking epic. |
