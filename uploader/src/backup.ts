import { gzipSync, gunzipSync } from 'node:zlib';
import {
  mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BackupSchedule } from './settings.js';
import type { DbPool } from './db.js';

export const DUMP_VERSION = 2;
export const BACKUP_FILE_RE = /^db-\d{8}-\d{6}\.json\.gz$/;

export class BackupError extends Error {}

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface BackupState { lastAttemptAt?: string; lastSuccessAt?: string; lastError?: string }
export interface BackupFileInfo { name: string; size: number }

function atomicWrite(path: string, data: Buffer | string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Dump users + posts (never sessions — disposable, and token hashes don't
 * belong in backups) as one gzipped, versioned JSON file. Returns the filename. */
export async function dumpDatabase(db: Queryable, dir: string, now: Date = new Date()): Promise<string> {
  const users = (await db.query('SELECT * FROM users ORDER BY created_at')).rows;
  // @ai-warning: node-postgres parses `date` (a DATE column) as a LOCAL-midnight
  // JS Date; JSON.stringify then serializes it in UTC, shifting the calendar day
  // west of UTC (e.g. Europe/Berlin: 2026-01-01 -> "2025-12-31T23:00:00.000Z").
  // Export it as text via to_char so the dump — and the eventual restore — carry
  // the exact calendar date instead of a shifted timestamp.
  const posts = (await db.query(
    `SELECT id, translation_key, locale, slug, title, to_char(date, 'YYYY-MM-DD') AS date, country,
       country_code, region, excerpt, hero_image, coordinates, stops, route, key_facts, body_markdown,
       images, status, created_at, updated_at
     FROM posts ORDER BY created_at`,
  )).rows;
  const pages = (await db.query('SELECT key, locale, title, body_markdown, images FROM pages ORDER BY key, locale')).rows;
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  const name = `db-${stamp}.json.gz`;
  mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ version: DUMP_VERSION, createdAt: iso, tables: { users, posts, pages } });
  atomicWrite(join(dir, name), gzipSync(payload));
  return name;
}

export function listBackups(dir: string): BackupFileInfo[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => BACKUP_FILE_RE.test(n))
    .sort()
    .reverse()
    .map((name) => ({ name, size: statSync(join(dir, name)).size }));
}

export function pruneBackups(dir: string, keep: number): string[] {
  const doomed = listBackups(dir).slice(keep).map((f) => f.name);
  for (const name of doomed) rmSync(join(dir, name), { force: true });
  return doomed;
}

const STATE_FILE = 'state.json';

export function readState(dir: string): BackupState {
  try { return JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as BackupState; } catch { return {}; }
}

export function writeState(dir: string, state: BackupState): void {
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, STATE_FILE), JSON.stringify(state, null, 2));
}

const INTERVALS: Record<Exclude<BackupSchedule, 'off'>, number> = {
  daily: 24 * 3600_000,
  weekly: 7 * 24 * 3600_000,
};

export function isBackupDue(state: BackupState, schedule: BackupSchedule, nowMs: number): boolean {
  if (schedule === 'off') return false;
  if (!state.lastSuccessAt) return true;
  return nowMs - Date.parse(state.lastSuccessAt) >= INTERVALS[schedule];
}

export interface DbBackup {
  dir: string;
  runNow(): Promise<BackupState>;
  list(): BackupFileInfo[];
  state(): BackupState;
}

export function createDbBackup(opts: { db: Queryable; dir: string; retention: () => number }): DbBackup {
  let running = false;
  return {
    dir: opts.dir,
    list: () => listBackups(opts.dir),
    state: () => readState(opts.dir),
    async runNow() {
      if (running) return readState(opts.dir);
      running = true;
      const state = readState(opts.dir);
      state.lastAttemptAt = new Date().toISOString();
      try {
        await dumpDatabase(opts.db, opts.dir);
        state.lastSuccessAt = new Date().toISOString();
        delete state.lastError;
        try {
          pruneBackups(opts.dir, opts.retention());
        } catch (e) {
          state.lastError = `prune failed: ${(e as Error).message}`;
        }
      } catch (e) {
        state.lastError = (e as Error).message;
      } finally {
        // Best-effort: a failed state write must neither wedge the in-flight
        // flag nor reject (callers fire-and-forget runNow).
        try { writeState(opts.dir, state); } catch { /* state write failed */ }
        running = false;
      }
      return { ...state };
    },
  };
}

interface Dump {
  version: number;
  createdAt: string;
  tables: { users: Record<string, unknown>[]; posts: Record<string, unknown>[]; pages?: Record<string, unknown>[] };
}

const asJsonb = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/** Restore a dump inside one transaction. Deleting users cascades to sessions
 * (FK ON DELETE CASCADE), so every login is invalidated. */
export async function restoreDatabase(
  pool: DbPool,
  filePath: string,
): Promise<{ users: number; posts: number; pages: number }> {
  const dump = JSON.parse(gunzipSync(readFileSync(filePath)).toString('utf8')) as Dump;
  if (dump.version !== 1 && dump.version !== 2) throw new BackupError(`unsupported dump version ${dump.version}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM posts');
    await client.query('DELETE FROM users');
    for (const u of dump.tables.users) {
      await client.query(
        'INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES ($1,$2,$3,$4,$5)',
        [u.id, u.username, u.password_hash, u.is_admin, u.created_at],
      );
    }
    for (const p of dump.tables.posts) {
      await client.query(
        `INSERT INTO posts (id, translation_key, locale, slug, title, date, country, country_code, region,
           excerpt, hero_image, coordinates, stops, route, key_facts, body_markdown, images, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15::jsonb,$16,$17::jsonb,$18,$19,$20)`,
        [p.id, p.translation_key, p.locale, p.slug, p.title, p.date, p.country, p.country_code, p.region,
         p.excerpt, asJsonb(p.hero_image), asJsonb(p.coordinates), asJsonb(p.stops), p.route,
         asJsonb(p.key_facts), p.body_markdown, asJsonb(p.images), p.status, p.created_at, p.updated_at],
      );
    }
    // A v1 dump carries no `pages` key at all — leave existing pages untouched
    // so restoring an old backup can't silently wipe content it never captured.
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
    await client.query('COMMIT');
    return { users: dump.tables.users.length, posts: dump.tables.posts.length, pages: dump.tables.pages?.length ?? 0 };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
