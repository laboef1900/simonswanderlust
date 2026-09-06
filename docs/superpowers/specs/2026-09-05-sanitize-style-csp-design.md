# No Inline `style` in Author Markup + Draft-Preview CSP — Design

**Date:** 2026-09-05
**Status:** Implemented on `feature/124-sanitize-style-csp`; awaiting owner approval (high risk).
**Risk:** **High.** CLAUDE.md's Change Risk table names the body-HTML render path explicitly:
this change edits the `rehype-sanitize` schema in `site/src/lib/body-images.ts`, the Markdown
options both `astro build` and the draft preview run with, and the headers of
`GET /posts/:tk/preview`.
**Repos touched:** `site/` (sanitizer, Shiki transformer, `Base.astro`, two new direct deps that
were already installed transitively) and `uploader/` (`preview.ts`, the preview route).
No schema change, no new endpoint, no new persistent file.
**Closes:** #124.

## Why this exists

`BODY_SCHEMA` extended `defaultSchema` with `style` on `span`, `code` and `pre` so Shiki's inline
syntax colours survived sanitization. Astro's Markdown renderer passes raw HTML through, so the
sanitizer cannot tell a Shiki `<span style>` from an author-typed one, and `style` values were
unconstrained. A non-admin author could write

```html
<span style="position:fixed;inset:0;background:#fff url(https://evil.example/px.png)">
```

and every reader page (static build, `set:html`) plus the draft preview would render a
full-viewport overlay and issue a third-party request per view — defacement, phishing text, and a
reader-IP leak that contradicts the zero-third-party-request guarantee. Publish review would not
catch it, because the overlay covers the preview too.

Separately, the preview page (`uploader/src/preview.ts`) is served on the admin origin with no
CSP, so any future sanitizer regression is admin-session XSS rather than a no-op.

## Trust boundaries

| Boundary | Trusted side | Untrusted side |
|---|---|---|
| `renderMarkdown` → `transformBodyImages` | Shiki/Astro output, our transformer | Author-typed raw HTML inside the Markdown |
| `transformBodyImages` output → `set:html` / preview `<article>` | Post-sanitize injected nodes (`pictureNode`, gallery) | Everything that came through the sanitizer |
| `GET /posts/:tk/preview` reply | The page skeleton `preview.ts` writes | The sanitized body, and any sanitizer bug |

The change moves one thing across the first boundary: Shiki's colours now arrive as **classes**
(`sh-c-<hex>`, `sh-bg-<hex>`, `sh-italic`, `sh-bold`, `sh-underline`, `sh-strike`, `sh-nosel`)
instead of `style`. Classes are already allowed on every element (`'*': ['className']`) and an
author can type them too — the worst an author can do with `class="sh-c-f97583"` is colour some
text with a theme colour. No class has layout, positioning, or URL semantics.

## Design

1. **`site/src/lib/shiki-classes.ts`** — a Shiki transformer, `shikiStyleToClass`, that runs in
   the `root` hook (after every `pre`/`line`/`span` hook, including Astro's own which appends
   `overflow-x: auto` to the `<pre>`), parses each `style` value into declarations, maps the ones
   Shiki emits to classes, and **drops everything else**. Unknown declarations are never passed
   through — "unknown → keep as style" is the hole being closed. `SHIKI_CSS` is generated from the
   same theme object (`@shikijs/themes/github-dark`) so palette and mapping cannot drift.
2. **Both Markdown configs** (`astro.config.mjs` and `MARKDOWN_OPTIONS`) register the transformer;
   `render-markdown.test.ts` keeps asserting they are equal.
3. **`BODY_SCHEMA`** allows `style` on no element. `code` keeps the default constrained
   `className`; Shiki puts its classes on `pre` and `span`, which fall to `'*'`.
4. **Stylesheet delivery.** `Base.astro` inlines `<style>${SHIKI_CSS}</style>` (unlayered, so it
   wins over `@tailwindcss/typography`'s layered `pre` colours); `preview.ts` appends `SHIKI_CSS`
   to its standalone `STYLE`. One source for both surfaces.
5. **Preview CSP.** `previewCsp(imageOrigin)` →
   `default-src 'none'; img-src 'self' <origin>; style-src 'unsafe-inline'; base-uri 'none';
   form-action 'none'; frame-ancestors 'none'`, computed once at server construction and set on
   every `GET /posts/:tk/preview` reply. `'unsafe-inline'` for styles is what the page's own inline
   `<style>` and the gallery `--r` style attributes need; there is no script directive at all.

## Invariants (all tested)

- No element in sanitized body HTML carries `style` — `body-images.test.ts` feeds
  `<p style>`, `<img style>`, `<span style>`, `<pre style>`, `<code style>` and asserts `style=`
  is absent.
- A highlighted block contains no `style=` and every `sh-*` class it uses has a rule in `SHIKI_CSS`
  — `render-markdown.test.ts` (js + diff + ansi corpus: diff exercises Astro's `user-select:none`
  marker spans, ansi the `terminal.ansi*` palette as foreground and background).
- `SHIKI_CSS` has a rule for every foreground/background colour in the theme's `tokenColors` and
  every `terminal.*` colour (a ```ansi fence paints with those), and the theme it is generated
  from is the theme `MARKDOWN_OPTIONS` highlights with — `shiki-classes.test.ts`.
- `classesFor` maps only colour/font-decoration declarations, and a colour only if it is in the
  theme palette (so no class is ever emitted without a rule); it drops `position`, `url(…)`,
  named colours and out-of-palette hex — `shiki-classes.test.ts`. Consequence: an ANSI
  **truecolor** escape (`38;2;r;g;b`, unbounded) renders in the inherited block colour instead of
  its exact colour. Accepted; the old inline-style path honoured it, nothing in the corpus uses it.
- The preview page ships `SHIKI_CSS`, renders a code block through classes, and contains no
  `style=` from author markup — `preview.test.ts`; the `.jgal` CSS parity guard stays green.
- `GET /posts/:tk/preview` carries the CSP and other admin JSON routes do not —
  `server.test.ts`.

## Misuse cases considered

- **Author types a `style` attribute on any element** → stripped by the schema (no exceptions).
- **Author types Shiki's classes** → at most theme colours on text; `.astro-code` adds
  `overflow-x:auto` only.
- **Future theme switch to dual `themes`** → Shiki emits `--shiki-light:` custom properties, which
  `classesFor` drops; colours vanish and `render-markdown.test.ts` fails. Documented as an
  `@ai-warning` in `shiki-classes.ts`; extend mapping and generator together.
- **Sanitizer regression lets `<script>` through** → blocked on the preview by CSP (no
  `script-src`, `default-src 'none'`); the public site still has no CSP (out of scope — admin pages
  use inline scripts and the blog is served at parity with the old nginx).
- **Draft references an image on another origin** → blocked by `img-src` on the preview only;
  shows as a broken image there while the live site would load it. Accepted: the CSP protects the
  admin session, not preview fidelity for foreign images.

## Rollback

Revert the PR. Nothing persisted changes shape: no schema, no stored content, no new files on
`/data`. A rebuild after revert restores inline-style highlighting; previews lose the CSP header.

## Residual risk

`'unsafe-inline'` on `style-src` means an author-typed `<style>` element would apply if the
sanitizer ever allowed one — it does not (`style` is not in `defaultSchema.tagNames`), and
`body-images.test.ts` would have to be weakened first. Nonce-based styles would remove the
directive but require threading a per-request nonce through `renderPreviewHtml` and the gallery
`style` attributes, which is not worth it for a page with no scripts.
