# #375 — Publish against rendered heading semantics

**Status: OWNER APPROVED 2026-10-28. Risk: High:** approved rendered, sanitized H1-element checks for single/bulk story publication. No body rewrite, new About/page restriction, owner-data mutation or deployment is authorized; implementation and verification remain required.

## Decision requested

Approve replacing the synchronous Markdown H1 scanner with an element check on the renderer's sanitized HAST, reused in the existing asynchronous single/bulk publication analysis. Reject exactly a surviving `h1` element at any nesting depth. Keep title/body requirements, other image gates and the existing single-publish field/locale-specific 400; keep bulk's existing per-pair failure envelope.

The 2026-09-20 imported-content specification describes an ATX/raw-HTML scanner but its invariant is “StoryHero owns the only H1.” This amendment changes the detection mechanism and covers every rendered H1; it does not authorize another one-time content normalization. The issue's alternative of extending the scanner is rejected: Setext, containers, inline code and indented code must be decided by the existing parser, not a second grammar.

## Existing path and smallest change

- `posts.ts:bodyHasH1` skips fenced blocks then regex-matches lines; `validateForPublish` calls it for DE and EN. Remove that private scanner and just its H1 loop. Keep `validateForPublish` synchronous for structural field validation; document that full publication eligibility also requires the asynchronous rendered-body gate.
- `publish-gate.ts:analyzeBodyImages` already calls the shared `renderMarkdown` once, reads `bodyImageSources` before resolution, and transforms the same HTML for readiness. Extend this existing analysis with `hasH1`, without rendering Markdown again.
- In `site/src/lib/body-images.ts`, share the current `rehypeParse({ fragment: true }) → rehypeSanitize(BODY_SCHEMA)` preparation and traverse that tree for sources/gallery lines **and** `h1`. Rename the expanded analysis helper and migrate its consumers rather than leave a misleading image-only alias. H1 detection runs before image injection: injected pictures/galleries do not create headings. Retain pre-transform foreign-source collection and post-transform readiness collection exactly as today.
- `server.ts:publicationImages` is the shared asynchronous loop used by both publish routes. Rename it to reflect body validation, and refuse with a `PostError` naming the current locale when analysis reports H1, before `posts.publish`, export or build. The single route currently calls this helper **outside** its `PostError` catch: extend the intentional validation catch to include this operation and map only the expected `PostError` to 400. Unexpected renderer failures remain sanitized server errors, never success or an H1 message. Bulk already catches per-pair errors; retain partial-batch behavior and rebuild only for successful changes.

No new endpoint, schema, renderer dependency or Markdown options. `render-markdown.ts`/`astro.config.mjs` parity remains authoritative. Do not invoke gallery partitioning merely to detect a heading; reuse the pre-transform tree already needed for image analysis. Existing #334 readiness behavior still runs for eligible bodies.

### Implemented interface contract for #356 / #358 / #378

- `analyzeRenderedBody(html: string)` in `site/src/lib/body-images.ts` returns
  `{ hasH1: boolean; sources: string[]; galleryLines: string[] }` from the shared
  sanitize-first preparation. `hasH1` means any actual sanitized H1 element,
  including nested elements; image-source traversal policy is unchanged.
- `analyzeBodyContent(body, images, imageOrigin)` in `uploader/src/publish-gate.ts`
  remains asynchronous and returns `{ hasH1: boolean; foreign: string[]; sources: string[] }`.
  It renders Markdown once, gathers headings/foreign references before transformation,
  and gathers readiness sources after transformation. No image-only alias remains.
- `publicationBody` is the private server pair gate, returning `{ foreign, keys }`
  or throwing the locale-specific `PostError` for an H1. Both publication routes use it;
  structural `validateForPublish` stays synchronous. Future language-mode integration
  must use the same publishable-locale set here as the other publication gates.
- Future renderer changes must preserve this predicate and error classification.
  This change does not implement an asynchronous rendering optimizer or change Markdown
  options, gallery partitioning, About/page policy, or stored content.


## Invariants and misuse cases

- Reject ATX, Setext, quoted/list-nested and surviving raw-HTML H1s, irrespective of heading text or nesting.
- Accept literal `<h1>` text in inline, indented and fenced code; escaped HTML; gallery caption/fence text that only looks like a heading. Sanitizer-stripped markup cannot create a false refusal.
- Never demote headings or mutate Markdown, working copies, snapshots, routes, revision history or owner content automatically.
- Preserve admin-only single/bulk publication, pair/route optimistic-concurrency tokens and store recheck, foreign-origin equality, readiness policy, sanitation/format/dimension guards, preview CSP and photo privacy. A render failure refuses before publication, not after it.
- Approved #283 language modes must supply the same set of publishable locales as the other publication gates; do not reintroduce an unconditional bilingual requirement after that integration.

## Verification and documentation

Tests to implement, not results claimed: shared sanitized-tree H1 cases; `uploader/test/publish-gate.test.ts` analysis parity against `renderMarkdown`; both single and bulk routes for Setext, blockquote/list H1 rejection and inline/indented/fenced code acceptance in each locale; assert no store publish/export/build for a refused pair, ordinary bulk successes still work, and no duplicate Markdown render per locale. Retain existing origin/readiness/concurrency cases. Move scanner-specific assertions out of `posts.test.ts` to the semantic gate/route suites rather than dropping their coverage. Include raw markup, character references, headings inside containers and sanitizer-removed content. Run affected site/uploader suites, typechecks and a disposable real publish/build path after implementation.

Amend `2026-09-20-imported-content-semantics-design.md` to describe the semantic gate and reconfirm `SECURITY.md` publication-image analysis/output-sanitization sections. This is not a new security claim that one H1 prevents XSS.

## Dependencies and rollback

Coordinate with #356/#358/#378 on shared renderer signatures; those changes must not alter the H1 predicate. No dependency on importer normalization or a content migration. Revert code and semantic-gate documentation together if necessary, preserving the last good release and stored bodies; reverting reintroduces false positives/negatives, so prefer a forward correction. Do not mass-edit existing articles to make a broken gate pass.
