# simonswanderlust.com — site

The Astro 7 rebuild of [simonswanderlust.com](https://simonswanderlust.com) (DE/EN travel blog).
Architecture overview in [`../ARCHITECTURE.md`](../ARCHITECTURE.md); design spec and phase plans
live in `../docs/superpowers/`.

Content is **loaded from Postgres at build time** (`src/lib/postgres-loader.ts`), not from git —
the MDX files under `src/content/trips/` are an authoring reference / export-only backup. The
`app` container (`uploader/src/build.ts`) spawns `astro build` **in-process** from the database and
atomically publishes the result to `/data/site/current`, which it also serves directly — no
separate build server or web server. See `../ARCHITECTURE.md` for the full pipeline.

## Commands

| Command | Action |
| :-- | :-- |
| `npm install` | Install dependencies |
| `npm run dev` | Dev server at `localhost:4321` |
| `npm run build` | Build production site to `./dist/` |
| `npm run preview` | Preview the build locally |
| `npm test` | Run vitest suites (i18n, paths, trips, format) |
| `npx astro check` | Type-check `.astro`/`.ts` files |

### Empty-install coverage

With no published stories, Home and Destinations keep their localized explanation
instead of a story grid or map teaser. Map explains where future published trips
will appear without mounting a map or an empty destination list. Empty regions
are neither generated nor linked; RSS remains a valid empty channel and the
sitemap lists only the generated public pages. These rules follow all four
supported primary/enabled-language configurations.

`TEST_DATABASE_URL=<test database> npm test` also runs
`test/empty-build.integration.test.ts`: it creates a private schema, runs the real
migrations and Astro builds in each language mode, and checks the emitted HTML,
RSS and sitemap. It removes only its own schema and temporary build/cache output.
The database role needs schema-creation permission; without `TEST_DATABASE_URL`
this integration suite is skipped. CI supplies it. Existing populated-page
rendering tests continue to cover map pins, fallback links and locale navigation.

## Structure

- `src/content/trips/{de,en}/<slug>.mdx` — authoring reference / backup; the `id`s (`de/<slug>`, `en/<slug>`) and filenames are the live WordPress slugs (SEO contract — never rename). `heroImage` is a remote URL object `{src,width,height,alt}` served by the image server (no binaries in git).
- `src/i18n/ui.ts` — ALL UI strings, both locales (completeness-tested; no hardcoded strings in components)
- `src/lib/` — tested helpers: `postgres-loader` (Content Layer loader), `paths`/`trips` (live WP slugs, locale pairing), `format`, `images`, `map-data`, and `body-images` (renders body images as responsive `<picture>` **and sanitizes the DB-sourced HTML** — see [`../SECURITY.md`](../SECURITY.md))
- `src/components/pages/` — shared per-page components rendered by thin locale routes in `src/pages/`
