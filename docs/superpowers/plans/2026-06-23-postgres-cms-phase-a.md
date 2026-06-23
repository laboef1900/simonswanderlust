# Postgres CMS — Phase A (Deployable Pipeline + Runtime Build) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the static blog build its content from **Postgres** (instead of MDX files) and deploy that build at **runtime** into the nginx-served volume — with the existing routes/output unchanged. No editor yet (that's Phase B).

**Architecture:** A custom Astro Content Layer loader reads published rows from Postgres at build time and emits collection entries with the same `id`/schema as today, so `trips.ts`/`paths.ts` are untouched. Bodies are Markdown; a loader-side rehype transform turns each image into the existing responsive `<picture>` using a per-post `images` map. Because the build now needs the DB, it runs at runtime: a long-running **builder** service (Node, has the site toolchain + DB access) exposes a secret-gated `POST /build` that runs `astro build` and atomically swaps the output into a shared volume; nginx serves that volume.

**Tech Stack:** Astro 6 (static), Node 22, `pg`, `unified`/`rehype-parse`/`rehype-stringify`/`unist-util-visit`, Postgres 17, Docker Compose, Vitest.

## Global Constraints

- Node `>=22.12.0`; site is ESM; strict TS (`astro/tsconfigs/strict`) — no `any`, no `@ts-ignore`.
- **SEO slug contract (critical):** DE at root, EN under `/en/`; slugs equal today's MDX filenames and must never change. The loader MUST emit entries with `id = `${locale}/${slug}`` so `trips.ts`/`paths.ts` and their tests stay unchanged.
- Collection schema is **unchanged** from `site/src/content.config.ts` (title, date, country, countryCode, region, translationKey, excerpt, heroImage{src,width,height,alt}, coordinates{lat,lng}, stops?, route?, keyFacts?).
- Responsive image widths MUST stay `IMAGE_WIDTHS = [640, 1280, 1920]` and use `site/src/lib/images.ts` helpers — body images must render byte-for-byte like today's `BodyImage`→`RemoteImage` `<picture>`.
- Tests run with **no live services** except the explicitly DB-backed ones, which are guarded by `TEST_DATABASE_URL` and skipped otherwise.
- Prerequisite: the uploader auth feature (PR #3) Postgres infra exists. **Execute this plan on a branch that already contains the auth work** (branch off `feature/uploader-auth`, or off `main` after it merges) so the `db` service + `DATABASE_URL` pattern are present.
- Gates before each commit (from `site/`): `npm run build` where noted, `npx astro check`, `npm test`.
- Commit style: `type(scope): desc`.

---

### Task 1: `pg` + transform deps, `posts` schema, and stub migration

**Files:**
- Modify: `site/package.json` (deps)
- Create: `site/scripts/migrate-stub-posts.mjs`
- Test: `site/test/migrate-stub-posts.test.ts`

**Interfaces:**
- Consumes: existing MDX under `site/src/content/trips/{de,en}/*.mdx`.
- Produces: a populated `posts` table (schema below); `parseMdxFile(path) → { locale, slug, data, bodyMarkdown, images }` exported from the script for testing.

`posts` schema (created idempotently by the script):
```sql
CREATE TABLE IF NOT EXISTS posts (
  id uuid PRIMARY KEY, translation_key text NOT NULL, locale text NOT NULL CHECK (locale IN ('de','en')),
  slug text NOT NULL, title text NOT NULL, date date NOT NULL, country text NOT NULL,
  country_code text NOT NULL CHECK (char_length(country_code)=2),
  region text NOT NULL CHECK (region IN ('europe','north-america','south-america')),
  excerpt text NOT NULL, hero_image jsonb NOT NULL, coordinates jsonb NOT NULL,
  stops jsonb, route text, key_facts jsonb, body_markdown text NOT NULL,
  images jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS posts_locale_slug_idx ON posts (locale, slug);
CREATE INDEX IF NOT EXISTS posts_translation_key_idx ON posts (translation_key);
```

- [ ] **Step 1: Add dependencies**

Run (from `site/`):
```bash
npm install pg gray-matter unified rehype-parse rehype-stringify unist-util-visit hastscript
npm install -D @types/pg
```
Expected: `package.json` lists these; `npm install` exits 0. (`gray-matter` parses MDX frontmatter; the `unified`/`rehype*`/`unist`/`hastscript` set is for the Task 2 transform.)

- [ ] **Step 2: Write the failing test for the MDX parser**

`site/test/migrate-stub-posts.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseMdxFile, mdxBodyToMarkdown } from '../scripts/migrate-stub-posts.mjs';
import { join } from 'node:path';

const de = join(process.cwd(), 'src/content/trips/de');

describe('parseMdxFile', () => {
  it('parses a stub post into row fields with locale/slug from the path', () => {
    const r = parseMdxFile(join(de, 'reisebericht-4-tage-bukarest.mdx'), 'de');
    expect(r.locale).toBe('de');
    expect(r.slug).toBe('reisebericht-4-tage-bukarest');
    expect(r.data.translationKey).toBe('bucharest-2024');
    expect(r.data.heroImage.src).toContain('/trips/bucharest-2024/hero');
    expect(r.bodyMarkdown).toContain('## Ankommen');
    expect(r.images).toEqual({});
  });
});

describe('mdxBodyToMarkdown', () => {
  it('rewrites a <BodyImage> tag to a markdown image and records its dimensions', () => {
    const body = 'Intro\n\n<BodyImage src="https://img/x/y" width={1600} height={1067} alt="A caption" />\n\nMore';
    const { markdown, images } = mdxBodyToMarkdown(body);
    expect(markdown).toContain('![A caption](https://img/x/y)');
    expect(markdown).not.toContain('<BodyImage');
    expect(images['https://img/x/y']).toEqual({ width: 1600, height: 1067 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/migrate-stub-posts.test.ts`
Expected: FAIL — cannot import from `../scripts/migrate-stub-posts.mjs`.

- [ ] **Step 4: Write the migration script**

`site/scripts/migrate-stub-posts.mjs`:
```js
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import pg from 'pg';

const CONTENT = join(process.cwd(), 'src/content/trips');

/** Convert MDX body to Markdown: <BodyImage .../> → ![alt](src), collecting {src:{width,height}}. */
export function mdxBodyToMarkdown(body) {
  const images = {};
  const markdown = body.replace(
    /<BodyImage\s+([^>]*?)\/>/g,
    (_m, attrs) => {
      const get = (name) => {
        const s = attrs.match(new RegExp(`${name}="([^"]*)"`));
        if (s) return s[1];
        const n = attrs.match(new RegExp(`${name}=\\{([^}]*)\\}`));
        return n ? n[1].trim() : undefined;
      };
      const src = get('src');
      const alt = get('alt') ?? '';
      const width = Number(get('width'));
      const height = Number(get('height'));
      if (src && Number.isFinite(width) && Number.isFinite(height)) images[src] = { width, height };
      return `![${alt}](${src})`;
    },
  );
  return { markdown, images };
}

/** Parse one MDX file into row fields. `locale` is supplied by the caller (folder). */
export function parseMdxFile(path, locale) {
  const raw = readFileSync(path, 'utf8');
  const { data, content } = matter(raw);
  const slug = path.split('/').pop().replace(/\.mdx$/, '');
  const { markdown, images } = mdxBodyToMarkdown(content.trim());
  return { locale, slug, data, bodyMarkdown: markdown, images };
}

function rowsFromDisk() {
  const rows = [];
  for (const locale of ['de', 'en']) {
    const dir = join(CONTENT, locale);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.mdx'))) {
      rows.push(parseMdxFile(join(dir, file), locale));
    }
  }
  return rows;
}

export async function migrate(connectionString) {
  const pool = new pg.Pool({ connectionString });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS posts (
      id uuid PRIMARY KEY, translation_key text NOT NULL, locale text NOT NULL CHECK (locale IN ('de','en')),
      slug text NOT NULL, title text NOT NULL, date date NOT NULL, country text NOT NULL,
      country_code text NOT NULL CHECK (char_length(country_code)=2),
      region text NOT NULL CHECK (region IN ('europe','north-america','south-america')),
      excerpt text NOT NULL, hero_image jsonb NOT NULL, coordinates jsonb NOT NULL,
      stops jsonb, route text, key_facts jsonb, body_markdown text NOT NULL,
      images jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS posts_locale_slug_idx ON posts (locale, slug)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS posts_translation_key_idx ON posts (translation_key)`);
    const rows = rowsFromDisk();
    for (const r of rows) {
      const d = r.data;
      await pool.query(
        `INSERT INTO posts (id, translation_key, locale, slug, title, date, country, country_code, region,
           excerpt, hero_image, coordinates, stops, route, key_facts, body_markdown, images, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'published')
         ON CONFLICT (locale, slug) DO UPDATE SET
           translation_key=EXCLUDED.translation_key, title=EXCLUDED.title, date=EXCLUDED.date,
           country=EXCLUDED.country, country_code=EXCLUDED.country_code, region=EXCLUDED.region,
           excerpt=EXCLUDED.excerpt, hero_image=EXCLUDED.hero_image, coordinates=EXCLUDED.coordinates,
           stops=EXCLUDED.stops, route=EXCLUDED.route, key_facts=EXCLUDED.key_facts,
           body_markdown=EXCLUDED.body_markdown, images=EXCLUDED.images, status='published', updated_at=now()`,
        [randomUUID(), d.translationKey, r.locale, r.slug, d.title, d.date, d.country, d.countryCode,
         d.region, d.excerpt, JSON.stringify(d.heroImage), JSON.stringify(d.coordinates),
         d.stops ? JSON.stringify(d.stops) : null, d.route ?? null, d.keyFacts ? JSON.stringify(d.keyFacts) : null,
         r.bodyMarkdown, JSON.stringify(r.images)],
      );
    }
    return rows.length;
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
  migrate(url).then((n) => console.log(`migrated ${n} post rows`)).catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/migrate-stub-posts.test.ts`
Expected: PASS (2 tests). (`date` may be a `Date` from gray-matter; the test only checks `translationKey`/`heroImage`/body — fine.)

- [ ] **Step 6: Commit**

```bash
git add site/package.json site/package-lock.json site/scripts/migrate-stub-posts.mjs site/test/migrate-stub-posts.test.ts
git commit -m "feat(site): posts schema + MDX→Postgres stub migration script"
```

---

### Task 2: Body-image rehype transform (markdown `<img>` → responsive `<picture>`)

**Files:**
- Create: `site/src/lib/body-images.ts`
- Test: `site/test/body-images.test.ts`

**Interfaces:**
- Consumes: `srcset`, `fallbackSrc`, `type RemoteHeroImage` from `site/src/lib/images.ts`.
- Produces: `transformBodyImages(html: string, images: Record<string,{width:number;height:number}>): string` — returns HTML with each `<img>` whose `src` is in `images` replaced by the `BodyImage`/`RemoteImage` `<figure><picture>…</figure>` markup. Unknown images are left as-is.

- [ ] **Step 1: Write the failing test**

`site/test/body-images.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { transformBodyImages } from '../src/lib/body-images';

const images = { 'https://img/x/y': { width: 1600, height: 1067 } };

describe('transformBodyImages', () => {
  it('replaces a known <img> with a responsive <picture> inside a figure', () => {
    const out = transformBodyImages('<p><img src="https://img/x/y" alt="A caption"></p>', images);
    expect(out).toContain('<figure class="my-8">');
    expect(out).toContain('<source type="image/avif"');
    expect(out).toContain('<source type="image/webp"');
    expect(out).toContain('https://img/x/y-1280.webp'); // fallback src
    expect(out).toContain('width="1600"');
    expect(out).toContain('height="1067"');
    expect(out).toContain('alt="A caption"');
    expect(out).toContain('class="block w-full rounded-lg"');
  });
  it('leaves an unknown image untouched', () => {
    const out = transformBodyImages('<img src="https://other/z" alt="z">', {});
    expect(out).toContain('<img src="https://other/z"');
    expect(out).not.toContain('<picture>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/body-images.test.ts`
Expected: FAIL — `../src/lib/body-images` not found.

- [ ] **Step 3: Write the implementation**

`site/src/lib/body-images.ts`:
```ts
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import { h } from 'hastscript';
import { srcset, fallbackSrc, type RemoteHeroImage } from './images';

export interface ImageDims { width: number; height: number }
const SIZES = '(min-width: 768px) 720px, 100vw';

/** hast <figure><picture>…</figure> mirroring BodyImage → RemoteImage output. */
function pictureNode(image: RemoteHeroImage) {
  return h('figure', { class: 'my-8' }, [
    h('picture', [
      h('source', { type: 'image/avif', srcset: srcset(image, 'avif'), sizes: SIZES }),
      h('source', { type: 'image/webp', srcset: srcset(image, 'webp'), sizes: SIZES }),
      h('img', {
        src: fallbackSrc(image),
        alt: image.alt,
        width: image.width,
        height: image.height,
        loading: 'lazy',
        decoding: 'async',
        class: 'block w-full rounded-lg',
      }),
    ]),
  ]);
}

export function transformBodyImages(html: string, images: Record<string, ImageDims>): string {
  const tree = unified().use(rehypeParse, { fragment: true }).parse(html);
  visit(tree, 'element', (node, index, parent) => {
    if (node.tagName !== 'img' || !parent || index === null) return;
    const src = node.properties?.src as string | undefined;
    if (!src || !images[src]) return;
    const dims = images[src];
    const alt = (node.properties?.alt as string) ?? '';
    parent.children[index] = pictureNode({ src, alt, width: dims.width, height: dims.height });
  });
  return unified().use(rehypeStringify, { allowDangerousHtml: true }).stringify(tree);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/body-images.test.ts`
Expected: PASS (2 tests). (`fallbackSrc` of a 1600-wide image → `…-1280.webp` since 1280 < 1600; matches the assertion.)

- [ ] **Step 5: Commit**

```bash
git add site/src/lib/body-images.ts site/test/body-images.test.ts
git commit -m "feat(site): rehype transform rendering body images as responsive <picture>"
```

---

### Task 3: Postgres Content Layer loader (replace the glob loader)

**Files:**
- Create: `site/src/lib/postgres-loader.ts`
- Modify: `site/src/content.config.ts`
- Test: `site/test/postgres-loader.test.ts` (pure mapping unit, no DB)

**Interfaces:**
- Consumes: `transformBodyImages` (Task 2); `pg`; the existing trips zod schema.
- Produces: `rowToEntryInput(row) → { id, data, body }` (pure, testable) and `postgresTripsLoader()` returning an Astro `Loader`.

- [ ] **Step 1: Write the failing test (pure row→entry mapping)**

`site/test/postgres-loader.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { rowToEntryInput } from '../src/lib/postgres-loader';

const row = {
  translation_key: 'bucharest-2024', locale: 'de', slug: 'reisebericht-4-tage-bukarest',
  title: 'T', date: new Date('2024-10-03'), country: 'Rumänien', country_code: 'RO', region: 'europe',
  excerpt: 'E', hero_image: { src: 'https://img/h', width: 768, height: 512, alt: 'a' },
  coordinates: { lat: 44.4, lng: 26.1 }, stops: null, route: null, key_facts: { K: 'V' },
  body_markdown: '## Hi', images: {},
};

describe('rowToEntryInput', () => {
  it('builds id as `${locale}/${slug}` and camelCase data matching the schema', () => {
    const e = rowToEntryInput(row as never);
    expect(e.id).toBe('de/reisebericht-4-tage-bukarest');
    expect(e.data.translationKey).toBe('bucharest-2024');
    expect(e.data.countryCode).toBe('RO');
    expect(e.data.heroImage).toEqual({ src: 'https://img/h', width: 768, height: 512, alt: 'a' });
    expect(e.data.keyFacts).toEqual({ K: 'V' });
    expect(e.body).toBe('## Hi');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/postgres-loader.test.ts`
Expected: FAIL — `rowToEntryInput` not found.

- [ ] **Step 3: Write the loader**

`site/src/lib/postgres-loader.ts`:
```ts
import type { Loader } from 'astro/loaders';
import pg from 'pg';
import { transformBodyImages, type ImageDims } from './body-images';

interface PostRow {
  translation_key: string; locale: 'de' | 'en'; slug: string; title: string; date: Date | string;
  country: string; country_code: string; region: string; excerpt: string;
  hero_image: { src: string; width: number; height: number; alt: string };
  coordinates: { lat: number; lng: number };
  stops: { name: string; lat: number; lng: number }[] | null; route: string | null;
  key_facts: Record<string, string> | null; body_markdown: string; images: Record<string, ImageDims>;
}

/** Pure mapping: a DB row → the { id, data, body } a loader will parse/store. */
export function rowToEntryInput(row: PostRow) {
  return {
    id: `${row.locale}/${row.slug}`,
    body: row.body_markdown,
    images: row.images ?? {},
    data: {
      title: row.title,
      date: row.date instanceof Date ? row.date : new Date(row.date),
      country: row.country,
      countryCode: row.country_code,
      region: row.region,
      translationKey: row.translation_key,
      excerpt: row.excerpt,
      heroImage: row.hero_image,
      coordinates: row.coordinates,
      ...(row.stops ? { stops: row.stops } : {}),
      ...(row.route ? { route: row.route } : {}),
      ...(row.key_facts ? { keyFacts: row.key_facts } : {}),
    },
  };
}

export function postgresTripsLoader(): Loader {
  return {
    name: 'postgres-trips',
    load: async ({ store, parseData, renderMarkdown, logger }) => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL is required to build content from Postgres');
      const pool = new pg.Pool({ connectionString: url });
      try {
        store.clear();
        const { rows } = await pool.query<PostRow>(
          `SELECT translation_key, locale, slug, title, date, country, country_code, region, excerpt,
                  hero_image, coordinates, stops, route, key_facts, body_markdown, images
             FROM posts WHERE status = 'published'`,
        );
        for (const row of rows) {
          const input = rowToEntryInput(row);
          const data = await parseData({ id: input.id, data: input.data });
          const rendered = await renderMarkdown(input.body);
          rendered.html = transformBodyImages(rendered.html, input.images);
          store.set({ id: input.id, data, body: input.body, rendered });
        }
        logger.info(`postgres-trips: loaded ${rows.length} published entries`);
      } finally {
        await pool.end();
      }
    },
  };
}
```

- [ ] **Step 4: Swap the loader in `content.config.ts`**

Replace the `loader:` line (keep the `schema` exactly as-is):
```ts
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { postgresTripsLoader } from './lib/postgres-loader';

const trips = defineCollection({
  loader: postgresTripsLoader(),
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
        src: z.url(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        alt: z.string().min(1),
      }),
      coordinates: z.object({ lat: z.number(), lng: z.number() }),
      stops: z.array(z.object({ name: z.string(), lat: z.number(), lng: z.number() })).optional(),
      route: z.string().optional(),
      keyFacts: z.record(z.string(), z.string()).optional(),
    }),
});

export const collections = { trips };
```
(The `glob`/`astro/loaders` import is removed.)

- [ ] **Step 5: Run the unit test + typecheck**

Run: `npx vitest run test/postgres-loader.test.ts && npx astro check`
Expected: unit PASS; `astro check` clean. (A full `npm run build` is exercised in Task 6 against a DB.)

- [ ] **Step 6: Commit**

```bash
git add site/src/lib/postgres-loader.ts site/src/content.config.ts site/test/postgres-loader.test.ts
git commit -m "feat(site): build trips collection from Postgres via a Content Layer loader"
```

---

### Task 4: StoryPage renders the loader's HTML (drop the MDX BodyImage prop)

**Files:**
- Modify: `site/src/components/pages/StoryPage.astro`

**Interfaces:**
- Consumes: the `render(trip)` `Content` whose HTML already contains the `<picture>` markup (from Task 3).
- Produces: a body `<article>` rendering `<Content />` with no `components` prop.

- [ ] **Step 1: Make the edit**

In `site/src/components/pages/StoryPage.astro`: remove `import BodyImage from '../BodyImage.astro';` (line 3) and change the body render from `<Content components={{ BodyImage }} />` to:
```astro
      <Content />
```
Leave everything else (heading, `headings`/Toc, KeyFacts, RouteDivider, pagination) unchanged. `RemoteImage` is still imported/used for the hero — keep it. (`BodyImage.astro` becomes unused; leave the file in place — Phase B removes it.)

- [ ] **Step 2: Typecheck**

Run (from `site/`): `npx astro check`
Expected: clean (no unused-import error for BodyImage, since the import was removed).

- [ ] **Step 3: Commit**

```bash
git add site/src/components/pages/StoryPage.astro
git commit -m "refactor(site): render post body from loader HTML (images handled in loader)"
```

---

### Task 5: Runtime builder service (astro build from Postgres + atomic deploy)

**Files:**
- Create: `site/build-server.mjs`
- Modify: `site/Dockerfile` (becomes the builder image)
- Modify: `site/nginx.conf` (serve the `current` release dir)
- Test: `site/test/build-server.test.ts` (pure helpers only)

**Interfaces:**
- Consumes: `astro build` (writes to `dist/`); `DATABASE_URL`, `BUILD_SECRET`, `RELEASES_DIR` (default `/srv/blog`) env.
- Produces: a long-running HTTP server with `POST /build` (header `x-build-secret`) and `GET /health`; on success it atomically repoints `${RELEASES_DIR}/current` → a new release dir; an initial build on boot. Exported pure helper `isAuthorized(header, secret)`.

- [ ] **Step 1: Write the failing test for the auth helper**

`site/test/build-server.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isAuthorized } from '../build-server.mjs';

describe('build-server isAuthorized', () => {
  it('accepts the matching secret and rejects others/empty', () => {
    expect(isAuthorized('s3cret', 's3cret')).toBe(true);
    expect(isAuthorized('nope', 's3cret')).toBe(false);
    expect(isAuthorized(undefined, 's3cret')).toBe(false);
    expect(isAuthorized('s3cret', '')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/build-server.test.ts`
Expected: FAIL — `../build-server.mjs` not found.

- [ ] **Step 3: Write the build server**

`site/build-server.mjs`:
```js
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, rm, rename, symlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const RELEASES_DIR = process.env.RELEASES_DIR ?? '/srv/blog';
const PORT = Number(process.env.BUILD_PORT ?? 4000);
const SECRET = process.env.BUILD_SECRET ?? '';
const APP_DIR = process.cwd(); // the site project

export function isAuthorized(header, secret) {
  if (!secret || !header) return false;
  const a = Buffer.from(header), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

let building = false;

function runAstroBuild(outDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['astro', 'build', '--outDir', outDir], {
      cwd: APP_DIR, env: process.env, stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`astro build exited ${code}`))));
    child.on('error', reject);
  });
}

/** Build into a fresh release dir, then atomically flip the `current` symlink. */
export async function buildAndDeploy() {
  if (building) throw new Error('a build is already running');
  building = true;
  try {
    const releases = join(RELEASES_DIR, 'releases');
    await mkdir(releases, { recursive: true });
    const stamp = `${Date.now()}-${process.pid}`;
    const dest = join(releases, stamp);
    await runAstroBuild(dest);
    // atomic swap: write a temp symlink then rename over `current`
    const tmpLink = join(RELEASES_DIR, `.current.${stamp}`);
    await symlink(dest, tmpLink);
    await rename(tmpLink, join(RELEASES_DIR, 'current'));
    // prune old releases (keep last 3)
    const all = (await readdir(releases)).sort();
    for (const old of all.slice(0, -3)) await rm(join(releases, old), { recursive: true, force: true });
    return stamp;
  } finally {
    building = false;
  }
}

function serve() {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      let ok = false;
      try { ok = (await stat(join(RELEASES_DIR, 'current'))).isSymbolicLink?.() ?? true; } catch { ok = false; }
      res.writeHead(ok ? 200 : 503).end(ok ? 'ok' : 'no build yet');
      return;
    }
    if (req.method === 'POST' && req.url === '/build') {
      if (!isAuthorized(req.headers['x-build-secret'], SECRET)) { res.writeHead(401).end('unauthorized'); return; }
      try { const stamp = await buildAndDeploy(); res.writeHead(200).end(JSON.stringify({ ok: true, release: stamp })); }
      catch (e) { res.writeHead(500).end(JSON.stringify({ ok: false, error: String(e) })); }
      return;
    }
    res.writeHead(404).end('not found');
  });
  server.listen(PORT, () => console.log(`build-server on :${PORT}, releases at ${RELEASES_DIR}`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Initial build on boot so the site is populated, then serve.
  buildAndDeploy().then((s) => console.log(`initial build ${s}`)).catch((e) => console.error('initial build failed', e)).finally(serve);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/build-server.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Rewrite `site/Dockerfile` as the builder image**

`site/Dockerfile`:
```dockerfile
# Long-running builder: holds the Astro toolchain, builds from Postgres at runtime,
# and atomically publishes into the shared /srv/blog volume that nginx serves.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV RELEASES_DIR=/srv/blog
EXPOSE 4000
VOLUME ["/srv/blog"]
CMD ["node", "build-server.mjs"]
```

- [ ] **Step 6: Point nginx at the `current` release**

`site/nginx.conf` — set the root to the symlinked release dir (keep other directives). The server block's `root` becomes:
```nginx
  root /srv/blog/current;
```
and add (so symlinks are followed and a missing build degrades gracefully):
```nginx
  disable_symlinks off;
```
Keep the existing `try_files`/SPA/trailing-slash and caching directives as they are; only the `root` (and `disable_symlinks`) change.

- [ ] **Step 7: Commit**

```bash
git add site/build-server.mjs site/Dockerfile site/nginx.conf site/test/build-server.test.ts
git commit -m "feat(site): runtime builder service (build from Postgres + atomic release swap)"
```

---

### Task 6: Compose wiring + end-to-end build-from-Postgres verification

**Files:**
- Modify: `docker-compose.yml` (root)
- Modify: `uploader/docker-compose.yml`
- Create: `docs/superpowers/plans/phase-a-verification.md` (a short run log template is fine to omit; this task's deliverable is the verified stack)

**Interfaces:**
- Consumes: Tasks 1–5; the `db` service from the auth feature.
- Produces: `blog` (nginx serving the `blog-dist` volume) + `blog-builder` (builds from Postgres into that volume) wired to `db`.

- [ ] **Step 1: Update the root `docker-compose.yml`**

Replace the `blog` service and add `blog-builder` + a `blog-dist` volume. `blog` now serves the volume; `blog-builder` builds into it:
```yaml
  blog:
    image: nginx:alpine
    ports:
      - "${BLOG_PORT:-8090}:80"
    volumes:
      - ./site/nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - blog-dist:/srv/blog:ro
    depends_on:
      blog-builder:
        condition: service_healthy
    restart: unless-stopped

  blog-builder:
    build: ./site
    environment:
      DATABASE_URL: ${DATABASE_URL:-postgres://${POSTGRES_USER:-images}:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@db:5432/${POSTGRES_DB:-images}}
      BUILD_SECRET: ${BUILD_SECRET:?set BUILD_SECRET in .env}
    volumes:
      - blog-dist:/srv/blog
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "node -e \"require('node:fs').statSync('/srv/blog/current')\""]
      interval: 5s
      timeout: 5s
      retries: 30
    restart: unless-stopped
```
And under top-level `volumes:` add `blog-dist:` (alongside `pgdata`).

- [ ] **Step 2: Mirror in `uploader/docker-compose.yml`**

Apply the same `blog`/`blog-builder`/`blog-dist` additions there (this compose previously had only `images`+`db`; add the blog side so the standalone stack is complete, `build: ../site`). Add `BUILD_SECRET` and `blog-dist` volume.

- [ ] **Step 3: Add the new env vars to `.env.example` files**

Append to `uploader/.env.example` (and note in the root usage):
```bash
# Secret the uploader uses to trigger a site rebuild (Phase B); also gates the builder endpoint.
BUILD_SECRET=change-me-to-a-long-random-string
```

- [ ] **Step 4: Validate compose**

Run:
```bash
POSTGRES_PASSWORD=x BUILD_SECRET=y docker compose -f docker-compose.yml config >/dev/null && echo ROOT_OK
POSTGRES_PASSWORD=x BUILD_SECRET=y docker compose -f uploader/docker-compose.yml config >/dev/null && echo UP_OK
```
Expected: `ROOT_OK` and `UP_OK`.

- [ ] **Step 5: End-to-end build-from-Postgres + route parity (the key verification)**

Run (brings up db + builder, migrates the stub posts, builds, checks routes):
```bash
cd /Users/simon/Documents/localGIT/blog
# baseline: current routes from the existing static build (before this branch) are known:
#   DE at /<slug>/, EN at /en/<slug>/ for each of the 18 posts.
export POSTGRES_PASSWORD=devpw BUILD_SECRET=devsecret
docker compose up -d --build db
sleep 5
# migrate the stub posts into Postgres
DATABASE_URL="postgres://images:devpw@127.0.0.1:5432/images" npm --prefix site run-script migrate 2>/dev/null \
  || DATABASE_URL="postgres://images:devpw@127.0.0.1:5432/images" node site/scripts/migrate-stub-posts.mjs
docker compose up -d --build blog-builder blog
# wait for the builder healthcheck (initial build) then hit nginx
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q blog-builder)")" = healthy ]; do sleep 3; done
curl -sI http://localhost:8090/reisebericht-4-tage-bukarest/ | head -1      # expect 200
curl -sI http://localhost:8090/en/4-days-in-bucharest/ | head -1            # expect 200 (EN slug)
docker compose down
```
Expected: both routes return `200`, confirming the deployed site builds its content from Postgres. (Replace the EN slug with a real one from `site/src/content/trips/en/`.) Acceptance: every DE route under `/` and EN route under `/en/` that the current MDX build produces also resolves here.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml uploader/docker-compose.yml uploader/.env.example
git commit -m "feat(deploy): blog builds from Postgres at runtime (nginx volume + builder + atomic swap)"
```

---

### Task 7: Docs — record the Phase A pipeline change

**Files:**
- Modify: `CLAUDE.md` (content pipeline + deploy notes)
- Modify: `docs/authoring-workflow.md` (Stage 3 note that the build now runs from Postgres at runtime)

**Interfaces:**
- Consumes: nothing.
- Produces: accurate docs for the new build model (editor authoring still comes in Phase B).

- [ ] **Step 1: Update `CLAUDE.md`**

In "Project Overview"/"Repository Structure"/"Build & Development", note that the blog's `trips` content is now loaded from **Postgres** at build time via `site/src/lib/postgres-loader.ts` (schema unchanged), body images render via `site/src/lib/body-images.ts`, and the blog is built at **runtime** by the `blog-builder` service into the `blog-dist` volume nginx serves (no image-time build). Note `DATABASE_URL`/`BUILD_SECRET` are required for the blog stack.

- [ ] **Step 2: Update `docs/authoring-workflow.md`**

Update Stage 3: the blog no longer rebuilds via `docker compose up --build blog`; content lives in Postgres and the site is rebuilt by triggering `blog-builder` (the in-admin Publish button arrives in Phase B). Keep the photo-upload (Stage 1) text. Add a one-line note that authoring MDX-in-GitHub (Stage 2) is superseded by the upcoming editor.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/authoring-workflow.md
git commit -m "docs: blog content now builds from Postgres at runtime (Phase A)"
```

---

## Self-Review

**Spec coverage (Phase A scope):** posts schema → T1; migrate the 18 stubs → T1; Postgres Content Layer loader, `id = locale/slug`, unchanged schema → T3; Markdown body + responsive-image transform via `images` map → T2+T3; StoryPage renders loader HTML → T4; runtime build (no image-time build) + atomic swap + secret-gated trigger → T5; compose/volume/db wiring → T6; route-for-route verification → T6; docs → T7. Editor/publish-button/export are **Phase B** (out of scope here) — noted in T7. `trips.ts`/`paths.ts` unchanged (loader emits the same `id`/schema) — verified by their existing suites staying green (run `npm test` in T3/T6).

**Placeholder scan:** No TBD/TODO; every code step has complete code. The EN slug in T6 Step 5 is explicitly flagged to substitute a real value from `site/src/content/trips/en/`.

**Type consistency:** `transformBodyImages(html, images)` (T2) is consumed with that exact signature in T3. `rowToEntryInput` returns `{id, body, images, data}`; T3's loader uses `input.id/.data/.body/.images` accordingly. `isAuthorized(header, secret)` (T5) matches its test. `BUILD_SECRET`/`DATABASE_URL`/`RELEASES_DIR` env names are consistent across T5 (server), T6 (compose). The loader uses the verified Astro 6 Content Layer API (`store`, `parseData`, `renderMarkdown`, `store.set({id,data,body,rendered})`).

**Highest-risk tasks to verify first during execution:** T5 (atomic-swap build server) and T6 Step 5 (end-to-end build-from-Postgres) — these exercise the genuinely new runtime-build behavior; everything else is pure/unit-tested.
