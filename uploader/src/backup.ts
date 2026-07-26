import { gzipSync, gunzipSync } from 'node:zlib';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { create as createTar } from 'tar';
import type { BackupSchedule } from './settings.js';
import { POST_SNAPSHOT_SQL, type DbPool } from './db.js';

/**
 * v3 added `media` + `media_folders` (issue #64); v2 added `pages`.
 * @ai-warning Bumping this ALSO requires widening the allow-list guard in
 * `restoreDatabase` — otherwise every newly written dump becomes unrestorable,
 * and a test that only checks "an old dump still restores" passes anyway.
 */
export const DUMP_VERSION = 3;
export const BACKUP_FILE_RE = /^db-\d{8}-\d{6}\.json\.gz$/;
export const IMAGES_ARCHIVE_RE = /^images-\d{8}-\d{6}\.tar$/;

export class BackupError extends Error {}

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface BackupState {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  /** mtime cutoff for the next incremental images archive (walk-start time of the last one). */
  lastImagesArchiveAt?: string;
}
export interface BackupFileInfo { name: string; size: number }

function atomicWrite(path: string, data: Buffer | string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** `YYYYMMDD-HHmmss` (UTC) — shared by dump and images-archive filenames. */
function fileStamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/** Dump users + posts + pages (never sessions — disposable, and token hashes
 * don't belong in backups) as one gzipped, versioned JSON file. Returns the filename. */
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
       images, status, created_at, updated_at, published_snapshot, published_at
     FROM posts ORDER BY created_at`,
  )).rows;
  const pages = (await db.query('SELECT key, locale, title, body_markdown, images FROM pages ORDER BY key, locale')).rows;
  // The media library's metadata. The FILES are captured by the incremental
  // images archive, not here — without these rows a restore would bring the
  // photos back but lose every folder, caption and tag, which is the worst
  // kind of partial recovery.
  const media = (await db.query('SELECT * FROM media ORDER BY key')).rows;
  const mediaFolders = (await db.query('SELECT path, created_at FROM media_folders ORDER BY path')).rows;
  const name = `db-${fileStamp(now)}.json.gz`;
  mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({
    version: DUMP_VERSION, createdAt: now.toISOString(),
    tables: { users, posts, pages, media, media_folders: mediaFolders },
  });
  atomicWrite(join(dir, name), gzipSync(payload));
  return name;
}

/**
 * Incremental images archive: tars every file under `storageDir` whose mtime is
 * >= `sinceMs` into `images-<stamp>.tar` in `dir` (next to the db dumps).
 * Returns the filename, or null — writing nothing — when no file qualifies.
 * Consecutive archives form a chain; restore by untarring them oldest-first
 * into an empty images dir (duplicate entries across tars are benign in that
 * order). Archives are deliberately never pruned: each holds a unique slice.
 */
export async function archiveImages(
  storageDir: string,
  dir: string,
  sinceMs: number,
  now: Date = new Date(),
): Promise<string | null> {
  let names: string[];
  try {
    names = readdirSync(storageDir, { recursive: true, encoding: 'utf8' });
  } catch (e) {
    // Only a genuinely absent images dir means "nothing to archive". Every
    // other failure (EACCES/EIO/...) MUST propagate so the caller records it
    // and does NOT advance the mtime cutoff — a swallowed transient error
    // would otherwise permanently exclude all pre-existing files from the chain.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
  const fresh = names.filter((rel) => {
    const st = statSync(join(storageDir, rel), { throwIfNoEntry: false });
    return st !== undefined && st.isFile() && st.mtimeMs >= sinceMs;
  });
  if (fresh.length === 0) return null;
  mkdirSync(dir, { recursive: true });
  // Stamps have second granularity; an existing archive must NEVER be
  // overwritten (each tar holds a unique slice of the chain — clobbering one
  // loses its files for good, because they never re-qualify against a later
  // cutoff). Bump the stamp until the name is free.
  let stampAt = now;
  let name = `images-${fileStamp(stampAt)}.tar`;
  while (existsSync(join(dir, name))) {
    stampAt = new Date(stampAt.getTime() + 1000);
    name = `images-${fileStamp(stampAt)}.tar`;
  }
  // Same atomic pattern as the dumps: the .tmp name never matches either
  // filename regex, so a crashed run can't leave a listable/served artifact.
  const tmp = join(dir, `${name}.${process.pid}.tmp`);
  await createTar({ file: tmp, cwd: storageDir, portable: true }, fresh);
  renameSync(tmp, join(dir, name));
  return name;
}

function listByPattern(dir: string, re: RegExp): BackupFileInfo[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => re.test(n))
    .sort()
    .reverse()
    .map((name) => ({ name, size: statSync(join(dir, name)).size }));
}

export function listBackups(dir: string): BackupFileInfo[] {
  return listByPattern(dir, BACKUP_FILE_RE);
}

export function listImageArchives(dir: string): BackupFileInfo[] {
  return listByPattern(dir, IMAGES_ARCHIVE_RE);
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
  listImageArchives(): BackupFileInfo[];
  state(): BackupState;
}

export function createDbBackup(
  opts: { db: Queryable; dir: string; retention: () => number; storageDir?: string },
): DbBackup {
  let running = false;
  return {
    dir: opts.dir,
    list: () => listBackups(opts.dir),
    listImageArchives: () => listImageArchives(opts.dir),
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
        // Best-effort incremental images archive after a successful dump. The
        // cutoff for the NEXT run is this run's walk-start time (>= compare),
        // so files written mid-archive land again in the next tar — duplicates
        // are benign on an ordered restore, gaps would not be.
        if (opts.storageDir) {
          try {
            const walkStart = new Date();
            const since = state.lastImagesArchiveAt ? Date.parse(state.lastImagesArchiveAt) : 0;
            await archiveImages(opts.storageDir, opts.dir, since, walkStart);
            state.lastImagesArchiveAt = walkStart.toISOString();
          } catch (e) {
            // Also log it: state.lastError is a single slot, and a later prune
            // failure in the same run would otherwise displace this message.
            console.error('images archive failed:', e);
            state.lastError = `images archive failed: ${(e as Error).message}`;
          }
        }
        try {
          pruneBackups(opts.dir, opts.retention());
        } catch (e) {
          const msg = `prune failed: ${(e as Error).message}`;
          state.lastError = state.lastError ? `${state.lastError}; ${msg}` : msg;
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
  tables: {
    users: Record<string, unknown>[];
    posts: Record<string, unknown>[];
    pages?: Record<string, unknown>[];
    media?: Record<string, unknown>[];
    media_folders?: Record<string, unknown>[];
  };
}

const asJsonb = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/**
 * `media.tags` is `text[]`, not jsonb.
 * @ai-warning It CANNOT round-trip through `asJsonb` the way every other
 * non-scalar column does — a JSON string bound to a `text[]` column is either
 * a type error or, worse, one array element containing literal JSON. It needs
 * a real JS array bound with an explicit `::text[]` cast.
 */
const asTextArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** Restore a dump inside one transaction. Deleting users cascades to sessions
 * (FK ON DELETE CASCADE), so every login is invalidated. */
export async function restoreDatabase(
  pool: DbPool,
  filePath: string,
): Promise<{ users: number; posts: number; pages: number; media: number }> {
  const dump = JSON.parse(gunzipSync(readFileSync(filePath)).toString('utf8')) as Dump;
  // @ai-warning An ALLOW-LIST, not a minimum. Every DUMP_VERSION bump must be
  // added here or dumps written by the new code are unrestorable.
  if (![1, 2, 3].includes(dump.version)) throw new BackupError(`unsupported dump version ${dump.version}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM posts');
    // @ai-warning media MUST be deleted before users. `media.uploaded_by`
    // references `users(id) ON DELETE SET NULL`, so deleting users first would
    // null out every uploader attribution on rows that are about to be
    // re-inserted anyway — silent, and only visible long after the restore.
    await client.query('DELETE FROM media');
    await client.query('DELETE FROM media_folders');
    await client.query('DELETE FROM users');
    for (const u of dump.tables.users) {
      await client.query(
        'INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES ($1,$2,$3,$4,$5)',
        [u.id, u.username, u.password_hash, u.is_admin, u.created_at],
      );
    }
    for (const p of dump.tables.posts) {
      // published_snapshot/published_at are absent from older dumps → inserted
      // as NULL here, then backfilled below in this same transaction.
      await client.query(
        `INSERT INTO posts (id, translation_key, locale, slug, title, date, country, country_code, region,
           excerpt, hero_image, coordinates, stops, route, key_facts, body_markdown, images, status, created_at, updated_at,
           published_snapshot, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15::jsonb,$16,$17::jsonb,$18,$19,$20,$21::jsonb,$22)`,
        [p.id, p.translation_key, p.locale, p.slug, p.title, p.date, p.country, p.country_code, p.region,
         p.excerpt, asJsonb(p.hero_image), asJsonb(p.coordinates), asJsonb(p.stops), p.route,
         asJsonb(p.key_facts), p.body_markdown, asJsonb(p.images), p.status, p.created_at, p.updated_at,
         asJsonb(p.published_snapshot), p.published_at ?? null],
      );
    }
    // @ai-warning: pre-snapshot dumps (v1, and v2 files written before issue
    // #20) carry no published_snapshot, so their published rows would land
    // NULL — invisible to the site loader (`published_snapshot IS NOT NULL`)
    // until ensureSchema runs at the NEXT app start, which the documented
    // restore flow (CLI restore → POST /rebuild, no restart) never triggers.
    // Backfill in the same transaction, exactly like the ensureSchema
    // migration: promote the restored working copy of already-published rows
    // into the snapshot. The NULL guard keeps new-format dumps intact — their
    // restored snapshots (and any unpublished draft edits) survive unchanged.
    await client.query(
      `UPDATE posts SET published_snapshot = ${POST_SNAPSHOT_SQL},
                        published_at = COALESCE(published_at, updated_at)
        WHERE status = 'published' AND published_snapshot IS NULL`,
    );
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
    // v1/v2 dumps predate the media library and carry no media tables — leave
    // existing rows alone rather than wiping metadata the dump never captured.
    // (The DELETEs above already ran; re-inserting nothing is the correct
    // outcome for a dump that genuinely had no media, and for an older dump
    // the files on disk are still there, so `POST /media/rescan` rebuilds the
    // rows.)
    for (const f of dump.tables.media_folders ?? []) {
      await client.query(
        `INSERT INTO media_folders (path, created_at) VALUES ($1, $2) ON CONFLICT (path) DO NOTHING`,
        [f.path, f.created_at ?? new Date()],
      );
    }
    for (const m of dump.tables.media ?? []) {
      await client.query(
        `INSERT INTO media (key, folder, title, alt_de, alt_en, caption_de, caption_en, tags,
                            width, height, orig_bytes, variant_bytes, status, error,
                            taken_at, camera, lens, lat, lng, uploaded_at, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [m.key, m.folder, m.title, m.alt_de, m.alt_en, m.caption_de, m.caption_en, asTextArray(m.tags),
         m.width, m.height, m.orig_bytes, m.variant_bytes, m.status, m.error ?? null,
         m.taken_at ?? null, m.camera ?? null, m.lens ?? null, m.lat ?? null, m.lng ?? null,
         m.uploaded_at ?? new Date(), m.uploaded_by ?? null],
      );
    }
    await client.query('COMMIT');
    return {
      users: dump.tables.users.length, posts: dump.tables.posts.length,
      pages: dump.tables.pages?.length ?? 0, media: dump.tables.media?.length ?? 0,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
