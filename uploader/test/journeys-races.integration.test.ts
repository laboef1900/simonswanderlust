import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { pgPostStore, type PostPair } from '../src/posts.js';
import { pgLanguageStore } from '../src/language.js';
import { memoryMediaStore } from '../src/media-store.js';
import { pgJourneyStore, type JourneyDraft, type StoredJourney } from '../src/journeys.js';

const url = process.env.TEST_DATABASE_URL;
const base = 'https://images.test';
function draft(members: string[]): JourneyDraft {
  const id = randomUUID(); const locale = (suffix: string) => ({ slug: `trip-${suffix}-${id}`, title: 'Journey', intro: 'Introduction', omitted: false, heroImage: { src: `${base}/photo`, width: 800, height: 600, alt: 'Photo' } });
  return { de: locale('de'), en: locale('en'), members };
}
function input(row: StoredJourney): JourneyDraft {
  const { publishedAt: _de, ...de } = row.de; const { publishedAt: _en, ...en } = row.en; return { de, en, members: row.members };
}
/** Pauses a real checked-out transaction, after its lock was acquired. No query result is fabricated. */
function barrier(pool: DbPool, match: (sql: string) => boolean, fail?: (sql: string) => boolean) {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); const statements: { sql: string; values: unknown }[] = []; let paused = false;
  const observed = new Proxy(pool, { get(target, property) {
    if (property === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, member) {
        if (member === 'query') return async (...args: unknown[]) => {
          const sql = typeof args[0] === 'string' ? args[0] : ''; statements.push({ sql, values: args[1] });
          if (fail?.(sql)) throw new Error('injected transaction failure');
          const result: unknown = await Reflect.apply(connection.query, connection, args);
          if (!paused && match(sql)) { paused = true; entered.resolve(); await release.promise; }
          return result;
        };
        const value: unknown = Reflect.get(connection, member); return typeof value === 'function' ? value.bind(connection) : value;
      } });
    };
    const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { pool: observed, entered: entered.promise, release: () => release.resolve(), statements };
}

(url ? describe : describe.skip)('journey language-first PostgreSQL races', () => {
  let owner: DbPool; let pool: DbPool; let schema: string;
  const media = memoryMediaStore({ baseUrl: base });
  beforeEach(async () => {
    owner = new pg.Pool({ connectionString: url }); schema = `journey_race_${randomUUID().replaceAll('-', '')}`;
    await owner.query(`CREATE SCHEMA ${schema}`); pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` }); await ensureSchema(pool);
    await media.upsert({ key: 'photo', width: 800, height: 600, origBytes: 1, status: 'ready', exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
  });
  afterEach(async () => { await pool?.end(); if (schema) await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner?.end(); });
  async function story(): Promise<string> {
    const id = randomUUID(); const locale = (locale: 'de' | 'en') => ({ locale, slug: `story-${locale}-${id}`, title: 'Story', country: 'Test', excerpt: 'Excerpt', bodyMarkdown: 'Body', images: {}, heroImage: { src: `${base}/photo`, width: 800, height: 600, alt: 'Photo' } });
    const pair: PostPair = { translationKey: '', status: 'draft', shared: { date: '2026-10-28', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') };
    return (await pgPostStore(pool).upsertDraft(pair)).translationKey;
  }
  const languageLock = (sql: string) => sql.includes('FROM site_language') && sql.includes('FOR UPDATE');

  it.each(['delete', 'save'] as const)('serializes story deletion versus save when %s wins', async (winner) => {
    const tk = await story(); const journeys = pgJourneyStore(pool, media, base); const original = await journeys.create(draft([]));
    const held = barrier(pool, languageLock);
    const savingStore = pgJourneyStore(winner === 'save' ? held.pool : pool, media, base);
    const deletingStore = pgPostStore(winner === 'delete' ? held.pool : pool);
    const save = () => savingStore.save(original.id, { ...input(original), members: [tk] }, original.updatedAt);
    const remove = () => deletingStore.remove(tk);
    const first = winner === 'save' ? save() : remove(); await held.entered;
    const second = (winner === 'save' ? remove() : save()).catch((error: unknown) => error);
    held.release(); await first; const result = await second;
    if (winner === 'delete') expect(result).toMatchObject({ code: 'unknown_member' });
    const current = (await journeys.get(original.id))!; expect(current.members).toEqual([]);
    if (winner === 'save') { expect(current.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime()); await expect(save()).rejects.toMatchObject({ code: 'conflict' }); }
  });

  it.each(['primary', 'disable', 'enable'] as const)('publication validates one mode before racing %s', async (change) => {
    const language = pgLanguageStore(pool); if (change === 'enable') await language.update({ primary: 'de', locales: ['de'] });
    const value = draft([await story()]); if (change === 'enable') value.en.omitted = true;
    const journeys = pgJourneyStore(pool, media, base); const row = await journeys.create(value);
    const held = barrier(pool, languageLock); const publishing = pgJourneyStore(held.pool, media, base).publish(row.id, row.updatedAt); await held.entered;
    const changing = language.update(change === 'primary' ? { primary: 'en', locales: ['en', 'de'] } : { primary: 'de', locales: change === 'disable' ? ['de'] : ['de', 'en'] }).catch((error: unknown) => error);
    held.release(); const published = await publishing; const changed = await changing;
    if (change === 'enable') { expect(changed).toMatchObject({ locales: ['de', 'en'] }); expect(published.publishedSnapshot?.locales.en).toBeUndefined(); }
    else expect(changed).toMatchObject({ code: change === 'primary' ? 'language_primary_locked' : 'language_locale_published' });
    expect((await language.get()).lockedAt).toBeInstanceOf(Date);
  });

  it('rechecks exact journey token after a mode change modifies coverage', async () => {
    const journeys = pgJourneyStore(pool, media, base); const row = await journeys.create(draft([await story()]));
    const held = barrier(pool, languageLock); const changing = pgLanguageStore(held.pool).update({ primary: 'de', locales: ['de'] }); await held.entered;
    const saving = journeys.save(row.id, input(row), row.updatedAt).catch((error: unknown) => error);
    held.release(); await changing; expect(await saving).toMatchObject({ code: 'conflict' });
    expect((await journeys.get(row.id))?.en.omitted).toBe(true);
  });

  it('admits exactly one competing claimant and locks sorted pair union before journey', async () => {
    const members = [await story(), await story(), await story()]; const journeys = pgJourneyStore(pool, media, base);
    const a = await journeys.create(draft([])); const b = await journeys.create(draft([]));
    const held = barrier(pool, languageLock);
    const winning = pgJourneyStore(held.pool, media, base).save(a.id, { ...input(a), members: [...members].reverse() }, a.updatedAt); await held.entered;
    const losing = journeys.save(b.id, { ...input(b), members: [members[0]!] }, b.updatedAt).catch((error: unknown) => error);
    held.release(); await winning; expect(await losing).toMatchObject({ code: 'story_in_other_journey', owner: { id: a.id } });
    const locks = held.statements.filter(({ sql }) => sql.includes('pg_advisory_xact_lock'));
    expect(locks.slice(0, 3).map(({ values }) => (values as string[])[0])).toEqual([...members].sort());
    expect(locks[3]?.sql).toContain("'journey:'"); expect(held.statements.findIndex(({ sql }) => languageLock(sql))).toBeLessThan(held.statements.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock')));
  });

  it('rolls back every repaired reference and token on later story-delete failure', async () => {
    const tk = await story(); const journeys = pgJourneyStore(pool, media, base); let a = await journeys.create(draft([tk]));
    a = await journeys.publish(a.id, a.updatedAt); a = await journeys.unpublish(a.id); a = await journeys.save(a.id, { ...input(a), members: [] }, a.updatedAt);
    const b = await journeys.create(draft([tk]));
    const failing = barrier(pool, () => false, (sql) => sql.startsWith('DELETE FROM posts'));
    await expect(pgPostStore(failing.pool).remove(tk)).rejects.toThrow('injected transaction failure');
    expect(await journeys.get(a.id)).toEqual(a); expect(await journeys.get(b.id)).toEqual(b); expect(await pgPostStore(pool).get(tk)).not.toBeNull();
  });
});

(url ? describe : describe.skip)('journey ownership fencing inside publication', () => {
  it('rolls back snapshot, history and language latch when ownership is lost after validation', async () => {
    const owner = new pg.Pool({ connectionString: url });
    const schema = `journey_owner_${randomUUID().replaceAll('-', '')}`;
    await owner.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    try {
      await ensureSchema(pool);
      const posts = pgPostStore(pool);
      const id = randomUUID();
      const locale = (locale: 'de' | 'en') => ({ locale, slug: `story-${locale}-${id}`, title: 'Story', country: 'Test', excerpt: 'Excerpt', bodyMarkdown: 'Body', images: {}, heroImage: { src: `${base}/photo`, width: 800, height: 600, alt: 'Photo' } });
      const story = await posts.upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-10-28', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') });
      const media = memoryMediaStore({ baseUrl: base });
      await media.upsert({ key: 'photo', width: 800, height: 600, origBytes: 1, status: 'ready', exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
      const journeys = pgJourneyStore(pool, media, base);
      const row = await journeys.create(draft([story.translationKey]));
      const held = barrier(pool, (sql) => sql.startsWith('UPDATE site_language SET locked_at'));
      let writable = true;
      const result = pgJourneyStore(held.pool, media, base, { isWritable: () => writable }).publish(row.id, row.updatedAt).catch((error: unknown) => error);
      await held.entered; writable = false; held.release();
      expect(await result).toMatchObject({ code: 'storage_read_only', statusCode: 503 });
      expect(await journeys.get(row.id)).toEqual(row);
      expect((await pgLanguageStore(pool).get()).lockedAt).toBeNull();
    } finally {
      await pool.end(); await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end();
    }
  });
});
