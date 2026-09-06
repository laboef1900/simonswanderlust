import { describe, expect, it, beforeEach } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { list as listTar } from 'tar';
import {
  dumpDatabase, listBackups, listImageArchives, pruneBackups, readState, writeState, isBackupDue,
  createDbBackup, archiveImages, archiveChainCutoff, sweepTempFiles, ArchiveSpaceError,
  BACKUP_FILE_RE, IMAGES_ARCHIVE_RE, resolveBackupDir, type Connectable,
} from '../src/backup.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'backup-')); });

const fakeDb = (
  users: Record<string, unknown>[] = [],
  posts: Record<string, unknown>[] = [],
  pages: Record<string, unknown>[] = [],
  media: Record<string, unknown>[] = [],
  mediaFolders: Record<string, unknown>[] = [],
): Connectable => {
  // Order matters: 'FROM media_folders' also contains 'FROM media'.
  const query = async (sql: string) => ({
    rows: sql.includes('FROM users') ? users
      : sql.includes('FROM pages') ? pages
      : sql.includes('FROM media_folders') ? mediaFolders
      : sql.includes('FROM media') ? media
      : posts,
  });
  return { query, connect: async () => ({ query, release() {} }) };
};

describe('resolveBackupDir', () => {
  it('is the container default with nothing set, and an explicit BACKUP_DIR wins', () => {
    expect(resolveBackupDir({})).toBe('/data/backup');
    expect(resolveBackupDir({ STORAGE_DIR: './data/images', BACKUP_DIR: '/mnt/bk' })).toBe('/mnt/bk');
  });

  it('follows a bare-dev STORAGE_DIR instead of reaching for /data (#145)', () => {
    // The .env.example bare-dev block sets only STORAGE_DIR; the export must
    // land beside it, not fail with EACCES on the developer's root filesystem.
    expect(resolveBackupDir({ STORAGE_DIR: './data/images' })).toBe('data/backup');
  });
});

describe('dumpDatabase', () => {
  it('writes a versioned gzipped JSON dump named after the timestamp', async () => {
    const now = new Date('2026-07-03T14:30:05Z');
    const name = await dumpDatabase(
      fakeDb(
        [{ id: 'u1', username: 'simon' }],
        [{ id: 'p1', slug: 's' }],
        [{ key: 'about', locale: 'de', title: 'X', body_markdown: 'B', images: {} }],
        [{ key: 'library/2025/a', folder: 'Island', tags: ['sunrise'] }],
        [{ path: 'Island' }],
      ),
      dir,
      now,
    );
    expect(name).toBe('db-20260703-143005.json.gz');
    expect(BACKUP_FILE_RE.test(name)).toBe(true);
    const dump = JSON.parse(gunzipSync(await readFile(join(dir, name))).toString('utf8'));
    expect(dump.version).toBe(4);
    expect(dump.tables.users).toEqual([{ id: 'u1', username: 'simon' }]);
    expect(dump.tables.posts).toEqual([{ id: 'p1', slug: 's' }]);
    expect(dump.tables.pages).toEqual([{ key: 'about', locale: 'de', title: 'X', body_markdown: 'B', images: {} }]);
    // Without these a restore would bring the photos back but lose every
    // folder, caption and tag — the worst kind of partial recovery.
    expect(dump.tables.media).toEqual([{ key: 'library/2025/a', folder: 'Island', tags: ['sunrise'] }]);
    expect(dump.tables.media_folders).toEqual([{ path: 'Island' }]);
    expect(dump.tables.sessions).toBeUndefined();
  });

  it('never overwrites an existing dump: a taken name advances to the next free stamp', async () => {
    // One-second name resolution + every writer (scheduler, "Back up now",
    // the restore CLI's pre-restore dump) sharing this directory: a reused
    // name would silently destroy the state the earlier file held.
    const now = new Date('2026-07-03T14:30:05Z');
    const first = await dumpDatabase(fakeDb([{ id: 'u1', username: 'before' }]), dir, now);
    const second = await dumpDatabase(fakeDb([{ id: 'u1', username: 'after' }]), dir, now);
    const third = await dumpDatabase(fakeDb([{ id: 'u1', username: 'later' }]), dir, now);
    expect([first, second, third]).toEqual([
      'db-20260703-143005.json.gz', 'db-20260703-143006.json.gz', 'db-20260703-143007.json.gz',
    ]);
    const usersIn = async (name: string) => JSON.parse(gunzipSync(await readFile(join(dir, name))).toString('utf8')).tables.users[0].username;
    expect(await usersIn(first)).toBe('before');
    expect(await usersIn(second)).toBe('after');
    // createdAt records when the dump was actually taken, not the steered name.
    expect(JSON.parse(gunzipSync(await readFile(join(dir, second))).toString('utf8')).createdAt).toBe(now.toISOString());
  });

  it('two processes publishing dumps concurrently under one stamp never lose a dump', async () => {
    // The scheduler (app process) and the restore CLI (`docker compose exec`,
    // a separate process) share BACKUP_DIR/db. An exists-check-then-rename
    // is a cross-process race: both pick the same free name and the second
    // rename silently replaces the first dump. Publication must claim the
    // name atomically (link(2) → EEXIST → next stamp). 2 × 40 dumps with
    // ONE `now` forces every pair onto contested names.
    const { spawn } = await import('node:child_process');
    const run = (tag: string) => new Promise<string[]>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'test/dump-race-worker.ts', dir, tag, '40', String(now.getTime())], {
        cwd: join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out) as string[]) : reject(new Error(`worker ${tag} exited ${code}`))));
    });
    const now = new Date('2026-07-03T14:30:05Z');
    const [a, b] = await Promise.all([run('a'), run('b')]);
    const names = [...a, ...b];
    expect(new Set(names).size).toBe(80);
    expect((await readdir(dir)).filter((n) => BACKUP_FILE_RE.test(n)).sort()).toEqual([...names].sort());
    // Every file still holds the row of the writer that claimed its name.
    const tagsOnDisk = await Promise.all(names.map(async (n) =>
      JSON.parse(gunzipSync(await readFile(join(dir, n))).toString('utf8')).tables.users[0].username as string));
    expect(new Set(tagsOnDisk).size).toBe(80);
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  }, 60_000);
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
    const t = '2026-07-03T12:00:00.000Z';
    writeState(dir, { lastSuccessAt: t, lastAttemptAt: t, lastImagesArchiveAt: t, lastError: 'x' });
    expect(readState(dir)).toEqual({ lastSuccessAt: t, lastAttemptAt: t, lastImagesArchiveAt: t, lastError: 'x' });
  });

  it('treats a corrupt or malformed state.json as empty', async () => {
    await writeFile(join(dir, 'state.json'), '{"lastSuccessAt":"2026-07-03T12:00:00Z","lastIm');
    expect(readState(dir)).toEqual({});
    await writeFile(join(dir, 'state.json'), '[1,2]');
    expect(readState(dir)).toEqual({});
  });

  it('drops fields that are not what they claim to be instead of letting NaN through', async () => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      lastSuccessAt: 'yesterday-ish', lastImagesArchiveAt: 12345, lastAttemptAt: '2026-07-03T12:00:00Z', lastError: { nested: true },
    }));
    expect(readState(dir)).toEqual({ lastAttemptAt: '2026-07-03T12:00:00Z' });
  });

  it('sweeps only in-flight temp names, leaving real backups alone', async () => {
    for (const n of [
      'images-20260703-120000.tar.4242.tmp', 'db-20260703-120000.json.gz.4242.tmp', 'state.json.4242.tmp',
      'images-20260703-120000.tar', 'db-20260703-120000.json.gz', 'state.json', 'notes.tmp',
    ]) await writeFile(join(dir, n), 'x');
    expect(sweepTempFiles(dir).sort()).toEqual([
      'db-20260703-120000.json.gz.4242.tmp', 'images-20260703-120000.tar.4242.tmp', 'state.json.4242.tmp',
    ]);
    expect((await readdir(dir)).sort()).toEqual(['db-20260703-120000.json.gz', 'images-20260703-120000.tar', 'notes.tmp', 'state.json']);
    expect(sweepTempFiles(join(dir, 'missing'))).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    'a leftover it cannot unlink is logged and skipped, never thrown — boot and runNow must survive it',
    async () => {
      await writeFile(join(dir, 'images-20260703-120000.tar.4242.tmp'), 'x');
      await chmod(dir, 0o555);
      try {
        expect(sweepTempFiles(dir)).toEqual([]);
        const b = createDbBackup({ db: fakeDb(), dir, retention: () => 5 });
        expect(b.sweepTempFiles()).toEqual([]);
        const s = await b.runNow(); // the dump's own write fails, recorded, not thrown
        expect(s.lastError).toMatch(/EACCES|EPERM/);
      } finally {
        await chmod(dir, 0o755);
      }
      expect(await readdir(dir)).toEqual(['images-20260703-120000.tar.4242.tmp']);
    },
  );

  it('derives the archive cutoff from the newest tar, stepping back over a same-second run', async () => {
    expect(archiveChainCutoff(dir)).toBe(0);
    for (const n of ['images-20260701-000000.tar', 'images-20260704-102030.tar']) await writeFile(join(dir, n), 'x');
    expect(archiveChainCutoff(dir)).toBe(Date.parse('2026-07-04T10:20:30Z'));
    // 102031/102032 were bumped off a collision with 102030 — their walks
    // started at or after 10:20:30, so that is the cutoff the chain can vouch for
    for (const n of ['images-20260704-102031.tar', 'images-20260704-102032.tar']) await writeFile(join(dir, n), 'x');
    expect(archiveChainCutoff(dir)).toBe(Date.parse('2026-07-04T10:20:30Z'));
    await writeFile(join(dir, 'images-20260704-102040.tar'), 'x');
    expect(archiveChainCutoff(dir)).toBe(Date.parse('2026-07-04T10:20:40Z'));
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

  // chmod 000 doesn't block root, so this EACCES fixture only works unprivileged.
  it.skipIf(process.getuid?.() === 0)(
    'propagates a non-ENOENT walk failure instead of treating it as empty',
    async () => {
      await chmod(storage, 0o000);
      try {
        await expect(archiveImages(storage, dir, 0)).rejects.toThrow();
      } finally {
        await chmod(storage, 0o755);
      }
      expect(await readdir(dir)).toEqual([]);
    },
  );

  it('never overwrites an existing archive: same-second runs get bumped stamps', async () => {
    const now = new Date('2026-07-04T10:20:30Z');
    const first = await archiveImages(storage, dir, 0, now);
    expect(first).toBe('images-20260704-102030.tar');
    await writeFile(join(storage, 'trips', 'x', 'new-orig.jpg'), 'n');
    const second = await archiveImages(storage, dir, 0, now);
    expect(second).toBe('images-20260704-102031.tar');
    // the first tar survives untouched — neither slice of the chain is lost
    expect(await tarEntries(join(dir, first!))).toEqual([
      'trips/x/hero-640.avif', 'trips/x/hero-orig.jpg',
    ]);
    expect(await tarEntries(join(dir, second!))).toContain('trips/x/new-orig.jpg');
  });

  it.skipIf(process.getuid?.() === 0)(
    'a failed tar rejects and leaves no .tmp behind',
    async () => {
      const locked = join(storage, 'trips', 'x', 'hero-orig.jpg');
      const exitListeners = process.listenerCount('exit');
      await chmod(locked, 0o000); // tar opens it mid-stream -> EACCES after the temp exists
      try {
        await expect(archiveImages(storage, dir, 0)).rejects.toThrow(/EACCES/);
      } finally {
        await chmod(locked, 0o644);
      }
      expect(await readdir(dir)).toEqual([]);
      expect(process.listenerCount('exit')).toBe(exitListeners); // the exit hook was deregistered
    },
  );

  it('refuses before creating anything when the estimate plus reserve would not fit', async () => {
    const tight = async () => ({ free: 2 * 1024 * 1024 * 1024 + 10, total: 0 }); // reserve + 10 B
    await expect(archiveImages(storage, dir, 0, new Date(), tight)).rejects.toThrow(ArchiveSpaceError);
    await expect(archiveImages(storage, dir, 0, new Date(), tight)).rejects.toThrow(/2 files/);
    expect(await readdir(dir)).toEqual([]);
    const roomy = async () => ({ free: 2 * 1024 * 1024 * 1024 + 2 * 2048 + 2, total: 0 });
    expect(await archiveImages(storage, dir, 0, new Date(), roomy)).toMatch(IMAGES_ARCHIVE_RE);
  });

  it('archives anyway when free space cannot be read', async () => {
    const broken = async (): Promise<never> => { throw new Error('statfs ENOSYS'); };
    expect(await archiveImages(storage, dir, 0, new Date(), broken)).toMatch(IMAGES_ARCHIVE_RE);
  });
});

describe('isBackupDue', () => {
  const now = Date.parse('2026-07-03T12:00:00Z'); // a Friday
  it('is never due when off', () => {
    expect(isBackupDue({}, 'off', now)).toBe(false);
  });
  it('is due immediately when never succeeded', () => {
    expect(isBackupDue({}, 'daily', now)).toBe(true);
  });
  it('daily: due once the UTC day changes, however few hours have passed', () => {
    expect(isBackupDue({ lastSuccessAt: '2026-07-03T00:10:00Z' }, 'daily', now)).toBe(false);
    expect(isBackupDue({ lastSuccessAt: '2026-07-02T23:50:00Z' }, 'daily', now)).toBe(true);
    // an hourly tick after a 00:10 success stays in the same day all day long: no drift
    expect(isBackupDue({ lastSuccessAt: '2026-07-03T00:10:00Z' }, 'daily', Date.parse('2026-07-03T23:59:00Z'))).toBe(false);
    expect(isBackupDue({ lastSuccessAt: '2026-07-03T00:10:00Z' }, 'daily', Date.parse('2026-07-04T00:00:00Z'))).toBe(true);
  });
  it('weekly: windows open on Monday 00:00 UTC', () => {
    expect(isBackupDue({ lastSuccessAt: '2026-06-29T00:30:00Z' }, 'weekly', now)).toBe(false); // Monday of this week
    expect(isBackupDue({ lastSuccessAt: '2026-06-28T23:30:00Z' }, 'weekly', now)).toBe(true);  // Sunday before
    expect(isBackupDue({ lastSuccessAt: '2026-07-03T12:00:00Z' }, 'weekly', Date.parse('2026-07-05T23:59:59Z'))).toBe(false);
    expect(isBackupDue({ lastSuccessAt: '2026-07-03T12:00:00Z' }, 'weekly', Date.parse('2026-07-06T00:00:00Z'))).toBe(true);
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
    const bad: Connectable = {
      query: async () => { throw new Error('db down'); },
      connect: async () => { throw new Error('db down'); },
    };
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
    // a FILE as storageDir: the walk fails with ENOTDIR -> nothing to archive
    const notADir = join(dir, 'file-not-dir');
    await writeFile(notADir, 'x');
    const b = createDbBackup({ db: fakeDb(), dir, retention: () => 5, storageDir: notADir });
    const s = await b.runNow();
    expect(s.lastSuccessAt).toBeTruthy();
    expect(s.lastError).toBeUndefined();
    expect(b.list().length).toBe(1);
    expect(b.listImageArchives().length).toBe(0);
  });

  it('sweeps a crashed run\'s temp before writing, and reports running only mid-run', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'images-20260101-000000.tar.999.tmp'), 'leftover');
    const b = createDbBackup({ db: fakeDb(), dir, retention: () => 5 });
    expect(b.running()).toBe(false);
    const p = b.runNow();
    expect(b.running()).toBe(true);
    expect(b.state().lastAttemptAt).toBeTruthy(); // this run's start is visible while it runs
    expect(b.state().lastSuccessAt).toBeUndefined();
    expect(b.sweepTempFiles()).toEqual([]); // never unlinks under a run in flight
    await p;
    expect(b.running()).toBe(false);
    expect((await readdir(dir)).some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('recovers the archive cutoff from the newest tar when state.json is corrupt', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'imgarch-'));
    const old = new Date('2026-01-01T00:00:00Z');
    await writeFile(join(storage, 'old-orig.jpg'), 'o');
    await utimes(join(storage, 'old-orig.jpg'), old, old);
    await writeFile(join(storage, 'new-orig.jpg'), 'n');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'images-20260601-000000.tar'), 'previous slice');
    await writeFile(join(dir, 'state.json'), '{"lastImagesArchiveAt":"2026-06-');
    const b = createDbBackup({ db: fakeDb(), dir, retention: () => 5, storageDir: storage });
    const s = await b.runNow();
    expect(s.lastError).toBeUndefined();
    const archives = b.listImageArchives();
    expect(archives.length).toBe(2);
    const entries: string[] = [];
    await listTar({ file: join(dir, archives[0]!.name), onReadEntry: (e) => { entries.push(e.path); } });
    expect(entries).toEqual(['new-orig.jpg']); // not a full re-archive
    expect(readState(dir).lastImagesArchiveAt).toBe(s.lastImagesArchiveAt);
  });

  it('starts a fresh full chain when the archives were deleted but state.json survived', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'imgarch-'));
    const old = new Date('2026-01-01T00:00:00Z');
    await writeFile(join(storage, 'old-orig.jpg'), 'o');
    await utimes(join(storage, 'old-orig.jpg'), old, old);
    writeState(dir, { lastImagesArchiveAt: '2026-06-01T00:00:00.000Z' });
    const b = createDbBackup({ db: fakeDb(), dir, retention: () => 5, storageDir: storage });
    await b.runNow();
    const archives = b.listImageArchives();
    expect(archives.length).toBe(1);
    const entries: string[] = [];
    await listTar({ file: join(dir, archives[0]!.name), onReadEntry: (e) => { entries.push(e.path); } });
    expect(entries).toEqual(['old-orig.jpg']);
  });

  it.skipIf(process.getuid?.() === 0)(
    'keeps the archive cutoff unchanged when the images walk fails',
    async () => {
      const storage = await mkdtemp(join(tmpdir(), 'imgarch-'));
      await writeFile(join(storage, 'hero-orig.jpg'), 'o');
      const cutoff = '2026-01-01T00:00:00.000Z';
      writeState(dir, { lastImagesArchiveAt: cutoff });
      await chmod(storage, 0o000); // EACCES on the walk — a transient failure, not "empty"
      try {
        const b = createDbBackup({ db: fakeDb(), dir, retention: () => 5, storageDir: storage });
        const s = await b.runNow();
        expect(s.lastSuccessAt).toBeTruthy(); // the dump itself still succeeded
        expect(s.lastError).toContain('images archive failed');
        // the cutoff MUST NOT advance — the next successful run re-covers the gap
        expect(s.lastImagesArchiveAt).toBe(cutoff);
        expect(b.listImageArchives().length).toBe(0);
      } finally {
        await chmod(storage, 0o755);
      }
    },
  );
});
