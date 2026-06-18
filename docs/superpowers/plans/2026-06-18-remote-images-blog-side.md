# Remote Images (Blog-Side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the Astro blog from local build-time hero images to remote, server-hosted images referenced by URL, rendered as responsive `<picture>` with no layout shift.

**Architecture:** A post's `heroImage` becomes a small object `{src, width, height, alt}` where `src` is the base URL on the image server. A pure, tested helper builds AVIF/WebP `srcset` strings from `src` + a fixed width convention (`{src}-{w}.{fmt}`). A thin `RemoteImage.astro` component renders the `<picture>`. The build never touches binaries; a down image server cannot break a deploy.

**Tech Stack:** Astro 6, TypeScript (strict), Vitest. Runs in `site/`.

**Contract (must match the uploader plan):** widths `[640, 1280, 1920]`, formats `avif` + `webp`, filename pattern `{src}-{width}.{format}`, and the variant-width rule in `variantWidths()` below (standard widths smaller than the source, plus the source's own intrinsic width — never upscaling). Source of truth: `docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md`.

---

## File Structure

- **Create** `site/src/lib/images.ts` — pure helpers: `RemoteHeroImage` type, `IMAGE_WIDTHS`, `variantWidths()`, `srcset()`, `fallbackSrc()`. One responsibility: turn a `heroImage` object into URL strings.
- **Create** `site/src/lib/images.test.ts` — unit tests for the helpers.
- **Create** `site/src/components/RemoteImage.astro` — logic-free `<picture>` renderer that consumes the helpers.
- **Modify** `site/src/content.config.ts` — `heroImage: image()` → zod object.
- **Modify** the 4 MDX files in `site/src/content/trips/{de,en}/` — `heroImage` string → object.
- **Modify** `site/src/components/FeaturedHero.astro`, `site/src/components/StoryCard.astro`, `site/src/components/pages/StoryPage.astro` — use `RemoteImage` instead of `astro:assets` `<Image>`.
- **Delete** `site/scripts/fetch-sample-images.sh`; **Modify** `site/README.md` and `CLAUDE.md` to drop references to it.

---

## Task 1: Image URL helper (`images.ts`)

**Files:**
- Create: `site/src/lib/images.ts`
- Test: `site/src/lib/images.test.ts`

- [ ] **Step 1: Write the failing test**

Create `site/src/lib/images.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { variantWidths, srcset, fallbackSrc, type RemoteHeroImage } from './images';

const big: RemoteHeroImage = {
  src: 'https://img.simonswanderlust.com/trips/rhodes-2021/hero',
  width: 2560,
  height: 965,
  alt: 'Rhodes coastline',
};
const small: RemoteHeroImage = {
  src: 'https://img.simonswanderlust.com/trips/bucharest-2024/hero',
  width: 768,
  height: 512,
  alt: 'Bucharest old town',
};

describe('variantWidths', () => {
  it('keeps standard widths below the source and appends the intrinsic width', () => {
    expect(variantWidths(2560)).toEqual([640, 1280, 1920, 2560]);
  });
  it('drops standard widths at or above the source (no upscaling)', () => {
    expect(variantWidths(768)).toEqual([640, 768]);
  });
  it('returns only the intrinsic width when the source is smaller than all standards', () => {
    expect(variantWidths(500)).toEqual([500]);
  });
});

describe('srcset', () => {
  it('builds an avif srcset from the convention', () => {
    expect(srcset(big, 'avif')).toBe(
      'https://img.simonswanderlust.com/trips/rhodes-2021/hero-640.avif 640w, ' +
        'https://img.simonswanderlust.com/trips/rhodes-2021/hero-1280.avif 1280w, ' +
        'https://img.simonswanderlust.com/trips/rhodes-2021/hero-1920.avif 1920w, ' +
        'https://img.simonswanderlust.com/trips/rhodes-2021/hero-2560.avif 2560w',
    );
  });
  it('builds a webp srcset honoring no-upscale', () => {
    expect(srcset(small, 'webp')).toBe(
      'https://img.simonswanderlust.com/trips/bucharest-2024/hero-640.webp 640w, ' +
        'https://img.simonswanderlust.com/trips/bucharest-2024/hero-768.webp 768w',
    );
  });
});

describe('fallbackSrc', () => {
  it('uses the 1280 webp when available', () => {
    expect(fallbackSrc(big)).toBe('https://img.simonswanderlust.com/trips/rhodes-2021/hero-1280.webp');
  });
  it('falls back to the largest available width otherwise', () => {
    expect(fallbackSrc(small)).toBe('https://img.simonswanderlust.com/trips/bucharest-2024/hero-768.webp');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- images`
Expected: FAIL — cannot find module `./images`.

- [ ] **Step 3: Write minimal implementation**

Create `site/src/lib/images.ts`:

```ts
/**
 * Remote hero image hosted on the image server (see
 * docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md).
 * `src` is the base URL with no size/format suffix; variants follow the
 * `{src}-{width}.{format}` convention.
 */
export interface RemoteHeroImage {
  src: string;
  width: number;
  height: number;
  alt: string;
}

export type ImageFormat = 'avif' | 'webp';

/** Standard responsive widths. MUST match the uploader's WIDTHS. */
export const IMAGE_WIDTHS = [640, 1280, 1920] as const;

/** Width used for the <img> fallback inside <picture>. */
const FALLBACK_WIDTH = 1280;

/**
 * Widths that actually exist for a given source: every standard width smaller
 * than the intrinsic width, plus the intrinsic width itself. Never upscales.
 * MUST mirror the uploader's variant logic so URLs never 404.
 */
export function variantWidths(
  intrinsicWidth: number,
  widths: readonly number[] = IMAGE_WIDTHS,
): number[] {
  const smaller = widths.filter((w) => w < intrinsicWidth);
  return [...smaller, intrinsicWidth];
}

/** Responsive srcset string for one format. */
export function srcset(image: RemoteHeroImage, format: ImageFormat): string {
  return variantWidths(image.width)
    .map((w) => `${image.src}-${w}.${format} ${w}w`)
    .join(', ');
}

/** Plain <img src> fallback — prefers the 1280 webp, else the largest available. */
export function fallbackSrc(image: RemoteHeroImage): string {
  const widths = variantWidths(image.width);
  const w = widths.includes(FALLBACK_WIDTH) ? FALLBACK_WIDTH : widths[widths.length - 1];
  return `${image.src}-${w}.webp`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- images`
Expected: PASS (8 assertions).

- [ ] **Step 5: Commit**

```bash
git add site/src/lib/images.ts site/src/lib/images.test.ts
git commit -m "feat(images): add remote hero-image URL helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `RemoteImage.astro` component

**Files:**
- Create: `site/src/components/RemoteImage.astro`

This component is intentionally logic-free — all URL logic lives in the tested `images.ts`. Verification is by `astro check` and by its use in Task 3.

- [ ] **Step 1: Create the component**

Create `site/src/components/RemoteImage.astro`:

```astro
---
import { srcset, fallbackSrc, type RemoteHeroImage } from '../lib/images';

interface Props {
  image: RemoteHeroImage;
  /** Responsive sizes attribute, e.g. "100vw" or "(min-width: 768px) 33vw, 100vw". */
  sizes: string;
  /** Overrides image.alt; pass "" for decorative images whose caption is adjacent text. */
  alt?: string;
  loading?: 'eager' | 'lazy';
  fetchpriority?: 'high' | 'auto' | 'low';
  class?: string;
}

const { image, sizes, alt, loading = 'lazy', fetchpriority, class: className } = Astro.props;
---

<picture>
  <source type="image/avif" srcset={srcset(image, 'avif')} sizes={sizes} />
  <source type="image/webp" srcset={srcset(image, 'webp')} sizes={sizes} />
  <img
    src={fallbackSrc(image)}
    alt={alt ?? image.alt}
    width={image.width}
    height={image.height}
    loading={loading}
    fetchpriority={fetchpriority}
    decoding="async"
    class={className}
  />
</picture>
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx astro check`
Expected: 0 errors (the component is unused so far; this confirms the import + props compile).

- [ ] **Step 3: Commit**

```bash
git add site/src/components/RemoteImage.astro
git commit -m "feat(images): add RemoteImage responsive picture component

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Switch schema, content, and components to remote images

This task lands together so the build stays green at the commit boundary: the schema, the 4 MDX files, and the 3 components must agree on the new `heroImage` shape simultaneously.

**Files:**
- Modify: `site/src/content.config.ts:7-17`
- Modify: `site/src/content/trips/de/sonne-und-abenteuer-rhodos.mdx:9`
- Modify: `site/src/content/trips/en/sun-and-adventure-on-rhodes.mdx:9`
- Modify: `site/src/content/trips/de/reisebericht-4-tage-bukarest.mdx:9`
- Modify: `site/src/content/trips/en/4-day-travel-report-bucharest.mdx:9`
- Modify: `site/src/components/FeaturedHero.astro:2,25-33`
- Modify: `site/src/components/StoryCard.astro:2,28-34`
- Modify: `site/src/components/pages/StoryPage.astro:2,40-48`

- [ ] **Step 1: Update the content schema**

In `site/src/content.config.ts`, change the `schema` so it no longer uses the `image()` helper. Replace lines 7-17 (the `schema: ({ image }) => z.object({ ... heroImage: image(), ...`) so it reads:

```ts
  schema: () =>
    z.object({
      title: z.string(),
      date: z.coerce.date(),
      country: z.string(),
      countryCode: z.string().length(2),
      region: z.enum(['europe', 'north-america', 'south-america']),
      translationKey: z.string(),
      excerpt: z.string(),
      heroImage: z.object({
        src: z.string().url(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        alt: z.string(),
      }),
      coordinates: z.object({ lat: z.number(), lng: z.number() }),
      stops: z.array(z.object({ name: z.string(), lat: z.number(), lng: z.number() })).optional(),
      route: z.string().optional(),
      keyFacts: z.record(z.string(), z.string()).optional(),
    }),
```

- [ ] **Step 2: Update the Rhodes DE frontmatter**

In `site/src/content/trips/de/sonne-und-abenteuer-rhodos.mdx`, replace line 9 (`heroImage: '../../../assets/trips/rhodos.webp'`) with:

```yaml
heroImage:
  src: 'https://img.simonswanderlust.com/trips/rhodes-2021/hero'
  width: 2560
  height: 965
  alt: 'Küste von Rhodos im Sommerlicht'
```

- [ ] **Step 3: Update the Rhodes EN frontmatter**

In `site/src/content/trips/en/sun-and-adventure-on-rhodes.mdx`, replace line 9 with:

```yaml
heroImage:
  src: 'https://img.simonswanderlust.com/trips/rhodes-2021/hero'
  width: 2560
  height: 965
  alt: 'Rhodes coastline in summer light'
```

- [ ] **Step 4: Update the Bucharest DE frontmatter**

In `site/src/content/trips/de/reisebericht-4-tage-bukarest.mdx`, replace line 9 with:

```yaml
heroImage:
  src: 'https://img.simonswanderlust.com/trips/bucharest-2024/hero'
  width: 768
  height: 512
  alt: 'Altstadt von Bukarest in der Abenddämmerung'
```

- [ ] **Step 5: Update the Bucharest EN frontmatter**

In `site/src/content/trips/en/4-day-travel-report-bucharest.mdx`, replace line 9 with:

```yaml
heroImage:
  src: 'https://img.simonswanderlust.com/trips/bucharest-2024/hero'
  width: 768
  height: 512
  alt: 'Bucharest old town at dusk'
```

- [ ] **Step 6: Update FeaturedHero.astro**

In `site/src/components/FeaturedHero.astro`, change the import on line 2 from:

```astro
import { Image } from 'astro:assets';
```
to:
```astro
import RemoteImage from './RemoteImage.astro';
```

Then replace the `<Image ... />` block (lines 25-33) with:

```astro
  <RemoteImage
    image={trip.data.heroImage}
    sizes="100vw"
    loading="eager"
    fetchpriority="high"
    class="absolute inset-0 h-full w-full object-cover"
  />
```

- [ ] **Step 7: Update StoryCard.astro**

In `site/src/components/StoryCard.astro`, change the import on line 2 from `import { Image } from 'astro:assets';` to `import RemoteImage from './RemoteImage.astro';`.

Then replace the `<Image ... />` block (lines 28-34) with:

```astro
  <RemoteImage
    image={trip.data.heroImage}
    alt=""
    sizes={featured ? '(min-width: 768px) 66vw, 100vw' : '(min-width: 768px) 33vw, 100vw'}
    class="h-full w-full object-cover transition duration-300 group-hover:scale-105"
  />
```

- [ ] **Step 8: Update StoryPage.astro**

In `site/src/components/pages/StoryPage.astro`, change the import on line 2 from `import { Image } from 'astro:assets';` to `import RemoteImage from '../RemoteImage.astro';`.

Then replace the `<Image ... />` block (lines 40-48) with:

```astro
    <RemoteImage
      image={trip.data.heroImage}
      sizes="100vw"
      loading="eager"
      fetchpriority="high"
      class="absolute inset-0 h-full w-full object-cover"
    />
```

- [ ] **Step 9: Type-check and test**

Run: `npx astro check && npm test`
Expected: astro check 0 errors; all Vitest suites pass (including `images` and the unchanged `trips`/`paths`/`format`/`ui` suites).

- [ ] **Step 10: Verify the rendered markup**

Run: `npm run dev` (background), then:

Run: `curl -s http://localhost:4321/ | grep -o '<source type="image/avif"[^>]*>' | head -1`
Expected: a `<source type="image/avif" srcset="https://img.simonswanderlust.com/trips/...-640.avif 640w, ...">` line is present. (The image itself will 404 until the uploader is deployed — that is expected; we are verifying the markup contract here.)

Stop the dev server when done.

- [ ] **Step 11: Commit**

```bash
git add site/src/content.config.ts site/src/content/trips site/src/components
git commit -m "feat(images): render hero images from remote URLs

heroImage becomes {src,width,height,alt}; hero/card/story now use the
RemoteImage responsive <picture> component instead of astro:assets.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Retire the fetch-images scaffold and update docs

**Files:**
- Delete: `site/scripts/fetch-sample-images.sh`
- Modify: `site/README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Delete the fetch script**

Run: `git rm site/scripts/fetch-sample-images.sh`
Expected: the file is staged for deletion.

- [ ] **Step 2: Update `site/README.md`**

Remove the entire "## Before first build" section (the heading and the two lines about `./scripts/fetch-sample-images.sh`). In the "## Structure" list, replace the first bullet's note about hero images so it reads:

```
- `src/content/trips/{de,en}/<slug>.mdx` — one story per language; filenames are the live WordPress slugs (SEO contract — never rename). `heroImage` is a remote URL object `{src,width,height,alt}` served by the image server (no binaries in git).
```

- [ ] **Step 3: Update `CLAUDE.md`**

In the "Build & Development" code block, delete the line:

```
./scripts/fetch-sample-images.sh    # one-time: download gitignored hero images
```

In the "## Repository Structure" tree, delete the `└── scripts/fetch-sample-images.sh` line. In Golden Rule 3 ("No Binaries in Git"), replace the sentence "Hero images are fetched by `site/scripts/fetch-sample-images.sh`." with "Hero images are hosted on the image server and referenced by URL in `heroImage` (see `docs/superpowers/specs/2026-06-18-image-hosting-uploader-design.md`)."

- [ ] **Step 4: Verify nothing else references the script**

Run: `grep -rn "fetch-sample-images" . --exclude-dir=.git`
Expected: no matches (or only inside `docs/superpowers/` historical plans, which are fine to leave).

- [ ] **Step 5: Final verification**

Run: `npx astro check && npm test && npm run build`
Expected: astro check 0 errors; all tests pass; `npm run build` completes and writes `dist/` (the build does not fetch any images).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(images): retire fetch-sample-images scaffold; update docs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- "Text in git, images by URL, no binaries" → Tasks 3 (schema/content) + 4 (retire fetch). ✓
- "heroImage becomes {src,width,height,alt}" → Task 3 Step 1. ✓
- "RemoteImage responsive `<picture>` with srcset + width/height + lazy/eager" → Tasks 1+2+3. ✓
- "srcset builder helper, unit-tested in src/lib/" → Task 1. ✓
- "retire fetch-sample-images.sh" → Task 4. ✓
- "schema validation fails build on malformed heroImage" → Task 3 Step 1 (zod object). ✓
- "build never fetches images" → verified Task 4 Step 5. ✓
- "no upscaling / URLs never 404 via shared width rule" → `variantWidths` in Task 1, mirrored by uploader plan. ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete; every referenced symbol (`variantWidths`, `srcset`, `fallbackSrc`, `RemoteHeroImage`) is defined in Task 1. ✓

**Type consistency:** `RemoteHeroImage` fields `{src,width,height,alt}` are identical in the schema (Task 3), the helper (Task 1), the component props (Task 2), and the MDX frontmatter (Task 3). Helper names match between definition (Task 1) and use (Task 2). ✓

**Known caveat (by design):** hero images will 404 in dev/prod until the uploader (separate plan) is deployed and the two sample images are uploaded under `trips/rhodes-2021/hero` and `trips/bucharest-2024/hero`. The blog-side work is fully verifiable via unit tests, `astro check`, build, and markup inspection without the server.
