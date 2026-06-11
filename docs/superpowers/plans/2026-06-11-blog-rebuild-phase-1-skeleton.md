# Blog Rebuild — Phase 1: Skeleton + Design System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable Astro skeleton of the new simonswanderlust.com — design system, DE/EN i18n, content model, home/story/region/about pages — rendering sample content with the approved editorial-magazine design.

> **Version note (Task 1 outcome):** create-astro installed **Astro 6**, not 5. Reviewed against the v6 breaking-changes list and accepted: this plan already uses the v6 content layer API (`src/content.config.ts`, glob loader, `render(entry)`), the i18n config (`prefixDefaultLocale: false`) is unaffected, `image()` schema and mdx/rss/sitemap are unchanged. Requires Node ≥22.12 (local: v26). All "Astro 5" references below read as "Astro 6".

**Architecture:** Static Astro 5 site in `site/` (repo subfolder). Content lives in MDX content collections (`src/content/trips/{de,en}/<slug>.mdx`), one file per trip per language, paired via `translationKey`. German is the default locale at root URLs; English under `/en/`. Shared page components (`HomePage`, `StoryPage`, …) render both locales so DE/EN can never drift apart. Zero client JavaScript in this phase (map island comes in Phase 3).

**Tech Stack:** Astro 5 (≥5.2), Tailwind CSS 4 (`@tailwindcss/vite` via `astro add tailwind`), `@tailwindcss/typography`, MDX, `@astrojs/sitemap`, `@astrojs/rss`, `@fontsource-variable/inter`, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-blog-redesign-design.md`. This plan covers spec phase 1 only. Phases 2 (content migration), 3 (travel map), 4 (polish + cutover) get their own plans once this one lands — their details depend on the landed component APIs and the real exported content.

**Conventions for all tasks:**
- `npm`/`npx` commands run from `site/`; `git` commands run from the repo root (`/Users/simon/Documents/localGIT/blog`).
- Never commit binaries (user git policy): sample images are downloaded by script and gitignored.
- All UI strings come from `src/i18n/ui.ts` — hardcoded UI text in a component is a defect (this is the regression guard for the live site's DE-text-in-EN-footer bug).

**Design tokens (from approved mockup voice 3):** canvas `#FBFBFD`, navy `#142A42`, ink `#16212E`, brand red `#D23B30`, light red (labels on photos) `#FF5A4E`, font Inter.

**URL contract (hard requirement, from live site):**
| Page | DE | EN |
|---|---|---|
| Home | `/` | `/en/` |
| Story (sample 1) | `/sonne-und-abenteuer-rhodos/` | `/en/sun-and-adventure-on-rhodes/` |
| Story (sample 2) | `/reisebericht-4-tage-bukarest/` | `/en/4-day-travel-report-bucharest/` |
| Regions index | `/reiseziele/` | `/en/destinations/` |
| Region | `/reiseziele/europa/` etc. | `/en/destinations/europe/` etc. |
| About | `/uber-mich/` | `/en/about-me/` |

---

### Task 1: Repo prep + Astro scaffold

**Files:**
- Modify: `.gitignore` (repo root)
- Create: `site/` (scaffolded by create-astro: `package.json`, `astro.config.mjs`, `tsconfig.json`, `src/pages/index.astro`, …)

- [ ] **Step 1: Check Node version**

Run: `node --version`
Expected: `v20.x` or newer (Astro 5 requires ≥18.17). If older, stop and report.

- [ ] **Step 2: Scope root .gitignore patterns to repo root**

The current root `.gitignore` blocks `*.jpeg`/`*.png` globally, which would swallow future site assets. Replace the file's content with:

```gitignore
.DS_Store
.venv/
.superpowers/
.playwright-mcp/
/*.jpeg
/*.png
/home-network.txt
.env
.env.*
```

- [ ] **Step 3: Scaffold the Astro project**

Run (from repo root):
```bash
npm create astro@latest site -- --template minimal --no-git --install --yes
```
Expected: exits 0, creates `site/` with `package.json`, `astro.config.mjs`, `tsconfig.json`, `src/pages/index.astro`.

- [ ] **Step 4: Verify the dev build works**

Run: `cd site && npm run build`
Expected: `Complete!` / build finishes with a `dist/` directory, no errors.

- [ ] **Step 5: Verify tsconfig is strict**

Run: `cat site/tsconfig.json`
Expected: contains `"extends": "astro/tsconfigs/strict"`. If not, edit it to:
```json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
```

- [ ] **Step 6: Commit**

```bash
git add .gitignore site/
git commit -m "chore: scaffold Astro 5 project in site/"
```

---

### Task 2: Integrations, Tailwind 4 design tokens, fonts

**Files:**
- Modify: `site/astro.config.mjs`
- Modify: `site/src/styles/global.css` (created by `astro add tailwind`)
- Modify: `site/package.json` (deps)

- [ ] **Step 1: Add integrations**

Run from `site/`:
```bash
npx astro add tailwind mdx sitemap --yes
npm install @astrojs/rss @fontsource-variable/inter
npm install -D @tailwindcss/typography vitest @astrojs/check typescript
```
Expected: `astro.config.mjs` now imports `tailwindcss` (vite plugin), `mdx`, `sitemap`; `src/styles/global.css` exists with `@import "tailwindcss";`.

- [ ] **Step 2: Configure site, i18n, trailing slashes**

Replace `site/astro.config.mjs` with:

```js
// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://simonswanderlust.com',
  trailingSlash: 'always',
  i18n: {
    defaultLocale: 'de',
    locales: ['de', 'en'],
    routing: { prefixDefaultLocale: false },
  },
  integrations: [mdx(), sitemap()],
  vite: { plugins: [tailwindcss()] },
});
```

Note: `sitemap()` is used WITHOUT its `i18n` option — it pairs URLs by identical paths, but our DE/EN slugs differ. hreflang is emitted as `<link>` tags by the Base layout (Task 7) instead.

- [ ] **Step 3: Design tokens in global.css**

Replace `site/src/styles/global.css` with:

```css
@import 'tailwindcss';
@plugin '@tailwindcss/typography';

@theme {
  --color-canvas: #fbfbfd;
  --color-navy: #142a42;
  --color-ink: #16212e;
  --color-brand-red: #d23b30;
  --color-brand-red-light: #ff5a4e;
  --font-sans: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
}
```

- [ ] **Step 4: Verify build with Tailwind**

Replace `site/src/pages/index.astro` with a token smoke test (overwritten again in Task 9):

```astro
---
import '../styles/global.css';
---
<html lang="de">
  <body class="bg-canvas text-ink font-sans">
    <h1 class="text-navy font-extrabold">Token check</h1>
    <p class="text-brand-red">red accent</p>
  </body>
</html>
```

Run: `npm run build && grep -c 'Token check' dist/index.html`
Expected: build succeeds, grep prints `1`.

- [ ] **Step 5: Commit**

```bash
git add site/
git commit -m "feat: add Tailwind 4 design tokens, MDX, sitemap, fonts"
```

---

### Task 3: Vitest + i18n dictionaries (TDD)

**Files:**
- Create: `site/vitest.config.ts`
- Create: `site/src/i18n/ui.ts`
- Test: `site/src/i18n/ui.test.ts`
- Modify: `site/package.json` (test script)

- [ ] **Step 1: Vitest config + script**

Create `site/vitest.config.ts`:

```ts
/// <reference types="vitest" />
import { getViteConfig } from 'astro/config';

export default getViteConfig({
  test: {},
});
```

In `site/package.json`, add to `"scripts"`: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing test**

Create `site/src/i18n/ui.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { locales, ui, useTranslations } from './ui';

describe('ui dictionaries', () => {
  it('defines every key in every locale (no leak like the old WP footer)', () => {
    const deKeys = Object.keys(ui.de).sort();
    for (const locale of locales) {
      expect(Object.keys(ui[locale]).sort(), `locale ${locale}`).toEqual(deKeys);
    }
  });

  it('returns locale-specific strings', () => {
    expect(useTranslations('de')('nav.about')).toBe('Über mich');
    expect(useTranslations('en')('nav.about')).toBe('About me');
    expect(useTranslations('en')('footer.latest')).toBe('Latest stories');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/i18n`
Expected: FAIL — `Cannot find module './ui'`.

- [ ] **Step 4: Implement the dictionaries**

Create `site/src/i18n/ui.ts`:

```ts
export const locales = ['de', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'de';

const de = {
  'site.title': "Simon's Wanderlust",
  'site.tagline': 'Reiseabenteuer & Geschichten',
  'nav.stories': 'Reiseberichte',
  'nav.about': 'Über mich',
  'footer.latest': 'Neueste Beiträge',
  'footer.about': 'Über mich',
  'home.title': 'Reiseabenteuer',
  'home.heroLabel': 'Neueste Geschichte',
  'home.mapTeaser.title': 'Wo ich gewesen bin',
  'home.mapTeaser.cta': 'Zur Karte',
  'home.mapTeaser.soon': 'bald verfügbar',
  'home.allStories': 'Alle Reiseberichte',
  'home.filter.all': 'Alle',
  'home.readStory': 'Geschichte lesen',
  'home.aboutTeaser.text': 'Ich bin Simon — ich sammle Geschichten von den belebten Straßen Europas bis zu den geheimnisvollen Pfaden Südamerikas.',
  'home.aboutTeaser.cta': 'Mehr über mich',
  'story.toc': 'Inhalt',
  'story.keyFactsAbout': 'Fakten über',
  'story.prev': 'Vorherige Geschichte',
  'story.next': 'Nächste Geschichte',
  'story.otherLang': 'Read this story in English',
  'region.europe': 'Europa',
  'region.north-america': 'Nordamerika',
  'region.south-america': 'Südamerika',
  'regions.title': 'Reiseziele',
  'about.title': 'Über mich',
  'notFound.title': 'Seite nicht gefunden',
  'notFound.home': 'Zur Startseite',
} as const;

export type UIKey = keyof typeof de;

const en: Record<UIKey, string> = {
  'site.title': "Simon's Wanderlust",
  'site.tagline': 'Travel adventures & stories',
  'nav.stories': 'Stories',
  'nav.about': 'About me',
  'footer.latest': 'Latest stories',
  'footer.about': 'About me',
  'home.title': 'Travel adventures',
  'home.heroLabel': 'Latest story',
  'home.mapTeaser.title': "Where I've been",
  'home.mapTeaser.cta': 'View the map',
  'home.mapTeaser.soon': 'coming soon',
  'home.allStories': 'All travel stories',
  'home.filter.all': 'All',
  'home.readStory': 'Read the story',
  'home.aboutTeaser.text': "I'm Simon — collecting stories from the bustling streets of Europe to the mysterious trails of South America.",
  'home.aboutTeaser.cta': 'More about me',
  'story.toc': 'Contents',
  'story.keyFactsAbout': 'Key facts about',
  'story.prev': 'Previous story',
  'story.next': 'Next story',
  'story.otherLang': 'Diese Geschichte auf Deutsch lesen',
  'region.europe': 'Europe',
  'region.north-america': 'North America',
  'region.south-america': 'South America',
  'regions.title': 'Destinations',
  'about.title': 'About me',
  'notFound.title': 'Page not found',
  'notFound.home': 'Back to home',
};

export const ui: Record<Locale, Record<UIKey, string>> = { de, en };

export function useTranslations(locale: Locale) {
  return (key: UIKey): string => ui[locale][key];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/i18n`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add site/vitest.config.ts site/src/i18n/ site/package.json site/package-lock.json
git commit -m "feat: i18n dictionaries with locale-completeness test"
```

---

### Task 4: Static path helpers (TDD)

**Files:**
- Create: `site/src/lib/paths.ts`
- Test: `site/src/lib/paths.test.ts`

- [ ] **Step 1: Write the failing test**

Create `site/src/lib/paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { aboutPath, homePath, regionPath, regionsIndexPath, regionSlugs, regions } from './paths';

describe('paths', () => {
  it('home: DE at root, EN prefixed', () => {
    expect(homePath('de')).toBe('/');
    expect(homePath('en')).toBe('/en/');
  });

  it('about pages keep the live WordPress slugs', () => {
    expect(aboutPath('de')).toBe('/uber-mich/');
    expect(aboutPath('en')).toBe('/en/about-me/');
  });

  it('region pages keep the live WordPress slugs', () => {
    expect(regionsIndexPath('de')).toBe('/reiseziele/');
    expect(regionsIndexPath('en')).toBe('/en/destinations/');
    expect(regionPath('europe', 'de')).toBe('/reiseziele/europa/');
    expect(regionPath('europe', 'en')).toBe('/en/destinations/europe/');
    expect(regionPath('north-america', 'de')).toBe('/reiseziele/nordamerika/');
    expect(regionPath('south-america', 'en')).toBe('/en/destinations/south-america/');
  });

  it('every region has a slug per locale', () => {
    for (const region of regions) {
      expect(regionSlugs[region].de).toBeTruthy();
      expect(regionSlugs[region].en).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/paths`
Expected: FAIL — `Cannot find module './paths'`.

- [ ] **Step 3: Implement**

Create `site/src/lib/paths.ts`:

```ts
import type { Locale } from '../i18n/ui';

export const regions = ['europe', 'north-america', 'south-america'] as const;
export type Region = (typeof regions)[number];

/** Live WordPress slugs — preserved exactly (SEO requirement, see spec §4). */
export const regionSlugs: Record<Region, Record<Locale, string>> = {
  europe: { de: 'europa', en: 'europe' },
  'north-america': { de: 'nordamerika', en: 'north-america' },
  'south-america': { de: 'suedamerika', en: 'south-america' },
};

export function homePath(locale: Locale): string {
  return locale === 'en' ? '/en/' : '/';
}

export function aboutPath(locale: Locale): string {
  return locale === 'en' ? '/en/about-me/' : '/uber-mich/';
}

export function regionsIndexPath(locale: Locale): string {
  return locale === 'en' ? '/en/destinations/' : '/reiseziele/';
}

export function regionPath(region: Region, locale: Locale): string {
  return regionsIndexPath(locale) + regionSlugs[region][locale] + '/';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/paths`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add site/src/lib/
git commit -m "feat: locale-aware path helpers preserving live WP slugs"
```

---

### Task 5: Content collection schema + sample content

**Files:**
- Create: `site/src/content.config.ts`
- Create: `site/scripts/fetch-sample-images.sh`
- Create: `site/src/content/trips/de/sonne-und-abenteuer-rhodos.mdx`
- Create: `site/src/content/trips/en/sun-and-adventure-on-rhodes.mdx`
- Create: `site/src/content/trips/de/reisebericht-4-tage-bukarest.mdx`
- Create: `site/src/content/trips/en/4-day-travel-report-bucharest.mdx`
- Modify: `site/.gitignore`

- [ ] **Step 1: Define the collection schema**

Create `site/src/content.config.ts`:

```ts
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const trips = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/trips' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      date: z.coerce.date(),
      country: z.string(),
      countryCode: z.string().length(2),
      region: z.enum(['europe', 'north-america', 'south-america']),
      translationKey: z.string(),
      excerpt: z.string(),
      heroImage: image(),
      coordinates: z.object({ lat: z.number(), lng: z.number() }),
      stops: z.array(z.object({ name: z.string(), lat: z.number(), lng: z.number() })).optional(),
      route: z.string().optional(),
      keyFacts: z.record(z.string()).optional(),
    }),
});

export const collections = { trips };
```

- [ ] **Step 2: Sample image fetch script (binaries stay out of git)**

Create `site/scripts/fetch-sample-images.sh`:

```bash
#!/usr/bin/env bash
# Downloads sample hero images from the live site. Images are gitignored
# (no binaries in git, per repo policy); run this after a fresh clone.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)/src/assets/trips"
mkdir -p "$dir"
curl -fsSL "https://simonswanderlust.com/wp-content/uploads/2023/12/Header-%CE%A1%CF%8C%CE%B4%CE%BF%CF%82-22.07.2021-153252-1-scaled-1-jpg.webp" -o "$dir/rhodos.webp"
curl -fsSL "https://simonswanderlust.com/wp-content/uploads/2024/10/Bucharest-2.10.2024-144335-768x512.webp" -o "$dir/bucharest.webp"
echo "ok: $(ls "$dir" | tr '\n' ' ')"
```

Append to `site/.gitignore`:

```gitignore
# downloaded by scripts/fetch-sample-images.sh — no binaries in git
src/assets/trips/
```

Run: `chmod +x site/scripts/fetch-sample-images.sh && site/scripts/fetch-sample-images.sh`
Expected: `ok: bucharest.webp rhodos.webp`

- [ ] **Step 3: Sample story — Rhodes (DE)**

Create `site/src/content/trips/de/sonne-und-abenteuer-rhodos.mdx`:

```mdx
---
title: 'Griechenland: Sonne und Abenteuer Rhodos'
date: 2021-07-25
country: 'Griechenland'
countryCode: 'GR'
region: 'europe'
translationKey: 'rhodes-2021'
excerpt: 'Eine Woche Sonne, Meer und Altstadtgassen auf Rhodos.'
heroImage: '../../../assets/trips/rhodos.webp'
coordinates: { lat: 36.4341, lng: 28.2176 }
---

## Ankommen auf der Insel

Beispielabsatz für das Phase-1-Grundgerüst. Der echte Reisebericht wird in
Phase 2 aus WordPress migriert und ersetzt diesen Text vollständig.

## Altstadt und Strände

Zweiter Beispielabschnitt, damit Inhaltsverzeichnis und Typografie etwas zu
rendern haben.
```

- [ ] **Step 4: Sample story — Rhodes (EN)**

Create `site/src/content/trips/en/sun-and-adventure-on-rhodes.mdx`:

```mdx
---
title: 'Greece: Sun and adventure Rhodes'
date: 2021-07-25
country: 'Greece'
countryCode: 'GR'
region: 'europe'
translationKey: 'rhodes-2021'
excerpt: 'A week of sun, sea and old-town alleys on Rhodes.'
heroImage: '../../../assets/trips/rhodos.webp'
coordinates: { lat: 36.4341, lng: 28.2176 }
---

## Arriving on the island

Sample paragraph for the Phase 1 skeleton. The real story will be migrated
from WordPress in Phase 2 and fully replaces this text.

## Old town and beaches

Second sample section so the table of contents and typography have something
to render.
```

- [ ] **Step 5: Sample story — Bucharest (DE, with keyFacts)**

Create `site/src/content/trips/de/reisebericht-4-tage-bukarest.mdx`:

```mdx
---
title: 'Bukarest in 4 Tagen: Nachtzug, Hostel und Stadtspaziergänge'
date: 2024-10-03
country: 'Rumänien'
countryCode: 'RO'
region: 'europe'
translationKey: 'bucharest-2024'
excerpt: 'Mit dem Nachtzug nach Bukarest — vier Tage treiben lassen.'
heroImage: '../../../assets/trips/bucharest.webp'
coordinates: { lat: 44.4268, lng: 26.1025 }
keyFacts:
  Einwohner: '19 Millionen'
  Hauptstadt: 'Bukarest'
  Fläche: '238.397 km²'
---

## Ankommen und treiben lassen

Beispielabsatz für das Phase-1-Grundgerüst. Der echte Reisebericht wird in
Phase 2 aus WordPress migriert.

## Stadtspaziergänge

Zweiter Beispielabschnitt für Inhaltsverzeichnis und Typografie.
```

- [ ] **Step 6: Sample story — Bucharest (EN, with keyFacts)**

Create `site/src/content/trips/en/4-day-travel-report-bucharest.mdx`:

```mdx
---
title: 'Bucharest in 4 Days: Night Train, Hostel and City Walks'
date: 2024-10-03
country: 'Romania'
countryCode: 'RO'
region: 'europe'
translationKey: 'bucharest-2024'
excerpt: 'Night train to Bucharest — four days of going with the flow.'
heroImage: '../../../assets/trips/bucharest.webp'
coordinates: { lat: 44.4268, lng: 26.1025 }
keyFacts:
  Population: '19 million'
  Capital: 'Bucharest'
  Area: '238,397 km²'
---

## Arrive and go with the flow

Sample paragraph for the Phase 1 skeleton. The real story will be migrated
from WordPress in Phase 2.

## City walks

Second sample section for the table of contents and typography.
```

- [ ] **Step 7: Verify the schema validates**

Run: `npx astro check` (answer yes if it offers to install anything) then `npm run build`
Expected: 0 schema errors; build succeeds. To prove the schema bites, temporarily change `countryCode: 'RO'` to `countryCode: 'ROU'` in one file, run `npm run build`, expect a zod error mentioning `countryCode`; revert.

- [ ] **Step 8: Commit**

```bash
git add site/src/content.config.ts site/src/content/ site/scripts/ site/.gitignore
git commit -m "feat: trips content collection with sample DE/EN stories"
```

---

### Task 6: Trip helpers (TDD)

**Files:**
- Create: `site/src/lib/trips.ts`
- Test: `site/src/lib/trips.test.ts`

- [ ] **Step 1: Write the failing test**

Create `site/src/lib/trips.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { byLocale, localeOf, pathOf, slugOf, translationOf, type Trip } from './trips';

function fake(id: string, date: string, translationKey: string): Trip {
  return { id, data: { date: new Date(date), translationKey } } as unknown as Trip;
}

const rhodesDe = fake('de/sonne-und-abenteuer-rhodos', '2021-07-25', 'rhodes-2021');
const rhodesEn = fake('en/sun-and-adventure-on-rhodes', '2021-07-25', 'rhodes-2021');
const buchDe = fake('de/reisebericht-4-tage-bukarest', '2024-10-03', 'bucharest-2024');
const all = [rhodesDe, rhodesEn, buchDe];

describe('trips helpers', () => {
  it('derives locale and slug from the entry id', () => {
    expect(localeOf(rhodesDe)).toBe('de');
    expect(localeOf(rhodesEn)).toBe('en');
    expect(slugOf(rhodesEn)).toBe('sun-and-adventure-on-rhodes');
  });

  it('builds URLs matching the live WordPress structure', () => {
    expect(pathOf(rhodesDe)).toBe('/sonne-und-abenteuer-rhodos/');
    expect(pathOf(rhodesEn)).toBe('/en/sun-and-adventure-on-rhodes/');
  });

  it('filters by locale, newest first', () => {
    expect(byLocale(all, 'de').map((t) => t.id)).toEqual([
      'de/reisebericht-4-tage-bukarest',
      'de/sonne-und-abenteuer-rhodos',
    ]);
  });

  it('finds the translation pair via translationKey', () => {
    expect(translationOf(rhodesDe, all)?.id).toBe('en/sun-and-adventure-on-rhodes');
    expect(translationOf(buchDe, all)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/trips`
Expected: FAIL — `Cannot find module './trips'`.

- [ ] **Step 3: Implement**

Create `site/src/lib/trips.ts`:

```ts
import type { CollectionEntry } from 'astro:content';
import type { Locale } from '../i18n/ui';

export type Trip = CollectionEntry<'trips'>;

export function localeOf(trip: Trip): Locale {
  return trip.id.startsWith('en/') ? 'en' : 'de';
}

export function slugOf(trip: Trip): string {
  return trip.id.replace(/^(de|en)\//, '');
}

/** URL of a story — DE at root, EN under /en/ (live WP structure). */
export function pathOf(trip: Trip): string {
  const slug = slugOf(trip);
  return localeOf(trip) === 'en' ? `/en/${slug}/` : `/${slug}/`;
}

export function byLocale(trips: Trip[], locale: Locale): Trip[] {
  return trips
    .filter((t) => localeOf(t) === locale)
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export function translationOf(trip: Trip, all: Trip[]): Trip | undefined {
  return all.find(
    (t) => t.data.translationKey === trip.data.translationKey && localeOf(t) !== localeOf(trip),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/trips`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add site/src/lib/
git commit -m "feat: trip locale/path/pairing helpers"
```

---

### Task 7: Base layout, Nav, Footer, LangSwitcher

**Files:**
- Create: `site/src/layouts/Base.astro`
- Create: `site/src/components/Nav.astro`
- Create: `site/src/components/LangSwitcher.astro`
- Create: `site/src/components/Footer.astro`

- [ ] **Step 1: Base layout with hreflang**

Create `site/src/layouts/Base.astro`:

```astro
---
import '@fontsource-variable/inter';
import '../styles/global.css';
import Nav from '../components/Nav.astro';
import Footer from '../components/Footer.astro';
import type { Locale } from '../i18n/ui';

interface Props {
  title: string;
  description: string;
  locale: Locale;
  /** Paths of this page in both languages; drives hreflang + language switcher. */
  alternates?: { de: string; en: string };
}

const { title, description, locale, alternates } = Astro.props;
const site = Astro.site ?? new URL('https://simonswanderlust.com');
---

<!doctype html>
<html lang={locale}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title} – Simon's Wanderlust</title>
    <meta name="description" content={description} />
    <link rel="canonical" href={new URL(Astro.url.pathname, site)} />
    {
      alternates && (
        <>
          <link rel="alternate" hreflang="de" href={new URL(alternates.de, site)} />
          <link rel="alternate" hreflang="en" href={new URL(alternates.en, site)} />
          <link rel="alternate" hreflang="x-default" href={new URL(alternates.de, site)} />
        </>
      )
    }
  </head>
  <body class="bg-canvas font-sans text-ink antialiased">
    <Nav locale={locale} alternates={alternates} />
    <main><slot /></main>
    <Footer locale={locale} />
  </body>
</html>
```

- [ ] **Step 2: Nav**

Create `site/src/components/Nav.astro`:

```astro
---
import { useTranslations, type Locale } from '../i18n/ui';
import { aboutPath, homePath } from '../lib/paths';
import LangSwitcher from './LangSwitcher.astro';

interface Props {
  locale: Locale;
  alternates?: { de: string; en: string };
}

const { locale, alternates } = Astro.props;
const t = useTranslations(locale);
---

<header class="border-b border-navy/10 bg-canvas">
  <div class="mx-auto flex max-w-6xl items-center justify-between gap-6 px-5 py-4">
    <a href={homePath(locale)} class="text-sm font-extrabold tracking-wide text-navy uppercase">
      {t('site.title')}
    </a>
    <nav class="flex items-center gap-5 text-sm">
      <a href={homePath(locale) + '#stories'} class="hover:text-brand-red">{t('nav.stories')}</a>
      <a href={aboutPath(locale)} class="hover:text-brand-red">{t('nav.about')}</a>
      <LangSwitcher locale={locale} alternates={alternates} />
    </nav>
  </div>
</header>
```

Note: no Map link yet — the map page ships in Phase 3; adding a dead link now would be worse than omitting it.

- [ ] **Step 3: LangSwitcher**

Create `site/src/components/LangSwitcher.astro`:

```astro
---
import type { Locale } from '../i18n/ui';
import { homePath } from '../lib/paths';

interface Props {
  locale: Locale;
  alternates?: { de: string; en: string };
}

const { locale, alternates } = Astro.props;
const other: Locale = locale === 'de' ? 'en' : 'de';
const otherHref = alternates ? alternates[other] : homePath(other);
---

<div class="flex items-center gap-1 text-xs font-semibold tracking-wide uppercase">
  <span class={locale === 'de' ? 'text-navy' : 'text-ink/40'}>
    {locale === 'de' ? 'DE' : <a href={otherHref} class="hover:text-brand-red">DE</a>}
  </span>
  <span class="text-ink/30">|</span>
  <span class={locale === 'en' ? 'text-navy' : 'text-ink/40'}>
    {locale === 'en' ? 'EN' : <a href={otherHref} class="hover:text-brand-red">EN</a>}
  </span>
</div>
```

- [ ] **Step 4: Footer (localized, with latest stories)**

Create `site/src/components/Footer.astro`:

```astro
---
import { getCollection } from 'astro:content';
import { useTranslations, type Locale } from '../i18n/ui';
import { aboutPath } from '../lib/paths';
import { byLocale, pathOf } from '../lib/trips';

interface Props {
  locale: Locale;
}

const { locale } = Astro.props;
const t = useTranslations(locale);
const latest = byLocale(await getCollection('trips'), locale).slice(0, 3);
---

<footer class="bg-navy text-white">
  <div class="mx-auto grid max-w-6xl gap-8 px-5 py-10 sm:grid-cols-3">
    <div>
      <p class="text-sm font-extrabold tracking-wide uppercase">{t('site.title')}</p>
      <p class="mt-1 text-sm text-white/60">{t('site.tagline')}</p>
    </div>
    <div>
      <p class="text-xs font-semibold tracking-[0.15em] text-white/50 uppercase">
        {t('footer.latest')}
      </p>
      <ul class="mt-2 space-y-1 text-sm">
        {
          latest.map((trip) => (
            <li>
              <a href={pathOf(trip)} class="hover:text-brand-red-light">
                {trip.data.title}
              </a>
            </li>
          ))
        }
      </ul>
    </div>
    <div>
      <p class="text-xs font-semibold tracking-[0.15em] text-white/50 uppercase">
        {t('footer.about')}
      </p>
      <ul class="mt-2 space-y-1 text-sm">
        <li><a href={aboutPath(locale)} class="hover:text-brand-red-light">{t('nav.about')}</a></li>
        <li>
          <a
            href="https://www.instagram.com/simonswanderlust"
            rel="me noopener"
            class="hover:text-brand-red-light">Instagram</a
          >
        </li>
      </ul>
    </div>
  </div>
</footer>
```

- [ ] **Step 5: Wire a temporary page through Base to verify**

Replace `site/src/pages/index.astro` (again temporary; final version in Task 9):

```astro
---
import Base from '../layouts/Base.astro';
---

<Base
  title="Reiseabenteuer"
  description="Reiseabenteuer & Geschichten"
  locale="de"
  alternates={{ de: '/', en: '/en/' }}
>
  <p class="p-10">layout check</p>
</Base>
```

Run:
```bash
npm run build
grep -c 'hreflang="en"' dist/index.html
grep -c 'Neueste Beiträge' dist/index.html
```
Expected: build OK, both greps print `1`.

- [ ] **Step 6: Commit**

```bash
git add site/src/layouts/ site/src/components/ site/src/pages/index.astro
git commit -m "feat: base layout with hreflang, localized nav/footer"
```

---

### Task 8: Story display components

**Files:**
- Create: `site/src/components/StoryCard.astro`
- Create: `site/src/components/FeaturedHero.astro`
- Create: `site/src/components/MapTeaser.astro`
- Create: `site/src/components/StoryGrid.astro`
- Create: `site/src/components/RegionFilter.astro`
- Create: `site/src/lib/format.ts`
- Test: `site/src/lib/format.test.ts`

- [ ] **Step 1: Date label helper (TDD) — failing test**

Create `site/src/lib/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dateLabel } from './format';

describe('dateLabel', () => {
  it('formats uppercase month + year per locale', () => {
    const d = new Date('2024-10-03');
    expect(dateLabel(d, 'en')).toBe('OCT 2024');
    expect(dateLabel(d, 'de')).toBe('OKT 2024');
  });
});
```

Run: `npx vitest run src/lib/format` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement**

Create `site/src/lib/format.ts`:

```ts
import type { Locale } from '../i18n/ui';

const intlLocale: Record<Locale, string> = { de: 'de-DE', en: 'en-US' };

/** "OCT 2024" / "OKT 2024" — the small-caps label used on cards and heroes. */
export function dateLabel(date: Date, locale: Locale): string {
  return date
    .toLocaleDateString(intlLocale[locale], { month: 'short', year: 'numeric' })
    .replace('.', '')
    .toUpperCase();
}
```

Run: `npx vitest run src/lib/format` — Expected: PASS.

- [ ] **Step 3: StoryCard**

Create `site/src/components/StoryCard.astro`:

```astro
---
import { Image } from 'astro:assets';
import { dateLabel } from '../lib/format';
import { localeOf, pathOf, type Trip } from '../lib/trips';

interface Props {
  trip: Trip;
  /** Large card spanning 2 columns/rows in the grid. */
  featured?: boolean;
}

const { trip, featured = false } = Astro.props;
const locale = localeOf(trip);
const label = `${dateLabel(trip.data.date, locale)} · ${trip.data.country}`;
---

<a
  href={pathOf(trip)}
  class:list={[
    'group relative block overflow-hidden rounded-lg',
    featured ? 'md:col-span-2 md:row-span-2' : '',
  ]}
>
  <Image
    src={trip.data.heroImage}
    alt={trip.data.title}
    widths={[480, 768, 1200]}
    sizes={featured ? '(min-width: 768px) 66vw, 100vw' : '(min-width: 768px) 33vw, 100vw'}
    class="h-full w-full object-cover transition duration-300 group-hover:scale-105"
  />
  <div class="absolute inset-0 bg-gradient-to-t from-navy/80 via-navy/10 to-transparent"></div>
  <div class="absolute right-0 bottom-0 left-0 p-5 text-white">
    <p class="text-[11px] font-semibold tracking-[0.2em] text-brand-red-light uppercase">{label}</p>
    <h3 class:list={['mt-1 font-extrabold', featured ? 'text-2xl' : 'text-lg']}>
      {trip.data.title}
    </h3>
  </div>
</a>
```

- [ ] **Step 4: FeaturedHero**

Create `site/src/components/FeaturedHero.astro`:

```astro
---
import { Image } from 'astro:assets';
import { useTranslations } from '../i18n/ui';
import { dateLabel } from '../lib/format';
import { localeOf, pathOf, type Trip } from '../lib/trips';

interface Props {
  trip: Trip;
}

const { trip } = Astro.props;
const locale = localeOf(trip);
const t = useTranslations(locale);
const label = `${dateLabel(trip.data.date, locale)} · ${trip.data.country}`;
---

<section class="relative h-[70vh] min-h-[420px]">
  <Image
    src={trip.data.heroImage}
    alt={trip.data.title}
    widths={[768, 1280, 1920]}
    sizes="100vw"
    loading="eager"
    fetchpriority="high"
    class="absolute inset-0 h-full w-full object-cover"
  />
  <div class="absolute inset-0 bg-gradient-to-t from-navy/85 via-transparent to-navy/20"></div>
  <div class="absolute right-0 bottom-0 left-0">
    <div class="mx-auto max-w-6xl px-5 pb-12 text-white">
      <p class="text-xs font-semibold tracking-[0.25em] text-brand-red-light uppercase">
        {t('home.heroLabel')} — {label}
      </p>
      <h1 class="mt-2 max-w-3xl text-4xl font-extrabold md:text-5xl">{trip.data.title}</h1>
      <p class="mt-3 max-w-xl text-white/85">{trip.data.excerpt}</p>
      <a
        href={pathOf(trip)}
        class="mt-5 inline-block rounded bg-brand-red px-5 py-2.5 text-sm font-semibold hover:bg-brand-red-light"
      >
        {t('home.readStory')} →
      </a>
    </div>
  </div>
</section>
```

- [ ] **Step 5: MapTeaser (static band — becomes the real teaser in Phase 3)**

Create `site/src/components/MapTeaser.astro`:

```astro
---
import { useTranslations, type Locale } from '../i18n/ui';

interface Props {
  locale: Locale;
}

const { locale } = Astro.props;
const t = useTranslations(locale);
---

<section class="bg-navy text-white">
  <div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-10">
    <h2 class="text-2xl font-extrabold">{t('home.mapTeaser.title')}</h2>
    <span class="rounded border border-white/30 px-4 py-2 text-sm text-white/70">
      {t('home.mapTeaser.cta')} — {t('home.mapTeaser.soon')}
    </span>
  </div>
</section>
```

- [ ] **Step 6: StoryGrid + RegionFilter**

Create `site/src/components/StoryGrid.astro`:

```astro
---
import StoryCard from './StoryCard.astro';
import type { Trip } from '../lib/trips';

interface Props {
  trips: Trip[];
}

const { trips } = Astro.props;
---

<div class="grid auto-rows-[240px] gap-4 md:grid-cols-3">
  {trips.map((trip, i) => <StoryCard trip={trip} featured={i === 0} />)}
</div>
```

Create `site/src/components/RegionFilter.astro`:

```astro
---
import { useTranslations, type Locale, type UIKey } from '../i18n/ui';
import { homePath, regionPath, regions, type Region } from '../lib/paths';

interface Props {
  locale: Locale;
  active?: Region;
}

const { locale, active } = Astro.props;
const t = useTranslations(locale);

const chip = 'rounded-full border px-3 py-1 text-sm';
const on = 'border-navy bg-navy text-white';
const off = 'border-navy/20 text-ink/70 hover:border-brand-red hover:text-brand-red';
---

<nav class="flex flex-wrap gap-2">
  <a href={homePath(locale) + '#stories'} class:list={[chip, active ? off : on]}>
    {t('home.filter.all')}
  </a>
  {
    regions.map((region) => (
      <a href={regionPath(region, locale)} class:list={[chip, active === region ? on : off]}>
        {t(`region.${region}` as UIKey)}
      </a>
    ))
  }
</nav>
```

- [ ] **Step 7: Type-check and commit**

Run: `npx astro check`
Expected: 0 errors (components are not yet referenced by pages; check still validates them).

```bash
git add site/src/components/ site/src/lib/
git commit -m "feat: story cards, hero, map teaser, grid and region filter"
```

---

### Task 9: Home pages (DE + EN)

**Files:**
- Create: `site/src/components/pages/HomePage.astro`
- Modify: `site/src/pages/index.astro`
- Create: `site/src/pages/en/index.astro`

- [ ] **Step 1: Shared HomePage component**

Create `site/src/components/pages/HomePage.astro`:

```astro
---
import { getCollection } from 'astro:content';
import Base from '../../layouts/Base.astro';
import FeaturedHero from '../FeaturedHero.astro';
import MapTeaser from '../MapTeaser.astro';
import RegionFilter from '../RegionFilter.astro';
import StoryGrid from '../StoryGrid.astro';
import { useTranslations, type Locale } from '../../i18n/ui';
import { byLocale } from '../../lib/trips';

interface Props {
  locale: Locale;
}

const { locale } = Astro.props;
const t = useTranslations(locale);
const trips = byLocale(await getCollection('trips'), locale);
const [featured, ...rest] = trips;
---

<Base
  title={t('home.title')}
  description={t('site.tagline')}
  locale={locale}
  alternates={{ de: '/', en: '/en/' }}
>
  {featured && <FeaturedHero trip={featured} />}
  <MapTeaser locale={locale} />
  <section id="stories" class="mx-auto max-w-6xl px-5 py-14">
    <div class="flex flex-wrap items-baseline justify-between gap-4">
      <h2 class="text-2xl font-extrabold text-navy">{t('home.allStories')}</h2>
      <RegionFilter locale={locale} />
    </div>
    <div class="mt-6">
      <StoryGrid trips={rest.length > 0 ? rest : trips} />
    </div>
  </section>
  <section class="border-t border-navy/10">
    <div class="mx-auto max-w-3xl px-5 py-14 text-center">
      <h2 class="text-xl font-extrabold text-navy">{t('nav.about')}</h2>
      <p class="mt-3 text-ink/80">{t('home.aboutTeaser.text')}</p>
      <a
        href={aboutPath(locale)}
        class="mt-4 inline-block text-sm font-medium text-brand-red hover:underline"
      >
        {t('home.aboutTeaser.cta')} →
      </a>
    </div>
  </section>
</Base>
```

The about-teaser link needs `aboutPath` — add it to the imports at the top of `HomePage.astro`:

```astro
import { aboutPath } from '../../lib/paths';
```

- [ ] **Step 2: Locale routes**

Replace `site/src/pages/index.astro` with:

```astro
---
import HomePage from '../components/pages/HomePage.astro';
---

<HomePage locale="de" />
```

Create `site/src/pages/en/index.astro`:

```astro
---
import HomePage from '../../components/pages/HomePage.astro';
---

<HomePage locale="en" />
```

- [ ] **Step 3: Build + leak regression check**

Run:
```bash
npm run build
grep -c 'lang="en"' dist/en/index.html        # expect 1
grep -c 'Neueste Beiträge' dist/en/index.html  # expect 0  ← the old WP bug stays dead
grep -c 'Latest stories' dist/en/index.html    # expect 1
grep -c 'Neueste Beiträge' dist/index.html     # expect 1
```
Expected: exactly as annotated. (`grep -c` exits 1 when it counts 0 — for the `expect 0` line, the printed `0` is the success signal.)

- [ ] **Step 4: Commit**

```bash
git add site/src/pages/ site/src/components/pages/
git commit -m "feat: DE and EN home pages from shared component"
```

---

### Task 10: Story pages

**Files:**
- Create: `site/src/components/KeyFacts.astro`
- Create: `site/src/components/Toc.astro`
- Create: `site/src/components/pages/StoryPage.astro`
- Create: `site/src/pages/[slug].astro`
- Create: `site/src/pages/en/[slug].astro`

- [ ] **Step 1: KeyFacts component**

Create `site/src/components/KeyFacts.astro`:

```astro
---
import { useTranslations, type Locale } from '../i18n/ui';

interface Props {
  facts: Record<string, string>;
  country: string;
  locale: Locale;
}

const { facts, country, locale } = Astro.props;
const t = useTranslations(locale);
---

<aside class="my-8 rounded-lg bg-navy/5 p-5">
  <p class="text-sm font-bold text-navy">{t('story.keyFactsAbout')} {country}</p>
  <dl class="mt-3 grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
    {
      Object.entries(facts).map(([key, value]) => (
        <div class="flex gap-2">
          <dt class="font-semibold text-ink/80">{key}:</dt>
          <dd>{value}</dd>
        </div>
      ))
    }
  </dl>
</aside>
```

- [ ] **Step 2: Toc component**

Create `site/src/components/Toc.astro`:

```astro
---
import type { MarkdownHeading } from 'astro';
import { useTranslations, type Locale } from '../i18n/ui';

interface Props {
  headings: MarkdownHeading[];
  locale: Locale;
}

const { headings, locale } = Astro.props;
const t = useTranslations(locale);
const items = headings.filter((h) => h.depth === 2);
---

{
  items.length > 1 && (
    <nav class="my-8 rounded-lg border border-navy/15 p-5 text-sm">
      <p class="font-bold text-navy">{t('story.toc')}</p>
      <ul class="mt-2 space-y-1.5">
        {items.map((h) => (
          <li>
            <a href={`#${h.slug}`} class="text-ink/80 hover:text-brand-red">
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
```

- [ ] **Step 3: StoryPage component**

Create `site/src/components/pages/StoryPage.astro`:

```astro
---
import { Image } from 'astro:assets';
import { getCollection, render } from 'astro:content';
import Base from '../../layouts/Base.astro';
import KeyFacts from '../KeyFacts.astro';
import Toc from '../Toc.astro';
import { useTranslations } from '../../i18n/ui';
import { dateLabel } from '../../lib/format';
import { byLocale, localeOf, pathOf, translationOf, type Trip } from '../../lib/trips';

interface Props {
  trip: Trip;
}

const { trip } = Astro.props;
const locale = localeOf(trip);
const t = useTranslations(locale);
const { Content, headings } = await render(trip);

const all = await getCollection('trips');
const other = translationOf(trip, all);
const siblings = byLocale(all, locale);
const index = siblings.findIndex((s) => s.id === trip.id);
const newer = index > 0 ? siblings[index - 1] : undefined;
const older = index < siblings.length - 1 ? siblings[index + 1] : undefined;

const alternates = other
  ? locale === 'de'
    ? { de: pathOf(trip), en: pathOf(other) }
    : { de: pathOf(other), en: pathOf(trip) }
  : undefined;
const label = `${dateLabel(trip.data.date, locale)} · ${trip.data.country}`;
---

<Base title={trip.data.title} description={trip.data.excerpt} locale={locale} alternates={alternates}>
  <section class="relative h-[55vh] min-h-[360px]">
    <Image
      src={trip.data.heroImage}
      alt={trip.data.title}
      widths={[768, 1280, 1920]}
      sizes="100vw"
      loading="eager"
      fetchpriority="high"
      class="absolute inset-0 h-full w-full object-cover"
    />
    <div class="absolute inset-0 bg-gradient-to-t from-navy/85 via-transparent to-navy/20"></div>
    <div class="absolute right-0 bottom-0 left-0">
      <div class="mx-auto max-w-3xl px-5 pb-10 text-white">
        <p class="text-xs font-semibold tracking-[0.25em] text-brand-red-light uppercase">{label}</p>
        <h1 class="mt-2 text-3xl font-extrabold md:text-4xl">{trip.data.title}</h1>
      </div>
    </div>
  </section>

  <div class="mx-auto max-w-3xl px-5 py-10">
    {
      other && (
        <p class="text-sm">
          <a href={pathOf(other)} class="font-medium text-brand-red hover:underline">
            {t('story.otherLang')} →
          </a>
        </p>
      )
    }
    <Toc headings={headings} locale={locale} />
    {
      trip.data.keyFacts && (
        <KeyFacts facts={trip.data.keyFacts} country={trip.data.country} locale={locale} />
      )
    }
    <article class="prose prose-lg max-w-none prose-headings:font-extrabold prose-headings:text-navy prose-a:text-brand-red">
      <Content />
    </article>

    <nav class="mt-12 flex justify-between gap-4 border-t border-navy/10 pt-6 text-sm">
      <span>
        {
          older && (
            <a href={pathOf(older)} class="hover:text-brand-red">
              ← {t('story.prev')}: {older.data.title}
            </a>
          )
        }
      </span>
      <span class="text-right">
        {
          newer && (
            <a href={pathOf(newer)} class="hover:text-brand-red">
              {t('story.next')}: {newer.data.title} →
            </a>
          )
        }
      </span>
    </nav>
  </div>
</Base>
```

- [ ] **Step 4: Route files**

Create `site/src/pages/[slug].astro`:

```astro
---
import { getCollection } from 'astro:content';
import StoryPage from '../components/pages/StoryPage.astro';
import { byLocale, slugOf } from '../lib/trips';

export async function getStaticPaths() {
  const trips = byLocale(await getCollection('trips'), 'de');
  return trips.map((trip) => ({ params: { slug: slugOf(trip) }, props: { trip } }));
}

const { trip } = Astro.props;
---

<StoryPage trip={trip} />
```

Create `site/src/pages/en/[slug].astro`:

```astro
---
import { getCollection } from 'astro:content';
import StoryPage from '../../components/pages/StoryPage.astro';
import { byLocale, slugOf } from '../../lib/trips';

export async function getStaticPaths() {
  const trips = byLocale(await getCollection('trips'), 'en');
  return trips.map((trip) => ({ params: { slug: slugOf(trip) }, props: { trip } }));
}

const { trip } = Astro.props;
---

<StoryPage trip={trip} />
```

- [ ] **Step 5: Build + URL/hreflang verification**

Run:
```bash
npm run build
ls dist/sonne-und-abenteuer-rhodos/index.html dist/en/sun-and-adventure-on-rhodes/index.html
grep -c 'hreflang="en" href="https://simonswanderlust.com/en/sun-and-adventure-on-rhodes/"' dist/sonne-und-abenteuer-rhodos/index.html
grep -c 'Inhalt' dist/sonne-und-abenteuer-rhodos/index.html
grep -c 'Inhalt' dist/en/sun-and-adventure-on-rhodes/index.html
```
Expected: both files exist; first grep prints `1`; `Inhalt` appears in the DE page (count ≥ 1 — the sample body also contains "Inhaltsverzeichnis") and NOT in the EN page (prints `0`, exit code 1) — EN shows `Contents` instead.

- [ ] **Step 6: Commit**

```bash
git add site/src/components/ site/src/pages/
git commit -m "feat: story pages with TOC, key facts, translation links"
```

---

### Task 11: Region pages, about pages, 404, RSS — and final verification

**Files:**
- Create: `site/src/components/pages/RegionPage.astro`
- Create: `site/src/pages/reiseziele/index.astro`, `site/src/pages/reiseziele/[region].astro`
- Create: `site/src/pages/en/destinations/index.astro`, `site/src/pages/en/destinations/[region].astro`
- Create: `site/src/components/pages/AboutPage.astro`
- Create: `site/src/pages/uber-mich.astro`, `site/src/pages/en/about-me.astro`
- Create: `site/src/pages/404.astro`
- Create: `site/src/pages/rss.xml.js`, `site/src/pages/en/rss.xml.js`

- [ ] **Step 1: RegionPage component**

Create `site/src/components/pages/RegionPage.astro`:

```astro
---
import { getCollection } from 'astro:content';
import Base from '../../layouts/Base.astro';
import RegionFilter from '../RegionFilter.astro';
import StoryGrid from '../StoryGrid.astro';
import { useTranslations, type Locale, type UIKey } from '../../i18n/ui';
import { regionPath, regionsIndexPath, type Region } from '../../lib/paths';
import { byLocale } from '../../lib/trips';

interface Props {
  locale: Locale;
  /** undefined = regions index page (all stories) */
  region?: Region;
}

const { locale, region } = Astro.props;
const t = useTranslations(locale);
const all = byLocale(await getCollection('trips'), locale);
const trips = region ? all.filter((trip) => trip.data.region === region) : all;
const title = region ? t(`region.${region}` as UIKey) : t('regions.title');
const alternates = region
  ? { de: regionPath(region, 'de'), en: regionPath(region, 'en') }
  : { de: regionsIndexPath('de'), en: regionsIndexPath('en') };
---

<Base title={title} description={`${title} – ${t('site.tagline')}`} locale={locale} alternates={alternates}>
  <section class="mx-auto max-w-6xl px-5 py-14">
    <div class="flex flex-wrap items-baseline justify-between gap-4">
      <h1 class="text-3xl font-extrabold text-navy">{title}</h1>
      <RegionFilter locale={locale} active={region} />
    </div>
    <div class="mt-6">
      <StoryGrid trips={trips} />
    </div>
  </section>
</Base>
```

- [ ] **Step 2: Region routes (live WP slugs preserved)**

Create `site/src/pages/reiseziele/index.astro`:

```astro
---
import RegionPage from '../../components/pages/RegionPage.astro';
---

<RegionPage locale="de" />
```

Create `site/src/pages/reiseziele/[region].astro`:

```astro
---
import RegionPage from '../../components/pages/RegionPage.astro';
import { regionSlugs, regions } from '../../lib/paths';

export function getStaticPaths() {
  return regions.map((region) => ({
    params: { region: regionSlugs[region].de },
    props: { region },
  }));
}

const { region } = Astro.props;
---

<RegionPage locale="de" region={region} />
```

Create `site/src/pages/en/destinations/index.astro`:

```astro
---
import RegionPage from '../../../components/pages/RegionPage.astro';
---

<RegionPage locale="en" />
```

Create `site/src/pages/en/destinations/[region].astro`:

```astro
---
import RegionPage from '../../../components/pages/RegionPage.astro';
import { regionSlugs, regions } from '../../../lib/paths';

export function getStaticPaths() {
  return regions.map((region) => ({
    params: { region: regionSlugs[region].en },
    props: { region },
  }));
}

const { region } = Astro.props;
---

<RegionPage locale="en" region={region} />
```

- [ ] **Step 3: About pages (minimal; real content migrates in Phase 2)**

Create `site/src/components/pages/AboutPage.astro`:

```astro
---
import Base from '../../layouts/Base.astro';
import { useTranslations, type Locale } from '../../i18n/ui';
import { aboutPath } from '../../lib/paths';

interface Props {
  locale: Locale;
}

const { locale } = Astro.props;
const t = useTranslations(locale);
const intro =
  locale === 'de'
    ? 'Hier teile ich meine Leidenschaft fürs Reisen — Geschichten und Erinnerungen von den belebten Straßen Europas bis zu den geheimnisvollen Pfaden Südamerikas. Der vollständige Über-mich-Text wird in Phase 2 von der bestehenden Seite migriert.'
    : 'Here I share my passion for travelling — stories and memories from the bustling streets of Europe to the mysterious trails of South America. The full about text will be migrated from the existing site in Phase 2.';
---

<Base
  title={t('about.title')}
  description={intro.slice(0, 150)}
  locale={locale}
  alternates={{ de: aboutPath('de'), en: aboutPath('en') }}
>
  <section class="mx-auto max-w-3xl px-5 py-14">
    <h1 class="text-3xl font-extrabold text-navy">{t('about.title')}</h1>
    <p class="prose prose-lg mt-6">{intro}</p>
  </section>
</Base>
```

Create `site/src/pages/uber-mich.astro`:

```astro
---
import AboutPage from '../components/pages/AboutPage.astro';
---

<AboutPage locale="de" />
```

Create `site/src/pages/en/about-me.astro`:

```astro
---
import AboutPage from '../../components/pages/AboutPage.astro';
---

<AboutPage locale="en" />
```

- [ ] **Step 4: 404 (single static page → bilingual content)**

Create `site/src/pages/404.astro` (Cloudflare Pages serves one `404.html` for all paths, so it carries both languages):

```astro
---
import Base from '../layouts/Base.astro';
import { useTranslations } from '../i18n/ui';

const tDe = useTranslations('de');
const tEn = useTranslations('en');
---

<Base title={`${tDe('notFound.title')} / ${tEn('notFound.title')}`} description="404" locale="de">
  <section class="mx-auto max-w-3xl px-5 py-24 text-center">
    <p class="text-6xl font-extrabold text-navy">404</p>
    <h1 class="mt-4 text-2xl font-extrabold">{tDe('notFound.title')}</h1>
    <p class="mt-1 text-ink/60">{tEn('notFound.title')}</p>
    <p class="mt-6 flex justify-center gap-6 text-sm">
      <a href="/" class="font-medium text-brand-red hover:underline">{tDe('notFound.home')}</a>
      <a href="/en/" class="font-medium text-brand-red hover:underline">{tEn('notFound.home')}</a>
    </p>
  </section>
</Base>
```

- [ ] **Step 5: RSS feeds (one per locale)**

Create `site/src/pages/rss.xml.js`:

```js
import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { ui } from '../i18n/ui';
import { byLocale, pathOf } from '../lib/trips';

export async function GET(context) {
  const trips = byLocale(await getCollection('trips'), 'de');
  return rss({
    title: ui.de['site.title'],
    description: ui.de['site.tagline'],
    site: context.site,
    items: trips.map((trip) => ({
      title: trip.data.title,
      pubDate: trip.data.date,
      description: trip.data.excerpt,
      link: pathOf(trip),
    })),
  });
}
```

Create `site/src/pages/en/rss.xml.js`:

```js
import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { ui } from '../../i18n/ui';
import { byLocale, pathOf } from '../../lib/trips';

export async function GET(context) {
  const trips = byLocale(await getCollection('trips'), 'en');
  return rss({
    title: ui.en['site.title'],
    description: ui.en['site.tagline'],
    site: context.site,
    items: trips.map((trip) => ({
      title: trip.data.title,
      pubDate: trip.data.date,
      description: trip.data.excerpt,
      link: pathOf(trip),
    })),
  });
}
```

- [ ] **Step 6: Full verification suite**

Run from `site/`:
```bash
npx astro check          # expect: 0 errors, 0 warnings
npm test                 # expect: all vitest suites pass (ui, paths, trips, format)
npm run build            # expect: success
ls dist/reiseziele/europa/index.html dist/en/destinations/europe/index.html \
   dist/uber-mich/index.html dist/en/about-me/index.html \
   dist/404.html dist/rss.xml dist/en/rss.xml dist/sitemap-index.xml
grep -c 'Neueste Beiträge' dist/en/destinations/europe/index.html   # expect 0 (exit 1)
```
Expected: all files exist; the final grep finds nothing on any EN page.

- [ ] **Step 7: Visual smoke test**

Run: `npm run preview` and open `http://localhost:4321/` and `/en/`.
Check: hero is full-color full-bleed, navy/red tokens visible, footer fully German on `/` and fully English on `/en/`, language switcher jumps between translated story pages (not just home).

- [ ] **Step 8: Commit**

```bash
git add site/src/
git commit -m "feat: region, about, 404 and RSS pages; phase 1 complete"
```

---

## After Phase 1

Separate plans, written when the previous phase lands:
- **Phase 2 — content migration:** WP REST export script, HTML→MDX conversion, all 9 stories × 2 + real about pages, referenced-image download, image storage decision (binaries-in-git policy vs. Cloudflare build needs — flagged in spec §6, decide with user). Checklist from Phase 1 review: hero images must be ≥1920px wide (FeaturedHero requests widths up to 1920; Astro won't upscale — the 768px sample renders soft on large screens); visual-audit `brand-red-light` label contrast on real photos (≈3.7:1 on mid-tone images; consider `from-navy/90` gradient if needed); revisit StoryPage element order with real content (spec §4 says intro → key facts → TOC; skeleton renders TOC → key facts → prose — decide deliberately when long-form stories land).
- **Phase 3 — travel map:** MapLibre GL island, `/karte/` + `/en/map/` pages, real homepage teaser with pins, per-story mini-map, nav links to Map.
- **Phase 4 — polish + cutover:** Lighthouse pass, parity crawl of all live URLs, Cloudflare Pages setup, DNS cutover, analytics.
