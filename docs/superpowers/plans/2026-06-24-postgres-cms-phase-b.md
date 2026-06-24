# Postgres CMS — Phase B (In-Admin Editor + Publish + Export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author bilingual (DE+EN) posts entirely from the uploader admin — create/edit, Publish (mark published + trigger the Phase A `blog-builder`), and Export to MDX as the backup.

**Architecture:** All in the uploader (Fastify, reuses auth + Postgres + `/upload`). A `postStore` reads/writes the Phase A `posts` table as DE/EN pairs; post routes (`requireAuth`) back a list page + a DE/EN tabbed editor (EasyMDE + integrated `/upload`); Publish sets both rows `published` and POSTs the builder's secret-gated `/build`, then auto-exports MDX to `/data/backup`.

**Tech Stack:** Node 22, Fastify 5, `pg`, EasyMDE (vendored), Postgres 17, Vitest.

## Global Constraints

- Node `>=22.12.0`; uploader is ESM (`"type":"module"`), import local files with `.js`. Strict TS — no `any`, no `@ts-ignore`. Named exports.
- Post routes use `requireAuth` (admin **and** author). User-management stays `requireAdmin`.
- **SEO slug contract:** a post's `slug` is the live URL and is **immutable once that locale row is `published`** (server-enforced). Slugs match `^[a-z0-9][a-z0-9-]*$`.
- A logical post = the `(translation_key)` pair of a `de` row and an `en` row; both locales required to publish. `translation_key` is auto-generated on create (not user-entered).
- The `posts` table shape is the Phase A one (unchanged): columns `id, translation_key, locale, slug, title, date, country, country_code, region, excerpt, hero_image jsonb, coordinates jsonb, stops jsonb, route, key_facts jsonb, body_markdown, images jsonb, status, created_at, updated_at`.
- The Astro `trips` zod schema is the source of the post shape; the publish validator mirrors it.
- EasyMDE is **vendored** into `public/` (no runtime CDN), mirroring the existing self-hosted webfonts.
- Tests run with no live services (in-memory `postStore`); the Postgres impl has a `TEST_DATABASE_URL`-guarded integration test (Phase A pattern).
- Prerequisite: **Phase A must be present** (the `posts` table, the `blog-builder` `/build` endpoint). Execute on a branch that already contains Phase A (off `feature/postgres-cms`, or off `main` after PR #4 merges).
- Gates before each commit (from `uploader/`): `npm run typecheck` + `npm test`.
- Commit style: `type(scope): desc`.

---

### Task 1: Post types + in-memory store

**Files:**
- Create: `uploader/src/posts.ts`
- Test: `uploader/test/posts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task):
  - `type Locale = 'de' | 'en'`
  - `interface HeroImage { src: string; width: number; height: number; alt: string }`
  - `interface ImageDims { width: number; height: number }`
  - `interface PostLocale { locale: Locale; slug: string; title: string; excerpt: string; heroImage: HeroImage; bodyMarkdown: string; images: Record<string, ImageDims> }`
  - `interface PostShared { date: string; country: string; countryCode: string; region: string; coordinates: { lat: number; lng: number }; stops?: { name: string; lat: number; lng: number }[]; route?: string; keyFacts?: Record<string, string> }`
  - `interface PostPair { translationKey: string; status: 'draft' | 'published'; shared: PostShared; de: PostLocale; en: PostLocale }`
  - `interface PostSummary { translationKey: string; titleDe: string; slugDe: string; slugEn: string; status: 'draft' | 'published'; updatedAt: Date }`
  - `class PostError extends Error`
  - `interface PostStore { list(): Promise<PostSummary[]>; get(tk: string): Promise<PostPair | null>; upsertDraft(pair: PostPair): Promise<PostPair>; publish(tk: string): Promise<void> }`
  - `function memoryPostStore(): PostStore`

- [ ] **Step 1: Write the failing test**

`uploader/test/posts.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { memoryPostStore, PostError, type PostPair } from '../src/posts.js';

function pair(overrides: Partial<PostPair> = {}): PostPair {
  const loc = (locale: 'de' | 'en', slug: string, title: string) => ({
    locale, slug, title, excerpt: 'x',
    heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'a' },
    bodyMarkdown: '## Hi', images: {},
  });
  return {
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', country: 'Rumänien', countryCode: 'RO', region: 'europe', coordinates: { lat: 44.4, lng: 26.1 } },
    de: loc('de', 'bukarest', 'Bukarest'), en: loc('en', 'bucharest', 'Bucharest'),
    ...overrides,
  };
}

describe('memoryPostStore', () => {
  it('creates a pair with a generated translationKey and lists it', async () => {
    const s = memoryPostStore();
    const created = await s.upsertDraft(pair());
    expect(created.translationKey).toMatch(/.+/);
    const list = await s.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ titleDe: 'Bukarest', slugDe: 'bukarest', slugEn: 'bucharest', status: 'draft' });
  });

  it('get returns the full pair; update preserves the key', async () => {
    const s = memoryPostStore();
    const created = await s.upsertDraft(pair());
    const updated = await s.upsertDraft({ ...created, de: { ...created.de, title: 'Bukarest 2' } });
    expect(updated.translationKey).toBe(created.translationKey);
    expect((await s.get(created.translationKey))?.de.title).toBe('Bukarest 2');
  });

  it('publish flips both rows to published', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.publish(c.translationKey);
    expect((await s.get(c.translationKey))?.status).toBe('published');
  });

  it('rejects changing a slug once published', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.publish(c.translationKey);
    await expect(s.upsertDraft({ ...c, status: 'published', de: { ...c.de, slug: 'renamed' } }))
      .rejects.toBeInstanceOf(PostError);
  });

  it('rejects a duplicate (locale, slug) across posts', async () => {
    const s = memoryPostStore();
    await s.upsertDraft(pair());
    await expect(s.upsertDraft(pair({ de: { ...pair().de, slug: 'bukarest' }, en: { ...pair().en, slug: 'other' } })))
      .rejects.toBeInstanceOf(PostError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/posts.test.ts`
Expected: FAIL — `../src/posts.js` not found.

- [ ] **Step 3: Write the implementation**

`uploader/src/posts.ts`:
```ts
import { randomUUID } from 'node:crypto';

export type Locale = 'de' | 'en';
export interface HeroImage { src: string; width: number; height: number; alt: string }
export interface ImageDims { width: number; height: number }
export interface PostLocale {
  locale: Locale; slug: string; title: string; excerpt: string;
  heroImage: HeroImage; bodyMarkdown: string; images: Record<string, ImageDims>;
}
export interface PostShared {
  date: string; country: string; countryCode: string; region: string;
  coordinates: { lat: number; lng: number };
  stops?: { name: string; lat: number; lng: number }[]; route?: string;
  keyFacts?: Record<string, string>;
}
export interface PostPair {
  translationKey: string; status: 'draft' | 'published';
  shared: PostShared; de: PostLocale; en: PostLocale;
}
export interface PostSummary {
  translationKey: string; titleDe: string; slugDe: string; slugEn: string;
  status: 'draft' | 'published'; updatedAt: Date;
}
export class PostError extends Error {}

export interface PostStore {
  list(): Promise<PostSummary[]>;
  get(translationKey: string): Promise<PostPair | null>;
  upsertDraft(pair: PostPair): Promise<PostPair>;
  publish(translationKey: string): Promise<void>;
}

interface Stored extends PostPair { updatedAt: Date }

export function memoryPostStore(): PostStore {
  const byKey = new Map<string, Stored>();
  const slugTaken = (locale: Locale, slug: string, exceptKey: string) =>
    [...byKey.values()].some((p) => p.translationKey !== exceptKey && p[locale].slug === slug);

  return {
    async list() {
      return [...byKey.values()]
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map((p) => ({ translationKey: p.translationKey, titleDe: p.de.title, slugDe: p.de.slug, slugEn: p.en.slug, status: p.status, updatedAt: p.updatedAt }));
    },
    async get(tk) {
      const p = byKey.get(tk);
      return p ? structuredClone({ translationKey: p.translationKey, status: p.status, shared: p.shared, de: p.de, en: p.en }) : null;
    },
    async upsertDraft(pair) {
      const key = pair.translationKey || randomUUID();
      const existing = byKey.get(key);
      for (const locale of ['de', 'en'] as Locale[]) {
        if (slugTaken(locale, pair[locale].slug, key)) throw new PostError(`slug "${pair[locale].slug}" already in use for ${locale}`);
        if (existing && existing.status === 'published' && existing[locale].slug !== pair[locale].slug) {
          throw new PostError('cannot change the slug of a published post');
        }
      }
      const stored: Stored = { ...structuredClone(pair), translationKey: key, status: existing?.status ?? 'draft', updatedAt: new Date() };
      byKey.set(key, stored);
      return { translationKey: key, status: stored.status, shared: stored.shared, de: stored.de, en: stored.en };
    },
    async publish(tk) {
      const p = byKey.get(tk);
      if (!p) throw new PostError('post not found');
      p.status = 'published';
      p.updatedAt = new Date();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/posts.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add uploader/src/posts.ts uploader/test/posts.test.ts
git commit -m "feat(uploader): post types + in-memory post store (DE/EN pairs)"
```

---

### Task 2: Post validation (draft-light, publish-full)

**Files:**
- Modify: `uploader/src/posts.ts`
- Test: `uploader/test/posts.test.ts`

**Interfaces:**
- Consumes: the Task 1 types.
- Produces: `function validateDraft(pair: PostPair): void` (throws `PostError`) and `function validateForPublish(pair: PostPair): void` (throws `PostError`).

- [ ] **Step 1: Write the failing test (append)**

```ts
import { validateDraft, validateForPublish } from '../src/posts.js';

describe('post validation', () => {
  it('draft requires only a DE title and valid slugs', () => {
    expect(() => validateDraft(pair({ de: { ...pair().de, title: '' } }))).toThrow(PostError);
    expect(() => validateDraft(pair({ de: { ...pair().de, slug: 'Bad Slug' } }))).toThrow(PostError);
    expect(() => validateDraft(pair())).not.toThrow();
  });
  it('publish requires both locales complete and schema-valid', () => {
    expect(() => validateForPublish(pair())).not.toThrow();
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, countryCode: 'ROU' } }))).toThrow(PostError);
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, region: 'mars' as never } }))).toThrow(PostError);
    expect(() => validateForPublish(pair({ en: { ...pair().en, excerpt: '' } }))).toThrow(PostError);
    expect(() => validateForPublish(pair({ de: { ...pair().de, heroImage: { ...pair().de.heroImage, alt: '' } } }))).toThrow(PostError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/posts.test.ts`
Expected: FAIL — `validateDraft`/`validateForPublish` not exported.

- [ ] **Step 3: Implement (append to `posts.ts`)**

```ts
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const REGIONS = ['europe', 'north-america', 'south-america'];

function checkSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new PostError(`invalid slug "${slug}" (lowercase a-z, 0-9, hyphen)`);
}

export function validateDraft(pair: PostPair): void {
  if (!pair.de.title.trim()) throw new PostError('a German title is required to start a draft');
  for (const locale of ['de', 'en'] as Locale[]) {
    if (pair[locale].slug) checkSlug(pair[locale].slug);
  }
}

function validateLocale(p: PostLocale): void {
  checkSlug(p.slug);
  if (!p.title.trim()) throw new PostError(`${p.locale}: title required`);
  if (!p.excerpt.trim()) throw new PostError(`${p.locale}: excerpt required`);
  if (!p.bodyMarkdown.trim()) throw new PostError(`${p.locale}: body required`);
  const h = p.heroImage;
  try { new URL(h.src); } catch { throw new PostError(`${p.locale}: heroImage.src must be a URL`); }
  if (!Number.isInteger(h.width) || h.width <= 0 || !Number.isInteger(h.height) || h.height <= 0) {
    throw new PostError(`${p.locale}: heroImage needs positive integer width/height`);
  }
  if (!h.alt.trim()) throw new PostError(`${p.locale}: heroImage.alt required`);
}

export function validateForPublish(pair: PostPair): void {
  const s = pair.shared;
  if (s.countryCode.length !== 2) throw new PostError('countryCode must be 2 letters');
  if (!REGIONS.includes(s.region)) throw new PostError(`region must be one of ${REGIONS.join(', ')}`);
  if (typeof s.coordinates?.lat !== 'number' || typeof s.coordinates?.lng !== 'number') {
    throw new PostError('coordinates must be numbers');
  }
  if (!s.country.trim()) throw new PostError('country required');
  if (!s.date.trim()) throw new PostError('date required');
  validateLocale(pair.de);
  validateLocale(pair.en);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/posts.test.ts`
Expected: PASS (all posts tests).

- [ ] **Step 5: Commit**

```bash
git add uploader/src/posts.ts uploader/test/posts.test.ts
git commit -m "feat(uploader): draft + publish post validation"
```

---

### Task 3: Postgres post store + schema

**Files:**
- Modify: `uploader/src/posts.ts` (add `pgPostStore`)
- Modify: `uploader/src/db.ts` (add `posts` to `ensureSchema`)
- Test: `uploader/test/pg.integration.test.ts` (extend the guarded suite)

**Interfaces:**
- Consumes: `DbPool` from `db.js`; Task 1 types.
- Produces: `function pgPostStore(pool: DbPool): PostStore`.

- [ ] **Step 1: Add `posts` to `ensureSchema`**

In `uploader/src/db.ts`, inside `ensureSchema`, add (after the sessions table):
```ts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id uuid PRIMARY KEY, translation_key text NOT NULL, locale text NOT NULL CHECK (locale IN ('de','en')),
      slug text NOT NULL, title text NOT NULL, date date NOT NULL, country text NOT NULL,
      country_code text NOT NULL CHECK (char_length(country_code)=2),
      region text NOT NULL CHECK (region IN ('europe','north-america','south-america')),
      excerpt text NOT NULL, hero_image jsonb NOT NULL, coordinates jsonb NOT NULL,
      stops jsonb, route text, key_facts jsonb, body_markdown text NOT NULL,
      images jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS posts_locale_slug_idx ON posts (locale, slug)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS posts_translation_key_idx ON posts (translation_key)`);
```

- [ ] **Step 2: Write the guarded integration test (append to `pg.integration.test.ts`)**

```ts
import { pgPostStore } from '../src/posts.js';

maybe('pgPostStore (integration)', () => {
  it('round-trips a pair, publishes, and enforces slug immutability', async () => {
    const pool = createPool(url!);
    await ensureSchema(pool);
    await pool.query('DELETE FROM posts');
    const store = pgPostStore(pool);
    const base = {
      translationKey: '', status: 'draft' as const,
      shared: { date: '2024-10-03', country: 'X', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
      de: { locale: 'de' as const, slug: 'de-slug', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## b', images: {} },
      en: { locale: 'en' as const, slug: 'en-slug', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    };
    const created = await store.upsertDraft(base);
    expect((await store.get(created.translationKey))?.de.slug).toBe('de-slug');
    await store.publish(created.translationKey);
    expect((await store.get(created.translationKey))?.status).toBe('published');
    await expect(store.upsertDraft({ ...created, status: 'published', de: { ...base.de, slug: 'renamed' } })).rejects.toThrow();
    await pool.end();
  });
});
```
(`maybe`, `createPool`, `ensureSchema`, `url` already exist in the Phase A integration file.)

- [ ] **Step 3: Implement `pgPostStore` (append to `posts.ts`)**

```ts
import type { DbPool } from './db.js';

interface PostRow {
  translation_key: string; locale: Locale; slug: string; title: string; date: Date | string;
  country: string; country_code: string; region: string; excerpt: string;
  hero_image: HeroImage; coordinates: { lat: number; lng: number };
  stops: PostShared['stops'] | null; route: string | null; key_facts: Record<string, string> | null;
  body_markdown: string; images: Record<string, ImageDims>; status: 'draft' | 'published'; updated_at: Date;
}

function rowLocale(r: PostRow): PostLocale {
  return { locale: r.locale, slug: r.slug, title: r.title, excerpt: r.excerpt, heroImage: r.hero_image, bodyMarkdown: r.body_markdown, images: r.images ?? {} };
}
function rowShared(r: PostRow): PostShared {
  const d = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
  return { date: d, country: r.country, countryCode: r.country_code, region: r.region, coordinates: r.coordinates, ...(r.stops ? { stops: r.stops } : {}), ...(r.route ? { route: r.route } : {}), ...(r.key_facts ? { keyFacts: r.key_facts } : {}) };
}

export function pgPostStore(pool: DbPool): PostStore {
  async function writeLocale(tk: string, status: string, shared: PostShared, p: PostLocale) {
    await pool.query(
      `INSERT INTO posts (id, translation_key, locale, slug, title, date, country, country_code, region,
         excerpt, hero_image, coordinates, stops, route, key_facts, body_markdown, images, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
       ON CONFLICT (locale, slug) DO UPDATE SET
         translation_key=EXCLUDED.translation_key, title=EXCLUDED.title, date=EXCLUDED.date, country=EXCLUDED.country,
         country_code=EXCLUDED.country_code, region=EXCLUDED.region, excerpt=EXCLUDED.excerpt, hero_image=EXCLUDED.hero_image,
         coordinates=EXCLUDED.coordinates, stops=EXCLUDED.stops, route=EXCLUDED.route, key_facts=EXCLUDED.key_facts,
         body_markdown=EXCLUDED.body_markdown, images=EXCLUDED.images, updated_at=now()`,
      [randomUUID(), tk, p.locale, p.slug, p.title, shared.date, shared.country, shared.countryCode, shared.region,
       p.excerpt, JSON.stringify(p.heroImage), JSON.stringify(shared.coordinates),
       shared.stops ? JSON.stringify(shared.stops) : null, shared.route ?? null, shared.keyFacts ? JSON.stringify(shared.keyFacts) : null,
       p.bodyMarkdown, JSON.stringify(p.images), status],
    );
  }
  return {
    async list() {
      const { rows } = await pool.query<PostRow>(`SELECT * FROM posts ORDER BY updated_at DESC`);
      const byKey = new Map<string, { de?: PostRow; en?: PostRow }>();
      for (const r of rows) { const e = byKey.get(r.translation_key) ?? {}; e[r.locale] = r; byKey.set(r.translation_key, e); }
      return [...byKey.entries()].map(([tk, e]) => ({
        translationKey: tk, titleDe: e.de?.title ?? '', slugDe: e.de?.slug ?? '', slugEn: e.en?.slug ?? '',
        status: (e.de?.status ?? e.en?.status ?? 'draft') as 'draft' | 'published',
        updatedAt: new Date(Math.max(e.de?.updated_at?.getTime() ?? 0, e.en?.updated_at?.getTime() ?? 0)),
      }));
    },
    async get(tk) {
      const { rows } = await pool.query<PostRow>(`SELECT * FROM posts WHERE translation_key = $1`, [tk]);
      const de = rows.find((r) => r.locale === 'de'); const en = rows.find((r) => r.locale === 'en');
      if (!de || !en) return null;
      return { translationKey: tk, status: de.status, shared: rowShared(de), de: rowLocale(de), en: rowLocale(en) };
    },
    async upsertDraft(pair) {
      const tk = pair.translationKey || randomUUID();
      const existing = await this.get(tk);
      for (const locale of ['de', 'en'] as Locale[]) {
        const { rows } = await pool.query<{ translation_key: string }>(`SELECT translation_key FROM posts WHERE locale=$1 AND slug=$2`, [locale, pair[locale].slug]);
        if (rows[0] && rows[0].translation_key !== tk) throw new PostError(`slug "${pair[locale].slug}" already in use for ${locale}`);
        if (existing && existing.status === 'published' && existing[locale].slug !== pair[locale].slug) throw new PostError('cannot change the slug of a published post');
      }
      const status = existing?.status ?? 'draft';
      await writeLocale(tk, status, pair.shared, { ...pair.de, locale: 'de' });
      await writeLocale(tk, status, pair.shared, { ...pair.en, locale: 'en' });
      const saved = await this.get(tk);
      if (!saved) throw new PostError('failed to save post');
      return saved;
    },
    async publish(tk) {
      const res = await pool.query(`UPDATE posts SET status='published', updated_at=now() WHERE translation_key=$1`, [tk]);
      if (res.rowCount === 0) throw new PostError('post not found');
    },
  };
}
```

- [ ] **Step 4: Verify (typecheck + suite; integration auto-skips without a DB)**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `pg.integration.test.ts` shows skipped; all else passes.

- [ ] **Step 5 (recommended): run the integration test against a throwaway DB**

```bash
docker run --rm -d --name pgb -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=images -e POSTGRES_USER=images -p 55434:5432 postgres:17-alpine
sleep 4
TEST_DATABASE_URL=postgres://images:pw@127.0.0.1:55434/images npx vitest run test/pg.integration.test.ts
docker rm -f pgb
```
Expected: the pgPostStore integration test passes.

- [ ] **Step 6: Commit**

```bash
git add uploader/src/posts.ts uploader/src/db.ts uploader/test/pg.integration.test.ts
git commit -m "feat(uploader): Postgres-backed post store + posts schema in ensureSchema"
```

---

### Task 4: MDX export

**Files:**
- Create: `uploader/src/export.ts`
- Test: `uploader/test/export.test.ts`

**Interfaces:**
- Consumes: `PostPair`, `PostLocale` (Task 1).
- Produces: `function renderPostToMdx(pair: PostPair, locale: Locale): string`; `async function exportPost(pair: PostPair, baseDir: string): Promise<string[]>` (writes both locale files, returns paths); `async function exportAll(pairs: PostPair[], baseDir: string): Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

`uploader/test/export.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { renderPostToMdx } from '../src/export.js';
import type { PostPair } from '../src/posts.js';

const pair: PostPair = {
  translationKey: 'k1', status: 'published',
  shared: { date: '2024-10-03', country: 'Rumänien', countryCode: 'RO', region: 'europe', coordinates: { lat: 44.4, lng: 26.1 }, keyFacts: { Einwohner: '19M' } },
  de: { locale: 'de', slug: 'bukarest', title: 'Bukarest', excerpt: 'E', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro\n\n![Gasse](https://img/x/y)\n', images: { 'https://img/x/y': { width: 1600, height: 1067 } } },
  en: { locale: 'en', slug: 'bucharest', title: 'Bucharest', excerpt: 'E', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {} },
};

describe('renderPostToMdx', () => {
  it('renders frontmatter + body and reconstructs <BodyImage> from the images map', () => {
    const mdx = renderPostToMdx(pair, 'de');
    expect(mdx).toContain("title: 'Bukarest'");
    expect(mdx).toContain('translationKey: \'k1\'');
    expect(mdx).toContain('countryCode: \'RO\'');
    expect(mdx).toContain('src: \'https://img/h\'');
    expect(mdx).toContain('coordinates: { lat: 44.4, lng: 26.1 }');
    expect(mdx).toContain('<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Gasse" />');
    expect(mdx).not.toContain('![Gasse]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/export.test.ts`
Expected: FAIL — `../src/export.js` not found.

- [ ] **Step 3: Implement**

`uploader/src/export.ts`:
```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locale, PostLocale, PostPair } from './posts.js';

const q = (s: string) => `'${s.replace(/'/g, "\\'")}'`;

/** Turn markdown body images back into <BodyImage> tags using the images map. */
function bodyToMdx(p: PostLocale): string {
  return p.bodyMarkdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => {
    const dims = p.images[src];
    if (!dims) return `![${alt}](${src})`;
    return `<BodyImage src="${src}" width={${dims.width}} height={${dims.height}} alt="${alt}" />`;
  });
}

export function renderPostToMdx(pair: PostPair, locale: Locale): string {
  const p = locale === 'de' ? pair.de : pair.en;
  const s = pair.shared;
  const lines = [
    '---',
    `title: ${q(p.title)}`,
    `date: ${s.date}`,
    `country: ${q(s.country)}`,
    `countryCode: ${q(s.countryCode)}`,
    `region: ${q(s.region)}`,
    `translationKey: ${q(pair.translationKey)}`,
    `excerpt: ${q(p.excerpt)}`,
    'heroImage:',
    `  src: ${q(p.heroImage.src)}`,
    `  width: ${p.heroImage.width}`,
    `  height: ${p.heroImage.height}`,
    `  alt: ${q(p.heroImage.alt)}`,
    `coordinates: { lat: ${s.coordinates.lat}, lng: ${s.coordinates.lng} }`,
  ];
  if (s.route) lines.push(`route: ${q(s.route)}`);
  if (s.stops?.length) lines.push(`stops: ${JSON.stringify(s.stops)}`);
  if (s.keyFacts && Object.keys(s.keyFacts).length) {
    lines.push('keyFacts:');
    for (const [k, v] of Object.entries(s.keyFacts)) lines.push(`  ${q(k)}: ${q(v)}`);
  }
  lines.push('---', '', bodyToMdx(p).trim(), '');
  return lines.join('\n');
}

export async function exportPost(pair: PostPair, baseDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const locale of ['de', 'en'] as Locale[]) {
    const dir = join(baseDir, 'trips', locale);
    await mkdir(dir, { recursive: true });
    const slug = locale === 'de' ? pair.de.slug : pair.en.slug;
    const path = join(dir, `${slug}.mdx`);
    await writeFile(path, renderPostToMdx(pair, locale), 'utf8');
    out.push(path);
  }
  return out;
}

export async function exportAll(pairs: PostPair[], baseDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of pairs) out.push(...(await exportPost(p, baseDir)));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/export.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add uploader/src/export.ts uploader/test/export.test.ts
git commit -m "feat(uploader): MDX export (post → trips/{de,en}/<slug>.mdx)"
```

---

### Task 5: Publish→build client

**Files:**
- Create: `uploader/src/publish.ts`
- Test: `uploader/test/publish.test.ts`

**Interfaces:**
- Consumes: nothing (takes a `fetch` impl for testing).
- Produces: `interface BuildResult { ok: boolean; release?: string; error?: string }`; `async function triggerBuild(builderUrl: string, secret: string, fetchImpl?: typeof fetch): Promise<BuildResult>`.

- [ ] **Step 1: Write the failing test**

`uploader/test/publish.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { triggerBuild } from '../src/publish.js';

const fakeFetch = (status: number, body: unknown, capture?: (h: HeadersInit | undefined) => void) =>
  (async (_url: string, init?: RequestInit) => { capture?.(init?.headers); return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }; }) as unknown as typeof fetch;

describe('triggerBuild', () => {
  it('sends the x-build-secret header and returns the release on success', async () => {
    let headers: Record<string, string> = {};
    const r = await triggerBuild('http://b:4000', 's3cret', fakeFetch(200, { ok: true, release: 'r1' }, (h) => { headers = h as Record<string, string>; }));
    expect(r).toEqual({ ok: true, release: 'r1' });
    expect(headers['x-build-secret']).toBe('s3cret');
  });
  it('returns ok:false with the error on a non-2xx', async () => {
    const r = await triggerBuild('http://b:4000', 's', fakeFetch(500, { ok: false, error: 'boom' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('boom');
  });
  it('returns ok:false when fetch throws', async () => {
    const throwing = (async () => { throw new Error('econn'); }) as unknown as typeof fetch;
    const r = await triggerBuild('http://b:4000', 's', throwing);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('econn');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/publish.test.ts`
Expected: FAIL — `../src/publish.js` not found.

- [ ] **Step 3: Implement**

`uploader/src/publish.ts`:
```ts
export interface BuildResult { ok: boolean; release?: string; error?: string }

export async function triggerBuild(builderUrl: string, secret: string, fetchImpl: typeof fetch = fetch): Promise<BuildResult> {
  try {
    const res = await fetchImpl(`${builderUrl.replace(/\/+$/, '')}/build`, {
      method: 'POST',
      headers: { 'x-build-secret': secret, 'content-type': 'application/json' },
    });
    const body = (await res.json().catch(() => ({}))) as { release?: string; error?: string };
    if (!res.ok) return { ok: false, error: body.error || `builder returned HTTP ${res.status}` };
    return { ok: true, release: body.release };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/publish.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add uploader/src/publish.ts uploader/test/publish.test.ts
git commit -m "feat(uploader): build-trigger client for the blog-builder"
```

---

### Task 6: Server routes + config wiring

**Files:**
- Modify: `uploader/src/server.ts`
- Modify: `uploader/src/main.ts`
- Test: `uploader/test/server.test.ts`

**Interfaces:**
- Consumes: `PostStore`, `validateDraft`, `validateForPublish`, `PostError` (Tasks 1–2); `exportPost`, `exportAll` (Task 4); `triggerBuild` (Task 5); `requireAuth` (existing).
- Produces: `ServerConfig` gains `posts: PostStore`, `builderUrl: string`, `buildSecret: string`, `backupDir: string`, and optional `fetchImpl`/`triggerImpl` for tests. Routes: `GET /posts`, `GET /posts/:tk`, `POST /posts`, `PUT /posts/:tk`, `POST /posts/:tk/publish`, `POST /export`.

- [ ] **Step 1: Add the routes to `server.ts`**

Add imports:
```ts
import { validateDraft, validateForPublish, PostError, type PostStore, type PostPair } from './posts.js';
import { exportPost, exportAll } from './export.js';
import { triggerBuild, type BuildResult } from './publish.js';
```
Extend `ServerConfig`:
```ts
  posts: PostStore;
  builderUrl: string;
  buildSecret: string;
  backupDir: string;
  triggerImpl?: (builderUrl: string, secret: string) => Promise<BuildResult>;
```
Inside `buildServer`, after the existing routes, add (`const { posts } = cfg;` and `const doBuild = cfg.triggerImpl ?? ((u, s) => triggerBuild(u, s));`):
```ts
app.get('/posts', { preHandler: requireAuth }, async () => posts.list());

app.get('/posts/:tk', { preHandler: requireAuth }, async (req, reply) => {
  const pair = await posts.get((req.params as { tk: string }).tk);
  if (!pair) return reply.code(404).send({ error: 'post not found' });
  return reply.send(pair);
});

const upsert = async (req: { body: unknown }, reply: import('fastify').FastifyReply, tk: string) => {
  const pair = { ...(req.body as PostPair), translationKey: tk };
  try {
    validateDraft(pair);
    return reply.send(await posts.upsertDraft(pair));
  } catch (e) {
    if (e instanceof PostError) return reply.code(/already in use|published/.test(e.message) ? 409 : 400).send({ error: e.message });
    throw e;
  }
};
app.post('/posts', { preHandler: requireAuth }, (req, reply) => upsert(req, reply, ''));
app.put('/posts/:tk', { preHandler: requireAuth }, (req, reply) => upsert(req, reply, (req.params as { tk: string }).tk));

app.post('/posts/:tk/publish', { preHandler: requireAuth }, async (req, reply) => {
  const tk = (req.params as { tk: string }).tk;
  const pair = await posts.get(tk);
  if (!pair) return reply.code(404).send({ error: 'post not found' });
  try { validateForPublish(pair); } catch (e) {
    if (e instanceof PostError) return reply.code(400).send({ error: e.message });
    throw e;
  }
  await posts.publish(tk);
  const published = await posts.get(tk);
  const build = await doBuild(cfg.builderUrl, cfg.buildSecret);
  if (published) await exportPost(published, cfg.backupDir).catch(() => { /* best-effort backup */ });
  return reply.send({ published: true, build });
});

app.post('/export', { preHandler: requireAuth }, async (reply) => {
  const list = await posts.list();
  const pairs = (await Promise.all(list.map((s) => posts.get(s.translationKey)))).filter((p): p is PostPair => p !== null);
  const files = await exportAll(pairs, cfg.backupDir);
  return { ok: true, count: files.length };
});
```
(Note: the `/export` handler signature is `async (req, reply)` — keep the `req` param even if unused, per Fastify; adjust to `async (_req, reply) => reply.send(...)` to satisfy lint. Return via `reply.send`.)

- [ ] **Step 2: Wire `main.ts`**

In `uploader/src/main.ts`, add `pgPostStore` import and pass the new config:
```ts
import { pgPostStore } from './posts.js';
// ...after `const sessions = pgSessionStore(pool);`
const posts = pgPostStore(pool);
// ...in buildServer({...}) add:
  posts,
  builderUrl: process.env.BUILDER_URL ?? 'http://blog-builder:4000',
  buildSecret: process.env.BUILD_SECRET ?? '',
  backupDir: process.env.BACKUP_DIR ?? '/data/backup',
```

- [ ] **Step 3: Update `server.test.ts` build helper + add route tests**

In `uploader/test/server.test.ts`, import the memory store and extend `build()` to supply the new config:
```ts
import { memoryPostStore } from '../src/posts.js';
// in build():
const built = buildServer({
  storageDir: dir, baseUrl: 'https://img.simonswanderlust.com',
  users, sessions, settings: fakeStore(),
  posts: extra.posts ?? memoryPostStore(),
  builderUrl: 'http://builder:4000', buildSecret: 'bs',
  backupDir: dir + '/backup',
  triggerImpl: extra.triggerImpl ?? (async () => ({ ok: true, release: 'r1' })),
  ...extra,
});
```
Append tests:
```ts
describe('posts editor', () => {
  const sample = () => ({
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', country: 'X', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: 'de-s', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
    en: { locale: 'en', slug: 'en-s', title: 'T', excerpt: 'e', heroImage: { src: 'https://i/h', width: 9, height: 9, alt: 'a' }, bodyMarkdown: '## b', images: {} },
  });

  it('GET /posts 401 without auth', async () => {
    expect((await build().app.inject({ method: 'GET', url: '/posts' })).statusCode).toBe(401);
  });

  it('create → list → publish (triggers the builder)', async () => {
    const b = build(); const { cookie } = await authed(b);
    const created = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: sample() });
    expect(created.statusCode).toBe(200);
    const tk = created.json().translationKey;
    const list = await b.app.inject({ method: 'GET', url: '/posts', cookies: cookie });
    expect(list.json()).toHaveLength(1);
    const pub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ published: true, build: { ok: true, release: 'r1' } });
  });

  it('publish rejects an incomplete post (400)', async () => {
    const b = build(); const { cookie } = await authed(b);
    const bad = sample(); bad.de.excerpt = '';
    const c = await b.app.inject({ method: 'POST', url: '/posts', headers: { 'content-type': 'application/json' }, cookies: cookie, payload: bad });
    const tk = c.json().translationKey;
    const pub = await b.app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies: cookie });
    expect(pub.statusCode).toBe(400);
  });
});
```
(`build()` must return `{ app, users, sessions }` plus accept `posts`/`triggerImpl` in `extra` — extend the `Built`/`extra` types accordingly.)

- [ ] **Step 4: Run tests to verify they fail, then pass**

Run: `npx vitest run test/server.test.ts` (fails on missing config), then implement Steps 1–2, then:
Run: `npm run typecheck && npm test`
Expected: typecheck clean; full suite passes.

- [ ] **Step 5: Commit**

```bash
git add uploader/src/server.ts uploader/src/main.ts uploader/test/server.test.ts
git commit -m "feat(uploader): post CRUD + publish (build trigger) + export routes"
```

---

### Task 7: EasyMDE vendoring + compose env

**Files:**
- Modify: `uploader/package.json` (add `easymde`)
- Create: `uploader/scripts/copy-easymde.mjs`
- Modify: `uploader/Dockerfile` (run the copy step)
- Modify: `docker-compose.yml`, `uploader/docker-compose.yml` (add `BUILDER_URL`; `BUILD_SECRET` already present)
- Modify: `uploader/.env.example` (add `BUILDER_URL`)

**Interfaces:**
- Consumes: nothing.
- Produces: `public/vendor/easymde.min.js` + `public/vendor/easymde.min.css` at image-build time; `BUILDER_URL` in the `images` env.

- [ ] **Step 1: Add EasyMDE + a copy script**

Run (from `uploader/`): `npm install easymde`
Create `uploader/scripts/copy-easymde.mjs` (mirrors `copy-fonts.mjs`):
```js
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'vendor');
mkdirSync(out, { recursive: true });
for (const [from, to] of [
  ['easymde/dist/easymde.min.js', 'easymde.min.js'],
  ['easymde/dist/easymde.min.css', 'easymde.min.css'],
]) {
  copyFileSync(join(here, '..', 'node_modules', from), join(out, to));
  console.log('copied', to);
}
```
Add to `uploader/package.json` scripts: `"copy:easymde": "node scripts/copy-easymde.mjs"`. Add `public/vendor/` to `uploader/.gitignore` (vendored at build, not committed).

- [ ] **Step 2: Run the copy script in the Dockerfile**

In `uploader/Dockerfile`, after the existing `RUN node scripts/copy-fonts.mjs` line, add:
```dockerfile
RUN node scripts/copy-easymde.mjs
```

- [ ] **Step 3: Add `BUILDER_URL` to both compose files' `images` service**

In `docker-compose.yml` and `uploader/docker-compose.yml`, under the `images` service `environment:` add:
```yaml
      BUILD_SECRET: ${BUILD_SECRET:?set BUILD_SECRET in .env}
      BUILDER_URL: ${BUILDER_URL:-http://blog-builder:4000}
```
(`BUILD_SECRET` may already be referenced by `blog-builder`; add it to `images` too so the uploader can call the builder.)

- [ ] **Step 4: Document the env in `.env.example`**

Append to `uploader/.env.example` (and the root `.env.example`):
```bash
# Internal URL of the blog-builder the uploader calls on Publish.
BUILDER_URL=http://blog-builder:4000
```

- [ ] **Step 5: Verify**

Run (from `uploader/`): `node scripts/copy-easymde.mjs && ls public/vendor` → shows the two files.
Run: `POSTGRES_PASSWORD=x BUILD_SECRET=y docker compose -f ../docker-compose.yml config >/dev/null && echo OK`
Expected: both vendor files listed; `OK`.

- [ ] **Step 6: Commit**

```bash
git add uploader/package.json uploader/package-lock.json uploader/scripts/copy-easymde.mjs uploader/Dockerfile uploader/.gitignore docker-compose.yml uploader/docker-compose.yml uploader/.env.example .env.example
git commit -m "build(uploader): vendor EasyMDE; wire BUILDER_URL for the publish trigger"
```

---

### Task 8: Editor UI (list + DE/EN editor)

**Files:**
- Create: `uploader/public/posts.html`, `uploader/public/editor.html`
- Modify: `uploader/public/admin.css` (editor styles), and the nav of `index.html`/`batch.html`/`settings.html`/`users.html` (add a "Posts" link)

**Interfaces:**
- Consumes: `GET/POST/PUT /posts*`, `POST /posts/:tk/publish`, `POST /export`, `POST /upload`; `auth.js`; vendored EasyMDE.
- Produces: the authoring UI. No unit tests (static); verified by the deploy smoke.

- [ ] **Step 1: Create `posts.html` (list)**

`uploader/public/posts.html` — Expedition-Log masthead + nav (include all admin links and `id="whoami"`), `<script src="/admin/auth.js">`, a table populated from `GET /posts`, a **New post** button linking to `editor.html`, an **Export all** button calling `POST /export`. On load: `const s = await Auth.ensureAuthed(); if(!s) return; Auth.renderHeader(s); load();` where `load()` fetches `/posts` (redirect to `/login` on 401), and renders rows (title, status, updated, an Edit link to `editor.html?tk=<translationKey>`). Build the table with `document.createElement`/`textContent` (no `innerHTML` with server data — XSS rule).

- [ ] **Step 2: Create `editor.html` (DE/EN editor)**

`uploader/public/editor.html` — load EasyMDE assets (`/admin/vendor/easymde.min.css`, `/admin/vendor/easymde.min.js`) and `/admin/auth.js`. Layout:
- Shared frontmatter form: `date` (date input), `country`, `countryCode` (maxlength 2), `region` (select: europe/north-america/south-america), `coordinates` lat/lng (number inputs), optional `route`, `keyFacts` (simple key/value rows), optional `stops`.
- A **slug** field shown as the live-URL preview, auto-derived from the DE title via a `slugify()` (copy the slug regex `^[a-z0-9][a-z0-9-]*$`-producing logic), **disabled when the loaded post status is `published`**.
- **DE/EN tabs**, each with: `title`, `excerpt`, a **hero image** picker (`<input type=file>` → POST to `/upload` with a `key` like `trips/<slug>/hero` → fill that locale's `heroImage` {src,width,height} + an `alt` field), an EasyMDE-backed **body** textarea, and an **insert body image** control (`<input type=file>` → `/upload` with key `trips/<slug>/<name>` → insert `![alt](src)` at the cursor via the EasyMDE instance + record `images[src]={width,height}`).
- **Save draft** → `POST /posts` (new) or `PUT /posts/:tk` (existing), sending the assembled `PostPair`; show the returned `translationKey` (switch the URL to `?tk=...`). **Publish** → `POST /posts/:tk/publish`; show "Building…" then `Published ✓ (release X)` or the build error from `{build}`. On any `401`, redirect to `/login`. Surface `400`/`409` validation errors inline.
- On load with `?tk=`, `GET /posts/:tk` and populate both locales + EasyMDE instances.
Two EasyMDE instances (DE, EN); track the per-locale `images` map in JS and include it in the saved payload.

- [ ] **Step 3: Editor styles + nav links**

Append minimal styles to `uploader/public/admin.css` for the tabs/form/table (reuse existing card/label/input styles where possible). Add `<a href="/admin/posts.html">Posts</a>` to the `<nav>` of `index.html`, `batch.html`, `settings.html`, `users.html`.

- [ ] **Step 4: Static sanity checks**

Run from repo root:
- `grep -rn "Bearer\|id=\"token\"" uploader/public/posts.html uploader/public/editor.html` → none.
- `grep -c "/admin/auth.js" uploader/public/posts.html uploader/public/editor.html` → 1 each.
- `grep -c "vendor/easymde" uploader/public/editor.html` → ≥1.
From `uploader/`: `npm run typecheck && npm test` (unchanged TS still green; static files don't affect it).
Live browser flow (NOT automated — needs the running stack + Postgres): new post → fill DE/EN → upload hero + a body image → Save draft → Publish → confirm the route builds and renders. Note in the report that this was not run.

- [ ] **Step 5: Commit**

```bash
git add uploader/public/posts.html uploader/public/editor.html uploader/public/admin.css uploader/public/index.html uploader/public/batch.html uploader/public/settings.html uploader/public/users.html
git commit -m "feat(uploader): post list + DE/EN editor UI (EasyMDE, integrated upload, slug-lock)"
```

---

### Task 9: Docs

**Files:**
- Modify: `docs/authoring-workflow.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: nothing.
- Produces: accurate authoring docs (the editor now exists).

- [ ] **Step 1: Update `docs/authoring-workflow.md`**

Replace the now-superseded Stage 2 (hand-writing MDX in GitHub) with the **in-admin editor** flow: sign in → Posts → New post → fill DE/EN (frontmatter + body + hero/body images via the integrated upload) → Save draft → **Publish** (rebuilds the site) → the post is live; an **Export all** button writes MDX backups to `/data/backup`. Keep Stage 1 (photo upload) accurate; note images can also be uploaded inline from the editor now. Update the checklist accordingly.

- [ ] **Step 2: Update `CLAUDE.md`**

In Project Status, mark **Phase B done** (in-admin editor + publish + export). In the `uploader/src` component list add `posts · publish · export`. Note authoring is now done in the admin editor (Postgres), not by editing MDX.

- [ ] **Step 3: Commit**

```bash
git add docs/authoring-workflow.md CLAUDE.md
git commit -m "docs: in-admin post editor workflow (Phase B)"
```

---

## Self-Review

**Spec coverage:** post store (DE/EN pairs, slug-lock, dup-guard) → T1/T3; draft+publish validation → T2; MDX export (auto on publish + on-demand, `<BodyImage>` reconstruction) → T4/T6; publish→build client → T5; routes (`requireAuth`, create/edit/publish/export) → T6; `BUILD_SECRET`/`BUILDER_URL` env → T7; integrated-upload editor + slug-lock + DE/EN tabs + EasyMDE vendored → T7/T8; docs → T9. Roles (`requireAuth`) → T6. Both-locales-to-publish → T2. `translation_key` auto-gen → T1/T3.

**Placeholder scan:** No TBD/TODO. The editor HTML (T8) is specified behaviorally with exact endpoints/keys/flows rather than full markup, because it's a large static file following the existing `settings.html`/`users.html` patterns; every dynamic interaction names its exact endpoint, payload shape, and the XSS-safe DOM rule. All TS tasks carry complete code.

**Type consistency:** `PostPair`/`PostLocale`/`PostShared`/`PostStore` defined in T1 are used unchanged in T3/T4/T6; `BuildResult`/`triggerBuild` (T5) consumed in T6 with matching signature; `ServerConfig` additions (T6) wired in `main.ts` (T6) and the test build helper (T6). `renderPostToMdx(pair, locale)` (T4) is the inverse of the Phase A `mdxBodyToMarkdown` (export round-trip).

**Highest-risk tasks:** T6 (routes + publish orchestration + test-helper changes) and T8 (the editor UI — the one task without unit tests; rely on the live smoke). T3 has a guarded integration test; run it against a throwaway DB (Step 5).
