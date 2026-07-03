import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dumpDatabase, listBackups, pruneBackups, readState, writeState, isBackupDue,
  createDbBackup, BACKUP_FILE_RE, DUMP_VERSION, type Queryable,
} from '../src/backup.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'backup-')); });

const fakeDb = (users: Record<string, unknown>[] = [], posts: Record<string, unknown>[] = []): Queryable => ({
  query: async (sql: string) => ({ rows: sql.includes('FROM users') ? users : posts }),
});

describe('dumpDatabase', () => {
  it('writes a versioned gzipped JSON dump named after the timestamp', async () => {
    const now = new Date('2026-07-03T14:30:05Z');
    const name = await dumpDatabase(fakeDb([{ id: 'u1', username: 'simon' }], [{ id: 'p1', slug: 's' }]), dir, now);
    expect(name).toBe('db-20260703-143005.json.gz');
    expect(BACKUP_FILE_RE.test(name)).toBe(true);
    const dump = JSON.parse(gunzipSync(await readFile(join(dir, name))).toString('utf8'));
    expect(dump.version).toBe(DUMP_VERSION);
    expect(dump.tables.users).toEqual([{ id: 'u1', username: 'simon' }]);
    expect(dump.tables.posts).toEqual([{ id: 'p1', slug: 's' }]);
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
    expect(listBackups(dir).map((f) => f.name)).toEqual([
      'db-20260103-000000.json.gz', 'db-20260102-000000.json.gz', 'db-20260101-000000.json.gz',
    ]);
    expect(pruneBackups(dir, 2)).toEqual(['db-20260101-000000.json.gz']);
    expect(listBackups(dir).length).toBe(2);
  });

  it('returns empty for a missing dir and round-trips state', () => {
    expect(listBackups(join(dir, 'missing'))).toEqual([]);
    expect(readState(dir)).toEqual({});
    writeState(dir, { lastSuccessAt: 't', lastAttemptAt: 't' });
    expect(readState(dir).lastSuccessAt).toBe('t');
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
});
