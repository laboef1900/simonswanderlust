import { publishTokens } from './publish-tokens.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { pgPostStore, type PostLocale, type StoredPostPair } from '../src/posts.js';
import { lockPostPair } from '../src/post-pair-lock.js';
import { createGpxFiles } from '../src/gpx-files.js';
import { createGpxService, type GpxService, type RouteMutation } from '../src/gpx-service.js';
import { createGpxWorker } from '../src/gpx-worker.js';
import { pgGpxStore } from '../src/gpx-store.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const xml = Buffer.from('<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><trkseg><trkpt lat="12.345678" lon="23.456789"><ele>17</ele><time>2026-01-01T00:00:00Z</time></trkpt><trkpt lat="12.346678" lon="23.457789"/></trkseg></trk></gpx>');
const selection = { startPoints: 0, endPoints: 0, removedSegments: [] };

// Observe actual PostgreSQL lock waiters, not arbitrary sleeps or mocked queries.
async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Expected pair-lock waiter did not arrive');
    await delay(10);
  }
}
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
function outcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
}

maybe('GPX and text saves share PostgreSQL pair isolation', () => {
  const schema = `gpx_concurrency_${randomUUID().replaceAll('-', '')}`;
  const applicationName = `gpx-concurrency:${randomUUID()}`;
  let owner: DbPool;
  let pool: DbPool;
  const fixtures: { root: string; service: GpxService }[] = [];

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, application_name: applicationName });
    await ensureSchema(pool);
  });
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await fixture.service.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
  afterAll(async () => {
    await pool?.end();
    if (owner) { await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); }
  });

  async function fixture() {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'gpx-concurrency-'));
    const files = createGpxFiles({ storageDir: join(root, 'images') });
    const service = createGpxService({ pool, files, worker: createGpxWorker(), backupDir: join(root, 'backup'), readManifestPins: async () => new Set<string>() });
    fixtures.push({ root, service });
    const posts = pgPostStore(pool, { routeFiles: files });
    const slug = randomUUID();
    const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: `${locale}-${slug}`, title: 'Before save', country: 'Test', excerpt: '', heroImage: { src: '', width: 1, height: 1, alt: '' }, bodyMarkdown: 'Original text', images: {} });
    const pair = await posts.upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') });
    const preview = await service.importBytes('synthetic-author', xml);
    const attach = (token: string, version: string | null = null) => service.attach('synthetic-author', pair.translationKey, { importId: preview.importId, baseVersion: version, baseUpdatedAt: token, selection, confirmReplace: version !== null });
    return { files, service, posts, pair, attach };
  }

  async function waiters(count: number) {
    await until(async () => {
      const result = await owner.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock' AND wait_event='advisory'`, [applicationName]);
      return result.rows[0]?.count === count;
    });
  }

  async function pairToken(tk: string, expected: string) {
    const rows = await pool.query<{ locale: string; token: Date; millisecond: boolean }>(`SELECT locale, updated_at AS token, updated_at=date_trunc('milliseconds', updated_at) AS millisecond FROM posts WHERE translation_key=$1 ORDER BY locale`, [tk]);
    expect(rows.rows.map(row => [row.locale, row.token.toISOString(), row.millisecond])).toEqual([['de', expected, true], ['en', expected, true]]);
  }

  it.each([
    ['attach', 'route'], ['attach', 'save'], ['detach', 'route'], ['detach', 'save'],
  ] as const)('%s versus text save: %s wins, the queued stale writer cannot overwrite it', async (operation, first) => {
    const f = await fixture();
    const tk = f.pair.translationKey;
    const attached = operation === 'detach' ? await f.attach(f.pair.updatedAt.toISOString()) : null;
    const current = (await f.posts.get(tk))!;
    const edited = { ...current, de: { ...current.de, title: 'Concurrent text edit' } };
    const route = () => operation === 'attach' ? f.attach(current.updatedAt.toISOString()) : f.service.detach(tk, { baseVersion: attached!.version, baseUpdatedAt: current.updatedAt.toISOString() });
    const save = () => f.posts.upsertDraft(edited, current.updatedAt);
    const blocker = await pool.connect();
    const pending: Promise<unknown>[] = [];
    let routeResult: Promise<Outcome<RouteMutation>> | undefined;
    let saveResult: Promise<Outcome<StoredPostPair>> | undefined;
    try {
      await blocker.query('BEGIN'); await lockPostPair(blocker, tk);
      if (first === 'route') { routeResult = outcome(route()); pending.push(routeResult); }
      else { saveResult = outcome(save()); pending.push(saveResult); }
      await waiters(1);
      if (first === 'route') { saveResult = outcome(save()); pending.push(saveResult); }
      else { routeResult = outcome(route()); pending.push(routeResult); }
      await waiters(2);
      await blocker.query('COMMIT');
      const routeOutcome = await routeResult!;
      const saveOutcome = await saveResult!;
      expect(routeOutcome.ok).toBe(first === 'route');
      expect(saveOutcome.ok).toBe(first === 'save');
      if (!routeOutcome.ok) expect(routeOutcome.error).toMatchObject({ code: 'gpx_conflict' });
      if (!saveOutcome.ok) expect(saveOutcome.error).toMatchObject({ code: 'conflict' });
      const stored = (await f.posts.get(tk))!;
      expect(stored.de.title).toBe(first === 'save' ? 'Concurrent text edit' : 'Before save');
      expect(stored.updatedAt.getTime()).toBeGreaterThan(current.updatedAt.getTime());
      await pairToken(tk, stored.updatedAt.toISOString());
      const state = await f.service.get(tk);
      expect(state.geometry !== null).toBe(operation === 'attach' ? first === 'route' : first === 'save');
      expect(await f.posts.listRevisions(tk)).toHaveLength(first === 'save' ? 1 : 0);
      // The loser can explicitly reconcile and retry; conflict did not consume staging.
      if (first === 'save') {
        const retried = operation === 'attach' ? await f.attach(stored.updatedAt.toISOString()) : await f.service.detach(tk, { baseVersion: attached!.version, baseUpdatedAt: stored.updatedAt.toISOString() });
        expect(retried.geometry !== null).toBe(operation === 'attach');
        await pairToken(tk, retried.updatedAt);
      }
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      await Promise.all(pending);
    }
  }, 20_000);

  it('increments millisecond tokens above the later locale even when wall clock is behind', async () => {
    const f = await fixture(); const tk = f.pair.translationKey;
    await pool.query(`UPDATE posts SET updated_at=CASE locale WHEN 'de' THEN '2099-01-01T00:00:00.100Z'::timestamptz ELSE '2099-01-01T00:00:00.200Z'::timestamptz END WHERE translation_key=$1`, [tk]);
    let previous = Date.parse('2099-01-01T00:00:00.200Z');
    const assertNext = async () => {
      const stored = (await f.posts.get(tk))!;
      expect(stored.updatedAt.getTime()).toBe(previous + 1);
      previous = stored.updatedAt.getTime();
      await pairToken(tk, stored.updatedAt.toISOString());
      return stored;
    };
    const attached = await f.attach(new Date(previous).toISOString()); await assertNext();
    await f.service.detach(tk, { baseVersion: attached.version, baseUpdatedAt: attached.updatedAt });
    let current = await assertNext();
    current = await f.posts.upsertDraft({ ...current, en: { ...current.en, title: 'English edit' } }, current.updatedAt);
    await assertNext();
    await f.posts.publish(tk, await publishTokens(f.posts, tk)); await assertNext();
    await f.posts.unpublish(tk); await assertNext();
  });

  it('does not resurrect a pair when deletion commits ahead of a queued stale save', async () => {
    const f = await fixture(); const tk = f.pair.translationKey;
    await f.attach(f.pair.updatedAt.toISOString());
    const current = (await f.posts.get(tk))!;
    const blocker = await pool.connect(); const pending: Promise<unknown>[] = [];
    try {
      await blocker.query('BEGIN'); await lockPostPair(blocker, tk);
      const deleted = outcome(f.posts.remove(tk)); pending.push(deleted); await waiters(1);
      const saved = outcome(f.posts.upsertDraft(current, current.updatedAt)); pending.push(saved); await waiters(2);
      await blocker.query('COMMIT');
      expect((await deleted).ok).toBe(true);
      expect(await saved).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(await f.posts.get(tk)).toBeNull();
      expect((await pool.query('SELECT 1 FROM posts WHERE translation_key=$1', [tk])).rowCount).toBe(0);
      expect((await pool.query('SELECT 1 FROM post_routes WHERE translation_key=$1', [tk])).rowCount).toBe(0);
      expect(await f.posts.listRevisions(tk)).toEqual([]);
      await expect(f.service.get(tk)).rejects.toMatchObject({ code: 'gpx_post_not_found' });
    } finally {
      await blocker.query('ROLLBACK'); blocker.release(); await Promise.all(pending);
    }
  }, 20_000);

  it('text revisions and revision restoration never copy or roll back the private route', async () => {
    const f = await fixture(); const tk = f.pair.translationKey;
    await f.attach(f.pair.updatedAt.toISOString());
    const current = (await f.posts.get(tk))!;
    const route = await pgGpxStore(pool).get(tk);
    const saved = await f.posts.upsertDraft({ ...current, de: { ...current.de, title: 'New title' } }, current.updatedAt);
    const [summary] = await f.posts.listRevisions(tk);
    const revision = (await f.posts.getRevision(tk, summary!.id))!;
    const expected = { status: current.status, shared: current.shared, de: current.de, en: current.en };
    expect(revision.snapshot).toEqual(expected);
    expect((await pool.query<{ snapshot: unknown }>('SELECT snapshot FROM post_revisions WHERE translation_key=$1', [tk])).rows).toEqual([{ snapshot: expected }]);
    await f.service.detach(tk, { baseVersion: route!.version, baseUpdatedAt: saved.updatedAt.toISOString() });
    const detached = await pgGpxStore(pool).get(tk);
    const beforeRestore = (await f.posts.get(tk))!;
    const restored = await f.posts.upsertDraft({ translationKey: tk, ...revision.snapshot }, beforeRestore.updatedAt);
    expect(restored.de.title).toBe('Before save');
    expect(await pgGpxStore(pool).get(tk)).toEqual(detached);
    expect(await f.service.original(tk)).toEqual(xml);
    for (const row of (await pool.query<{ snapshot: Record<string, unknown> }>('SELECT snapshot FROM post_revisions WHERE translation_key=$1', [tk])).rows) {
      expect(Object.keys(row.snapshot).sort()).toEqual(['de', 'en', 'shared', 'status']);
      const serialized = JSON.stringify(row.snapshot);
      expect(serialized).not.toContain('12.345678');
      expect(serialized).not.toContain(route!.source.sourceId);
      expect(serialized).not.toContain(route!.source.sha256);
    }
  });
});
