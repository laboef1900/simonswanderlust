# 2026-09-20 — Imported content semantics

**Risk: Normal.** This pass changes author-visible story structure and publish validation, but does not change routes, slugs, database schema, authentication, or the image trust boundary.

## Why

The WordPress/Elementor import preserved all prose and photos, but also preserved presentation artifacts from the old page template. The public story page already owns the document H1, table of contents, key-facts panel, and gallery semantics; imported bodies duplicated or bypassed each of those structures. The result was a second H1, empty `Inhalt` / `Table of Contents` headings, facts stranded in prose, colon-ended outline entries, hard-line-broken introductions, and filename-like alt text announced as if it described the photograph.

## Content rules

- Per-locale `Eckdaten`, `Key data`, or `Key facts` rows belong in that locale's `keyFacts` JSON and are removed from `body_markdown`. The old empty TOC heading is removed because the Astro page generates its own contents navigation.
- StoryHero owns the only page H1. A body H1 that merely repeats the title is removed; any other body H1 is demoted to H2 during this one-time content pass.
- **Elementor heading rule:** an imported `## Heading:` immediately followed through a hard break by a short plain-text subtitle becomes one heading: `## Heading — Subtitle`. The colon is dropped, the subtitle text is preserved, and the rule is identical for DE and EN.
- Hard breaks that joined the imported opening copy are paragraph boundaries and become real blank-line-separated Markdown paragraphs.
- The typo `Hauptstad` is normalized to `Hauptstadt` while the Galápagos facts move into `keyFacts`.
- Curated gallery width is explicit. `#layout: breakout` is added only to the four fences selected in the paired Galápagos and Cuyabeno stories; no photographs are removed by this pass.

## Publish and import guards

`htmlToMarkdown` now repairs the Elementor heading/subtitle artifact, splits hard-break-joined opening copy before the facts block, and drops an empty legacy TOC slot. A real authored contents section with list content is preserved.

`validateForPublish` synchronously refuses either locale when its body contains an ATX `# ` heading or raw `<h1>` element. Fenced Markdown/HTML examples are ignored. The error names the locale and explains that the story hero supplies the page H1. This is a structural publish gate, not an editorial-quality gate.

## Alt decision

An alt matching the imported attachment-title pattern `Name - d.m.yyyy hhmmss` is not a description. In this corpus those values occur on referenced photos inside captionless gallery grids. The one-time pass keeps every photo and clears only those captionless gallery alts to `alt=""`, making the image decorative instead of announcing file provenance. It does not invent descriptions.

Future filename-pattern alts are counted by `alt-audit.ts` with reason `filename`. The audit remains a warning and never gates Publish: imported posts can legitimately contain many undescribed photos, and requiring invented text would be worse than an explicit decorative alt. Empty and title-repeating alt behavior remains aligned with the public renderer.

## Data safety and visibility

Before any update, the database was dumped to the gitignored backup directory under `uploader/data/backup/db`. Every mutation is an `UPDATE` constrained by `translation_key` and `locale`; no row is deleted. The working copy is updated while `published_snapshot` remains unchanged, preserving the draft/publish boundary. Each story must be published from the admin before a rebuild can expose the changes.

The exact per-locale before/after record, including body hunks, key facts, hero focus points, alt changes, and curated gallery directives, is kept in `local://content-pass-diff.md` for this work session.

## Verification

- `uploader/test/wp-content.test.ts` covers heading/subtitle merge, opening hard-break paragraphs, empty TOC removal, and preservation of a real contents section.
- `uploader/test/posts.test.ts` covers Markdown and raw-HTML H1 refusal plus fenced examples.
- `uploader/test/alt-audit.test.ts` covers the filename warning without changing publish eligibility.
