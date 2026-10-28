# Complete bounded moderation traversal (#350)

Date: 2026-10-27. Risk: **High — moderation/reader-erasure boundary.**
Status: **OWNER APPROVED 2026-10-28** — source implementation and regression tests added; verification is pending the integration owner's checks and isolated runtime proof. No owner-data mutation or deployment is authorized.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Evidence and scope

Accept the supplied real-app/Postgres 501-row reproduction: `CommentAdminStore.list` returns
only the oldest 500 and `comments.html` has no paging, leaving the newest row unreachable.
This defeats the comments spec's existing “admin deletion as erasure” compensating control.
Increasing the cap or reversing the sort would merely change which rows cannot be moderated.

Add complete bounded traversal through the existing store, route and UI. Retain oldest-first
order for **both** Pending and Approved; the issue permits pagination instead of newest-first.
No search, per-post filters, bulk deletion, public pagination, new statuses, schema migration,
automatic retention or change to the ASVS exception is required.

## Store and HTTP contract

Use the repository's existing limit/offset convention (`comments.ts:145–153,258–265` and media
paging), not an additional opaque cursor scheme. Keep the dedicated `CommentAdminStore` because
it carries the moderation shape; do not switch the public route to this store.

- Replace `list(status): Promise<AdminComment[]>` with
  `list(status, offset = 0): Promise<{ comments: AdminComment[]; hasMore: boolean }>`.
  Fixed page size **50**, no caller-selectable unbounded limit. Remove the old `LIST_LIMIT=500`
  behavior and migrate callers/tests together; no compatibility return-shape union.
- Validate offset in the store as a nonnegative safe integer with room to add 50 safely.
  SQL uses parameterized `status` and `OFFSET`, `ORDER BY created_at ASC, id ASC`, `LIMIT 51`.
  Return the first 50 and `hasMore = fetched.length > 50`. No full-table materialization or
  count query. Memory store uses the same timestamp/id total order and slices the same window.
  UUID tie comparison is normalized canonical UUID ordering, not locale-sensitive collation.
- `GET /moderation/comments?status=pending|approved&offset=N` defaults to pending, offset 0.
  Respond `{ comments, hasMore }`, `Cache-Control: no-store`. Offset is a single decimal integer;
  negative, fractional, exponent, repeated/non-string, overflow or otherwise invalid input → 400
  with a stable generic pagination error, before any list query. No SQL error leakage.
- `requireAdmin` runs **before** status/offset validation and every read: anonymous 401,
  non-admin 403. Existing 503 for absent store and mutation routes remain unchanged. Offset
  beyond the end is an empty page with `hasMore:false`, not a misleading 404.

Offset traversal is deterministic for a fixed dataset including equal timestamps; it is **not a
snapshot across requests**. Concurrent insertion/deletion/status changes can shift page offsets.
Restarting from page one reaches the new state; do not promise exactly-once traversal while the
queue is changing. The UI resets to page one after its own successful mutation so a removed row
cannot cause its next-page request to silently skip the shifted row. This is a deliberate simple
contract, not an attempt to solve a new concurrent snapshot-export problem.

## UI and integration contract

`uploader/public/comments.html` gains Previous / Next controls and a localized page indicator.
Previous subtracts 50; Next adds 50 only when `hasMore`. Disable impossible/in-flight controls.
A filter change resets offset to zero. A successful Approve, Unapprove, Delete, Spam or Reply
refreshes page one for the current filter; confirmation cancellation makes no mutation. If a
page becomes empty because another moderator removed its rows, keep Previous usable (or return
to page one with the same explicit empty-state behavior), never strand navigation.

Apply #367's in-memory reply-draft/focus contract to **every** paging/filter/refresh render:
retain drafts keyed by comment id across pages; restore them on return, clear only a confirmed
successful reply's own draft or successfully deleted target. No browser storage, draft API or
new persistent reader data. Paging moves focus to the new page's sensible heading/control;
a refresh preserves an extant focused field/caret per #367.

The implementation stacks on #349, #367 and #396. The existing shared loader owns one
view key `{status, offset}`; its latest-request check binds both values and failed loads
disable stale navigation as well as clearing stale row actions. There is no second loader
or request-state mechanism. User navigation retires old mutation completions, while
mutation-driven page-one resets preserve the same navigation revision so overlapping
successful writes each refresh. The inherited focus-cancellation behavior remains in place.

All added labels, empty-page and pagination-error display copy belongs to DE/EN `site/src/i18n/ui.ts`
and the existing admin copy delivery mechanism (`server.ts`'s editor-image-copy route). Keep
reader fields rendered with `textContent`, native keyboard buttons, focus visibility and the
existing scoped destructive confirmation. No unrelated moderation redesign/localization sweep.

## Affected files, dependencies and verification

Implementation touches `uploader/src/comments-admin.ts`, moderation wiring in `server.ts`,
`public/comments.html`, its existing/extracted #367 UI test seam, `site/src/i18n/ui.ts` and admin
copy delivery, `test/comments-admin.test.ts`, and Postgres integration/DOM tests.

**Order:** #349 first removes anonymous GET's `commentsAdmin.list` dependency; #367 is the
reply-draft prerequisite for UI integration; #396 then extends the shared loader's view identity.
`CommentStore.listApproved` and public `{ enabled, comments }` response stay unchanged.

Required after approval (not run here):

- Memory and Postgres: 551+ approved rows, timestamp ties crossing multiple page boundaries;
  concatenate all pages and assert every id appears exactly once in `(createdAt,id)` order,
  at most 50 per response, final `hasMore:false`. Repeat pending, empty and exact-page-size cases.
- Actual route pagination, auth-before-validation, invalid offsets and no-store. Two admin
  instances must be able to read without mutation; no pending/private record leaks publicly.
- DOM/browser: reach **oldest and newest** approved rows with Previous/Next and unapprove/delete
  them through the existing actions; verify the public runtime GET reflects removal immediately,
  without rebuilding. This tests erasure, not merely whether a Next button exists.
- Delete/approve rows at page boundaries, reset to page one and traverse again without a hidden
  shifted row. Exercise an externally emptied last page and return navigation.
- Type a reply on page one, navigate away/back and moderate another row: draft survives with
  #367 focus behavior. Include status+offset identity in the later #396 ordering/failure tests.
- Full affected uploader suite/typecheck, real Postgres integration, site i18n tests/typecheck
  for added copy, and browser keyboard smoke. Never report skipped DB tests as coverage.

Source coverage is in `uploader/test/comments-admin.test.ts` (memory and optional real
Postgres contracts, route authorization/validation and public removal without a build)
and `uploader/test/admin-actions-dom.test.ts` (paging, drafts, mutation resets, cancellation,
empty pages and status/offset response ownership). No automated checks or runtime proof
were run by the implementation worker; these are verification requirements, not results.

## Documentation, containment and exact owner decision

Implementation updates `SECURITY.md` moderation/Public comments to state bounded admin paging
and complete erasure reachability, while reconfirming the unchanged public cap/key set and
admin-only access. Update the existing comments spec and authoring instructions for navigation.
The old UI's “next rebuild” deletion wording is false for runtime comments; the touched deletion
confirmation must describe immediate disappearance on the next public read, using localized copy.
No reader-content edits, database cleanup or new privacy exception.

Rollback code only, leaving comments untouched. An old server/UI restores the 500-row limitation;
that is not acceptable long-term erasure containment. Keep the working paginated version or
roll forward before using moderation for an outstanding erasure request. Existing known-id admin
mutation routes remain available; never recommend hand-run SQL or bulk deletion as recovery.

**Exact owner approval requested:** “Approve #350's fixed 50-row limit/offset moderation paging,
oldest-first timestamp/id order, Previous/Next UI and reset-after-mutation behavior; preserve
#367 drafts, stack #396's view-sequencing fix, and keep public responses and permissions unchanged.”
The owner approved this contract on 2026-10-28; implementation and verification remain required.
