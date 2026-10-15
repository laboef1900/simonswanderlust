# WXR Importer — CommonMark Image Destinations and Classic Shortcodes — Design

**Date:** 2026-09-05
**Status:** Proposed (implements the "Suggested fix" on issue #125)
**Risk:** **High.** CLAUDE.md's Change Risk table names WXR import explicitly: this changes which
URLs the importer hands to `safeFetch`, and what body Markdown it stores. Requires this spec,
trust-boundary analysis, the full affected suite, explicit human approval, and a documented
rollback plan.
**Repos touched:** blog repo — `uploader/src/wp-content.ts`, `uploader/src/wp-import.ts` and
their tests. No `site/` change, no schema change, no new endpoint, no new runtime dependency, no
UI change.
**Builds on:** `2026-08-25-wxr-import-image-cap-design.md` (#96: `rehostUrlSet` must mirror
`buildLocale`'s extraction exactly) and `2026-09-05-wxr-import-pair-identity-design.md` (#99, the
branch this stacks on).
**Closes:** #125.

## Why this exists

The importer converts post HTML with Turndown 7.2.4 and then finds body images with
`/!\[([^\]]*)\]\(([^)]+)\)/g`. Turndown does not write `![alt](url)`; it writes CommonMark:

| `<img>` attribute | Turndown output | What the regex captured |
| --- | --- | --- |
| `title="IMG_0001"` | `![alt](https://wp/a.jpg "IMG_0001")` | `https://wp/a.jpg "IMG_0001"` → `safeFetch` requested `…/a.jpg%20%22IMG_0001%22` → 404 → "download failed", hot-link kept |
| `src` containing `(` or `)` | `![alt](https://wp/p-\(1\).jpg)` | `https://wp/p-\(1\` — a bogus URL, or no match |
| `src` containing a space | `![alt](<https://wp/my photo.jpg>)` | `<https://wp/my photo.jpg>` → fetch of a URL that starts with `<` |
| `alt` containing `]` | `![Day \[1\]](…)` | no match at all — the image is silently skipped |

Elementor's image widget sets `title` from the attachment title, which defaults to the filename,
so the first row is the **common** single-body-image case, not an edge case.

Secondary (same file, lower priority per the issue): classic pre-Elementor shortcodes
`[gallery ids="1,2,3"]` and `[caption …]…[/caption]` reach Turndown as text and are emitted as
escaped literals (`\[gallery ids="1,2,3"\]`), so a classic post imports "clean" with its galleries
silently lost and caption markup shown as junk.

## Decision

1. **Parse what Turndown writes** rather than reconfigure Turndown to write something else.
   `markdownImages(md)` in `wp-content.ts` matches the CommonMark inline-image grammar restricted
   to what Turndown can produce — alt with backslash escapes; destination either `<…>` or bare with
   backslash escapes and one level of balanced parentheses; an optional title in `"…"`, `'…'` or
   `(…)` — and returns, per image, the exact source text (for `replaceAll`), the alt **as written**
   (still escaped, so it can be re-emitted verbatim), and the destination **decoded** (escapes and
   `<…>` removed) — the URL the `<img>` actually carried.

   Why not override Turndown's image rule to emit a bare destination: the stored body is Markdown
   that the site renders. A bare `(` in a destination is invalid CommonMark; a bare space ends
   the destination. The escaped form is the *correct* Markdown for the WordPress URL, which is what
   must remain in the body when a fetch fails (issue #85: "the original URL is left in place rather
   than lost"). After a successful re-host the reference is rewritten to `![alt](<our url>)` —
   our URLs contain none of those characters — and the title is dropped: it was the attachment
   filename, and nothing downstream reads titles.

2. **One parser for both extraction sites.** `buildLocale` (does the work) and `rehostUrlSet`
   (the #96 pre-flight count) both call `markdownImages` on the output of the same
   `htmlToMarkdown(html, attachments)` call shape. The #96 invariant — the count equals what the
   import fetches — is preserved by construction and pinned by a test that sets `maxImages` to the
   exact count of a titled/escaped/spaced body.

3. **Classic shortcodes expand before Turndown, through the existing gallery pipeline.**
   `expandShortcodes(html, attachments)` runs on the HTML when an attachment map is supplied
   (`importWxr` always supplies one; plain `htmlToMarkdown(html)` is unchanged):
   - `[gallery ids="1,2,3"]` → for each id present in the export's attachment map, an anchor of
     the exact shape Elementor's lightbox emits (`<a data-elementor-lightbox-slideshow="wp-gallery-N"
     href="…"></a>`), so **one** pipeline (`elementorLightboxGallery` rule + `foldGalleries`)
     produces the ```gallery fence for both eras. Ids with no attachment are dropped; a gallery
     that resolves to nothing, or has no `ids` (WordPress's "all media attached to this post",
     which the export cannot express), is left as it was rather than emitted empty.
   - `[caption …]<img …> text[/caption]` → `<figure><img …><figcaption>text</figcaption></figure>`,
     which Turndown renders as the image followed by the caption as its own paragraph. Nothing is
     lost and no shortcode markup is shown. When WordPress linked the image to its full-size file
     (`<a href><img></a>`), the whole linked subtree is kept, so the reader's click-through survives
     as `[![alt](thumb)](full)`. A `[caption]` without an `<img>` is unwrapped to its inner content.
   - Any other shortcode is unchanged (pre-existing behaviour). Counting and warning on them would
     need a warnings channel out of the pure `htmlToMarkdown`; not worth a second reporting path
     for a corpus that is Elementor-authored.

## Trust boundaries

| Boundary | Control | Effect of this change |
| --- | --- | --- |
| WXR body → URL handed to `safeFetch` | `assertFetchableUrl` inside `safeFetch`, on every attempt | **Unchanged.** The decoded destination is the same string the `<img src>` carried; before, a *mangled* version of it was fetched. Every URL still passes through the SSRF guard, the timeout and the size cap, and the `https?://` scheme filter still runs before `rehost`. |
| WXR body → stored Markdown | `normalizeGalleryFences` + `images`-map validation at the `posts.ts` store chokepoint | **Unchanged.** Expanded galleries are ordinary ```gallery fences and go through the same store-side validation as Elementor ones; a `[caption]` becomes a normal image plus a paragraph. No new markup reaches the renderer. |
| Pre-flight image count (#96) → actual fetches | `rehostUrlSet` mirrors `buildLocale` | **Preserved.** Both call the same two functions with the same arguments; a test pins the count for titled/escaped/spaced destinations and for an expanded shortcode gallery. |
| Attachment map → anchor `href` | `foldGalleries` emits the URL onto a fence line; the store validates fence URLs | **New input path, same sink.** An attachment URL from the export lands on a gallery line exactly as an Elementor `href` would; it is re-hosted (or, on failure, left as a hot-link) by the same code. |

## Invariants (each has a test)

`test/wp-content.test.ts`, `describe('markdownImages')` and `describe('htmlToMarkdown classic shortcodes')`:

1. A titled image yields the un-titled URL, and its `full` text is the whole `![…](… "…")`.
2. Escaped parentheses in a destination are decoded.
3. A `<…>`-wrapped destination containing a space is decoded.
4. An escaped `]` in alt is preserved in `alt` and does not hide the destination.
5. Titles with escaped quotes, and single-quoted titles, are stripped.
6. Several images on one line are each returned with their own exact source text.
7. A plain link and an empty destination are not images.
8. `[gallery ids]` expands to one fence per shortcode, unknown ids are dropped, and a gallery with
   no `ids` or only unknown ids is left untouched; no expansion without an attachment map.
9. `[caption]` yields the image followed by its caption text, with no shortcode markup left; a
   linked image keeps its link.

`test/wp-import.test.ts`, `describe('importWxr Turndown image destinations')`:

10. A titled image is fetched by its real URL, counted as hosted with no warning, and rewritten to
    `![alt](<re-hosted>)` with its dimensions in `images`.
11. Escaped-paren and spaced destinations are fetched by their real URLs, and the #96 pre-flight
    count equals the fetch count (`maxImages` set to exactly that count does not throw).
12. A classic `[gallery ids]` shortcode is expanded against the export's attachments, re-hosted,
    and stored as a fence with its dimensions lifted into `images`.

## Definition of done

- `npx tsc --noEmit` and `npm test` green in `uploader/` with `TEST_DATABASE_URL` set; CI green.
- Every invariant above has a test; invariants 1–5 and 10–11 fail on the pre-#125 regex.
- Explicit human approval before merge, per CLAUDE.md's High-risk row.

## Rollback

Revert the single commit. No schema, no migration, no persistent state. The importer returns to the
naive regex — titled images 404 and are left hot-linked, as documented in #125.

## Not included here

- **Warning on unhandled shortcodes** — see Decision 3.
- **#98 `nameFromUrl` non-injectivity** — a decoded destination goes through the same
  `nameFromUrl` as before; `p-(1).jpg` and `p-(2).jpg` still collide on `p-1`/`p-2` only insofar
  as they did already.
