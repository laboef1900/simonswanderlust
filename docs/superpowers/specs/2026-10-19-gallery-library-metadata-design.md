# Gallery descriptions follow the Media library

Date: 2026-10-19
Status: Owner-approved behavior: Media changes appear on the next site rebuild, without republishing each article.
Risk: High — published-content composition and post-sanitize gallery rendering.

## Problem and decision

The owner edited photo titles, localized alt text and descriptions in Media, but existing article galleries retained insertion-time copies. The owner chose “On the next site rebuild” over refreshing only when each article is published. This supersedes the frozen gallery-description rule in the 2026-07-26 media-library specification.

Media is authoritative for gallery alt text and captions, independently in DE and EN. Empty library fields override stored values; a missing media row retains the stored values. Titles remain library labels, not replacement alt text or an additional public caption. Hero/title images and ordinary inline images are unchanged.

## Boundaries and invariants

- Build article bodies, order, dimensions, formats, routes and all other post fields exclusively from published snapshots. Overlay only current gallery alt/caption at rendering time; do not rewrite posts, snapshots or media rows.
- The trips loader reads only media key and localized alt/caption columns, once per load. No GPS, credentials, EXIF or uploader identity enters site content.
- `transformBodyImages` accepts an optional `ReadonlyMap<string, { alt: string; caption: string }>` keyed by full base image URL. The override is consulted only for galleries, after the existing origin/protocol, dimensions and format guards. Coerce metadata to strings and retain hast escaping. No title-to-alt or cross-locale fallback.
- Draft preview resolves the same metadata from the media store and passes it to the same renderer. Missing rows preserve old descriptions; lookup failures propagate as sanitized errors rather than silently showing stale text.
- Editor gallery widgets and gallery selection show current library descriptions. Library-backed descriptions are edited in Media, not as ineffective per-article overrides; unresolved photos retain the existing post-local editing path. Preserve JPEG markers, gallery membership, layout and undo behavior. Never save edits to Media as a hidden side effect of editing an article.
- Saving Media does not trigger a build. The next explicit rebuild or publication-triggered build refreshes galleries. Existing releases remain untouched until successful build promotion.

## Critical review

Could this leak draft edits through a rebuild? Only explicitly approved library alt/caption changes are live inputs; published snapshots still supply article text and structure. A regression must exercise a draft edit alongside a media edit and prove only the latter appears.

Could fallback resurrect a deliberately cleared description or lose imported photos? Presence of a media row, not non-empty strings, decides precedence. Absence alone falls back. The overlay never changes photo identity or dimensions and never admits a URL the renderer would reject.

Could the editor imply an override that the build ignores? Library-backed gallery fields must visibly use library values and direct editing to Media; post-local AI/alt controls remain only for unresolved library photos.

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
