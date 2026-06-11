# simonswanderlust.com — site

The Astro 6 rebuild of [simonswanderlust.com](https://simonswanderlust.com) (DE/EN travel blog).
Design spec and phase plans live in `../docs/superpowers/`.

## Before first build

Hero images are not in git (no-binaries policy). Download them once:

    ./scripts/fetch-sample-images.sh

## Commands

| Command | Action |
| :-- | :-- |
| `npm install` | Install dependencies |
| `npm run dev` | Dev server at `localhost:4321` |
| `npm run build` | Build production site to `./dist/` |
| `npm run preview` | Preview the build locally |
| `npm test` | Run vitest suites (i18n, paths, trips, format) |
| `npx astro check` | Type-check `.astro`/`.ts` files |

## Structure

- `src/content/trips/{de,en}/<slug>.mdx` — one story per language; filenames are the live WordPress slugs (SEO contract — never rename)
- `src/i18n/ui.ts` — ALL UI strings, both locales (completeness-tested; no hardcoded strings in components)
- `src/lib/` — tested helpers: paths (live WP slugs), trips (locale/pairing), format
- `src/components/pages/` — shared per-page components rendered by thin locale routes in `src/pages/`
