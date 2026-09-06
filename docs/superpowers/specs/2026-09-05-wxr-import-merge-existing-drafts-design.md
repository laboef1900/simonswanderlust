# WXR Importer — Re-runs Merge Into Existing Drafts — Design

**Date:** 2026-09-05
**Status:** Proposed (implements the "Suggested fix" on issue #126)
**Risk:** **High.** CLAUDE.md's Change Risk table names WXR import explicitly, and this change
decides *what an import writes over an author's work*. Requires this spec, misuse-case analysis,
the full affected suite, explicit human approval, and a documented rollback plan.
**Repos touched:** blog repo — `uploader/src/wp-import.ts`, `uploader/src/server.ts` (`POST /import`,
two additive lines), `uploader/public/import.html`, tests, `docs/authoring-workflow.md`. No
`site/` change, no schema change, no new endpoint, no new runtime dependency.
**Builds on:** `2026-07-30-wxr-import-hardening-design.md` (#85 made "run it again" the documented
recovery path), `2026-09-05-wxr-import-pair-identity-design.md` (#99: which stored pair a group
binds to) and `2026-09-05-wxr-import-image-destinations-design.md` (#125: `markdownImages`, the
parser the merge reuses). Stacked on both.
**Closes:** #126.

## Why this exists

`importWxr` rebuilds every draft pair entirely from the export — `shared` hard-coded to
placeholders (`countryCode 'XX'`, `region 'europe'`, coordinates 0/0), `country: ''`, body/hero/
images/excerpt from the WXR — and calls `upsertDraft` with the **existing** `translationKey`.
`pgPostStore.writeLocale`'s `ON CONFLICT` overwrites every column; nothing merges with the stored
row.

The page promises the opposite ("existing drafts are updated", "running it again is safe and
resumes where it left off"), and re-running **is** the documented recovery path for photos that
failed the first time (#85). So the scenario is not exotic: import, spend an hour filling country /
region / coordinates / key facts / stops / alt text, re-run to pick up the missing photos — every
edit is gone. The revision snapshot makes it recoverable one post at a time, which is the only
reason this is not priority-high.

## Decision

**Default: merge.** For a group that binds to an existing **draft** pair (#99's exact-match rule),
the import keeps the stored pair and changes only what a re-run exists to change — the photos:

| Field | Source on re-run |
| --- | --- |
| `shared` (date, countryCode, region, coordinates, stops, route, categories, tags) | **stored** |
| per-locale `slug`, `title`, `excerpt`, `country`, `keyFacts` | **stored** |
| `heroImage` | **stored** if it has a `src`. The export's featured image is fetched only when the **pair** has no stored hero in *either* locale: the hero key `trips/<slug>/hero` carries no URL identity and is never resumed, both locales usually share one featured URL and therefore one key (the pair cache memoises by URL), so a fetch for an emptied DE slot would overwrite the bytes a kept EN hero still references (review findings on PR #164, rounds 1–2). An author who cleared one locale's hero sets it again in the editor. When fetched, an empty slot takes the recovered hero with the stored `alt` if the author wrote one |
| `bodyMarkdown` | **stored**, with every WordPress image URL the run re-hosted rewritten to the hosted URL — via the same `markdownImages` + `rewriteFences` pass `buildLocale` uses on a fresh body |
| `images` | **stored** ∪ the entries for the URLs rewritten above. A rewritten URL's entry is **moved and merged**, not re-created: the store lifts a gallery line's `\| WxH \| alt= \| caption=` into `images[url]` on save — for a failed hot-link, under the WordPress URL — so healing the URL carries alt/caption to the hosted key and drops the orphaned one, and a second occurrence of the same URL merges into (never replaces) what the first moved (review findings on PR #164, rounds 1–2) |
| `status` | `draft` (the pair was a draft; published pairs are skipped before this point) |

That is: a re-run is a **URL substitution over the author's body**, not a body replacement. Prose
edits, alt-text edits, removed photos and reordered galleries survive; a hot-link the first run left
behind (`![Beach](https://wp/a.jpg "IMG_0001")`, still parseable thanks to #125) is healed in place.

Why merge rather than "skip existing drafts": with skip as the default, the documented recovery
path (re-run to fetch the photos that failed) would require the overwrite flag — which is exactly
the data loss the issue reports. Skip-by-default makes the safe action useless and the useful action
destructive.

**Opt-in: `overwriteDrafts`.** A multipart field on `POST /import` (`ImportDeps.overwriteDrafts`)
that restores today's behaviour — rebuild matched drafts wholesale from the export — for the case
the merge cannot serve: the author changed the content **in WordPress** and re-exported. It is a
checkbox on `import.html`, unchecked by default, whose label names the loss ("discards your edits
to those drafts"), and the Import button asks for confirmation naming the scope before sending.
Published posts are never touched either way (`skippedPublished`, unchanged).

**No new summary bucket.** A merged draft is `updated`, the same as before — the buckets still sum
to the group count (#100). The page's wording under the tally says what "updated" meant for this
run (edits kept vs. replaced) because it knows which box was ticked.

### What the merge deliberately does NOT do

- It does not diff the export against the stored body to pick up WordPress-side prose changes.
  That is what the overwrite flag is for; a three-way merge without a common ancestor would guess.
- It does not fetch the export's featured image for a pair with any stored hero, so a
  WordPress-side change of featured image is picked up only by `overwriteDrafts` (which is what
  it is for). The `#96` pre-flight count excludes that hero too, so the count stays exact.
- It does not re-host URLs that appear only in the stored body and not in the export (e.g. a photo
  the author pasted by hand as a hot-link). The re-host set is still derived from the export — the
  #96 pre-flight count stays exact — and the stored body is only a *target* for substitution.
- It does not touch a stored hero the author replaced through the editor, even if the export's
  featured image differs.

## Misuse cases

| Case | Before | After (default) | After (`overwriteDrafts`) |
| --- | --- | --- | --- |
| Re-run after filling country/region/coords/keyFacts/stops | All reset to placeholders | Kept | Reset (author confirmed the loss) |
| Re-run after editing body prose and alt text | Body replaced by the export's | Kept; only re-hosted URLs substituted | Replaced |
| Re-run after the first run left a hot-linked photo | Body replaced; photo now hosted | Hot-link healed in place, dimensions recorded | Same as before |
| Re-run after the author deleted a photo from the body | Photo comes back | Stays deleted | Comes back |
| Re-run after the author picked a different hero in the editor | Hero reset to the featured image | Author's hero kept | Featured image |
| First run's hero failed; author left it empty; re-run recovers it | Recovered | Recovered, with the author's alt if any | Recovered |
| Published pair | `skippedPublished` | unchanged | unchanged (the flag never reaches a published pair) |
| Stored pair unreadable (`get()` null: a stranded single-locale row) | overwritten | falls back to the export's content — nothing to merge with | same |
| Non-admin author ticks overwrite | n/a | same authority as today's import: whoever may import may overwrite drafts. Reversible via the revision snapshot `upsertDraft` still takes, so it stays session-level per `SECURITY.md`'s reversibility rule (#97 moves the whole route to admin-only independently). | |

## Invariants (each has a test in `test/wp-import.test.ts`, `describe('importWxr re-run merge')`)

1. A re-run keeps the stored `shared`, per-locale `country`, `keyFacts`, `title`, `excerpt`.
2. A re-run keeps the stored body text and alt edits, and rewrites only the WordPress URLs it
   re-hosted this time (body image and gallery line), adding their dimensions to `images` without
   dropping existing entries.
3. A re-run keeps a stored hero that has a `src`; when the stored hero is empty it takes the
   export's, keeping the author's alt if present.
4. A photo the author removed from the body does not come back.
5. With `overwriteDrafts: true` the pair is rebuilt from the export exactly as before (placeholders
   and all).
6. The summary counts a merged pair as `updated`; the buckets still sum to the group count.
7. `POST /import` reads `overwriteDrafts` from the multipart body and passes it through; absent →
   merge (`test/server.test.ts`, via the injected `importRunner`).
8. Healing a gallery hot-link the author annotated moves its `alt`/`caption` from `images[<wp url>]`
   to `images[<hosted url>]` and leaves no orphan.
9. A merge run with a stored hero makes **no** fetch for the featured image, and the pre-flight
   count agrees (`maxImages` set to the body-photo count does not throw).
10. The same holds when only ONE locale keeps a hero (the emptied locale stays empty; the kept
    hero's bytes are never rewritten).
11. A hot-link that occurs twice in the stored body keeps its moved alt/caption after both
    substitutions.

## UI (`import.html`)

- Checkbox `overwriteDrafts` under the file input: label "Replace existing drafts with the export",
  hint "Off (default): drafts you already have are kept — only photos that are still missing are
  downloaded and swapped in. On: those drafts are rebuilt from the export and **your edits to them
  are discarded**. Published posts are never touched." Native checkbox, `width: auto`, associated
  `<label>`, hint linked with `aria-describedby`; keyboard-operable, visible focus from the shared
  stylesheet.
- When ticked, the Import button runs a `confirm()` naming the scope before sending (the admin's
  incumbent pattern for destructive actions — `posts.html`, `media-browser.js`).
- The lede and the "running it again is safe" paragraph become truthful: re-runs keep edits.
- The result line under the tally says "Updated: N (your edits were kept)" or "(rebuilt from the
  export — edits discarded)".

## Definition of done

- `npx tsc --noEmit` and `npm test` green in `uploader/` with `TEST_DATABASE_URL` set; CI green.
- Every invariant above has a test; 1–4 fail on the pre-#126 importer.
- Real-UI verification: the checkbox, hint, confirm and result wording exercised in a browser
  against a running dev server, screenshot attached to the PR.
- `docs/authoring-workflow.md` describes re-runs and the overwrite option.
- Explicit human approval before merge, per CLAUDE.md's High-risk row.

## Rollback

Revert the single commit. No schema, no migration, no persistent state. Re-runs go back to
rebuilding drafts wholesale — the pre-#126 documented state; the revision snapshot remains the
per-post recovery.

## Not included here

- **Warning the author when the export's content differs from the stored body** (a "WordPress
  changed since your last import" hint). Useful, but it needs a stored fingerprint of the
  export-derived body per pair — a schema change — and is a separate decision.
- **#92 (async import + progress endpoint)** rewrites the route handler; the `overwriteDrafts`
  field is a plain multipart field so it carries over to a job-based handler unchanged.
