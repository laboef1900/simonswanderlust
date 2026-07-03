process.env.TZ = 'Europe/Berlin';

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgUserStore } from '../src/users.js';
import { pgPostStore } from '../src/posts.js';
import { pgSessionStore } from '../src/sessions.js';
import { dumpDatabase, restoreDatabase } from '../src/backup.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('backup round-trip (Postgres)', () => {
  let pool: DbPool;
  let dir: string;
  beforeAll(async () => {
    pool = createPool(url as string);
    await ensureSchema(pool);
    await pool.query('DELETE FROM posts');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM users');
    dir = await mkdtemp(join(tmpdir(), 'bk-int-'));
  });
  afterAll(async () => { await pool.end(); });

  it('dump -> wipe -> restore reproduces users and posts and kills sessions', async () => {
    const users = pgUserStore(pool);
    const posts = pgPostStore(pool);
    const sessions = pgSessionStore(pool);
    const u = await users.create({ username: 'simon', password: 'pw', isAdmin: true });
    await sessions.create(u.id, 60_000);
    // Minimal valid draft pair — same fixture shape as the `base` fixture in
    // pg.integration.test.ts (PostPair requires both locales).
    const base = {
      translationKey: '', status: 'draft' as const,
      shared: { date: '2026-01-01', country: 'Rumänien', countryCode: 'RO', region: 'europe', coordinates: { lat: 45, lng: 25 } },
      de: { locale: 'de' as const, slug: 'test-reise', title: 'Test', excerpt: 'x', heroImage: { src: 'https://img.example/x', width: 100, height: 50, alt: 'a' }, bodyMarkdown: 'Hallo', images: {} },
      en: { locale: 'en' as const, slug: 'test-trip', title: 'Test', excerpt: 'x', heroImage: { src: 'https://img.example/x', width: 100, height: 50, alt: 'a' }, bodyMarkdown: 'Hello', images: {} },
    };
    await posts.upsertDraft(base);

    const file = join(dir, await dumpDatabase(pool, dir));
    await pool.query('DELETE FROM posts');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM users');

    const counts = await restoreDatabase(pool, file);
    expect(counts.users).toBe(1);
    expect(counts.posts).toBe(2); // one row per locale (de + en) for the single translation pair
    const back = await users.findByUsername('simon');
    expect(back?.isAdmin).toBe(true);
    expect((await pool.query('SELECT count(*) AS n FROM sessions')).rows[0].n).toBe('0');
    const list = await posts.list();
    expect(list.length).toBe(1);

    // Date fidelity: with TZ=Europe/Berlin, a naive `SELECT *` would parse the
    // `date` column as local midnight and JSON.stringify would shift it a day
    // west in UTC, so the restored row would carry the wrong calendar date.
    const dateText = (await pool.query("SELECT to_char(date,'YYYY-MM-DD') AS d FROM posts LIMIT 1")).rows[0].d;
    expect(dateText).toBe(base.shared.date);
  });

  it('rejects an unsupported dump version without touching data', async () => {
    // hand-craft a version-2 dump
    const { gzipSync } = await import('node:zlib');
    const { writeFileSync } = await import('node:fs');
    const bad = join(dir, 'db-20260101-000000.json.gz');
    writeFileSync(bad, gzipSync(JSON.stringify({ version: 2, tables: { users: [], posts: [] } })));
    await expect(restoreDatabase(pool, bad)).rejects.toThrow(/unsupported dump version/);
    expect((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n).toBe('1');
  });
});
