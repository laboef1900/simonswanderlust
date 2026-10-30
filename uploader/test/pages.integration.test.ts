import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgPageStore, type PagePair, type StoredPagePair } from '../src/pages.js';
import { REVISION_CAP } from '../src/posts.js';

const about = (title: string): PagePair => ({
  key: 'about',
  de: { locale: 'de', title, bodyMarkdown: 'DE ' + title, images: {} },
  en: { locale: 'en', title: 'EN', bodyMarkdown: 'EN body', images: {} },
});

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

  it('keys() lists every saved key exactly once', async () => {
    const store = pgPageStore(pool);
    // Save a second key to prove keys() is neither hardcoded nor duplicated
    // per locale row, then clean it up: backup.integration asserts exact
    // `pages` row counts against this shared database (integration files run
    // sequentially — fileParallelism: false in vitest.config.ts — so the
    // finally-cleanup is ordered before that suite reads the table).
    try {
      await store.save({
        key: 'imprint',
        de: { locale: 'de', title: 'Impressum', bodyMarkdown: 'x', images: {} },
        en: { locale: 'en', title: 'Imprint', bodyMarkdown: 'x', images: {} },
      });
      const keys = await store.keys();
      expect(keys).toContain('about');
      expect(keys.filter((k) => k === 'imprint')).toEqual(['imprint']);
    } finally {
      await pool.query(`DELETE FROM pages WHERE key = 'imprint'`);
    }
  });

  it('optimistic concurrency: a stale updatedAt echo is refused with code conflict and writes nothing (#141)', async () => {
    const store = pgPageStore(pool);
    const v1 = await store.save(about('occ-1'));
    expect(v1.updatedAt).toBeInstanceOf(Date);
    const v2 = await store.save(about('occ-2'), v1.updatedAt!);
    expect(v2.updatedAt!.getTime()).toBeGreaterThan(v1.updatedAt!.getTime());
    await expect(store.save(about('lost'), v1.updatedAt!)).rejects.toMatchObject({ code: 'conflict' });
    const stored = await store.get('about');
    expect(stored.de.title).toBe('occ-2');
    expect(stored.updatedAt).toEqual(v2.updatedAt);
  });

  it('every overwrite snapshots the previous pair into page_revisions, newest first, capped (#141)', async () => {
    const store = pgPageStore(pool);
    await pool.query(`DELETE FROM page_revisions WHERE key = 'about'`);
    const before = (await store.get('about')).de.title;
    for (let i = 1; i <= REVISION_CAP + 1; i++) await store.save(about(`rev-${i}`));
    const revs = await store.listRevisions('about');
    expect(revs).toHaveLength(REVISION_CAP);
    expect(revs[0]!.titleDe).toBe(`rev-${REVISION_CAP}`);
    // The oldest survivor is rev-1 (the pre-loop state was pruned).
    expect(revs.map((r) => r.titleDe)).not.toContain(before);
    expect(revs[REVISION_CAP - 1]!.titleDe).toBe('rev-1');
    const full = await store.getRevision('about', revs[0]!.id);
    expect(full!.snapshot.de.bodyMarkdown).toBe(`DE rev-${REVISION_CAP}`);
    expect(full!.snapshot.en.bodyMarkdown).toBe('EN body');
    // Malformed id → null (no 22P02), unknown uuid → null.
    expect(await store.getRevision('about', 'not-a-uuid')).toBeNull();
    expect(await store.getRevision('about', '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

type Outcome = { ok: true; value: StoredPagePair } | { ok: false; error: unknown };
function outcome(promise: Promise<StoredPagePair>): Promise<Outcome> {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

// #344: two saves of one page that overlap between the read and the commit.
// The interleaving is forced by real PostgreSQL locks and observed through
// pg_stat_activity — no sleeps standing in for ordering, no mocked queries.
maybe('pgPageStore serializes saves of one page (Postgres, #344)', () => {
  const schema = `page_concurrency_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `page-concurrency:${randomUUID()}`;
  let owner: DbPool;
  let pool: DbPool;
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, application_name: applicationName });
    await ensureSchema(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (owner) { await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); }
  });

  const page = (key: string, title: string): PagePair => ({
    key,
    de: { locale: 'de', title, bodyMarkdown: `DE ${title}`, images: {} },
    en: { locale: 'en', title: `EN ${title}`, bodyMarkdown: `EN ${title}`, images: {} },
  });
  const freshKey = () => `p-${randomUUID()}`;

  async function waiters(count: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await owner.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'`,
        [applicationName],
      );
      if (rows[0]?.count === count) return;
      if (Date.now() >= deadline) throw new Error(`expected ${count} lock waiter(s), saw ${rows[0]?.count}`);
      await delay(10);
    }
  }

  /**
   * The issue's reproduction: a SHARE lock on `pages` stops the first save at
   * its row write, the second is started only once the first is blocked, and
   * both are released together once the second is blocked too.
   */
  async function race(first: () => Promise<StoredPagePair>, second: () => Promise<StoredPagePair>): Promise<[Outcome, Outcome]> {
    const blocker = await owner.connect();
    const pending: Promise<Outcome>[] = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query(`LOCK TABLE ${schema}.pages IN SHARE MODE`);
      pending.push(outcome(first()));
      await waiters(1);
      pending.push(outcome(second()));
      await waiters(2);
      await blocker.query('COMMIT');
      return [await pending[0]!, await pending[1]!];
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.all(pending);
    }
  }

  /** Both locale rows carry exactly `expected`, at millisecond precision. */
  async function rowTokens(key: string, expected: Date): Promise<void> {
    const { rows } = await pool.query<{ locale: string; token: Date; ms: boolean }>(
      `SELECT locale, updated_at AS token, updated_at = date_trunc('milliseconds', updated_at) AS ms
         FROM pages WHERE key = $1 ORDER BY locale`, [key],
    );
    expect(rows.map((r) => [r.locale, r.token.toISOString(), r.ms]))
      .toEqual([['de', expected.toISOString(), true], ['en', expected.toISOString(), true]]);
  }

  it('existing page: of two saves from one updatedAt, one is accepted and the other conflicts without writing', async () => {
    const store = pgPageStore(pool);
    const key = freshKey();
    const base = await store.save(page(key, 'S0'));
    const [a, b] = await race(
      () => store.save(page(key, 'TAB-A'), base.updatedAt!),
      () => store.save(page(key, 'TAB-B'), base.updatedAt!),
    );
    expect(b).toMatchObject({ ok: false, error: { code: 'conflict' } });
    if (!a.ok) throw a.error;
    const stored = await store.get(key);
    expect(stored.de.title).toBe('TAB-A');
    // The response is this save's own state and token.
    expect(a.value).toEqual(stored);
    expect(a.value.updatedAt!.getTime()).toBeGreaterThan(base.updatedAt!.getTime());
    await rowTokens(key, a.value.updatedAt!);
    // The true predecessor, snapshotted once; the refused save left no trace.
    const revs = await store.listRevisions(key);
    expect(revs.map((r) => r.titleDe)).toEqual(['S0']);
    expect((await store.getRevision(key, revs[0]!.id))!.snapshot).toEqual({ de: base.de, en: base.en });
  }, 20_000);

  it('new page: of two creations from one supplied updatedAt, one is accepted and the other conflicts without writing', async () => {
    const store = pgPageStore(pool);
    const key = freshKey();
    // A key never saved has no token to hold; an echo is only checked
    // against a stored one, so the first creation passes it.
    const echo = new Date('2000-01-01T00:00:00.000Z');
    const [a, b] = await race(
      () => store.save(page(key, 'NEW-A'), echo),
      () => store.save(page(key, 'NEW-B'), echo),
    );
    expect(b).toMatchObject({ ok: false, error: { code: 'conflict' } });
    if (!a.ok) throw a.error;
    const stored = await store.get(key);
    expect(stored.de.title).toBe('NEW-A');
    expect(a.value).toEqual(stored);
    await rowTokens(key, a.value.updatedAt!);
    expect(await store.listRevisions(key)).toEqual([]);
  }, 20_000);

  it('new page: token-less creations stay last-writer-wins, but run in turn — the first is a revision and each gets its own token', async () => {
    const store = pgPageStore(pool);
    const key = freshKey();
    const [a, b] = await race(
      () => store.save(page(key, 'FIRST')),
      () => store.save(page(key, 'SECOND')),
    );
    if (!a.ok) throw a.error;
    if (!b.ok) throw b.error;
    expect(a.value.de.title).toBe('FIRST');
    expect(b.value.de.title).toBe('SECOND');
    expect(b.value.updatedAt!.getTime()).toBeGreaterThan(a.value.updatedAt!.getTime());
    expect(await store.get(key)).toEqual(b.value);
    await rowTokens(key, b.value.updatedAt!);
    const revs = await store.listRevisions(key);
    expect(revs.map((r) => r.titleDe)).toEqual(['FIRST']);
    expect((await store.getRevision(key, revs[0]!.id))!.snapshot).toEqual({ de: a.value.de, en: a.value.en });
  }, 20_000);

  it('every accepted save strictly advances the token, even when the wall clock is behind the stored one', async () => {
    const store = pgPageStore(pool);
    const key = freshKey();
    await store.save(page(key, 'S0'));
    await pool.query(
      `UPDATE pages SET updated_at = CASE locale WHEN 'de' THEN '2099-01-01T00:00:00.100Z'::timestamptz
                                                 ELSE '2099-01-01T00:00:00.200Z'::timestamptz END
        WHERE key = $1`, [key],
    );
    let token = new Date('2099-01-01T00:00:00.200Z');
    for (const title of ['S1', 'S2']) {
      const saved = await store.save(page(key, title), token);
      expect(saved.updatedAt!.getTime()).toBe(token.getTime() + 1);
      await rowTokens(key, saved.updatedAt!);
      token = saved.updatedAt!;
    }
    // The token a tab held two saves ago is stale now.
    await expect(store.save(page(key, 'stale'), new Date('2099-01-01T00:00:00.201Z'))).rejects.toMatchObject({ code: 'conflict' });
    expect((await store.listRevisions(key)).map((r) => r.titleDe)).toEqual(['S1', 'S0']);
  });
});
