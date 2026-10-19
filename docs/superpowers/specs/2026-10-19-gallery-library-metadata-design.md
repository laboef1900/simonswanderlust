# Gallery descriptions follow the Media library

Date: 2026-10-19
Status: Owner-approved behavior: Media changes appear on the next site rebuild, without republishing each article.
Risk: High — published-content composition and post-sanitize gallery rendering.

## Problem and decision

The owner edited photo titles, localized alt text and descriptions in Media, but existing article galleries retained insertion-time copies. The owner chose “On the next site rebuild” over refreshing only when each article is published. This supersedes the frozen gallery-description rule in the 2026-07-26 media-library specification.

Media is the default source for gallery alt text and captions, independently in DE and EN. Empty library fields override stored values; a missing media row retains the stored values. Titles remain library labels, not replacement alt text or an additional public caption. Hero/title images and ordinary inline images are unchanged. The owner-approved gallery-local caption controls below supersede caption authority only where explicitly edited.

## Boundaries and invariants

- Build article bodies, order, dimensions, formats, routes and all other post fields exclusively from published snapshots. Overlay only current gallery alt/caption at rendering time; do not rewrite posts, snapshots or media rows.
- The trips loader reads only media key and localized alt/caption columns, once per load. No GPS, credentials, EXIF or uploader identity enters site content.
- `transformBodyImages` accepts an optional `ReadonlyMap<string, { alt: string; caption: string }>` keyed by full base image URL. The override is consulted only for galleries, after the existing origin/protocol, dimensions and format guards. Coerce metadata to strings and retain hast escaping. No title-to-alt or cross-locale fallback.
- Draft preview resolves the same metadata from the media store and passes it to the same renderer. Missing rows preserve old descriptions; lookup failures propagate as sanitized errors rather than silently showing stale text.
- Editor gallery widgets and gallery selection show current library descriptions unless a gallery-local caption overrides them. Alt text remains library-authoritative; unresolved photos retain post-local alt editing. Preserve JPEG markers, gallery membership, layout and undo behavior. Never save edits to Media as a hidden side effect of editing an article.
- Saving Media does not trigger a build. The next explicit rebuild or publication-triggered build refreshes galleries. Existing releases remain untouched until successful build promotion.

## Critical review

Could this leak draft edits through a rebuild? Only explicitly approved library alt/caption changes are live inputs; published snapshots still supply article text and structure. A regression must exercise a draft edit alongside a media edit and prove only the latter appears.

Could fallback resurrect a deliberately cleared description or lose imported photos? Presence of a media row, not non-empty strings, decides precedence. Absence alone falls back. The overlay never changes photo identity or dimensions and never admits a URL the renderer would reject.

Could the editor imply an override that the build ignores? Library-backed alt fields must visibly use library values and direct editing to Media; gallery-local captions must pass through the same fence representation in editor, save, export, preview and build.

## Verification and recovery

Regression coverage: subsequent loader runs observe changed library descriptions; DE/EN isolation; empty values; missing rows; published snapshot isolation; HTML escaping and unchanged gallery URL guards; preview and editor behavior. Run both affected suites and type checks, plus a real local rendering/browser smoke with isolated fixture data. Do not modify the owner's stored photos or articles.

Rollback: revert the code and rebuild. Existing stored post metadata and published snapshots are not migrated or overwritten by the rendering overlay, so the prior composition remains recoverable. A failed build leaves the previous release active. No schema change or data migration is needed.

## Observed verification

- `site/`: `astro check` — 95 files, zero errors/warnings/hints; Vitest — 24 files, 300 tests passed.
- `uploader/`: `tsc --noEmit` passed; Vitest with an isolated Postgres 18 `TEST_DATABASE_URL` — 77 files, 1,894 tests passed, including integration suites.
- Real `src/main.ts` and Astro builds against a separate fixture database: saved DE/EN descriptions through the Media page, reopened the real editor, and fetched draft preview. Both showed the current localized library text without saving the article.
- The served article retained its old description before rebuilding. `POST /rebuild` succeeded and both served locale galleries changed, while an intentionally unpublished body edit remained absent.
- Clearing DE alt/caption through Media and rebuilding emitted `alt=""` and no caption; EN stayed unchanged. Editor and public gallery screenshots confirmed loaded images and current captions. Only disposable fixture content was edited; no owner content or deployed releases were changed.
- About-page galleries intentionally retain their existing composition: this change is scoped to article galleries.

## Gallery-local caption controls — owner approved 2026-10-19

The owner selected **This gallery only**: the gallery menu offers **Show captions**
and an editable caption for each selected photo. Editing affects this occurrence of
the gallery in the active locale, never Media or another gallery using the same URL.

Contract:

- Existing galleries keep showing captions by default and keep following Media until
  an author explicitly edits a caption. A reset action returns a photo to its current
  library caption (or stored fallback when no row exists).
- `#captions: hidden` inside the gallery fence hides all its public captions, including
  lightbox captions, without deleting their text. Missing/unknown directive values mean
  visible. The first matching directive wins, as for layout. Toggling on removes the
  directive; unrelated directives survive.
- A photo line's `caption-override="…"` stores its gallery-local plain-text caption.
  Empty is an intentional clear; absence means inherit. Use the existing gallery
  entity escaping and 1,000-character cap. This attribute stays on the photo line
  through normalization and export: it MUST NOT enter the URL-keyed `images` map,
  which would leak changes into other galleries.
- Precedence: hidden gallery → no caption; explicit line override → override (including
  empty); otherwise current localized Media caption → stored caption fallback.
  Alt text, URL allow-listing, dimensions, formats and photo order stay unchanged.
- Picker edits are buffered until Insert/Update gallery; Cancel changes nothing.
  Caption edits survive selection reordering, pagination and asynchronous Media
  resolution. Hidden captions remain editable so showing them restores the author's text.
- No schema migration, new endpoint, Media write or live publication. The existing draft,
  publish and rebuild boundaries apply. Escape through hast text nodes after sanitizing;
  a caption containing HTML or fence syntax must remain text, not markup.

Verification: regression cases cover repeated URLs in distinct galleries, empty and
escaped overrides, hide/show retention, reset/inheritance, DE/EN isolation, save/export
round-trips, late library responses and Cancel. Browser smoke checks the real picker,
editor widget and rendered gallery at desktop/mobile sizes using disposable content.
Rollback: revert and rebuild; no persistent data migration. Retained fence attributes
are ignored by the old renderer, which resumes library captions. Existing releases
remain unchanged until successful promotion.

### Caption-controls verification

- Site: `astro check` passed for 95 files with zero errors, warnings or hints;
  all 314 tests in 24 files passed.
- Uploader: `tsc --noEmit` passed; all 1,934 tests in 77 files passed with an
  isolated Postgres 18 integration database. Regression coverage includes caption
  text that resembles Markdown images or BodyImage tags across save/export/import,
  so author text is not interpreted as another photo.
- Real `src/main.ts`, browser and Astro publish/build smoke against disposable
  DE/EN content: edited, reordered, cancelled, reset, hid and restored captions;
  saved/reopened the picker; checked escaped text in draft preview; published the
  fixture and opened its lightbox. The custom caption appeared in its own gallery,
  while the second gallery sharing the photo and the English locale kept Media text.
  Hiding the first gallery removed captions from both the page and lightbox while
  its saved override remained editable. Media captions were unchanged.
- Desktop (1360px) and phone (390px) picker checks: labelled controls, editable
  hidden text, reachable confirm/reset actions, and no horizontal overflow.
  No owner content or deployed release was modified.
