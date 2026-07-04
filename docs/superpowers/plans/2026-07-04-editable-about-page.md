# Editable About Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the About page (`/uber-mich/`, `/en/about-me/`) editable from `/admin/` — DE/EN heading + Markdown body with inline photos — stored in a new Postgres `pages` table and rendered through the existing trips markdown/sanitize/body-image pipeline; Save writes and rebuilds.

**Architecture:** A dedicated `pages` table (one row per `key`,`locale`; `key='about'`) with its own `PageStore`, two admin routes (`GET`/`PUT /pages/:key`), and a small editor page. On the Astro side, a second Content Layer loader (mirroring `postgresTripsLoader`) exposes a `pages` collection rendered identically to trips (`renderMarkdown` + `transformBodyImages`); `AboutPage.astro` renders the `about/<locale>` entry. Save triggers `builder.build()`.

**Tech Stack:** Node 22, Fastify 5, pg 8, EasyMDE, Astro 6 Content Layer, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-04-editable-about-page-design.md` — read it first.

## Global Constraints

- Branch: `feature/editable-about-page` (exists). Conventional commits. Commits stay local.
- Strict TS: no `any`, no `@ts-ignore` (Golden Rule 6). Uploader: `cd uploader && npm test`, `npm run typecheck`. Site: `cd site && npm test`.
- Reuse the existing pipeline: markdown → `renderMarkdown` (loader) → `transformBodyImages(html, images)` (sanitize + responsive `<picture>`). Do NOT add a second markdown renderer or sanitizer.
- Table: `pages(key text, locale text CHECK IN ('de','en'), title text DEFAULT '', body_markdown text DEFAULT '', images jsonb DEFAULT '{}', updated_at timestamptz DEFAULT now(), PRIMARY KEY(key, locale))`.
- Content-entry id is `` `${key}/${locale}` `` (e.g. `about/de`) — mirrors trips' `` `${locale}/${slug}` ``.
- `GET /pages/:key` → `requireAuth`; `PUT /pages/:key` → `requireAdmin` (401 unauth / 403 non-admin). Save = upsert both locales then `cfg.builder.build()`.
- Page key validated `^[a-z0-9][a-z0-9-]*$`. Inline uploads reuse `POST /upload` with keys `pages/about/<name>` (pass the existing `assertSafeKey`).
- Backup: bump `DUMP_VERSION` 1 → 2, add `pages` to the dump; restore accepts **both** v1 (no pages — leave existing pages untouched) and v2.
- Heading from DB `title`, falling back to `t('about.title')` when blank. Nav label stays in i18n.
- Seed the two `about` rows on `ensureSchema` with the current placeholder text (below), `ON CONFLICT DO NOTHING`.

**Current placeholder text to seed** (verbatim from `AboutPage.astro:12-15`):
- DE title: `Über mich` · DE body: `Hier teile ich meine Leidenschaft fürs Reisen — Geschichten und Erinnerungen von den belebten Straßen Europas bis zu den geheimnisvollen Pfaden Südamerikas. Der vollständige Über-mich-Text wird in Phase 2 von der bestehenden Seite migriert.`
- EN title: `About me` · EN body: `Here I share my passion for travelling — stories and memories from the bustling streets of Europe to the mysterious trails of South America. The full about text will be migrated from the existing site in Phase 2.`

## File Structure

| File | Responsibility |
| :-- | :-- |
| `uploader/src/db.ts` | `pages` DDL + idempotent seed in `ensureSchema` |
| `uploader/src/pages.ts` (new) | `PageStore` (memory + pg), types, key/locale validation |
| `uploader/src/server.ts` | `GET`/`PUT /pages/:key`; `ServerConfig.pages`; `/pages` in `ADMIN_PREFIXES` |
| `uploader/src/main.ts` | wire `pgPageStore(pool)` |
| `uploader/src/backup.ts` | dump v2 with `pages`; restore v1/v2 |
| `uploader/public/about.html` (new) | the editor |
| `uploader/public/auth.js` | admin-nav "About page" link |
| `site/src/lib/pages-loader.ts` (new) | `postgresPagesLoader` + pure `rowToPageEntry` |
| `site/src/content.config.ts` | register the `pages` collection |
| `site/src/components/pages/AboutPage.astro` | render from the `pages` collection |

Uploader commands run from `uploader/`; site commands from `site/`.

---

### Task 1: `pages` table + seed

**Files:**
- Modify: `uploader/src/db.ts`
- Test: `uploader/test/pg.integration.test.ts` (extend)

**Interfaces:**
- Produces: a `pages` table + seeded `('about','de')`/`('about','en')` rows. Consumed by Tasks 2, 4, 6.

- [ ] **Step 1: Write the failing integration test** — append to `uploader/test/pg.integration.test.ts` inside its existing `maybe(...)` block (which is gated on `TEST_DATABASE_URL`; reuse its `pool`):

```ts
  it('creates and seeds the pages table (About)', async () => {
    const { rows } = await pool.query(
      `SELECT locale, title, body_markdown FROM pages WHERE key='about' ORDER BY locale`,
    );
    expect(rows.map((r) => r.locale)).toEqual(['de', 'en']);
    const de = rows.find((r) => r.locale === 'de');
    expect(de.title).toBe('Über mich');
    expect(de.body_markdown).toContain('Leidenschaft');
  });
```

- [ ] **Step 2: Run to verify failure** — with a scratch DB (never a real one):
  `docker run --rm -d --name p1-pg -p 54340:5432 -e POSTGRES_PASSWORD=p1 -e POSTGRES_DB=p1 postgres:17-alpine`, wait, then
  `TEST_DATABASE_URL=postgres://postgres:p1@127.0.0.1:54340/p1 npm test -- pg.integration` → FAIL (`relation "pages" does not exist`). If docker is unavailable, note it and rely on the type-check + later e2e.

- [ ] **Step 3: Implement** — in `uploader/src/db.ts`, add a seed constant near the top (after the imports):

```ts
const ABOUT_SEED = {
  de: {
    title: 'Über mich',
    body: 'Hier teile ich meine Leidenschaft fürs Reisen — Geschichten und Erinnerungen von den belebten Straßen Europas bis zu den geheimnisvollen Pfaden Südamerikas. Der vollständige Über-mich-Text wird in Phase 2 von der bestehenden Seite migriert.',
  },
  en: {
    title: 'About me',
    body: 'Here I share my passion for travelling — stories and memories from the bustling streets of Europe to the mysterious trails of South America. The full about text will be migrated from the existing site in Phase 2.',
  },
};
```

At the end of `ensureSchema` (after the posts indexes), add:

```ts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pages (
      key           text NOT NULL,
      locale        text NOT NULL CHECK (locale IN ('de','en')),
      title         text NOT NULL DEFAULT '',
      body_markdown text NOT NULL DEFAULT '',
      images        jsonb NOT NULL DEFAULT '{}',
      updated_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (key, locale)
    )
  `);
  // Seed the About page with the previous hardcoded placeholder so the page
  // never goes blank; the author then edits it in /admin/about.html.
  await pool.query(
    `INSERT INTO pages (key, locale, title, body_markdown) VALUES
       ('about','de',$1,$2), ('about','en',$3,$4)
     ON CONFLICT (key, locale) DO NOTHING`,
    [ABOUT_SEED.de.title, ABOUT_SEED.de.body, ABOUT_SEED.en.title, ABOUT_SEED.en.body],
  );
```

- [ ] **Step 4: Verify** — re-run the integration test (scratch DB) → PASS. `npm run typecheck` → clean. `docker rm -f p1-pg`.

- [ ] **Step 5: Commit** — `git add uploader/src/db.ts uploader/test/pg.integration.test.ts && git commit -m "feat(db): pages table + seeded About content"`

---

### Task 2: `PageStore` (memory + pg)

**Files:**
- Create: `uploader/src/pages.ts`
- Test: `uploader/test/pages.test.ts` (new), `uploader/test/pages.integration.test.ts` (new)

**Interfaces:**
- Consumes: `DbPool` (`db.ts`); the `pages` table (Task 1).
- Produces (consumed by Tasks 3, 6-parallel):

```ts
export type Locale = 'de' | 'en';
export interface ImageDims { width: number; height: number }
export interface PageContent { locale: Locale; title: string; bodyMarkdown: string; images: Record<string, ImageDims> }
export interface PagePair { key: string; de: PageContent; en: PageContent }
export class PageError extends Error {}
export function isSafePageKey(key: string): boolean
export function validatePagePair(pair: PagePair): void
export interface PageStore { get(key: string): Promise<PagePair>; save(pair: PagePair): Promise<PagePair> }
export function memoryPageStore(): PageStore
export function pgPageStore(pool: DbPool): PageStore
```

- [ ] **Step 1: Write failing unit tests** — `uploader/test/pages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { memoryPageStore, validatePagePair, isSafePageKey, PageError, type PagePair } from '../src/pages.js';

const pair = (key = 'about'): PagePair => ({
  key,
  de: { locale: 'de', title: 'Über mich', bodyMarkdown: 'Hallo', images: {} },
  en: { locale: 'en', title: 'About me', bodyMarkdown: 'Hi', images: {} },
});

describe('page key validation', () => {
  it('accepts safe keys, rejects unsafe', () => {
    expect(isSafePageKey('about')).toBe(true);
    expect(isSafePageKey('privacy-policy')).toBe(true);
    expect(isSafePageKey('../etc')).toBe(false);
    expect(isSafePageKey('About')).toBe(false);
  });
  it('validatePagePair throws PageError on a bad key', () => {
    expect(() => validatePagePair({ ...pair(), key: 'bad key' })).toThrow(PageError);
  });
});

describe('memoryPageStore', () => {
  it('returns an empty-but-valid pair before any save', async () => {
    const s = memoryPageStore();
    const p = await s.get('about');
    expect(p).toEqual({
      key: 'about',
      de: { locale: 'de', title: '', bodyMarkdown: '', images: {} },
      en: { locale: 'en', title: '', bodyMarkdown: '', images: {} },
    });
  });
  it('round-trips a saved pair', async () => {
    const s = memoryPageStore();
    await s.save(pair());
    const p = await s.get('about');
    expect(p.de.title).toBe('Über mich');
    expect(p.en.bodyMarkdown).toBe('Hi');
  });
});
```

- [ ] **Step 2: Write the failing pg integration test** — `uploader/test/pages.integration.test.ts` (gated exactly like `pg.integration.test.ts:7-8`):

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgPageStore } from '../src/pages.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('pgPageStore (Postgres)', () => {
  let pool: DbPool;
  beforeAll(async () => { pool = createPool(url as string); await ensureSchema(pool); });
  afterAll(async () => { await pool.end(); });

  it('saves and reads back both locales with images', async () => {
    const store = pgPageStore(pool);
    await store.save({
      key: 'about',
      de: { locale: 'de', title: 'DE', bodyMarkdown: '![a](https://img/x)\nDE body', images: { 'https://img/x': { width: 800, height: 600 } } },
      en: { locale: 'en', title: 'EN', bodyMarkdown: 'EN body', images: {} },
    });
    const p = await store.get('about');
    expect(p.de.title).toBe('DE');
    expect(p.de.images['https://img/x']).toEqual({ width: 800, height: 600 });
    expect(p.en.bodyMarkdown).toBe('EN body');
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npm test -- pages` → FAIL (module missing). (Integration test skips without `TEST_DATABASE_URL`.)

- [ ] **Step 4: Implement** `uploader/src/pages.ts`:

```ts
import type { DbPool } from './db.js';

export type Locale = 'de' | 'en';
export interface ImageDims { width: number; height: number }
export interface PageContent { locale: Locale; title: string; bodyMarkdown: string; images: Record<string, ImageDims> }
export interface PagePair { key: string; de: PageContent; en: PageContent }

export class PageError extends Error {}

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
export function isSafePageKey(key: string): boolean { return KEY_RE.test(key); }

function emptyContent(locale: Locale): PageContent {
  return { locale, title: '', bodyMarkdown: '', images: {} };
}

export function validatePagePair(pair: PagePair): void {
  if (!isSafePageKey(pair.key)) throw new PageError(`invalid page key "${pair.key}" (lowercase a-z, 0-9, hyphen)`);
  for (const locale of ['de', 'en'] as Locale[]) {
    if (pair[locale].locale !== locale) throw new PageError(`locale field mismatch for ${locale}`);
  }
}

export interface PageStore {
  get(key: string): Promise<PagePair>;
  save(pair: PagePair): Promise<PagePair>;
}

export function memoryPageStore(): PageStore {
  const byKeyLocale = new Map<string, PageContent>();
  return {
    async get(key) {
      return {
        key,
        de: structuredClone(byKeyLocale.get(`${key}:de`) ?? emptyContent('de')),
        en: structuredClone(byKeyLocale.get(`${key}:en`) ?? emptyContent('en')),
      };
    },
    async save(pair) {
      validatePagePair(pair);
      for (const locale of ['de', 'en'] as Locale[]) {
        byKeyLocale.set(`${pair.key}:${locale}`, structuredClone({ ...pair[locale], locale }));
      }
      return this.get(pair.key);
    },
  };
}

interface PageRow { key: string; locale: Locale; title: string; body_markdown: string; images: Record<string, ImageDims> | null }
function rowToContent(r: PageRow): PageContent {
  return { locale: r.locale, title: r.title, bodyMarkdown: r.body_markdown, images: r.images ?? {} };
}

export function pgPageStore(pool: DbPool): PageStore {
  return {
    async get(key) {
      const { rows } = await pool.query<PageRow>(
        `SELECT key, locale, title, body_markdown, images FROM pages WHERE key = $1`, [key],
      );
      const de = rows.find((r) => r.locale === 'de');
      const en = rows.find((r) => r.locale === 'en');
      return { key, de: de ? rowToContent(de) : emptyContent('de'), en: en ? rowToContent(en) : emptyContent('en') };
    },
    async save(pair) {
      validatePagePair(pair);
      for (const locale of ['de', 'en'] as Locale[]) {
        const c = pair[locale];
        await pool.query(
          `INSERT INTO pages (key, locale, title, body_markdown, images, updated_at)
           VALUES ($1,$2,$3,$4,$5::jsonb, now())
           ON CONFLICT (key, locale) DO UPDATE SET
             title=EXCLUDED.title, body_markdown=EXCLUDED.body_markdown, images=EXCLUDED.images, updated_at=now()`,
          [pair.key, locale, c.title, c.bodyMarkdown, JSON.stringify(c.images ?? {})],
        );
      }
      return this.get(pair.key);
    },
  };
}
```

- [ ] **Step 5: Verify** — `npm test -- pages` → unit tests PASS (integration runs green against a scratch DB per Task 1's recipe, or skips). `npm run typecheck` → clean.

- [ ] **Step 6: Commit** — `git add uploader/src/pages.ts uploader/test/pages.test.ts uploader/test/pages.integration.test.ts && git commit -m "feat(uploader): PageStore for backend-managed pages"`

---

### Task 3: `GET`/`PUT /pages/:key` routes + wiring

**Files:**
- Modify: `uploader/src/server.ts`, `uploader/src/main.ts`
- Test: `uploader/test/server.test.ts` (extend)

**Interfaces:**
- Consumes: `PageStore`, `PagePair`, `PageContent`, `PageError` (Task 2); `cfg.builder` (existing `SiteBuilder`).
- Produces: `ServerConfig.pages: PageStore`. Routes: `GET /pages/:key` (auth) → `PagePair`; `PUT /pages/:key` (admin) → `{ saved: PagePair, build: BuildOutcome }`. Consumed by Task 5 (editor).

- [ ] **Step 1: Extend the test helper + write failing tests.** In `uploader/test/server.test.ts`, add to the imports `import { memoryPageStore, type PageStore } from '../src/pages.js';`, and in the `build()` helper's `buildServer({...})` config add `pages: (extra.pages as PageStore) ?? memoryPageStore(),`. Then add tests:

```ts
describe('pages routes', () => {
  it('GET /pages/:key requires auth and returns the pair', async () => {
    const b = build();
    expect((await b.app.inject({ method: 'GET', url: '/pages/about' })).statusCode).toBe(401);
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'GET', url: '/pages/about', cookies: cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().key).toBe('about');
    expect(res.json().de.locale).toBe('de');
  });

  it('PUT /pages/:key is admin-only and saves + rebuilds', async () => {
    const s = stubBuilder({ ok: true, release: 'r7' });
    const b = build({ builder: s.builder });
    const body = {
      de: { locale: 'de', title: 'Über mich', bodyMarkdown: 'Hallo', images: {} },
      en: { locale: 'en', title: 'About me', bodyMarkdown: 'Hi', images: {} },
    };
    expect((await b.app.inject({ method: 'PUT', url: '/pages/about', payload: body })).statusCode).toBe(401);
    const nonAdmin = await authed(b, { isAdmin: false });
    expect((await b.app.inject({ method: 'PUT', url: '/pages/about', cookies: nonAdmin.cookie, payload: body })).statusCode).toBe(403);
    const admin = await authed(b);
    const res = await b.app.inject({ method: 'PUT', url: '/pages/about', cookies: admin.cookie, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json().saved.de.title).toBe('Über mich');
    expect(res.json().build).toEqual({ ok: true, release: 'r7' });
    expect(s.calls.length).toBe(1);
  });

  it('PUT /pages/:key rejects an unsafe key with 400', async () => {
    const b = build();
    const { cookie } = await authed(b);
    const res = await b.app.inject({ method: 'PUT', url: '/pages/Bad_Key', cookies: cookie, payload: { de: { locale: 'de', title: '', bodyMarkdown: '', images: {} }, en: { locale: 'en', title: '', bodyMarkdown: '', images: {} } } });
    expect(res.statusCode).toBe(400);
  });
});
```

(This reuses the existing `stubBuilder`/`authed` helpers already in `server.test.ts`.)

- [ ] **Step 2: Run to verify failure** — `npm test -- server` → FAIL (config type error + 404 on routes).

- [ ] **Step 3: Implement in `uploader/src/server.ts`:**
  1. Import: `import { type PageStore, type PagePair, type PageContent, PageError } from './pages.js';`
  2. `ServerConfig`: add `pages: PageStore;`
  3. `ADMIN_PREFIXES`: add `'/pages'` to the array.
  4. Add routes (next to the `/rebuild` route):

```ts
  app.get('/pages/:key', { preHandler: requireAuth }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    return reply.send(await cfg.pages.get(key));
  });

  // Admin-only: writing a page rebuilds the public site (like publishing a post).
  app.put('/pages/:key', { preHandler: requireAdmin }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const b = (req.body ?? {}) as Partial<Record<'de' | 'en', Partial<PageContent>>>;
    const mkLocale = (loc: 'de' | 'en'): PageContent => {
      const src = b[loc] ?? {};
      return {
        locale: loc,
        title: String(src.title ?? ''),
        bodyMarkdown: String(src.bodyMarkdown ?? ''),
        images: (src.images ?? {}) as Record<string, { width: number; height: number }>,
      };
    };
    const pair: PagePair = { key, de: mkLocale('de'), en: mkLocale('en') };
    try {
      const saved = await cfg.pages.save(pair);
      const build = await cfg.builder.build();
      return reply.send({ saved, build });
    } catch (e) {
      if (e instanceof PageError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });
```

  5. In `uploader/src/main.ts`: add `import { pgPageStore } from './pages.js';`, then `const pages = pgPageStore(pool);` (next to `const posts = ...`), and add `pages,` to the `buildServer({...})` config object.

- [ ] **Step 4: Verify** — `npm test` (full) → PASS; `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add uploader/src/server.ts uploader/src/main.ts uploader/test/server.test.ts && git commit -m "feat(uploader): GET/PUT /pages/:key routes, admin-gated, rebuild on save"`

---

### Task 4: Back up the `pages` table (dump v2, restore v1/v2)

**Files:**
- Modify: `uploader/src/backup.ts`
- Test: `uploader/test/backup.test.ts`, `uploader/test/backup.integration.test.ts`

**Interfaces:**
- Consumes: the `pages` table (Task 1). Produces: dumps at `DUMP_VERSION = 2` carrying `tables.pages`; restore handling v1 (pages absent → leave existing pages) and v2.

- [ ] **Step 1: Update tests.** In `uploader/test/backup.test.ts`, the `dumpDatabase` test uses a `fakeDb` that routes on `FROM users`. Extend it to also answer the pages query and assert the dump carries pages + version 2. Change the `fakeDb` signature to accept pages and add a case:

```ts
const fakeDb = (users = [], posts = [], pages = []) => ({
  query: async (sql: string) => ({
    rows: sql.includes('FROM users') ? users : sql.includes('FROM pages') ? pages : posts,
  }),
});
```

Add to the dump test's assertions:

```ts
    expect(dump.version).toBe(2);
    expect(dump.tables.pages).toEqual([{ key: 'about', locale: 'de', title: 'X', body_markdown: 'B', images: {} }]);
```

(construct that dump via `dumpDatabase(fakeDb([{ id: 'u1' }], [{ id: 'p1' }], [{ key: 'about', locale: 'de', title: 'X', body_markdown: 'B', images: {} }]), dir, now)`.)

In `uploader/test/backup.integration.test.ts`: (a) the existing "rejects an unsupported dump version" test crafts a **version-2** dump and expects rejection — change it to **version 3** (still unsupported). (b) Extend the round-trip test to insert an About page before dump and assert it restores:

```ts
    await pool.query(`INSERT INTO pages (key,locale,title,body_markdown) VALUES ('about','de','T','Body')
      ON CONFLICT (key,locale) DO UPDATE SET title=EXCLUDED.title, body_markdown=EXCLUDED.body_markdown`);
    // ... after dump + wipe + restore:
    const pg = (await pool.query(`SELECT title, body_markdown FROM pages WHERE key='about' AND locale='de'`)).rows[0];
    expect(pg.title).toBe('T');
```

Add a new test for v1 backward-compat:

```ts
  it('restores a v1 dump (no pages) without wiping existing pages', async () => {
    const { gzipSync } = await import('node:zlib');
    const { writeFileSync } = await import('node:fs');
    await pool.query(`INSERT INTO pages (key,locale,title,body_markdown) VALUES ('about','en','keep','me')
      ON CONFLICT (key,locale) DO UPDATE SET title='keep', body_markdown='me'`);
    const v1 = join(dir, 'db-20250101-000000.json.gz');
    writeFileSync(v1, gzipSync(JSON.stringify({ version: 1, tables: { users: [], posts: [] } })));
    await restoreDatabase(pool, v1);
    const kept = (await pool.query(`SELECT title FROM pages WHERE key='about' AND locale='en'`)).rows[0];
    expect(kept.title).toBe('keep');
  });
```

- [ ] **Step 2: Run to verify failure** — `npm test -- backup` → unit FAIL (version still 1, no pages). Integration (scratch DB) FAIL on the new assertions.

- [ ] **Step 3: Implement in `uploader/src/backup.ts`:**
  1. `export const DUMP_VERSION = 2;`
  2. In `dumpDatabase`, after the `posts` query add:

```ts
  const pages = (await db.query('SELECT key, locale, title, body_markdown, images FROM pages ORDER BY key, locale')).rows;
```

  and change the payload to `tables: { users, posts, pages }`.
  3. Widen the `Dump` interface:

```ts
interface Dump {
  version: number;
  createdAt: string;
  tables: { users: Record<string, unknown>[]; posts: Record<string, unknown>[]; pages?: Record<string, unknown>[] };
}
```

  4. In `restoreDatabase`: change the version guard to accept 1 or 2:

```ts
  if (dump.version !== 1 && dump.version !== 2) throw new BackupError(`unsupported dump version ${dump.version}`);
```

  and inside the transaction, after the posts insert loop, add (only when the dump carries pages, so a v1 restore leaves existing pages intact):

```ts
    if (dump.tables.pages) {
      await client.query('DELETE FROM pages');
      for (const pg of dump.tables.pages) {
        await client.query(
          `INSERT INTO pages (key, locale, title, body_markdown, images, updated_at)
           VALUES ($1,$2,$3,$4,$5::jsonb, now())`,
          [pg.key, pg.locale, pg.title, pg.body_markdown, asJsonb(pg.images)],
        );
      }
    }
```

  5. Update the return: `return { users: dump.tables.users.length, posts: dump.tables.posts.length, pages: dump.tables.pages?.length ?? 0 };` and widen the function's return type to `{ users: number; posts: number; pages: number }`. (The CLI in `cli.ts` prints `counts.users`/`counts.posts` — add `+ counts.pages + ' pages'` to its message.)

- [ ] **Step 4: Verify** — `npm test -- backup` → unit PASS; integration PASS against a scratch DB (Task 1 recipe). `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add uploader/src/backup.ts uploader/src/cli.ts uploader/test/backup.test.ts uploader/test/backup.integration.test.ts && git commit -m "feat(backup): include pages in dump (v2) with v1-compatible restore"`

---

### Task 5: About editor page + admin nav link

**Files:**
- Create: `uploader/public/about.html`
- Modify: `uploader/public/auth.js`

**Interfaces:**
- Consumes: `GET /pages/about`, `PUT /pages/about`, `POST /upload` (Task 3 + existing). `Auth.ensureAuthed()`/`Auth.renderHeader(s)` (existing).

- [ ] **Step 1: Add the nav link** — in `uploader/public/auth.js`, add to the `NAV` array (after the Posts entry):

```js
    { label: 'About page',     href: '/admin/about.html',    admin: true },
```

- [ ] **Step 2: Create `uploader/public/about.html`** (mirrors `editor.html`'s EasyMDE + tab + upload patterns; title + body per locale, one Save):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About Page · Simon's Wanderlust</title>
    <link rel="stylesheet" href="/admin/admin.css" />
    <link rel="stylesheet" href="/admin/vendor/easymde.min.css" />
  </head>
  <body>
    <header class="masthead">
      <div class="masthead-inner">
        <nav id="mainnav" aria-label="Admin"></nav>
        <p class="eyebrow">Expedition Log · Image Station</p>
        <h1>About page</h1>
        <p class="muted" id="whoami"></p>
      </div>
    </header>
    <main>
      <div class="tabs-bar">
        <button type="button" class="tab-btn active" data-tab="de">Deutsch (DE)</button>
        <button type="button" class="tab-btn" data-tab="en">English (EN)</button>
      </div>

      <section id="tab-de" class="card locale-tab">
        <h2 class="card-heading">Deutsch</h2>
        <label for="deTitle">Heading</label>
        <input id="deTitle" type="text" placeholder="Über mich" />
        <label>Body (Markdown)</label>
        <textarea id="deBody"></textarea>
        <div class="body-img-row">
          <input id="deBodyImgFile" type="file" accept="image/*" />
          <input id="deBodyImgAlt" type="text" placeholder="Alt text (DE)" />
          <button type="button" id="deBodyImgUpload" class="btn-secondary">Insert body image</button>
          <p id="deBodyImgStatus" class="muted"></p>
        </div>
      </section>

      <section id="tab-en" class="card locale-tab" style="display:none">
        <h2 class="card-heading">English</h2>
        <label for="enTitle">Heading</label>
        <input id="enTitle" type="text" placeholder="About me" />
        <label>Body (Markdown)</label>
        <textarea id="enBody"></textarea>
        <div class="body-img-row">
          <input id="enBodyImgFile" type="file" accept="image/*" />
          <input id="enBodyImgAlt" type="text" placeholder="Alt text (EN)" />
          <button type="button" id="enBodyImgUpload" class="btn-secondary">Insert body image</button>
          <p id="enBodyImgStatus" class="muted"></p>
        </div>
      </section>

      <div class="editor-actions card">
        <button id="saveBtn" class="btn-publish">Save &amp; rebuild</button>
        <p id="actionStatus" class="muted"></p>
        <p id="actionError" class="err" style="display:none"></p>
      </div>
    </main>

    <script src="/admin/auth.js"></script>
    <script src="/admin/vendor/easymde.min.js"></script>
    <script>
      'use strict';
      const $ = (id) => document.getElementById(id);
      const KEY = 'about';
      const deImages = {}, enImages = {};

      const deMDE = new EasyMDE({ element: $('deBody'), spellChecker: false, autosave: { enabled: false },
        toolbar: ['bold', 'italic', 'heading', '|', 'quote', 'unordered-list', 'ordered-list', '|', 'link', 'image', '|', 'preview'] });
      const enMDE = new EasyMDE({ element: $('enBody'), spellChecker: false, autosave: { enabled: false },
        toolbar: ['bold', 'italic', 'heading', '|', 'quote', 'unordered-list', 'ordered-list', '|', 'link', 'image', '|', 'preview'] });

      document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        $('tab-de').style.display = tab === 'de' ? '' : 'none';
        $('tab-en').style.display = tab === 'en' ? '' : 'none';
        (tab === 'en' ? enMDE : deMDE).codemirror.refresh();
      }));

      function showErr(msg) { const el = $('actionError'); el.textContent = msg; el.style.display = msg ? '' : 'none'; }
      function setStatus(msg) { $('actionStatus').textContent = msg; }

      async function uploadBodyImg(locale) {
        const fileInput = $(locale + 'BodyImgFile'), altInput = $(locale + 'BodyImgAlt'), statusEl = $(locale + 'BodyImgStatus');
        const file = fileInput.files[0];
        if (!file) { statusEl.textContent = 'Pick a file first.'; return; }
        const imgSlug = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
        statusEl.textContent = 'Uploading…';
        const fd = new FormData();
        fd.append('key', 'pages/about/' + imgSlug);
        fd.append('alt', altInput.value);
        fd.append('file', file);
        const res = await fetch('/upload', { method: 'POST', body: fd });
        if (res.status === 401) { location.href = '/login'; return; }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { statusEl.textContent = 'Upload failed: ' + (body.error || res.status); return; }
        (locale === 'de' ? deImages : enImages)[body.src] = { width: body.width, height: body.height };
        (locale === 'de' ? deMDE : enMDE).codemirror.replaceSelection('![' + (altInput.value || '') + '](' + body.src + ')');
        statusEl.textContent = 'Inserted: ' + body.src;
        fileInput.value = ''; altInput.value = '';
      }
      $('deBodyImgUpload').addEventListener('click', () => uploadBodyImg('de'));
      $('enBodyImgUpload').addEventListener('click', () => uploadBodyImg('en'));

      function localeObj(loc) {
        return { locale: loc, title: $(loc + 'Title').value.trim(),
          bodyMarkdown: (loc === 'de' ? deMDE : enMDE).value(), images: { ...(loc === 'de' ? deImages : enImages) } };
      }

      $('saveBtn').addEventListener('click', async () => {
        showErr(''); setStatus('Saving & rebuilding…');
        const payload = { de: localeObj('de'), en: localeObj('en') };
        const res = await fetch('/pages/' + KEY, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        if (res.status === 401) { location.href = '/login'; return; }
        if (res.status === 403) { showErr('Only admins can save the About page.'); setStatus(''); return; }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { showErr(body.error || ('Save failed: ' + res.status)); setStatus(''); return; }
        if (body.build && !body.build.ok) { showErr('Build error: ' + (body.build.error || 'unknown')); setStatus(''); return; }
        const release = (body.build && body.build.release) ? ' (release ' + body.build.release + ')' : '';
        setStatus('Saved & rebuilt ✓' + release);
      });

      function fill(loc, data) {
        if (!data) return;
        $(loc + 'Title').value = data.title || '';
        (loc === 'de' ? deMDE : enMDE).value(data.bodyMarkdown || '');
        if (data.images) Object.assign(loc === 'de' ? deImages : enImages, data.images);
      }

      (async () => {
        const s = await Auth.ensureAuthed();
        if (!s) return;
        Auth.renderHeader(s);
        if (!s.isAdmin) { showErr('You are signed in as an author; only admins can edit the About page.'); $('saveBtn').disabled = true; }
        const res = await fetch('/pages/' + KEY);
        if (res.status === 401) { location.href = '/login'; return; }
        if (res.ok) { const p = await res.json(); fill('de', p.de); fill('en', p.en); enMDE.codemirror.refresh(); setStatus('Loaded.'); }
        else setStatus('Could not load: ' + res.status);
      })();
    </script>
  </body>
</html>
```

- [ ] **Step 3: Manual smoke** — with the stack running (`docker compose up -d`) and an admin session: open `/admin/about.html` → the "About page" nav link shows for admins only; the DE/EN heading + body load the seeded text; "Insert body image" uploads to `pages/about/…` and inserts Markdown; "Save & rebuild" reports a release. (No unit test — this is a static page; the routes it calls are covered in Task 3.)

- [ ] **Step 4: Commit** — `git add uploader/public/about.html uploader/public/auth.js && git commit -m "feat(admin): About page editor + nav link"`

---

### Task 6: Astro `pages` collection loader

**Files:**
- Create: `site/src/lib/pages-loader.ts`
- Modify: `site/src/content.config.ts`
- Test: `site/src/lib/pages-loader.test.ts` (new)

**Interfaces:**
- Consumes: the `pages` table (Task 1); `transformBodyImages` (existing).
- Produces: `postgresPagesLoader(): Loader`, `rowToPageEntry(row)` → `{ id: 'about/de', body, images, data: { title } }`; a `pages` collection. Consumed by Task 7.

- [ ] **Step 1: Write the failing test** — `site/src/lib/pages-loader.test.ts` (mirrors the trips loader's pure-mapping test style):

```ts
import { describe, expect, it } from 'vitest';
import { rowToPageEntry } from './pages-loader';

describe('rowToPageEntry', () => {
  it('maps a page row to a content entry input', () => {
    const out = rowToPageEntry({
      key: 'about', locale: 'de', title: 'Über mich',
      body_markdown: 'Hallo', images: { 'https://img/x': { width: 800, height: 600 } },
    });
    expect(out).toEqual({
      id: 'about/de',
      body: 'Hallo',
      images: { 'https://img/x': { width: 800, height: 600 } },
      data: { title: 'Über mich' },
    });
  });

  it('defaults images to {} when null', () => {
    const out = rowToPageEntry({ key: 'about', locale: 'en', title: 'About me', body_markdown: 'Hi', images: null });
    expect(out.images).toEqual({});
    expect(out.id).toBe('about/en');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd site && npm test -- pages-loader` → FAIL (module missing).

- [ ] **Step 3: Implement `site/src/lib/pages-loader.ts`** (mirror `postgres-loader.ts`):

```ts
import type { Loader } from 'astro/loaders';
import pg from 'pg';
import { transformBodyImages, type ImageDims } from './body-images.js';

interface PageRow {
  key: string; locale: 'de' | 'en'; title: string; body_markdown: string;
  images: Record<string, ImageDims> | null;
}

/** Pure mapping: a DB row → the { id, data, body } a loader will parse/store. */
export function rowToPageEntry(row: PageRow) {
  return {
    id: `${row.key}/${row.locale}`,
    body: row.body_markdown,
    images: row.images ?? {},
    data: { title: row.title },
  };
}

export function postgresPagesLoader(): Loader {
  return {
    name: 'postgres-pages',
    load: async ({ store, parseData, renderMarkdown, logger }) => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL is required to build content from Postgres');
      const pool = new pg.Pool({ connectionString: url });
      try {
        store.clear();
        const { rows } = await pool.query<PageRow>(
          `SELECT key, locale, title, body_markdown, images FROM pages`,
        );
        for (const row of rows) {
          const input = rowToPageEntry(row);
          const data = await parseData({ id: input.id, data: input.data });
          const rendered = await renderMarkdown(input.body);
          rendered.html = transformBodyImages(rendered.html, input.images);
          store.set({ id: input.id, data, body: input.body, rendered });
        }
        logger.info(`postgres-pages: loaded ${rows.length} entries`);
      } finally {
        await pool.end();
      }
    },
  };
}
```

- [ ] **Step 4: Register the collection** — in `site/src/content.config.ts`:

```ts
import { postgresPagesLoader } from './lib/pages-loader';
// ...
const pages = defineCollection({
  loader: postgresPagesLoader(),
  schema: () => z.object({ title: z.string() }),
});

export const collections = { trips, pages };
```

- [ ] **Step 5: Verify** — `cd site && npm test -- pages-loader` → PASS; `npm test` (full) → green.

- [ ] **Step 6: Commit** — `git add site/src/lib/pages-loader.ts site/src/content.config.ts site/src/lib/pages-loader.test.ts && git commit -m "feat(site): pages content collection loaded from Postgres"`

---

### Task 7: Render `AboutPage.astro` from the collection

**Files:**
- Modify: `site/src/components/pages/AboutPage.astro`

**Interfaces:**
- Consumes: the `pages` collection (Task 6) — `getEntry('pages', 'about/<locale>')`, `render(entry)` → `{ Content }`.

- [ ] **Step 1: Replace `site/src/components/pages/AboutPage.astro`:**

```astro
---
import Base from '../../layouts/Base.astro';
import { getEntry, render } from 'astro:content';
import { useTranslations, type Locale } from '../../i18n/ui';
import { aboutPath } from '../../lib/paths';

interface Props {
  locale: Locale;
}

const { locale } = Astro.props;
const t = useTranslations(locale);

// About content is authored in /admin/about.html and stored in Postgres (the
// `pages` collection). Fall back to the i18n title if the entry/heading is
// missing so the build never breaks on an empty DB.
const entry = await getEntry('pages', `about/${locale}`);
const heading = entry?.data.title?.trim() || t('about.title');
const Content = entry ? (await render(entry)).Content : null;
const plain = (entry?.body ?? '').replace(/[#>*_`~\-\[\]!()]/g, ' ').replace(/\s+/g, ' ').trim();
const description = plain ? plain.slice(0, 150) : t('about.title');
---

<Base
  title={t('about.title')}
  description={description}
  locale={locale}
  alternates={{ de: aboutPath('de'), en: aboutPath('en') }}
>
  <section class="mx-auto max-w-3xl px-5 py-14">
    <h1 class="text-3xl font-extrabold text-navy">{heading}</h1>
    <div class="prose prose-lg mt-6">{Content ? <Content /> : null}</div>
  </section>
</Base>
```

- [ ] **Step 2: Verify types** — `cd site && DATABASE_URL=<reachable scratch DB with schema> npx astro check` → 0 errors. (Seed the scratch DB schema first via the Task 8 recipe. If no DB is reachable, defer this to the Task 8 sweep and note it.)

- [ ] **Step 3: Commit** — `git add site/src/components/pages/AboutPage.astro && git commit -m "feat(site): render About page from the pages collection"`

---

### Task 8: Verification sweep + end-to-end

- [ ] **Step 1: Uploader** — `cd uploader && npm test && npm run typecheck` → all green (integration suites skip without `TEST_DATABASE_URL`; run them against a scratch DB too).
- [ ] **Step 2: Scratch DB for the integration + astro-check** — `docker run --rm -d --name a8-pg -p 54341:5432 -e POSTGRES_PASSWORD=a8 -e POSTGRES_DB=a8 postgres:17-alpine`; wait; seed schema from `uploader/`:
  `DATABASE_URL=postgres://postgres:a8@127.0.0.1:54341/a8 node --import tsx -e "import('./src/db.js').then(async m=>{const p=m.createPool(process.env.DATABASE_URL);await m.ensureSchema(p);await p.end()})"`.
  Then: `cd uploader && TEST_DATABASE_URL=postgres://postgres:a8@127.0.0.1:54341/a8 npm test -- pages.integration backup.integration pg.integration` → PASS. And `cd site && DATABASE_URL=postgres://postgres:a8@127.0.0.1:54341/a8 npm test && DATABASE_URL=… npx astro check` → green / 0 errors.
- [ ] **Step 3: Full-stack e2e** — rebuild the app image and run the stack (`docker compose ... build app` via the scratch override used previously, then `docker compose up -d`); with an admin session (curl `/setup` then cookie):
  - `GET /pages/about` → seeded DE/EN content.
  - `PUT /pages/about` with new DE/EN `{title, bodyMarkdown}` → `{ saved, build: { ok:true, release } }`.
  - `curl -s http://localhost:3000/uber-mich/` and `/en/about-me/` → the served HTML shows the **new** heading + body (not the placeholder), proving the loader + rebuild + render path end-to-end.
  - Clean up test admin (`DELETE FROM sessions; DELETE FROM users;` in the db container) and `docker rm -f a8-pg` if used.
- [ ] **Step 4:** Commit any fixes as `fix(scope): …`; hand the branch to review (superpowers:requesting-code-review / finishing-a-development-branch).

---

## Plan Self-Review (done at authoring time)

- **Spec coverage:** `pages` table + seed (T1); PageStore (T2); routes + wiring + ADMIN_PREFIXES (T3); backup dump v2 + v1-compatible restore (T4); editor + nav (T5); loader + collection (T6); AboutPage render with DB title + i18n fallback + description excerpt (T7); tests + e2e (T8). Reuse of `renderMarkdown` + `transformBodyImages` → T6. Inline uploads via existing `/upload` keyed `pages/about/…` → T5.
- **Type consistency:** `PageContent`/`PagePair`/`PageStore`/`PageError`/`memoryPageStore`/`pgPageStore` (T2) consumed unchanged in T3; `rowToPageEntry` shape (T6) matches the AboutPage `getEntry('pages','about/<locale>')` usage (T7); `DUMP_VERSION=2` (T4) matches the updated version tests.
- **Judgment calls for the implementer:** (1) integration/astro-check steps need a reachable Postgres — use the throwaway-container recipe, never a real DB. (2) `render(entry)` returns `{ Content, headings }`; only `Content` is used. (3) If `astro check` can't reach a DB in your env, defer it to T8's scratch-DB step and say so.
