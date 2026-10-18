# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Simon (sole author and admin): a travel photographer and writer who manages a bilingual (DE/EN) travel blog. Publishes trip reports with rich photography, interactive maps, and key facts from expeditions around the world.

## Product Purpose

Simon's Wanderlust is a personal travel journal that presents expedition-style trip reports with professional photography (shot on Leica Q2 and Canon AE-1), interactive route maps (Protomaps/PMTiles), and bilingual content. The admin ("Wanderlust Studio") is the content management backend: authoring, editing, uploading photos, publishing, and managing the live site.

## Positioning

Self-hosted, single-author travel CMS with a custom bilingual editor, automatic responsive image pipeline (AVIF/WebP variants), interactive map integration, and a publish/snapshot workflow that keeps drafts isolated from the live site.

## Operating Context

- Simon accesses the admin on desktop browsers (primarily) to write and edit posts, upload and manage photos, and publish to the live site.
- The editor handles DE/EN post pairs with a shared translation key, markdown body editing (EasyMDE), hero image and body image management, key facts, stops/route data, and coordinates.
- Publishing triggers a static site rebuild (Astro) inside a Docker container; the live blog is served as pre-rendered HTML.
- Image uploads are processed through a pipeline that generates responsive AVIF/WebP variants at multiple sizes.

## Capabilities and Constraints

- **Pages:** Login, Photo Upload (index), Posts list, Post Editor, Media Library, About Page editor, Comments moderation queue, Import (WordPress WXR), Settings, Users management.
- **Comment moderation queue:** Reader comments on trip reports are held until an admin approves them (`/admin/comments.html`). Admins approve, unapprove, delete (erasure, with confirmation) and reply as the author; author replies publish immediately. Comments are self-hosted in Postgres — Principle 4 still holds, no third-party comment service.
- **Auth:** Cookie-based sessions with admin/non-admin roles; rate-limited login.
- **Editor:** Bilingual DE/EN tabs, slug preview, hero image picker, body markdown with EasyMDE, key facts and stops editors, revision history, preview, publish/unpublish. Country names can fill approximate map coordinates offline without replacing saved/manual locations. Optional browser-direct excerpt suggestions reuse Story Review settings and require explicit acceptance.
- **Media library:** One browsable store for every hosted photo — bulk drag-and-drop upload, virtual folders, search, per-item alt text. Optional browser-direct AI suggests title, DE/EN alt text and captions and tags for one photo (reviewed before saving) or fills empty fields for a selection or a whole folder view (saved as it runs; overwriting is opt-in per run). Encoding runs asynchronously behind a queue that a site build preempts; publishing is refused while a referenced photo is still encoding. GPS and uploader identity are redacted for non-admin authors.
- **Galleries:** Multiple photos render as one grid from a fenced `gallery` block, composed via an "Insert / edit gallery" picker that reuses the library's own alt text. Three layout modes (justified rows at breakout or column width, or a slider), each with a lightbox.
- **Photo privacy:** Published variants carry an eight-tag EXIF allow-list — no GPS, XMP or IPTC — applied at encode time, so it covers WordPress-imported photos as well as direct uploads.
- **Tech stack:** Fastify server, plain HTML/CSS/JS admin UI (no framework), PostgreSQL, Docker.
- **Constraint:** Admin UI is vanilla HTML/CSS/JS served as static files from `uploader/public/`; no bundler and no framework. The only build step copies vendored fonts and EasyMDE into `public/` (`Dockerfile` runs `scripts/copy-fonts.mjs` and `scripts/copy-easymde.mjs`), so `public/fonts/` and `public/vendor/` are generated, not checked in.

## Brand Commitments

- Name: "Simon's Wanderlust" (blog), "Wanderlust Studio" (admin), with the descriptor "Simon's travel journal".
- Fonts: Inter (sans), IBM Plex Mono (mono) — self-hosted from `uploader/public/fonts/`
- Public blog colors: Navy (#142a42), Brand Red (#d23b30), Canvas (#fbfbfd).
- Public visual identity: Expedition/cartography theme with dashed route dividers, passport stamps, mono-tracked uppercase labels.
- Admin shell and Posts: approved **Editorial desk** (mockup 2), following the owner's CompendiQ reference — light gray navigation, white workspace, compact lists, and steel-blue active navigation/New post. Publish and destructive actions retain red; the public blog is unchanged. Exact scoped tokens and responsive behavior live in `DESIGN.md`.

## Evidence on Hand

- 20 published trip reports spanning Europe, North America, South America
- Real photography from Leica Q2 and Canon AE-1
- Interactive map with Protomaps PMTiles

## Product Principles

1. **Author-first workflow** — Every admin interaction serves the solo author's publishing workflow; no multi-tenant complexity.
2. **Photography leads** — The image pipeline and visual presentation treat photos as the primary content, not decoration.
3. **Bilingual by design** — DE/EN content lives as a first-class pair, not a translation afterthought.
4. **Self-hosted independence** — The stack is two containers, `app` (Fastify, which also builds the Astro site in-process) and `db` (Postgres), with no third-party runtime services.
   Owner-approved exception (2026-10-16): explicit waypoint searches in the editor
   use external Nominatim through the authenticated app, with caching/rate limits
   and manual-coordinate fallback. Public maps remain entirely self-hosted.

## Accessibility & Inclusion

WCAG 2.1 AA minimum. Admin must be keyboard-navigable and screen-reader usable.
