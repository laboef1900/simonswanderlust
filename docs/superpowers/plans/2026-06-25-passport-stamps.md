# Per-Country Passport Stamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the uniform decorative story-page stamp into an authentic, per-country passport stamp — deterministic by country code, with two regional families (Schengen rectangle for Europe, circular immigration stamp for the Americas) and a worn rubber-ink look.

**Architecture:** A pure, unit-tested `stampStyle(countryCode)` picks ink/border/rotation deterministically; `regionShape(region)` picks the family. `Stamp.astro` renders inline SVG in the chosen family (arced country name, date, ✈) styled with the worn-ink CSS. Decorative (`aria-hidden`).

**Tech Stack:** Astro 6 component (`.astro` + inline SVG/CSS), `site/src/lib/` TS helper, Vitest.

## Global Constraints

- Strict TS (`astro/tsconfigs/strict`) — no `any`, no `@ts-ignore`. Named exports. Match surrounding code style.
- **Deterministic**: same `countryCode` → identical stamp, always. Pure helper (string in → object out), no DOM.
- **Two families by region**: `europe` → `rect` (Schengen square-corner entry); everything else → `circle`.
- Ink palette (weighted to black/navy): `#1a1a2e`, `#1e3a6e`, `#c0311e`, `#6b3d9e`, `#1e5c30`.
- Worn-ink look: ink at `opacity:0.82`, `mix-blend-mode:multiply` over the cream canvas (`--color-canvas:#fbfbfd`), `filter:blur(0.3px)`, hand-tilt rotation **−5°…+5°**.
- **No new i18n keys** — reuse `story.stamp` (`EINREISE`/`ARRIVED`). Stamp stays `aria-hidden` (data already in page text).
- Story page only; no homepage/teaser stamp. `npx astro check` + `npm test` green (both need a reachable Postgres — a DB forwarder at `DATABASE_URL=postgres://images:devpw@localhost:5432/images` is available; if not reachable, that's the documented loader caveat — `npm test` alone covers the helper).

---

### Task 1: `stampStyle` helper (pure, unit-tested)

**Files:**
- Create: `site/src/lib/stamp.ts`
- Test: `site/test/stamp.test.ts`

**Interfaces:**
- Produces:
  - `type StampShape = 'rect' | 'circle'`
  - `type StampBorder = 'single' | 'double' | 'dashed'`
  - `interface StampStyle { ink: string; border: StampBorder; rotation: number }`
  - `function regionShape(region: string): StampShape`
  - `function stampStyle(countryCode: string): StampStyle`

- [ ] **Step 1: Write the failing test** — `site/test/stamp.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { regionShape, stampStyle } from '../src/lib/stamp';

const INKS = ['#1a1a2e', '#1e3a6e', '#c0311e', '#6b3d9e', '#1e5c30'];
const BORDERS = ['single', 'double', 'dashed'];

describe('regionShape', () => {
  it('maps europe to rect, other regions to circle', () => {
    expect(regionShape('europe')).toBe('rect');
    expect(regionShape('north-america')).toBe('circle');
    expect(regionShape('south-america')).toBe('circle');
    expect(regionShape('whatever')).toBe('circle');
  });
});

describe('stampStyle', () => {
  it('is deterministic for a given code', () => {
    expect(stampStyle('HU')).toEqual(stampStyle('hu')); // case-insensitive + stable
    expect(stampStyle('MX')).toEqual(stampStyle('MX'));
  });
  it('returns a valid style for any code', () => {
    for (const c of ['HU', 'RO', 'GR', 'DK', 'MX', 'CR', 'EC', 'BR', 'X', 'ZZ']) {
      const s = stampStyle(c);
      expect(INKS).toContain(s.ink);
      expect(BORDERS).toContain(s.border);
      expect(s.rotation).toBeGreaterThanOrEqual(-5);
      expect(s.rotation).toBeLessThanOrEqual(5);
    }
  });
  it('produces visible variety across the blog countries', () => {
    const inks = new Set(['HU', 'RO', 'GR', 'DK', 'MX', 'CR', 'EC', 'BR'].map((c) => stampStyle(c).ink));
    expect(inks.size).toBeGreaterThanOrEqual(3);
  });
  it('weights ink toward black/navy (as real stamps do)', () => {
    const codes = [];
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) codes.push(String.fromCharCode(a, b));
    const darks = codes.filter((c) => ['#1a1a2e', '#1e3a6e'].includes(stampStyle(c).ink)).length;
    expect(darks / codes.length).toBeGreaterThan(0.5);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** — `cd site && npx vitest run test/stamp.test.ts` (module not found).

- [ ] **Step 3: Implement** — `site/src/lib/stamp.ts`

```ts
export type StampShape = 'rect' | 'circle';
export type StampBorder = 'single' | 'double' | 'dashed';
export interface StampStyle { ink: string; border: StampBorder; rotation: number }

// Real-world-weighted ink palette: black + navy appear twice → ~57% of codes.
const INKS = ['#1a1a2e', '#1e3a6e', '#1a1a2e', '#1e3a6e', '#c0311e', '#6b3d9e', '#1e5c30'];
const BORDERS: StampBorder[] = ['single', 'double', 'dashed'];

function hash(code: string): number {
  let h = 2166136261;
  const s = code.toUpperCase();
  for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 16777619)) >>> 0;
  return h;
}

export function regionShape(region: string): StampShape {
  return region === 'europe' ? 'rect' : 'circle';
}

export function stampStyle(countryCode: string): StampStyle {
  const h = hash(countryCode);
  return {
    ink: INKS[h % INKS.length] as string,
    border: BORDERS[(h >>> 4) % BORDERS.length] as StampBorder,
    rotation: ((h >>> 8) % 11) - 5, // -5..+5
  };
}
```

- [ ] **Step 4: Run — expect PASS** — `cd site && npx vitest run test/stamp.test.ts`

- [ ] **Step 5: Commit**

```bash
git add site/src/lib/stamp.ts site/test/stamp.test.ts
git commit -m "feat(stamp): deterministic per-country stampStyle + regionShape (tested)"
```

---

### Task 2: `Stamp.astro` SVG rewrite + wiring

**Files:**
- Modify (rewrite): `site/src/components/Stamp.astro`
- Modify: `site/src/components/pages/StoryPage.astro:71` (pass `country` + `region`)

**Interfaces:**
- Consumes: `regionShape`, `stampStyle` (Task 1); `dateLabel` (`site/src/lib/format`) is NOT used for the stamp date — a compact numeric date is computed inline (more authentic + fits). `t('story.stamp')` for the status word.

- [ ] **Step 1: Rewrite `Stamp.astro`.** Replace the whole file with:

```astro
---
import { useTranslations, type Locale } from '../i18n/ui';
import { regionShape, stampStyle } from '../lib/stamp';

interface Props {
  countryCode: string;
  country: string;
  date: Date;
  region: string;
  locale: Locale;
}

const { countryCode, country, date, region, locale } = Astro.props;
const t = useTranslations(locale);
const shape = regionShape(region);
const { ink, border, rotation } = stampStyle(countryCode);

const code = countryCode.toUpperCase();
const name = country.toUpperCase();
const status = t('story.stamp');
const pad = (n: number) => String(n).padStart(2, '0');
const when = `${pad(date.getUTCDate())} ${pad(date.getUTCMonth() + 1)} ${date.getUTCFullYear()}`;
const dash = border === 'dashed' ? '5 3' : undefined;
const styleVars = `--ink:${ink};--rot:${rotation}deg`;
const topId = `stamp-top-${code}`;
const botId = `stamp-bot-${code}`;
---

{shape === 'circle' ? (
  <svg class="stamp" style={styleVars} viewBox="0 0 100 100" width="86" height="86" aria-hidden="true" role="presentation">
    <defs>
      <path id={topId} d="M 16,50 A 34,34 0 0 1 84,50" fill="none" />
      <path id={botId} d="M 18,50 A 32,32 0 0 0 82,50" fill="none" />
    </defs>
    <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray={dash} />
    {border === 'double' && <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" stroke-width="1" />}
    <text font-size="9" letter-spacing="1.2" fill="currentColor">
      <textPath href={`#${topId}`} startOffset="50%" text-anchor="middle">{name}</textPath>
    </text>
    <text font-size="6.5" letter-spacing="2" fill="currentColor">
      <textPath href={`#${botId}`} startOffset="50%" text-anchor="middle">★ {status} ★</textPath>
    </text>
    <text x="50" y="40" text-anchor="middle" font-size="11" fill="currentColor">✈</text>
    <text x="50" y="60" text-anchor="middle" font-size="12" font-weight="800" fill="currentColor">{when}</text>
  </svg>
) : (
  <svg class="stamp" style={styleVars} viewBox="0 0 124 72" width="124" height="72" aria-hidden="true" role="presentation">
    <rect x="3" y="3" width="118" height="66" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray={dash} />
    {border === 'double' && <rect x="7" y="7" width="110" height="58" fill="none" stroke="currentColor" stroke-width="1" />}
    <circle cx="20" cy="19" r="10" fill="none" stroke="currentColor" stroke-width="1" />
    <text x="20" y="22" text-anchor="middle" font-size="8" font-weight="800" fill="currentColor">{code}</text>
    <text x="104" y="23" text-anchor="middle" font-size="12" fill="currentColor">✈</text>
    <text x="64" y="42" text-anchor="middle" font-size="8.5" letter-spacing="1.2" fill="currentColor">{name}</text>
    <text x="64" y="60" text-anchor="middle" font-size="13" font-weight="800" fill="currentColor">{when}</text>
  </svg>
)}

<style>
  .stamp {
    color: var(--ink);
    opacity: 0.82;
    mix-blend-mode: multiply;
    filter: blur(0.3px);
    transform: rotate(var(--rot));
  }
  .stamp text { font-family: var(--font-mono, ui-monospace, monospace); text-transform: uppercase; }
</style>
```

- [ ] **Step 2: Wire the new props in `StoryPage.astro`.** Change line 71 from:

```astro
      <Stamp countryCode={trip.data.countryCode} date={trip.data.date} locale={locale} />
```
to:
```astro
      <Stamp countryCode={trip.data.countryCode} country={trip.data.country} date={trip.data.date} region={trip.data.region} locale={locale} />
```

- [ ] **Step 3: Type-check + tests.**

Run: `cd site && DATABASE_URL="postgres://images:devpw@localhost:5432/images" npx astro check`
Expected: 0 errors.
Run: `cd site && npm test`
Expected: green (incl. the Task 1 stamp tests).

- [ ] **Step 4: Visual check (the real verification).** Rebuild the blog and view a Europe post and an Americas post:

```bash
cd .. && POSTGRES_PASSWORD=devpw BUILD_SECRET=devsecret docker compose up -d --build blog-builder blog
```
Then in the browser open a published story (e.g. `/karte/` links, or a published post route): Europe posts show the **rectangle** Schengen stamp, Americas posts the **circle** stamp; the same country always looks identical; ink reads as printed-on-paper (multiply over the cream page); the hand-tilt + worn look reads as a real stamp; no layout shift; the country name + date are legible.

- [ ] **Step 5: Commit**

```bash
git add site/src/components/Stamp.astro site/src/components/pages/StoryPage.astro
git commit -m "feat(stamp): authentic per-country passport stamp (SVG, two regional families)"
```

---

## Self-Review

**Spec coverage:** deterministic `stampStyle` + `regionShape` (ink palette/weighting, border, rotation range) → Task 1; two SVG families by region (Schengen rect / Americas circle), arced country name, date, ✈, worn-ink CSS (opacity/multiply/blur/tilt), `aria-hidden`, reuse `story.stamp`, wiring with `country`+`region` → Task 2. No new i18n keys; story-page only; no homepage stamp — all honored.

**Placeholder scan:** No TBD/TODO. Both tasks carry complete code (helper + tests + full `Stamp.astro` + the exact `StoryPage` line change). The SVG is concrete; visual tuning happens against the running blog in Step 4 (not a placeholder — the component renders correctly as written).

**Type consistency:** `StampStyle`/`StampShape`/`StampBorder` (Task 1) consumed by `Stamp.astro` (Task 2). `stampStyle(countryCode)` and `regionShape(region)` signatures match. The `INKS` weighting (black+navy twice) matches the Task 1 test's `>0.5` black/navy assertion. The component's `Props` (`countryCode, country, date, region, locale`) match the new `StoryPage` call. Date is compact-numeric inline (UTC getters → no TZ drift), intentionally not `dateLabel` (noted in Task 2 Interfaces).
