import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { createImportRunner, pgImportJobStore, IMPORT_JOB_HISTORY, type ImportJob } from '../src/import-jobs.js';
import { prepareImport, type ImportSummary } from '../src/wp-import.js';
import { memoryPostStore } from '../src/posts.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const OK: ImportSummary = { imported: 2, updated: 1, skippedPublished: 0, rejected: 0, failed: 0, images: { total: 5, hosted: 4, failed: 1 }, warnings: ['image x: blocked address'] };
const job = (id: string, status: ImportJob['status'], startedAt: string): ImportJob => ({
  id, status, startedBy: 'simon', startedAt, updatedAt: startedAt, finishedAt: null,
  progress: { groups: { total: 3, done: 1 }, images: { planned: 5, hosted: 2, failed: 0 } }, summary: null, error: null,
});

/**
 * Issue #92: the `import_jobs` table — what makes GET /import/status honest
 * across a restart.
 */
maybe('pgImportJobStore (integration)', () => {
  let pool: DbPool;
  beforeAll(async () => {
    pool = createPool(url!);
    await ensureSchema(pool);
    await pool.query('DELETE FROM import_jobs');
  });
  afterAll(async () => { await pool.end(); });

  it('round-trips a job through insert, progress update and completion', async () => {
    const store = pgImportJobStore(pool);
    const id = '11111111-1111-4111-8111-111111111111';
    await store.insert(job(id, 'running', '2026-09-05T10:00:00.000Z'));
    expect(await store.latest()).toMatchObject({ id, status: 'running', startedBy: 'simon', progress: { groups: { total: 3, done: 1 } }, summary: null, finishedAt: null });
    await store.update(id, { progress: { groups: { total: 3, done: 2 }, images: { planned: 5, hosted: 4, failed: 1 } } });
    expect((await store.latest())?.progress.images).toEqual({ planned: 5, hosted: 4, failed: 1 });
    await store.update(id, { status: 'done', summary: OK, finishedAt: '2026-09-05T10:05:00.000Z' });
    const done = await store.latest();
    expect(done).toMatchObject({ id, status: 'done', summary: OK, finishedAt: '2026-09-05T10:05:00.000Z' });
    expect(done!.updatedAt >= done!.startedAt).toBe(true);
  });

  it('persists a real untranslated-only import summary with zero planned work across runner recreation', async () => {
    const posts = memoryPostStore();
    const prepared = await prepareImport(`<rss><channel><item>
      <wp:post_type>post</wp:post_type><wp:status>publish</wp:status>
      <wp:post_name>nur-deutsch</wp:post_name>
      <category domain="language" nicename="de"/>
      <content:encoded><![CDATA[<img src="https://wp.example/no-fetch.jpg">]]></content:encoded>
    </item></channel></rss>`, {
      postStore: posts, storageDir: '/unused', baseUrl: 'https://img.example',
      rehost: async () => { throw new Error('untranslated images must not be fetched'); },
      log: () => {},
    });
    expect(prepared.groups).toBe(1);
    const store = pgImportJobStore(pool);
    const runner = createImportRunner({ store, log: () => {} });
    const started = await runner.start({ startedBy: 'simon', planned: prepared.planned, run: prepared.run });
    await runner.settle();
    const restarted = createImportRunner({ store: pgImportJobStore(pool), log: () => {} });
    expect(await restarted.recover()).toBe(0);
    const persisted = await restarted.latest();
    expect(persisted).toMatchObject({
      id: started.id, status: 'done',
      progress: { groups: { total: 0, done: 0 }, images: { planned: 0, hosted: 0, failed: 0 } },
      summary: {
        imported: 0, updated: 0, skippedPublished: 0, rejected: 1, failed: 0,
        images: { total: 0, hosted: 0, failed: 0 },
        warnings: ['nur-deutsch (de): no translation (untranslated post) — rejected'],
      },
    });
    expect(persisted?.finishedAt).toBeTruthy();
    expect(await posts.list()).toEqual([]);
  });

  it('latest() is the most recently STARTED job, not the most recently written', async () => {
    const store = pgImportJobStore(pool);
    await pool.query('DELETE FROM import_jobs');
    await store.insert(job('22222222-2222-4222-8222-222222222222', 'done', '2026-09-05T11:00:00.000Z'));
    await store.insert(job('33333333-3333-4333-8333-333333333333', 'done', '2026-09-05T09:00:00.000Z'));
    await store.update('33333333-3333-4333-8333-333333333333', { error: 'x' });
    expect((await store.latest())?.id).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('boot recovery marks rows left running as interrupted, keeping their last progress', async () => {
    const store = pgImportJobStore(pool);
    await pool.query('DELETE FROM import_jobs');
    await store.insert(job('44444444-4444-4444-8444-444444444444', 'running', '2026-09-05T12:00:00.000Z'));
    await store.insert(job('55555555-5555-4555-8555-555555555555', 'done', '2026-09-05T11:00:00.000Z'));
    const runner = createImportRunner({ store, log: () => {} });
    expect(await runner.recover()).toBe(1);
    const latest = await store.latest();
    expect(latest).toMatchObject({ id: '44444444-4444-4444-8444-444444444444', status: 'interrupted', progress: { groups: { done: 1 } } });
    expect(latest?.finishedAt).toBeTruthy();
    const { rows } = await pool.query(`SELECT status FROM import_jobs WHERE id = '55555555-5555-4555-8555-555555555555'`);
    expect(rows[0]?.status).toBe('done');
    expect(await runner.recover()).toBe(0);
  });

  it('prunes history to the newest IMPORT_JOB_HISTORY rows on insert', async () => {
    const store = pgImportJobStore(pool);
    await pool.query('DELETE FROM import_jobs');
    for (let i = 0; i < IMPORT_JOB_HISTORY + 3; i++) {
      const id = `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`;
      await store.insert(job(id, 'done', `2026-09-05T13:${String(i).padStart(2, '0')}:00.000Z`));
    }
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM import_jobs');
    expect(rows[0]?.n).toBe(IMPORT_JOB_HISTORY);
    expect((await store.latest())?.id).toBe(`66666666-6666-4666-8666-${String(IMPORT_JOB_HISTORY + 2).padStart(12, '0')}`);
  });

  it('rejects a status outside the enum at the schema level', async () => {
    await expect(pool.query(
      `INSERT INTO import_jobs (id, status, started_by, progress) VALUES ('77777777-7777-4777-8777-777777777777', 'bogus', 'x', '{}')`,
    )).rejects.toThrow(/check constraint/i);
  });
});
