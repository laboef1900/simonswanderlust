# #365 — Reconcile GPX state on conflict Reload

**Status: OWNER APPROVED 2026-10-28.**
**Risk: High** (private GPX state and publication concurrency). Approved: client-only awaited reconciliation and visible loading/failure blocking, with unchanged server tokens and publication policy. Implementation and verification remain required; no owner-data mutation or deployment is authorized.
Baseline: `11e16d1b8e43141d296b801ee663a351ae3fe415`.

## Evidence and scope

The issue's supplied runtime reproduction is accepted, not rerun. In `uploader/public/editor.html`, Save's 409 handler calls `loadPost(currentTk)`. That function commits the refreshed form and `loadedUpdatedAt`, but only page initialization calls `gpxEditor.refresh()`. `editor-gpx.js` therefore retains the previous version, geometry and attachment controls. `posts.ts:assertPublishTokens` correctly refuses the fresh pair token combined with the stale route token.

Keep the approved `2026-10-23-gpx-route-import-design.md` §§2, 5–7 and `SECURITY.md` **GPX routes — private source and public snapshot** authoritative. This fixes client reconciliation, not publication, attachment retention, token comparison or authorization policy.

## Smallest implementation contract

1. Make successful explicit post reloads await the existing route GET through `gpxEditor.refresh()`, inside the successful `loadPost` path. Do not merely append it after `if (reload) await loadPost(...)`: `loadPost` returns **true on failed loads**, for stash recovery, not as a success signal. A failed GET or failed `populateForm` must retain the existing blocked/recovery state and must not promote a fresh route token as if the form reconciled.
2. Preserve initialization's existing order (load post, offer local stash, refresh route for the resulting identity). Use an explicit initialization-only defer-route-refresh option on `loadPost`; ordinary callers refresh by default. Keep the final initialization refresh, including for a new post. This avoids a duplicate initial GET and refreshes the identity after stash handling without duplicating the conflict-path logic.
3. On successful form population, start route refresh before returning the editor to actionable state. `refreshRoute` already sets `routeLoaded=false` synchronously and uses `routeEpoch` plus post identity to discard stale successes. Preserve those guards. The newly loaded form can become the text baseline; a successful post GET alone does **not** mean route reconciliation succeeded.
4. Represent loading/failed route state honestly: do not leave an unqualified old “Attached”/“No route” label while a required refresh is pending or failed. Render loading/unavailable text and disable attachment mutation controls until a current successful response. `publishVersion()` must continue throwing while `routeLoaded=false`; Attach/Detach must not send cached versions. Reuse existing GPX error/status patterns; any new copy belongs in both locales in `site/src/i18n/ui.ts` and its existing generated-copy path.
5. Refresh failures (network, non-2xx, invalid version/JSON) remain fail-closed and visibly actionable: explain that post fields loaded but route state did not, and require page reload before route actions/Publish. Do not replace an unavailable route with `{version:null}` or mark it reviewed. Keep 401 login handling. A later successful explicit reload restores controls/status from the actual response and clears only obsolete route-refresh feedback. No retry loop or new endpoint.
6. Never infer detached means never attached: a detached route retains its non-null tombstone version and original availability. Preserve `outcomeUnknown`, pending previews and mutation guards; a normal GET must not acknowledge an uncertain mutation or silently attach/discard a preview. Existing server checks still catch another tab changing either token between the two GETs or after reconciliation; no auto-retry or automatic Publish.

Affected implementation files: `uploader/public/editor.html`, `uploader/public/editor-gpx.js`; regressions in `uploader/test/editor-gpx.test.ts` and affected `editor-dom.test.ts` harness contracts; localized copy only as required. `posts.ts`, GPX stores/routes, private storage and publication code remain unchanged. Explicitly reconfirm the SECURITY.md section above, documenting that reload reads do not publish or advance tokens without their corresponding loaded state.

## Required verification after approval

Use the existing `editor-gpx.test.ts:fullEditor` harness, which executes real editor serialization, DraftGuard and GPX controller. The general `editor-dom.test.ts` currently stubs GPX with a no-op refresh; asserting that stub was called is insufficient.

- Exact issue AC: initial route GET returns null; another-tab mutation makes Save return 409; confirm Reload; second route GET returns an attachment. Assert the GET occurs, status and Detach update, and subsequent Publish carries its version with the post token returned by Save.
- Repeat for attached v1 → replacement v2 and attached v1 → detached v2. Detached Publish must carry **v2**, not null; original controls match `originalAvailable`.
- Hold the reload route GET unresolved: attempts to Publish/Attach/Detach emit no corresponding mutation. Reject it with network/500/invalid JSON or invalid version: visible failure, no success/absence claim, no stale-token mutation; a later successful reload recovers.
- Failed post GET or form population: no successful reconciliation claim, no token adoption from a route-only fetch, dirty recovery payload preserved. 401 redirects without continuing. Canceling the conflict dialog performs no refresh and preserves unsaved edits.
- Delayed old response after a newer refresh or changed post identity cannot overwrite current state. New-post initialization and existing stash recovery retain their ordering; GPX arrays never enter browser storage.
- Actual runtime: in an isolated app/Postgres instance use two browser tabs and a synthetic GPX/post. Attach, replace and detach in B; Save → Reload → Publish in A. Inspect request tokens and visible controls; inject route GET failure in A and confirm blocking. No owner route, content or publication is used. Run affected uploader tests/typecheck and relevant GPX concurrency/publication integration suites with `TEST_DATABASE_URL`; run site i18n tests/`astro check` if copy changes. These are future checks, not evidence collected here.

## Dependencies, recovery and exact decision

No native blocker is recorded. Preserve independently implemented #361 unpublish-token behavior and #345 local-stash token fix (PR #408) when integrating; do not reimplement either. #306's broader conflict UX is not added here.

Rollback only this client/copy change; no migration or data rewrite. The old client fails closed but may again require a full browser reload after a conflict. Containment is to stop route/publish actions and reload the page; never bypass server token checks. Existing snapshots and private originals stay untouched.

**Owner decision requested:** approve implementing this client-only, awaited route reconciliation with explicit loading/failure blocking and the stated regression/runtime checks. Approval grants no GPX publication-policy change, real-data mutation, deployment or merge authorization.
