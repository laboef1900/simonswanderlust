import { gzipSync } from 'node:zlib';
import {
  mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BackupSchedule } from './settings.js';

export const DUMP_VERSION = 1;
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
  const posts = (await db.query('SELECT * FROM posts ORDER BY created_at')).rows;
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
  const name = `db-${stamp}.json.gz`;
  mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ version: DUMP_VERSION, createdAt: iso, tables: { users, posts } });
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
