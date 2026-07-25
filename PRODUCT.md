# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Simon (sole author and admin): a travel photographer and writer who manages a bilingual (DE/EN) travel blog. Publishes trip reports with rich photography, interactive maps, and key facts from expeditions around the world.

## Product Purpose

Simon's Wanderlust is a personal travel journal that presents expedition-style trip reports with professional photography (shot on Leica Q2 and Canon AE-1), interactive route maps (Protomaps/PMTiles), and bilingual content. The admin ("Image Station") is the content management backend: authoring, editing, uploading photos, publishing, and managing the live site.

## Positioning

Self-hosted, single-author travel CMS with a custom bilingual editor, automatic responsive image pipeline (AVIF/WebP variants), interactive map integration, and a publish/snapshot workflow that keeps drafts isolated from the live site.

## Operating Context

- Simon accesses the admin on desktop browsers (primarily) to write and edit posts, upload and manage photos, and publish to the live site.
- The editor handles DE/EN post pairs with a shared translation key, markdown body editing (EasyMDE), hero image and body image management, key facts, stops/route data, and coordinates.
- Publishing triggers a static site rebuild (Astro) inside a Docker container; the live blog is served as pre-rendered HTML.
- Image uploads are processed through a pipeline that generates responsive AVIF/WebP variants at multiple sizes.

## Capabilities and Constraints

- **Pages:** Login, Photo Upload (index), Posts list, Post Editor, Media Library, About Page editor, Import (WordPress WXR), Settings, Users management.
- **Auth:** Cookie-based sessions with admin/non-admin roles; rate-limited login.
- **Editor:** Bilingual DE/EN tabs, slug preview, hero image picker, body markdown with EasyMDE, key facts and stops editors, revision history, preview, publish/unpublish.
- **Tech stack:** Fastify server, plain HTML/CSS/JS admin UI (no framework), PostgreSQL, Docker.
- **Constraint:** Admin UI is vanilla HTML/CSS/JS served as static files from `uploader/public/`; no build step, no bundler, no framework.

## Brand Commitments

- Name: "Simon's Wanderlust" (blog), "Expedition Log · Image Station" (admin branding)
- Fonts: Inter (sans), IBM Plex Mono (mono) — self-hosted from `uploader/public/fonts/`
- Colors: Navy (#142a42), Brand Red (#d23b30), Canvas (#fbfbfd)
- Visual identity: Expedition/cartography theme with dashed route dividers, passport stamps, mono-tracked uppercase labels

## Evidence on Hand

- 20 published trip reports spanning Europe, North America, South America
- Real photography from Leica Q2 and Canon AE-1
- Interactive map with Protomaps PMTiles

## Product Principles

1. **Author-first workflow** — Every admin interaction serves the solo author's publishing workflow; no multi-tenant complexity.
2. **Photography leads** — The image pipeline and visual presentation treat photos as the primary content, not decoration.
3. **Bilingual by design** — DE/EN content lives as a first-class pair, not a translation afterthought.
4. **Self-hosted independence** — The entire stack runs in a single Docker container with no external dependencies.

## Accessibility & Inclusion

WCAG 2.1 AA minimum. Admin must be keyboard-navigable and screen-reader usable.
