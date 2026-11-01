# #379 — Match body-image hints to opening and remainder widths

**Status: OWNER APPROVED 2026-10-28; implemented and locally qualified. Risk: High:** generated responsive-image markup. Final-head review/CI and the unmerged dependency stack are PR gates; no existing-library re-encoding, owner-data change or deployment is authorized.

## Approved decision

Use build-time, layout-specific `sizes` for generated inline pictures: the desktop opening's narrow column and the wider remainder get separate hints. Keep layout, variant formats/widths, no-upscale behavior, EXIF policy and lazy loading unchanged. Do not fix under-fetch by serving the largest image everywhere or by relabeling every opening image as 1056px.

The issue's Chromium 1365px/DPR 1.5/cache-isolated pre-fix reproduction was accepted without repeating it. The former `body-images.ts:SIZES` claimed 720px from 768px upward. Current CSS and `DESIGN.md` use **66rem/1056px**, not the older 60rem/960px in historical context; `gallery-layout.ts:COLUMN_WIDTH` is already 1056. `StoryPage.astro` owns the opening/rest split, after loader rendering. Post-fix source selection is qualified below.

## Width contract (default 16px root size)

Derive from the existing `max-w-3xl px-5 lg:max-w-6xl`, 66rem spread, 18rem rail and 3rem gap; do not use the issue's illustrative 1112px breakpoint as an exact threshold.

| Viewport | Opening image slot | Remainder image slot |
| --- | --- | --- |
| below 48rem/768px | viewport minus 2.5rem/40px | same |
| 48rem to below 64rem/1024px | 45.5rem/728px | same |
| 64rem to below 68.5rem/1096px | viewport minus 23.5rem/376px | viewport minus 2.5rem/40px |
| at least 68.5rem/1096px | 45rem/720px | 66rem/1056px |

The 1096px lock is 1056 + 40; the outer 1152px maximum does not constrain the narrower spread. At exactly 1024px, the two desktop slots are 648px and 984px; neither is 720px. Use rem-based thresholds/calcs corresponding to CSS, and parity tests tying numeric helpers to CSS tokens/COLUMN_WIDTH. Nested blockquotes/lists can narrow a picture further; the surrounding article width is the safe upper bound, without pretending to compute arbitrary prose indentation.

## Smallest integration preserving the layout boundary

- Keep loader sanitization/transformation where it is; do not move Markdown rendering into the page or make the loader guess the split from Markdown. Mark only generated **inline** pictures with a reserved `data-body-image` attribute injected after sanitization; galleries are not marked. Keep that attribute outside the author sanitizer allow-list and test that author-supplied copies are stripped, so the later helper cannot mistake an author picture for generated markup. Do not use an author-preserved class as proof of provenance.
- Add a narrow HAST helper in `body-images.ts` that accepts already sanitized/transformed body HTML and a trusted sizes value, and updates only `source` nodes inside those generated inline pictures. It must leave source URLs/srcsets, image properties, surrounding text and all galleries unchanged. No regex HTML rewriting and no second sanitize pass that strips trusted post-sanitize attributes. This helper is internal rendering code, not a client/server API.
- In `StoryPage.astro`, call the helper on `opening` and `rest` **after** `splitOpening`, using the respective table-derived strings. Generated markup reaches `set:html` with final hints before any browser script runs. The splitter and its heading metadata remain unchanged, including bodies with no remainder.
- Replace the undocumented blanket constant with explicit caller sizing policy for initial transformation. Story loader output uses the conservative full-width envelope until the page applies exact section hints; publish analysis uses the same non-fetching envelope. `pages-loader.ts` uses the existing About grid's own envelope, and `preview.ts` uses its standalone 46rem border-box main minus 2.5rem padding (maximum 43.5rem/696px). No redesign of About/preview layout is included.
- For the current About grid: below 64rem the slot is `100vw - 2.5rem`; at/above 64rem it is `(min(100vw, 72rem) - 5.5rem) × 2.2 / 3.2` (40px outer padding plus 48px grid gap). Emit equivalent supported `calc` clauses, with its 731.5px desktop maximum. Approved #287's page layout must provide its actual policy instead if it replaces that consumer.
- Share the story width constants with `COLUMN_WIDTH` rather than introducing another untested 1056 literal. Test the CSS/TS contract; do not import Astro or browser globals into renderer helpers used under uploader `tsx`.

#378's bare-picture/figure separation is compatible: mark the picture, not the figure, so linked/mixed-paragraph images also receive the correct hint. Other than typed rendering arguments and the scoped markup helper, no new abstraction or public interface is needed.

## Safety and verification

Reconfirm `SECURITY.md` post-sanitize rendering and published-image metadata sections. Sizes values come only from trusted layout constants; never author text. Sanitization, image-origin rules, dimension/format validation, AVIF/WebP versus JPEG-only selection, fallback URLs, variant width limits and private originals remain unchanged. No photo re-encoding, new format, URL change, schema change or dependency on #347's codec upgrade.

Implemented acceptance coverage:

- Deterministic sizing tests around 767/768, 1023/1024, 1095/1096 and 1152px; CSS-token/COLUMN_WIDTH parity; source-hint updates for figures and bare/linked pictures, with galleries and unrelated author pictures untouched.
- Loader/page composition coverage proves **final** opening/rest markup differs as required; unknown/empty opening and no-rest cases remain valid. About and script-free preview retain adequate, context-specific hints.
- Real built DE/EN stories with distinct opening/remainder photos: inspect actual slots and `currentSrc` at mobile/tablet/desktop boundaries and DPR 1, 1.25 and 1.5. Use fresh browser contexts or isolated fixture URLs so a cached hero cannot mask selection. Ensure sufficient intrinsic width where an existing variant can supply it; explicitly distinguish intrinsically small originals from under-fetch. For the reported 1056px × 1.5 case, a 1920px candidate must be available and selected under normal no-cache/no-data-saver conditions, not 1280px.
- JS-disabled inspection confirms all hints are present; layout, aspect ratio, keyboard link behavior and source-format policy are unchanged. Run affected site/uploader suites/typechecks and a disposable build after implementation. Do not claim a wall-clock/perceptual result from string tests alone.

Update `DESIGN.md` imagery/source-hint notes and the relevant gallery/body-image documentation with the exact width contract.

## Local qualification

- Source `5718aacf71262bc430079deaab63e02cde56104d`, integrated onto #378's qualified
  structure fix. Full six-check wave `1793237862386_16569` passed: uploader types and
  Postgres-enabled tests, fixture schema, Astro check, site tests and build.
- Actual `main.ts` and authenticated APIs published main/no-remainder DE/EN fixtures
  and saved/built About in isolated `swl_379_dev`. Five genuine pipeline photos include
  distinct-content 3000px opening/remainder originals, a separate hero, JPEG-only output
  and an 800px original whose available widths stop at 800.
- 96 JS-disabled cases each use a fresh browser context with cache disabled: 54 story
  cases across DE/EN, DPR 1/1.25/1.5 and 390/767/768/1023/1024/1095/1096/1152/1365px;
  20 About cases, 16 authenticated script-free previews and six no-remainder cases.
  All 366 generated image instances decode; actual CSS slots match the approved
  equations. No data-saver mode; root font is 16px.
- At 1365px/DPR 1.5 in both locales, the 720px opening selects 1280px AVIF, while
  the 1056px remainder selects 1920px AVIF and the JPEG-only image selects 1920px JPEG.
  The small original selects its existing 800px maximum, not an invented larger variant.
  About's desktop slot is 731.5px; preview's is 696px. No phantom remainder appears.
- Authored provenance markers are stripped, gallery/authored hints remain separate,
  and aspect ratio, lazy/async loading and picture structure are preserved. Two native
  Tab/Shift-Tab/Enter cases keep link order and open the genuine 3000×2000 destination.
  Eight raw server responses retain the script-denying preview CSP.
- Evidence: `.local/backlog-execution-2026-10-27/issue-379-runtime/` contains source
  hashes, full slot/candidate records, screenshots, native-navigation records and final
  readback. Four stored/published body rows and their image maps plus About content
  remain unchanged after exercise; five photos remain ready. Temporary account/sessions,
  browser application/profile/launcher and runtime are removed; synthetic state is retained.
  No physical-device, screen-reader-speech or before/after perceptual comparison is claimed.

## Dependencies and recovery

Coordinate the shared renderer signature with #356/#358/#375/#378 and approved #287 page consumers. The gallery partition and per-row/slider sizes policy is otherwise unchanged. No owner content changes.

Code-only rollback restores old hints after the next normal rebuild; existing releases remain intact and image variants require no migration. Prefer a forward sizing correction because reverting reintroduces blur. Never clear/delete original photos or regenerate the library as a workaround.
