import { describe, expect, it, beforeEach } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { list as listTar } from 'tar';
import {
  dumpDatabase, listBackups, listImageArchives, pruneBackups, readState, writeState, isBackupDue,
  createDbBackup, archiveImages, BACKUP_FILE_RE, IMAGES_ARCHIVE_RE, type Queryable,
} from '../src/backup.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'backup-')); });

const fakeDb = (
  users: Record<string, unknown>[] = [],
  posts: Record<string, unknown>[] = [],
  pages: Record<string, unknown>[] = [],
): Queryable => ({
  query: async (sql: string) => ({
    rows: sql.includes('FROM users') ? users : sql.includes('FROM pages') ? pages : posts,
  }),
});

describe('dumpDatabase', () => {
  it('writes a versioned gzipped JSON dump named after the timestamp', async () => {
    const now = new Date('2026-07-03T14:30:05Z');
    const name = await dumpDatabase(
      fakeDb(
        [{ id: 'u1', username: 'simon' }],
        [{ id: 'p1', slug: 's' }],
        [{ key: 'about', locale: 'de', title: 'X', body_markdown: 'B', images: {} }],
      ),
      dir,
      now,
    );
    expect(name).toBe('db-20260703-143005.json.gz');
    expect(BACKUP_FILE_RE.test(name)).toBe(true);
    const dump = JSON.parse(gunzipSync(await readFile(join(dir, name))).toString('utf8'));
    expect(dump.version).toBe(2);
    expect(dump.tables.users).toEqual([{ id: 'u1', username: 'simon' }]);
    expect(dump.tables.posts).toEqual([{ id: 'p1', slug: 's' }]);
    expect(dump.tables.pages).toEqual([{ key: 'about', locale: 'de', title: 'X', body_markdown: 'B', images: {} }]);
    expect(dump.tables.sessions).toBeUndefined();
  });
});

describe('list + prune + state', () => {
  it('lists newest first, ignoring foreign files, and prunes beyond keep', async () => {
    for (const stamp of ['20260101-000000', '20260102-000000', '20260103-000000']) {
      await writeFile(join(dir, `db-${stamp}.json.gz`), 'x');
    }
    await writeFile(join(dir, 'state.json'), '{}');
    await writeFile(join(dir, 'evil.sh'), 'x');
    await writeFile(join(dir, 'images-20260101-000000.tar'), 'x');
    expect(listBackups(dir).map((f) => f.name)).toEqual([
      'db-20260103-000000.json.gz', 'db-20260102-000000.json.gz', 'db-20260101-000000.json.gz',
    ]);
    expect(pruneBackups(dir, 2)).toEqual(['db-20260101-000000.json.gz']);
    expect(listBackups(dir).length).toBe(2);
    // image archives are never pruned — every tar holds a unique slice
    expect(listImageArchives(dir).map((f) => f.name)).toEqual(['images-20260101-000000.tar']);
  });

  it('lists image archives newest first, ignoring dumps and state.json', async () => {
    for (const stamp of ['20260101-000000', '20260102-000000']) {
      await writeFile(join(dir, `images-${stamp}.tar`), 'x');
    }
    await writeFile(join(dir, 'db-20260103-000000.json.gz'), 'x');
    await writeFile(join(dir, 'state.json'), '{}');
    await writeFile(join(dir, 'images-1.tar'), 'x'); // malformed stamp
    expect(listImageArchives(dir).map((f) => f.name)).toEqual([
      'images-20260102-000000.tar', 'images-20260101-000000.tar',
    ]);
    expect(listImageArchives(join(dir, 'missing'))).toEqual([]);
  });

  it('returns empty for a missing dir and round-trips state', () => {
    expect(listBackups(join(dir, 'missing'))).toEqual([]);
    expect(readState(dir)).toEqual({});
    writeState(dir, { lastSuccessAt: 't', lastAttemptAt: 't', lastImagesArchiveAt: 'i' });
    expect(readState(dir).lastSuccessAt).toBe('t');
    expect(readState(dir).lastImagesArchiveAt).toBe('i');
  });
});

describe('archiveImages', () => {
  let storage: string;
  beforeEach(async () => {
    storage = await mkdtemp(join(tmpdir(), 'imgarch-'));
    await mkdir(join(storage, 'trips', 'x'), { recursive: true });
    await writeFile(join(storage, 'trips', 'x', 'hero-640.avif'), 'a');
    await writeFile(join(storage, 'trips', 'x', 'hero-orig.jpg'), 'o');
  });

  async function tarEntries(file: string): Promise<string[]> {
    const entries: string[] = [];
    await listTar({ file, onReadEntry: (e) => { entries.push(e.path); } });
    return entries.sort();
  }

  it('tars everything on first run (since 0) with a stamped name', async () => {
    const name = await archiveImages(storage, dir, 0, new Date('2026-07-04T10:20:30Z'));
    expect(name).toBe('images-20260704-102030.tar');
    expect(IMAGES_ARCHIVE_RE.test(name!)).toBe(true);
    expect(await tarEntries(join(dir, name!))).toEqual([
      'trips/x/hero-640.avif', 'trips/x/hero-orig.jpg',
    ]);
  });

  it('includes only files modified at/after the cutoff', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    await utimes(join(storage, 'trips', 'x', 'hero-640.avif'), old, old);
    const cutoff = Date.parse('2026-06-01T00:00:00Z');
    const name = await archiveImages(storage, dir, cutoff, new Date('2026-07-04T10:20:30Z'));
    expect(await tarEntries(join(dir, name!))).toEqual(['trips/x/hero-orig.jpg']);
  });

  it('writes nothing and returns null when no file is new', async () => {
    const far = Date.parse('2099-01-01T00:00:00Z');
    expect(await archiveImages(storage, dir, far)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it('returns null for a missing storage dir', async () => {
    expect(await archiveImages(join(storage, 'nope'), dir, 0)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('isBackupDue', () => {
  const now = Date.parse('2026-07-03T12:00:00Z');
  it('is never due when off', () => {
    expect(isBackupDue({}, 'off', now)).toBe(false);
  });
  it('is due immediately when never succeeded', () => {
    expect(isBackupDue({}, 'daily', now)).toBe(true);
  });
  it('respects the daily and weekly windows', () => {
    const h23 = { lastSuccessAt: new Date(now - 23 * 3600_000).toISOString() };
    const h25 = { lastSuccessAt: new Date(now - 25 * 3600_000).toISOString() };
    expect(isBackupDue(h23, 'daily', now)).toBe(false);
    expect(isBackupDue(h25, 'daily', now)).toBe(true);
    expect(isBackupDue(h25, 'weekly', now)).toBe(false);
    const d8 = { lastSuccessAt: new Date(now - 8 * 24 * 3600_000).toISOString() };
    expect(isBackupDue(d8, 'weekly', now)).toBe(true);
  });
});

describe('createDbBackup.runNow', () => {
  it('dumps, prunes to retention, and records success', async () => {
    const b = createDbBackup({ db: fakeDb(), dir, retention: () => 1 });
    const s1 = await b.runNow();
    expect(s1.lastSuccessAt).toBeTruthy();
    expect(s1.lastError).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1100)); // distinct per-second filename
    await b.runNow();
    expect(b.list().length).toBe(1);
  });

  it('records the error and keeps lastSuccessAt on failure', async () => {
    const bad: Queryable = { query: async () => { throw new Error('db down'); } };
    const b = createDbBackup({ db: bad, dir, retention: () => 5 });
    const s = await b.runNow();
    expect(s.lastError).toBe('db down');
    expect(s.lastAttemptAt).toBeTruthy();
    expect(s.lastSuccessAt).toBeUndefined();
  });

  it('keeps the successful dump when prune fails, and stays runnable', async () => {
    const b = createDbBackup({ db: fakeDb(), dir, retention: () => { throw new Error('boom'); } });
    const s = await b.runNow();
    expect(s.lastSuccessAt).toBeTruthy();
    expect(s.lastError).toContain('prune failed: boom');
    const s2 = await b.runNow(); // flag was freed — a second run still works
    expect(s2.lastAttemptAt).toBeTruthy();
  });

  it('with storageDir set, writes an incremental images tar next to the dump', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'imgarch-'));
    await writeFile(join(storage, 'hero-orig.jpg'), 'o');
    // The cutoff is truncated to whole ms while mtimeMs keeps a sub-ms
    // fraction; step out of the write's millisecond so run 2 sees no
    // "fresh" file (in production such a same-ms duplicate is benign).
    await new Promise((r) => setTimeout(r, 20));
    const b = createDbBackup({ db: fakeDb(), dir, retention: () => 5, storageDir: storage });

    const s1 = await b.runNow();
    expect(s1.lastSuccessAt).toBeTruthy();
    expect(s1.lastError).toBeUndefined();
    expect(s1.lastImagesArchiveAt).toBeTruthy();
    expect(b.list().length).toBe(1);
    expect(b.listImageArchives().length).toBe(1);

    // nothing changed since the cutoff — the second run adds no second tar
    await new Promise((r) => setTimeout(r, 1100)); // distinct per-second filename
    const s2 = await b.runNow();
    expect(s2.lastError).toBeUndefined();
    expect(b.listImageArchives().length).toBe(1);
    expect(Date.parse(s2.lastImagesArchiveAt!)).toBeGreaterThan(Date.parse(s1.lastImagesArchiveAt!));
  });

  it('tolerates a bogus storageDir without failing the dump', async () => {
    // a FILE as storageDir: the walk fails -> treated as nothing to archive
    const notADir = join(dir, 'file-not-dir');
    await writeFile(notADir, 'x');
    const b = createDbBackup({ db: fakeDb(), dir, retention: () => 5, storageDir: notADir });
    const s = await b.runNow();
    expect(s.lastSuccessAt).toBeTruthy();
    expect(s.lastError).toBeUndefined();
    expect(b.list().length).toBe(1);
    expect(b.listImageArchives().length).toBe(0);
  });
});
