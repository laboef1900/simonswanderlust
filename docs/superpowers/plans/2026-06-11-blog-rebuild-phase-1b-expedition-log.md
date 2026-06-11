# Blog Rebuild — Phase 1b: Expedition Log Flavor Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the user-approved "Expedition Log" visual direction to the Phase 1 skeleton: monospace coordinate typography from real trip data, chronological entry numbers, topographic contour textures in navy bands, arrival stamps, dashed route-line dividers, and a live stats line in the map teaser.

**Architecture:** Pure flavor layer on the existing approved layout — no route, content-model, or i18n-structure changes. New pure helpers (TDD), three small decorative components, and surgical edits to six existing components. All decoration is `aria-hidden` (the same information stays available as visible text); all new UI strings go through `src/i18n/ui.ts`.

**Tech Stack:** Existing Astro 6 + Tailwind 4 site in `site/`. Adds `@fontsource/ibm-plex-mono` (static 400/600 — no variable build of Plex Mono exists) as the mono accent font.

**Approved direction (user choice "A" from the visual companion, 2026-06-11):** coordinates as typography, numbered journal entries, contour-line texture, arrival stamps, dashed route dividers — "fancy through detail, not noise". Stats line replaces the hardcoded mockup figures with live collection-derived counts (the mockup's "23.741 KM" is dropped — no route data exists yet; revisit with the Polarsteps export in Phase 3).

**Conventions:** npm/npx from `site/`; git from repo root; commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; stage only task files; never push.

---

### Task F1: Mono font, tokens, helpers (TDD), i18n keys

**Files:**
- Modify: `site/package.json` (+ lockfile)
- Modify: `site/src/styles/global.css`
- Modify: `site/src/layouts/Base.astro`
- Modify: `site/src/lib/format.ts`
- Modify: `site/src/lib/trips.ts`
- Modify: `site/src/i18n/ui.ts`
- Test: `site/src/lib/format.test.ts`, `site/src/lib/trips.test.ts`

- [ ] **Step 1: Install the mono font**

Run from `site/`: `npm install -D @fontsource/ibm-plex-mono`

- [ ] **Step 2: Token + font wiring**

In `site/src/styles/global.css`, add inside the `@theme` block:

```css
  --font-mono: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', monospace;
```

In `site/src/layouts/Base.astro` frontmatter, after the existing Inter import:

```ts
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
```

- [ ] **Step 3: Failing tests for the new helpers**

Append to `site/src/lib/format.test.ts` (new describes at file end):

```ts
import { coordsLabel, entryLabel } from './format';

describe('coordsLabel', () => {
  it('formats N/E coordinates', () => {
    expect(coordsLabel({ lat: 44.4268, lng: 26.1025 })).toBe('44.4268° N · 26.1025° E');
  });
  it('formats S/W coordinates (Galápagos)', () => {
    expect(coordsLabel({ lat: -0.7393, lng: -90.3273 })).toBe('0.7393° S · 90.3273° W');
  });
});

describe('entryLabel', () => {
  it('zero-pads the entry number', () => {
    expect(entryLabel(7)).toBe('N°07');
    expect(entryLabel(12)).toBe('N°12');
  });
});
```

(Adjust the import line to merge with the existing `dateLabel` import.)

Append to `site/src/lib/trips.test.ts`:

```ts
import { entryNumberOf } from './trips';

describe('entryNumberOf', () => {
  it('numbers chronologically, oldest = 1, within the trip locale', () => {
    expect(entryNumberOf(rhodesDe, all)).toBe(1);
    expect(entryNumberOf(buchDe, all)).toBe(2);
    expect(entryNumberOf(rhodesEn, all)).toBe(1);
  });
});
```

(Merge import with the existing one.)

Run from `site/`: `npx vitest run src/lib` — Expected: FAIL (coordsLabel/entryLabel/entryNumberOf not exported).

- [ ] **Step 4: Implement helpers**

Append to `site/src/lib/format.ts`:

```ts
/** "44.4268° N · 26.1025° E" — expedition-log coordinate line. */
export function coordsLabel(coords: { lat: number; lng: number }): string {
  const lat = `${Math.abs(coords.lat).toFixed(4)}° ${coords.lat >= 0 ? 'N' : 'S'}`;
  const lng = `${Math.abs(coords.lng).toFixed(4)}° ${coords.lng >= 0 ? 'E' : 'W'}`;
  return `${lat} · ${lng}`;
}

/** "N°07" — journal entry label. */
export function entryLabel(n: number): string {
  return `N°${String(n).padStart(2, '0')}`;
}
```

Append to `site/src/lib/trips.ts`:

```ts
/** 1-based chronological number (oldest = 1) of a trip within its locale's set. */
export function entryNumberOf(trip: Trip, all: Trip[]): number {
  const siblings = byLocale(all, localeOf(trip));
  return siblings.length - siblings.findIndex((t) => t.id === trip.id);
}
```

Run: `npx vitest run src/lib` — Expected: PASS (paths 4, trips 6, format 4).

- [ ] **Step 5: New i18n keys (both locales — completeness test enforces)**

In `site/src/i18n/ui.ts` add to `de`:

```ts
  'story.stamp': 'EINREISE',
  'stats.trips': 'REISEN',
  'stats.countries': 'LÄNDER',
  'stats.continents': 'KONTINENTE',
```

and to `en`:

```ts
  'story.stamp': 'ARRIVED',
  'stats.trips': 'TRIPS',
  'stats.countries': 'COUNTRIES',
  'stats.continents': 'CONTINENTS',
```

- [ ] **Step 6: Verify + commit**

Run from `site/`: `npm test` (expect 17 passed), `npx astro check` (0 errors), `npm run build` (17 pages).

```bash
git add site/src/ site/package.json site/package-lock.json
git commit -m "feat: expedition-log helpers, mono font, stats/stamp strings"
```

---

### Task F2: Decorative components + MapTeaser stats

**Files:**
- Create: `site/src/components/Contours.astro`
- Create: `site/src/components/Stamp.astro`
- Create: `site/src/components/RouteDivider.astro`
- Modify: `site/src/components/MapTeaser.astro`

- [ ] **Step 1: Contours (decorative topographic lines)**

Create `site/src/components/Contours.astro`:

```astro
---
/** Decorative topographic contour lines for dark bands. Parent needs `relative overflow-hidden`. */
---

<svg
  aria-hidden="true"
  class="pointer-events-none absolute inset-0 h-full w-full text-[#7fa3c8] opacity-15"
  viewBox="0 0 600 90"
  preserveAspectRatio="none"
>
  <path d="M0,60 Q80,20 160,45 T320,40 T480,55 T600,35" stroke="currentColor" fill="none" stroke-width="1"></path>
  <path d="M0,75 Q90,40 180,60 T340,55 T500,70 T600,50" stroke="currentColor" fill="none" stroke-width="1"></path>
  <path d="M0,45 Q70,5 150,30 T310,25 T470,40 T600,20" stroke="currentColor" fill="none" stroke-width="1"></path>
  <path d="M0,30 Q100,-5 200,15 T380,10 T560,25 T600,8" stroke="currentColor" fill="none" stroke-width="1"></path>
</svg>
```

- [ ] **Step 2: Stamp (arrival mark)**

Create `site/src/components/Stamp.astro`:

```astro
---
import { useTranslations, type Locale } from '../i18n/ui';
import { dateLabel } from '../lib/format';

interface Props {
  countryCode: string;
  date: Date;
  locale: Locale;
}

const { countryCode, date, locale } = Astro.props;
const t = useTranslations(locale);
---

{/* Decorative: country + date are in the page's visible text already. */}
<div
  aria-hidden="true"
  class="flex h-20 w-20 -rotate-12 flex-col items-center justify-center rounded-full border-2 border-dashed border-brand-red/80 text-brand-red/90"
>
  <span class="font-mono text-[8px] font-semibold tracking-[0.18em]">{t('story.stamp')}</span>
  <span class="text-sm font-extrabold">{countryCode}</span>
  <span class="font-mono text-[8px]">{dateLabel(date, locale)}</span>
</div>
```

- [ ] **Step 3: RouteDivider (dashed travel line)**

Create `site/src/components/RouteDivider.astro`:

```astro
---
/** Decorative dashed route line: filled dot → dashes → compass arrow → dashes → open ring. */
---

<div aria-hidden="true" class="mx-auto flex max-w-6xl items-center gap-2 px-5">
  <span class="h-1.5 w-1.5 rounded-full bg-brand-red"></span>
  <span class="flex-1 border-t-2 border-dashed border-navy/15"></span>
  <svg width="16" height="16" viewBox="0 0 16 16" class="text-ink/40">
    <path d="M2 14 L14 2 M14 2 h-5 M14 2 v5" stroke="currentColor" stroke-width="1.5" fill="none"></path>
  </svg>
  <span class="flex-1 border-t-2 border-dashed border-navy/15"></span>
  <span class="h-1.5 w-1.5 rounded-full border-2 border-brand-red bg-canvas"></span>
</div>
```

- [ ] **Step 4: MapTeaser gets contours + live stats**

Replace `site/src/components/MapTeaser.astro` with:

```astro
---
import { getCollection } from 'astro:content';
import Contours from './Contours.astro';
import { useTranslations, type Locale } from '../i18n/ui';
import { byLocale } from '../lib/trips';

interface Props {
  locale: Locale;
}

const { locale } = Astro.props;
const t = useTranslations(locale);
const trips = byLocale(await getCollection('trips'), locale);
const countries = new Set(trips.map((trip) => trip.data.countryCode)).size;
const continents = new Set(trips.map((trip) => trip.data.region)).size;
const stats = [
  `${trips.length} ${t('stats.trips')}`,
  `${countries} ${t('stats.countries')}`,
  `${continents} ${t('stats.continents')}`,
].join(' · ');
---

<section class="relative overflow-hidden bg-navy text-white">
  <Contours />
  <div class="relative mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-10">
    <div>
      <h2 class="text-2xl font-extrabold">{t('home.mapTeaser.title')}</h2>
      <p class="mt-1 font-mono text-xs tracking-[0.15em] text-brand-red-light">{stats}</p>
    </div>
    <span class="rounded border border-white/30 px-4 py-2 text-sm text-white/70">
      {t('home.mapTeaser.cta')} — {t('home.mapTeaser.soon')}
    </span>
  </div>
</section>
```

- [ ] **Step 5: Verify + commit**

Run from `site/`: `npx astro check` (0 errors), `npm run build`, then `grep -c '2 REISEN · 2 LÄNDER · 1 KONTINENTE' dist/index.html` → 1 and `grep -c '2 TRIPS · 2 COUNTRIES · 1 CONTINENTS' dist/en/index.html` → 1.

```bash
git add site/src/components/
git commit -m "feat: contour texture, arrival stamp, route divider, live map stats"
```

---

### Task F3: Apply the layer to cards, heroes, pages

**Files:**
- Modify: `site/src/components/StoryCard.astro`
- Modify: `site/src/components/StoryGrid.astro`
- Modify: `site/src/components/FeaturedHero.astro`
- Modify: `site/src/components/Footer.astro`
- Modify: `site/src/components/pages/HomePage.astro`
- Modify: `site/src/components/pages/RegionPage.astro`
- Modify: `site/src/components/pages/StoryPage.astro`

- [ ] **Step 1: StoryCard — entry number + mono label**

In `site/src/components/StoryCard.astro`:

Frontmatter: add `number?: number` to Props, destructure it, and import `entryLabel`:

```ts
import { dateLabel, entryLabel } from '../lib/format';

interface Props {
  trip: Trip;
  /** Large card spanning 2 columns/rows in the grid. */
  featured?: boolean;
  /** Chronological entry number (from entryNumberOf); omits the N° prefix when absent. */
  number?: number;
}

const { trip, featured = false, number } = Astro.props;
const locale = localeOf(trip);
const label = [number !== undefined ? entryLabel(number) : null, `${dateLabel(trip.data.date, locale)} · ${trip.data.country}`]
  .filter(Boolean)
  .join(' — ');
```

Template: change the label `<p>` class from `text-[11px] font-semibold` to `font-mono text-[11px] font-semibold` (mono accent), keep everything else.

- [ ] **Step 2: StoryGrid — numbering pool**

Replace `site/src/components/StoryGrid.astro` frontmatter and map call:

```astro
---
import StoryCard from './StoryCard.astro';
import { entryNumberOf, type Trip } from '../lib/trips';

interface Props {
  trips: Trip[];
  /** Full locale trip set used for chronological numbering; defaults to `trips`. */
  numberingPool?: Trip[];
}

const { trips, numberingPool = trips } = Astro.props;
---

<div class="grid auto-rows-[240px] gap-4 md:grid-cols-3">
  {
    trips.map((trip, i) => (
      <StoryCard trip={trip} featured={i === 0} number={entryNumberOf(trip, numberingPool)} />
    ))
  }
</div>
```

In `site/src/components/pages/HomePage.astro`, pass the full set so numbering survives the hero split:

```astro
<StoryGrid trips={rest.length > 0 ? rest : trips} numberingPool={trips} />
```

In `site/src/components/pages/RegionPage.astro` (region subsets must number against the whole locale set):

```astro
<StoryGrid trips={trips} numberingPool={all} />
```

- [ ] **Step 3: FeaturedHero — entry number + coordinates line**

In `site/src/components/FeaturedHero.astro`:

Frontmatter: import `coordsLabel, entryLabel` from `../lib/format` and `entryNumberOf` — but the hero has no sibling list; accept a `number` prop instead:

```ts
import { coordsLabel, dateLabel, entryLabel } from '../lib/format';

interface Props {
  trip: Trip;
  /** Chronological entry number for the N° label. */
  number?: number;
}

const { trip, number } = Astro.props;
const label = [
  t('home.heroLabel'),
  [number !== undefined ? entryLabel(number) : null, `${dateLabel(trip.data.date, locale)} · ${trip.data.country}`]
    .filter(Boolean)
    .join(' '),
].join(' — ');
```

Template: label `<p>` gets `font-mono` added to its classes. After the excerpt `<p>`, add the coordinates line:

```astro
<p class="mt-2 font-mono text-xs tracking-[0.15em] text-white/60">
  {coordsLabel(trip.data.coordinates)}
</p>
```

In `site/src/components/pages/HomePage.astro`, import `entryNumberOf` from `../../lib/trips` and pass:

```astro
{featured && <FeaturedHero trip={featured} number={entryNumberOf(featured, trips)} />}
```

- [ ] **Step 4: StoryPage — mono label, coordinates, stamp, divider**

In `site/src/components/pages/StoryPage.astro`:

Frontmatter additions:

```ts
import RouteDivider from '../RouteDivider.astro';
import Stamp from '../Stamp.astro';
import { coordsLabel, dateLabel, entryLabel } from '../../lib/format';
import { byLocale, entryNumberOf, localeOf, pathOf, translationOf, type Trip } from '../../lib/trips';

const number = entryNumberOf(trip, all);
const label = `${entryLabel(number)} — ${dateLabel(trip.data.date, locale)} · ${trip.data.country}`;
```

(The `label` const replaces the existing one; `all` already exists.)

Template changes:
1. Hero label `<p>`: add `font-mono` to its classes.
2. Under the `<h1>`, add the coordinates line:

```astro
<p class="mt-2 font-mono text-xs tracking-[0.2em] text-white/60">
  {coordsLabel(trip.data.coordinates)}
</p>
```

3. The other-language link paragraph becomes a flex row with the stamp on the right (stamp shows regardless of translation availability — restructure to keep both):

```astro
<div class="flex items-start justify-between gap-4">
  <p class="text-sm">
    {
      other && (
        <a href={pathOf(other)} class="font-medium text-brand-red hover:underline">
          {t('story.otherLang')} →
        </a>
      )
    }
  </p>
  <Stamp countryCode={trip.data.countryCode} date={trip.data.date} locale={locale} />
</div>
```

4. Directly above the prev/next `<nav ...>`, insert `<RouteDivider />` (the divider's own `max-w-6xl` is fine inside the `max-w-3xl` column — replace its `max-w-6xl` usage here by using it as-is; it fills the column).

- [ ] **Step 5: HomePage + Footer — dividers and contour footer**

In `site/src/components/pages/HomePage.astro`, insert `<RouteDivider />` between the `#stories` section and the about-teaser section (import it from `../RouteDivider.astro`). Remove the about-teaser section's `border-t border-navy/10` class (the divider replaces the hairline).

In `site/src/components/Footer.astro`, add the contour texture: import Contours from './Contours.astro', change `<footer class="bg-navy text-white">` to `<footer class="relative overflow-hidden bg-navy text-white">`, add `<Contours />` directly inside it, and add `relative` to the inner grid div's classes.

- [ ] **Step 6: Full verification**

From `site/`:
```bash
npm test            # 17 passed
npx astro check     # 0 errors
npm run build       # 17 pages
grep -c 'N°02' dist/index.html                          # ≥1 (Bucharest is entry 2: hero label)
grep -c '44.4268° N · 26.1025° E' dist/reisebericht-4-tage-bukarest/index.html   # ≥1
grep -c 'EINREISE' dist/reisebericht-4-tage-bukarest/index.html                  # 1 (stamp, DE)
grep -c 'ARRIVED' dist/en/4-day-travel-report-bucharest/index.html               # 1 (stamp, EN)
grep -c 'EINREISE' dist/en/4-day-travel-report-bucharest/index.html              # 0 (no leak)
```

- [ ] **Step 7: Commit**

```bash
git add site/src/
git commit -m "feat: apply expedition-log layer to cards, heroes and story pages"
```
