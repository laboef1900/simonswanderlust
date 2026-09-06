process.env.TZ = 'Europe/Berlin';

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgUserStore } from '../src/users.js';
import { pgPostStore } from '../src/posts.js';
import { pgSessionStore } from '../src/sessions.js';
import { dumpDatabase, readDump, restoreDatabase, BACKUP_FILE_RE } from '../src/backup.js';
import { pgMediaStore } from '../src/media-store.js';
import { runCli } from './run-cli.js';

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
    const u = await users.create({ username: 'simon', password: 'password123456', isAdmin: true });
    await sessions.create(u.id, 60_000);
    // Minimal valid draft pair — same fixture shape as the `base` fixture in
    // pg.integration.test.ts (PostPair requires both locales).
    const base = {
      translationKey: '', status: 'draft' as const,
      shared: {
        date: '2026-01-01', countryCode: 'RO', region: 'europe', coordinates: { lat: 45, lng: 25 },
        categories: ['reise'], tags: ['griechenland', 'sommer'], scheduledAt: '2026-10-01T08:00:00.000Z',
      },
      de: { locale: 'de' as const, slug: 'test-reise', title: 'Test', excerpt: 'x', country: 'Rumänien', heroImage: { src: 'https://img.example/x', width: 100, height: 50, alt: 'a' }, bodyMarkdown: 'Hallo', images: {} },
      en: { locale: 'en' as const, slug: 'test-trip', title: 'Test', excerpt: 'x', country: 'Romania', heroImage: { src: 'https://img.example/x', width: 100, height: 50, alt: 'a' }, bodyMarkdown: 'Hello', images: {} },
    };
    const createdPair = await posts.upsertDraft(base);
    // Publish, then save a draft edit: the dump must carry BOTH the working
    // copy and the published snapshot (issue #20), or a restore would lose the
    // published/working separation. (Built from `base`, not the round-tripped
    // pair: with TZ=Europe/Berlin, rowShared's Date→string conversion shifts
    // the calendar date west, and re-saving it would poison the date column —
    // a pre-existing quirk this test deliberately keeps out of its scope.)
    await posts.publish(createdPair.translationKey);
    await posts.upsertDraft({ ...base, translationKey: createdPair.translationKey, de: { ...base.de, bodyMarkdown: 'Hallo v2' } });
    await pool.query(`INSERT INTO pages (key,locale,title,body_markdown) VALUES ('about','de','T','Body')
      ON CONFLICT (key,locale) DO UPDATE SET title=EXCLUDED.title, body_markdown=EXCLUDED.body_markdown`);

    const file = join(dir, await dumpDatabase(pool, dir));
    await pool.query('DELETE FROM posts');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM pages');
    // Prove the pages are actually gone before restore, so the post-restore
    // assertion below can only pass if restoreDatabase truly re-inserts them.
    expect((await pool.query(`SELECT count(*) AS n FROM pages`)).rows[0].n).toBe('0');

    const counts = await restoreDatabase(pool, file);
    expect(counts.users).toBe(1);
    expect(counts.posts).toBe(2); // one row per locale (de + en) for the single translation pair
    // ensureSchema seeds About for both locales; we overwrote about/de to 'T' and
    // left the seeded about/en, so the dump carried — and restore re-inserts — 2 pages.
    expect(counts.pages).toBe(2);
    const back = await users.findByUsername('simon');
    expect(back?.isAdmin).toBe(true);
    expect((await pool.query('SELECT count(*) AS n FROM sessions')).rows[0].n).toBe('0');
    const list = await posts.list();
    expect(list.length).toBe(1);
    const pg = (await pool.query(`SELECT title, body_markdown FROM pages WHERE key='about' AND locale='de'`)).rows[0];
    expect(pg.title).toBe('T');

    // Date fidelity: with TZ=Europe/Berlin, a naive `SELECT *` would parse the
    // `date` column as local midnight and JSON.stringify would shift it a day
    // west in UTC, so the restored row would carry the wrong calendar date.
    const dateText = (await pool.query("SELECT to_char(date,'YYYY-MM-DD') AS d FROM posts LIMIT 1")).rows[0].d;
    expect(dateText).toBe(base.shared.date);

    // Published-snapshot fidelity: the restored row keeps the draft edit as the
    // working copy AND the pre-edit content as the live snapshot.
    const de = (await pool.query(
      `SELECT body_markdown AS work, published_snapshot->>'body_markdown' AS live, published_at AS p
         FROM posts WHERE locale='de'`,
    )).rows[0] as { work: string; live: string; p: Date };
    expect(de.work).toBe('Hallo v2');
    expect(de.live).toBe('Hallo');
    expect(de.p).toBeInstanceOf(Date);

    // Column fidelity (issue #107): categories/tags/scheduled_at are app-layer
    // columns the old explicit SELECT/INSERT lists omitted, so a restore silently
    // reset every working copy to '{}' / '{}' / NULL.
    const restored = await posts.get(createdPair.translationKey);
    expect(restored?.shared.categories).toEqual(['reise']);
    expect(restored?.shared.tags).toEqual(['griechenland', 'sommer']);
    expect(restored?.shared.scheduledAt).toBe('2026-10-01T08:00:00.000Z');
    const sched = (await pool.query(
      `SELECT to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS s FROM posts WHERE locale='de'`,
    )).rows[0] as { s: string };
    expect(sched.s).toBe('2026-10-01T08:00:00.000Z');
  });

  it('rejects an unsupported dump version without touching data', async () => {
    // @ai-warning: the guard is an ALLOW-LIST (1, 2, 3, 4), not a minimum — so
    // this probes the next UNRELEASED version. Bump it whenever DUMP_VERSION
    // is bumped, or this stops testing anything.
    const { gzipSync } = await import('node:zlib');
    const { writeFileSync } = await import('node:fs');
    const bad = join(dir, 'db-20260101-000000.json.gz');
    writeFileSync(bad, gzipSync(JSON.stringify({ version: 5, tables: { users: [], posts: [] } })));
    await expect(restoreDatabase(pool, bad)).rejects.toThrow(/unsupported dump version/);
    expect((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n).toBe('1');
  });

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

  it('backfills published_snapshot when restoring a pre-snapshot dump, in the same transaction', async () => {
    // A dump taken BEFORE issue #20 (v2, but no published_snapshot/published_at
    // keys): its published rows must become loader-visible right after the
    // restore — the documented flow is restore → POST /rebuild with no app
    // restart, so restoreDatabase itself must run the backfill, not ensureSchema.
    const { gzipSync } = await import('node:zlib');
    const { writeFileSync } = await import('node:fs');
    const { randomUUID } = await import('node:crypto');
    const oldPost = (locale: 'de' | 'en', slug: string, status: 'draft' | 'published', body: string) => ({
      id: randomUUID(), translation_key: 'legacy-pair', locale, slug, title: 'Legacy', date: '2025-06-01',
      country: 'Peru', country_code: 'PE', region: 'south-america', excerpt: 'x',
      hero_image: { src: 'https://img.example/h', width: 100, height: 50, alt: 'a' },
      coordinates: { lat: -12, lng: -77 }, stops: null, route: null, key_facts: null,
      body_markdown: body, images: {}, status,
      created_at: '2025-06-01T10:00:00.000Z', updated_at: '2025-06-02T10:00:00.000Z',
    });
    const posts = [
      oldPost('de', 'legacy-reise', 'published', 'Live DE'),
      oldPost('en', 'legacy-trip', 'published', 'Live EN'),
      { ...oldPost('de', 'entwurf', 'draft', 'Draft body'), translation_key: 'legacy-draft' },
    ];
    const pre = join(dir, 'db-20260601-000000.json.gz');
    writeFileSync(pre, gzipSync(JSON.stringify({ version: 2, tables: { users: [], posts } })));

    await restoreDatabase(pool, pre);
    // Published rows are immediately visible to the site loader's query…
    const visible = await pool.query(
      `SELECT slug, published_snapshot->>'body_markdown' AS live, published_at
         FROM posts WHERE status='published' AND published_snapshot IS NOT NULL ORDER BY slug`,
    );
    expect(visible.rows.map((r) => [r.slug, r.live])).toEqual([
      ['legacy-reise', 'Live DE'],
      ['legacy-trip', 'Live EN'],
    ]);
    for (const r of visible.rows) expect(r.published_at).toBeInstanceOf(Date);
    // …while the draft row stays snapshot-less.
    const draft = (await pool.query(
      `SELECT published_snapshot, published_at FROM posts WHERE slug='entwurf'`,
    )).rows[0];
    expect(draft.published_snapshot).toBeNull();
    expect(draft.published_at).toBeNull();
  });

  it('a v3 dump round-trips the media library, including tags and folders', async () => {
    // @ai-warning: without this, a restore brings the photos back (they are on
    // disk) but loses every folder, caption and tag — the worst kind of
    // partial recovery. `tags` is text[], which CANNOT round-trip through the
    // JSON.stringify path every other non-scalar column uses.
    const users = pgUserStore(pool);
    const media = pgMediaStore(pool, { baseUrl: 'https://img.example' });
    await pool.query('DELETE FROM media');
    await pool.query('DELETE FROM media_folders');
    await pool.query('DELETE FROM users');
    const u = await users.create({ username: `mediauser-${Date.now()}`, password: 'password123456', isAdmin: true });
    await media.upsert({
      key: 'library/2025/a', folder: 'Island/Sued', title: 'Sonnenaufgang',
      alt: { de: 'DE alt', en: 'EN alt' }, caption: { de: 'Tag 3', en: 'Day 3' },
      tags: ['dawn', 'sea'], status: 'ready',
      width: 3000, height: 2000, origBytes: 10_700_000,
      exif: { takenAt: new Date('2026-07-04T18:23:11Z'), camera: 'LEICA Q2', lens: 'Summilux', lat: 63.0759, lng: 10.3887 },
      uploadedBy: u.id,
    });
    await media.setVariantBytes('library/2025/a', 6_900_000);

    const name = await dumpDatabase(pool, dir);
    const dump = JSON.parse(
      (await import('node:zlib')).gunzipSync((await import('node:fs')).readFileSync(join(dir, name))).toString('utf8'),
    );
    expect(dump.version).toBe(4);

    await pool.query('DELETE FROM media');
    await pool.query('DELETE FROM media_folders');
    const counts = await restoreDatabase(pool, join(dir, name));
    expect(counts.media).toBe(1);

    const back = await media.get('library/2025/a');
    expect(back).toMatchObject({
      folder: 'Island/Sued', title: 'Sonnenaufgang',
      alt: { de: 'DE alt', en: 'EN alt' }, caption: { de: 'Tag 3', en: 'Day 3' },
      tags: ['dawn', 'sea'], width: 3000, height: 2000,
      origBytes: 10_700_000, variantBytes: 6_900_000, status: 'ready',
    });
    expect(back?.exif.camera).toBe('LEICA Q2');
    expect(back?.exif.lat).toBeCloseTo(63.0759, 4);
    // Restore ordering: media is deleted BEFORE users, so uploaded_by is not
    // nulled by the users cascade before the rows come back.
    expect(back?.uploadedBy).toBe(u.id);
    expect(await media.folders()).toEqual(expect.arrayContaining(['Island', 'Island/Sued']));
  });

  it('a v2 dump (no media tables) still restores and leaves media rows to be rescanned', async () => {
    const { gzipSync } = await import('node:zlib');
    const { writeFileSync } = await import('node:fs');
    const v2 = join(dir, 'db-20260102-000000.json.gz');
    writeFileSync(v2, gzipSync(JSON.stringify({
      version: 2, createdAt: new Date().toISOString(),
      tables: { users: [], posts: [], pages: [] },
    })));
    const counts = await restoreDatabase(pool, v2);
    expect(counts.media).toBe(0);
  });

  it('a v3 dump (no categories/tags/scheduled_at keys) restores those columns at their defaults', async () => {
    const now = new Date().toISOString();
    const row = (locale: 'de' | 'en', slug: string) => ({
      id: randomUUID(), translation_key: 'v3-tk', locale, slug, title: 'V3', date: '2026-02-02',
      country: 'X', country_code: 'RO', region: 'europe', excerpt: 'x',
      hero_image: { src: 'https://img.example/x', width: 100, height: 50, alt: 'a' },
      coordinates: { lat: 45, lng: 25 }, stops: null, route: null, key_facts: null,
      body_markdown: 'b', images: {}, status: 'draft', created_at: now, updated_at: now,
      published_snapshot: null, published_at: null,
    });
    const v3 = join(dir, 'db-20260103-000000.json.gz');
    writeFileSync(v3, gzipSync(JSON.stringify({
      version: 3, createdAt: now,
      tables: { users: [], posts: [row('de', 'v3-reise'), row('en', 'v3-trip')], pages: [], media: [], media_folders: [] },
    })));
    const counts = await restoreDatabase(pool, v3);
    expect(counts.posts).toBe(2);
    const back = (await pool.query(
      `SELECT categories, tags, scheduled_at FROM posts WHERE translation_key='v3-tk' ORDER BY locale`,
    )).rows as { categories: string[]; tags: string[]; scheduled_at: Date | null }[];
    expect(back).toHaveLength(2);
    for (const r of back) {
      expect(r.categories).toEqual([]);
      expect(r.tags).toEqual([]);
      expect(r.scheduled_at).toBeNull();
    }
  });

  it('dumps every column of posts, so the next added column cannot be silently dropped', async () => {
    // @ai-warning: dumpDatabase uses an explicit column list for posts (to_char
    // on `date`), so a column added in db.ts without touching backup.ts is
    // silently absent from every dump and reset on restore — exactly how
    // categories/tags/scheduled_at were lost (issue #107). This diff is the
    // only thing that catches the next one.
    const posts = pgPostStore(pool);
    await pool.query('DELETE FROM posts');
    await posts.upsertDraft({
      translationKey: '', status: 'draft',
      shared: { date: '2026-03-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 45, lng: 25 } },
      de: { locale: 'de', slug: 'cols-reise', title: 'C', excerpt: 'x', country: 'Rumänien', heroImage: { src: 'https://img.example/x', width: 100, height: 50, alt: 'a' }, bodyMarkdown: 'b', images: {} },
      en: { locale: 'en', slug: 'cols-trip', title: 'C', excerpt: 'x', country: 'Romania', heroImage: { src: 'https://img.example/x', width: 100, height: 50, alt: 'a' }, bodyMarkdown: 'b', images: {} },
    });
    const name = await dumpDatabase(pool, dir);
    const dump = JSON.parse(gunzipSync(readFileSync(join(dir, name))).toString('utf8')) as {
      tables: { posts: Record<string, unknown>[] };
    };
    const schemaCols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'posts'`,
    )).rows.map((r) => r.column_name as string).sort();
    expect(dump.tables.posts).toHaveLength(2);
    expect(Object.keys(dump.tables.posts[0] ?? {}).sort()).toEqual(schemaCols);
  });

  // The restore CLI (issue #114): spawned exactly as production runs it. Each
  // case seeds `alice`, dumps, adds `bob`, then restores that dump — so "the
  // rows about to be replaced" (alice + bob) differ from the dump (alice) and
  // both the refusal and the pre-restore dump are observable in the database.
  describe('restore CLI', () => {
    const usernames = async () =>
      (await pool.query('SELECT username FROM users ORDER BY username')).rows.map((r) => r.username);
    const preDumps = (backupDir: string) => {
      try { return readdirSync(join(backupDir, 'db')).filter((n) => BACKUP_FILE_RE.test(n)); } catch { return []; }
    };
    const usersIn = (dumpPath: string) => readDump(dumpPath).tables.users.map((u) => String(u.username)).sort();
    async function seed(): Promise<{ dumpFile: string; backupDir: string; env: NodeJS.ProcessEnv }> {
      await pool.query('DELETE FROM posts');
      await pool.query('DELETE FROM users');
      const users = pgUserStore(pool);
      await users.create({ username: 'alice', password: 'password-alice', isAdmin: true });
      const dumpDir = await mkdtemp(join(tmpdir(), 'bk-cli-src-'));
      const dumpFile = join(dumpDir, await dumpDatabase(pool, dumpDir));
      await users.create({ username: 'bob', password: 'password-bob-1', isAdmin: false });
      const backupDir = await mkdtemp(join(tmpdir(), 'bk-cli-dst-'));
      return { dumpFile, backupDir, env: { ...process.env, DATABASE_URL: url!, BACKUP_DIR: backupDir } };
    }

    it('without --yes and no confirmation line (stdin EOF) it aborts: no rows touched, no pre-dump written', async () => {
      const { dumpFile, backupDir, env } = await seed();
      const r = await runCli(['restore', dumpFile], env);
      expect(r.code).toBe(1);
      // The summary names the target and both row sets before asking.
      expect(r.stdout).toContain('target database: ');
      expect(r.stdout).not.toContain('sw:sw@'); // never echo credentials
      expect(r.stdout).toMatch(/dump: .*users 1, posts 0/);
      expect(r.stdout).toMatch(/about to REPLACE the live rows: users 2, posts 0/);
      expect(r.stderr).toContain('aborted; nothing was changed');
      expect(await usernames()).toEqual(['alice', 'bob']);
      expect(preDumps(backupDir)).toEqual([]);
    }, 30_000);

    it('with --yes it writes a pre-restore dump of the replaced rows into BACKUP_DIR/db, then restores', async () => {
      const { dumpFile, backupDir, env } = await seed();
      const r = await runCli(['restore', '--yes', dumpFile], env);
      expect(r.code).toBe(0);
      const written = preDumps(backupDir);
      expect(written).toHaveLength(1);
      const preDumpPath = join(backupDir, 'db', written[0]!);
      expect(r.stdout).toContain(`pre-restore dump written: ${preDumpPath}`);
      // The pre-dump captures the state BEFORE the wipe (alice + bob) …
      expect(usersIn(preDumpPath)).toEqual(['alice', 'bob']);
      // … and the database now matches the restored dump (alice only).
      expect(await usernames()).toEqual(['alice']);
      // The undo path: the pre-dump is itself a restorable dump. Run
      // back-to-back — usually within the same UTC second — so this also pins
      // that the undo's OWN pre-dump never overwrites the file being restored
      // (dump names have one-second resolution; the CLI steers past the clash).
      const undo = await runCli(['restore', '--yes', preDumpPath], env);
      expect(undo.code).toBe(0);
      expect(await usernames()).toEqual(['alice', 'bob']);
      expect(preDumps(backupDir)).toHaveLength(2);
      expect(usersIn(preDumpPath)).toEqual(['alice', 'bob']);
    }, 60_000);

    it('a "yes" line on stdin confirms; anything else aborts', async () => {
      const { dumpFile, env } = await seed();
      const no = await runCli(['restore', dumpFile], env, 'no\n');
      expect(no.code).toBe(1);
      expect(await usernames()).toEqual(['alice', 'bob']);
      const yes = await runCli(['restore', dumpFile], env, 'yes\n');
      expect(yes.code).toBe(0);
      expect(await usernames()).toEqual(['alice']);
    }, 60_000);

    it('two --yes restores in quick succession keep BOTH pre-dumps (a name is never reused)', async () => {
      // Same external source, back to back — usually within one UTC second.
      // The second run's pre-dump (state: alice) must not land on the first
      // run's name and overwrite its content (state: alice + bob).
      const { dumpFile, backupDir, env } = await seed();
      const first = await runCli(['restore', '--yes', dumpFile], env);
      const second = await runCli(['restore', '--yes', dumpFile], env);
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const written = preDumps(backupDir).sort();
      expect(written).toHaveLength(2);
      expect(usersIn(join(backupDir, 'db', written[0]!))).toEqual(['alice', 'bob']);
      expect(usersIn(join(backupDir, 'db', written[1]!))).toEqual(['alice']);
    }, 60_000);

    it('aborts before the transaction when the pre-restore dump cannot be written', async () => {
      const { dumpFile, env } = await seed();
      // BACKUP_DIR under a regular file: mkdir of `<file>/db` fails with ENOTDIR.
      const r = await runCli(['restore', '--yes', dumpFile], { ...env, BACKUP_DIR: dumpFile });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('pre-restore dump into');
      expect(r.stderr).toContain('restore aborted, nothing was changed');
      expect(await usernames()).toEqual(['alice', 'bob']);
    }, 30_000);

    it('refuses an unsupported dump version before writing a pre-dump', async () => {
      const { backupDir, env } = await seed();
      const bad = join(dir, 'db-20260102-000000.json.gz');
      writeFileSync(bad, gzipSync(JSON.stringify({ version: 5, tables: { users: [], posts: [] } })));
      const r = await runCli(['restore', '--yes', bad], env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('unsupported dump version 5');
      expect(await usernames()).toEqual(['alice', 'bob']);
      expect(preDumps(backupDir)).toEqual([]);
    }, 30_000);
  });
});
