# Optional story title image

Status: Implemented; owner approved the product choice and technical implementation, then requested a PR and local deployment. Production deployment is not authorized.

## Request and scope

Restore the ability to choose a special wide title photograph independently of a post's overview photograph. Extend the existing editorial design, not the page layout or image encoding pipeline.

- Add an optional title image to each locale's editor, using the existing media picker and upload pipeline, alt text, focal-point controls, preview, and remove action.
- The story header and draft preview use `titleImage ?? heroImage`.
- Overview cards, homepage cover, pagination thumbnails, and social/structured-data images continue to use `heroImage`.
- Keep the existing full-width story-header layout: desktop cover with the selected focal point; mobile preserves the photograph's natural proportions. No text over the photograph, forced panoramic aspect ratio, or new encoding profile.
- Existing posts remain unchanged until an author explicitly selects and publishes a title image. No automatic extraction from WordPress exports or bulk content edits.
- No routes or slugs change. No deployment, publication, or production-data mutation is authorized by implementation approval.

## Contract

`PostLocale.titleImage?: HeroImage`, with the existing image shape:

- `src`: hosted image base URL;
- positive integer `width` and `height`;
- string `alt`, required and nonblank for publishing;
- optional `format: 'jpeg'` and `focus: { x, y }` percentages, validated as for the hero.

Absence means use the existing hero. Removing the editor selection omits the property in the full-locale save payload and stores SQL NULL. Old revisions, snapshots, imports, and backups with no title image remain valid. A supplied invalid image is rejected rather than silently replaced with the hero.

Persist as nullable `posts.title_image jsonb`, added idempotently before any SQL snapshot expression references it. Include it in published snapshots and the site's loader/schema. Do not backfill existing published snapshots from working copies.

Preserve the field through both stores, revisions, duplicate-post actions, MDX export, and database dump/restore. Advance the backup format version so older application versions reject new dumps rather than silently discard the new field. Restore supported older dumps with no title image.

The existing safe import merge preserves the author's title image; explicit wholesale draft replacement retains its existing replacement semantics. Build-time image-origin retargeting must handle the title image using the same hosted-path rules as the hero.

## Trust boundaries and invariants

Risk: High under repository policy (schema, publish boundary, backup/restore).

1. Validate at the post-store chokepoint as well as the request boundary: imports and other direct callers must not bypass validation. Reuse image validation; do not add a second URL or dimension grammar.
2. Publishing a selected title image requires a valid hosted reference and ready media. Apply to single and bulk publishing; never publish a missing, processing, failed, or foreign title image.
3. Media usage/deletion checks include title images from both working copies and published snapshots. Replacing a draft banner must not permit deleting the banner still on the live site.
4. Draft saves cannot change the published banner during unrelated rebuilds. Only explicit publication updates the snapshot.
5. Editor reload, locale switches, draft recovery, and revision restore preserve the independent title and hero selections; restoring an absent title image clears any stale editor selection.
6. Titles and alt text remain escaped; render through the existing responsive image component and preview escaping. No new raw HTML surface, remote-fetch capability, or EXIF behavior.
7. Existing authorization, publication permissions, preview CSP, upload limits, and secret handling remain unchanged. Reconfirm applicable image/publication controls in SECURITY.md.

## Verification and acceptance

- Store/API regression coverage: valid round trip, invalid image rejection, removal, and locale independence.
- Real Postgres integration: additive schema migration on existing rows, save/reload, publication snapshot isolation, and old snapshot fallback.
- Publish and media-usage regressions: a not-ready title image blocks publication; draft and published title images both protect their media from deletion.
- Editor DOM regression: select a title image without altering the hero; save/reload; clear it; restore a revision with no title image; duplicate without shared mutable image objects.
- Site loader/schema and rendering: title image selected when present, correct alt/focus/source format, old posts use hero, overview image unchanged.
- Export and database backup/restore round trips preserve both images; older supported dumps restore with no title image.
- Browser smoke on desktop and mobile: select/save/reopen, preview the selected banner, remove and observe fallback. Exercise a locally built story with and without a banner without publishing user content.
- Run affected Vitest suites in both trees, uploader TypeScript check, and Astro check. Database-backed verification requires an isolated test database, never destructive setup against the content database.

## Recovery and containment

Take a verified database backup before applying the migration to an existing content database. Implementation verification uses isolated data. The migration is additive and leaves current rows/snapshots intact; rollback leaves the nullable column in place rather than dropping data. Keep the last static release available through the existing release mechanism.

Rolling back application code removes banner editing/rendering support. Older code must not save affected posts or perform backup/restore after rollback: it does not preserve the new field end-to-end, and older backups omit it. Retain a new-format backup and restore forward with the new application if recovery is needed. No automatic down migration or production restore.

## Design self-review

- Why not store the banner inside `heroImage` to avoid a migration? That couples independent assets and hides the second reference from media usage, backups, and publishing. A nullable column is explicit and matches the existing locale-row model.
- Could a correct editor and renderer still lose the banner? Yes: fixed SQL column lists, published snapshots, backup restores, and media usage projections are independent contracts. Their round trips and deletion/publication transitions are acceptance criteria, not follow-ups.
- Why retain per-locale selection? It follows the current hero workflow and permits translated alt text without inventing a shared-image/per-locale-caption model.

## Approval

Owner technical approval recorded in this implementation conversation: **Approve implementation**,
after reviewing this contract's schema, publication, backup and recovery implications.
Approval covers the implementation only; deployment and changes to existing content remain separate.
The subsequent request, “Push the changes, create a pr and bring them to the local running
version”, authorizes pushing the feature branch, opening a PR into `dev`, and updating the
local app after a verified database backup. It does not authorize merging or production deployment.

## Local verification

- Uploader: 70 Vitest files, 1,563 tests passed with `TEST_DATABASE_URL` set to a disposable
  Postgres 18 database; `npx tsc --noEmit` passed.
- Site: 24 Vitest files, 290 tests passed. `npx astro check` reported zero errors, warnings
  or hints. `npm run build` produced 17 static pages against isolated fixture content;
  Vite reported a chunk-size warning, not a build failure.
- Real app/browser smoke: selected a library banner, changed alt and framing, saved/reloaded,
  uploaded and encoded another banner, rendered it in draft preview, removed it and observed
  the hero fallback. An upload can precede encoding completion; its preview loaded after the
  media became ready.
- The locally built DE story served its published JPEG title banner and focal point while
  its working copy differed. The EN story with no banner and homepage/card images retained
  the hero. Desktop and mobile captures showed the existing cover/natural-aspect behavior
  without horizontal overflow.
- Existing-row migration smoke preserved old snapshots without a title image. Automated
  Postgres, backup and media-deletion tests covered independent draft/live references,
  new-format recovery and old-backup fallback.
- Verification used synthetic posts, disposable databases and a separate data directory;
  no existing post, production database or deployment was changed.
- Independent security and UI reviewer agents could not run because their provider returned
  rate-limit errors. Local code/visual checks substituted; independent review and CI remain
  release/merge checks, not claimed results.
