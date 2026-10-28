# Public author badges independent of moderation pagination (#349)

Date: 2026-10-27. Risk: **High — public comment response boundary.**
Status: **OWNER APPROVED 2026-10-28** — public-row author projection implemented; isolated real-main/Postgres and browser acceptance recorded below. Final automated verification and PR review remain the integration owner's responsibility. No historical rewrite or deployment is authorized.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Root cause and outcome

The supplied real-main/Postgres reproduction is accepted evidence: 500 older approved reader
comments on story A cause a newer author reply on story B to be returned with `isAuthor:false`.
`server.ts:1864–1873` builds an author-id set through site-wide `commentsAdmin.list('approved')`,
which stops at the oldest 500. Its claim that the public store lacks an author flag is obsolete:
`comments.ts:158,248–256` already selects and explicitly projects `isAuthor`.

An approved reply actually returned for a story must retain its stored author flag regardless
of other stories' sizes. Anonymous GET must never call the moderation store. This does **not**
change the existing 500-comment public response cap for one story, public pagination, ordering,
name policy, or whether an off/closed story's approved comments remain readable.

## Minimal contract and affected callers

- In `uploader/src/comments-public.ts`, remove `PublicCommentsOptions.isAuthorIds` completely.
  Remove the associated lookup. Serialize the returned public store record through the existing
  explicit `toPublic` projection using `c.isAuthor` (prefer `toPublic(c, postedLocale)` with the
  flag read inside it so callers cannot substitute a second source of truth).
- Remove the complete `isAuthorIds` wiring and stale comment in `uploader/src/server.ts`.
  No replacement admin scan, enlarged cap, cache, new endpoint or schema change.
- Keep the explicit JSON allow-list exactly `{ id, authorName, body, createdAt, isAuthor,
  postedLocale }`. Do not spread a database/public/admin record into the response. Keep
  `CommentStore.listApproved(tk, locale)`'s explicit public projection and approved-only filter.
  `CommentAdminStore` and `AdminComment` remain separate, admin-only contracts.
- Update the old route test at `test/comments-public.test.ts:154–163`: it currently creates a
  **reader** row in the public memory store and an independent author-labelled row in the admin
  store with the same id. That intentionally contradictory fixture must no longer pass. Create
  the author reply through the public store's actual author-reply operation for memory coverage;
  use both real stores against the same Postgres table for the end-to-end moderation path.
- Migrate any `toPublic`/options test callers, without leaving a deprecated option or alias.
  `comments.ts` needs no production behavior change for this fix. #274 owns author display-name
  identity and its signature migration; use whichever approved signature is integrated.

## Security invariants and misuse cases

Public GET still has no session preHandler, returns approved rows only for a published pair,
uses no-store, and never exposes email, status, sender hash, translation key or user identity.
Public POST cannot forge `isAuthor`: the existing store insert uses literal `false`, and body
extras never control it. The badge comes from a trusted persisted flag, not matching a name or
cookie. Pending/rejected/spam rows remain private even if their flag is true. Plain-text
rendering and sanitized errors remain unchanged.

## Verification after approval

1. Route fixture with 501+ approved rows across stories: 500 older rows on A, newest approved
   author reply on B. GET B returns `isAuthor:true` and exactly the public keys; ordinary reader
   rows remain false. This distribution is essential: putting all 501 on B tests the separate
   intentional public cap instead of this defect.
2. Supply an admin store whose `list` spy throws: GET B still succeeds and the spy is never
   called. Repeat without an admin store; the public store flag still wins. No session lookup.
3. Real Postgres integration: create rows on published A/B, reply via authenticated
   `/moderation/comments/:id/reply`, then GET B anonymously and with an admin cookie. Both
   return the same flagged public shape; pending fixtures and private fields are absent.
4. POST supplied `isAuthor:true` still creates a pending reader row with stored false. Retain
   existing public cap, both-locale merge, closed-thread and unknown/draft 404 regressions.
5. Runtime smoke: newest owner reply displays the localized Author badge after the large
   cross-story fixture. Run full affected uploader tests/typecheck with `TEST_DATABASE_URL`;
   don't call skipped integration coverage a pass.

## Runtime acceptance recorded 2026-10-28

The actual `uploader/src/main.ts` ran on `127.0.0.1:33449` against disposable Postgres 18
database `swl_349_dev` (separate from `swl_349_test`). All writable paths and `SITE_APP_DIR`
were checked under this issue's worktree. An authenticated `POST /rebuild` returned 200 and
produced release `1793188974811-73684-0000`, with four published locale entries and 15 pages.
Vite reported its existing large-chunk warning; no standalone build or automated suite was
run by the runtime-proof worker.

- Seeded **505 older approved reader comments on story A**, then created a real reply on
  story B through authenticated `POST /moderation/comments/:id/reply` (201). The moderation
  list still returned its oldest 500 without this reply; public GET B returned the reply
  with `isAuthor:true`, its reply-time admin name, and the unchanged six-key allow-list.
- Anonymous and admin-cookie public responses matched. Two ordinary DE/EN reader rows
  remained false; pending/rejected/spam fixtures with stored true flags stayed private.
  Reader POST supplying `isAuthor:true` and email still stored pending/false/null.
  Story A returned exactly its oldest 500 in merged-locale chronological order.
  Unknown/draft keys remained 404; disabling comments retained the approved thread and
  refused POST with 409.
- **Injected faults, not naturally occurring failures:** a real PostgreSQL
  `ACCESS EXCLUSIVE` lock on `sessions` demonstrably blocked a guarded session query
  (`wait_event_type=Lock`, `wait_event=relation`), while public GET with the same real
  admin cookie returned 200 and the author flag. Separately, temporarily renaming the
  disposable `comments.email` column made the real moderation listing return a sanitized
  500; public GET was unchanged. The column was restored and moderation recovered to 200.
  This second probe simulates a moderation-only query failure, not a privilege failure.
- Managed Chromium (`relay:false`) loaded the actual rebuilt DE and EN story routes at
  desktop 1440×1000 and mobile 390×844. Each showed the localized **Autor / Author** text
  badge and author styling, three approved rows, no private fixture, and no horizontal
  overflow. This is focused comment-island proof, not a whole-site accessibility audit.

Sanitized evidence: `.issue-runtime/author-projection-proof.json`; four retained captures
under `.issue-runtime/screenshots/author-badge-{de,en}-{desktop,mobile}.png`.
Synthetic database records are removed after capture, services/tabs stopped, and static
release/screenshot evidence retained. No owner data, live slug or deployed instance changed.

## Dependencies, documentation and recovery

Land before #350 changes `CommentAdminStore.list` to a paginated result. #349 deliberately has
**no dependency** on that admin interface after this cutover; #350 must not reintroduce one.
#367 reply-draft preservation and later #396 load sequencing do not change the public contract.
No implementation of these prerequisites is duplicated here.

Implementation reconfirms `SECURITY.md` Public comments' exact key set and approved-only rule,
and adds that author flags come from each approved public-store row, never an admin listing.
Update the existing comments spec's author-badge implementation note; no new privacy policy.

Code-only rollback retains data. Reverting this fix restores missing badges after 500 global
approvals and the unnecessary anonymous admin-table scan; prefer roll-forward rather than
changing persisted `is_author` values. No data migration or restoration is warranted.

**Exact owner approval requested:** “Approve #349: derive public author badges from each approved
public-store row through the unchanged explicit JSON allow-list, remove the admin-list lookup,
and retain the existing public cap, permissions, privacy and verification contract.”
The owner approved this contract on 2026-10-28; runtime acceptance is recorded above.
