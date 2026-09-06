import { gzipSync, gunzipSync } from 'node:zlib';
import {
  existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { create as createTar } from 'tar';
import type { BackupSchedule } from './settings.js';
import { POST_SNAPSHOT_SQL, type DbPool } from './db.js';
import { diskSpace, formatBytes, UPLOAD_HEADROOM_BYTES, type DiskSpace } from './disk.js';

/**
 * v4 added `posts.categories`, `posts.tags` and `posts.scheduled_at` (issue #107);
 * v3 added `media` + `media_folders` (issue #64); v2 added `pages`.
 * @ai-warning Bumping this ALSO requires widening the allow-list guard in
 * `restoreDatabase` — otherwise every newly written dump becomes unrestorable,
 * and a test that only checks "an old dump still restores" passes anyway.
 */
export const DUMP_VERSION = 4;
export const BACKUP_FILE_RE = /^db-\d{8}-\d{6}\.json\.gz$/;
export const IMAGES_ARCHIVE_RE = /^images-\d{8}-\d{6}\.tar$/;
/**
 * In-flight write of a dump, an archive or state.json (`<final>.<pid>.tmp`,
 * see `atomicWrite`). Matches neither regex above, so a leftover is never
 * listed, served or pruned — which is exactly why `sweepTempFiles` exists.
 */
const TEMP_FILE_RE = /^(?:db-\d{8}-\d{6}\.json\.gz|images-\d{8}-\d{6}\.tar|state\.json)\.\d+\.tmp$/;

export class BackupError extends Error {}

/**
 * Where MDX exports and (under `db/`) dumps land. Without `BACKUP_DIR` it is a
 * sibling of the image store — `/data/backup` in the container, `./data/backup`
 * beside `STORAGE_DIR=./data/images` in bare dev — the same derivation
 * `SETTINGS_PATH` uses, so a developer's publish never tries to write `/data`
 * (#145). Shared by the app and the restore CLI so both name one directory.
 */
export function resolveBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BACKUP_DIR ?? join(dirname(env.STORAGE_DIR ?? '/data/images'), 'backup');
}

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** A pool: hands out one dedicated client so a dump can run inside a single
 * transaction. `pg.Pool` satisfies this structurally. */
export interface Connectable extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
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
 * don't belong in backups) as one gzipped, versioned JSON file. Returns the filename.
 * @ai-note The five SELECTs run on ONE client inside a REPEATABLE READ READ ONLY
 * transaction, so they see the same snapshot. Autocommit on the pool would let a
 * bulk delete of a post + its media land between two SELECTs and produce a dump
 * whose posts reference media rows that are not in it. */
export async function dumpDatabase(db: Connectable, dir: string, now: Date = new Date()): Promise<string> {
  const client = await db.connect();
  let users: Record<string, unknown>[];
  let posts: Record<string, unknown>[];
  let pages: Record<string, unknown>[];
  let media: Record<string, unknown>[];
  let mediaFolders: Record<string, unknown>[];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    users = (await client.query('SELECT * FROM users ORDER BY created_at')).rows;
    // @ai-warning: node-postgres parses `date` (a DATE column) as a LOCAL-midnight
    // JS Date; JSON.stringify then serializes it in UTC, shifting the calendar day
    // west of UTC (e.g. Europe/Berlin: 2026-01-01 -> "2025-12-31T23:00:00.000Z").
    // Export it as text via to_char so the dump — and the eventual restore — carry
    // the exact calendar date instead of a shifted timestamp.
    posts = (await client.query(
      `SELECT id, translation_key, locale, slug, title, to_char(date, 'YYYY-MM-DD') AS date, country,
         country_code, region, excerpt, hero_image, coordinates, stops, route, key_facts, body_markdown,
         images, status, created_at, updated_at, published_snapshot, published_at,
         categories, tags, scheduled_at
       FROM posts ORDER BY created_at`,
    )).rows;
    pages = (await client.query('SELECT key, locale, title, body_markdown, images FROM pages ORDER BY key, locale')).rows;
    // The media library's metadata. The FILES are captured by the incremental
    // images archive, not here — without these rows a restore would bring the
    // photos back but lose every folder, caption and tag, which is the worst
    // kind of partial recovery.
    media = (await client.query('SELECT * FROM media ORDER BY key')).rows;
    mediaFolders = (await client.query('SELECT path, created_at FROM media_folders ORDER BY path')).rows;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  mkdirSync(dir, { recursive: true });
  const payload = gzipSync(JSON.stringify({
    version: DUMP_VERSION, createdAt: now.toISOString(),
    tables: { users, posts, pages, media, media_folders: mediaFolders },
  }));
  // @ai-warning Names have one-second resolution and every writer — the
  // scheduler in the app, "Back up now", and the restore CLI running in a
  // SEPARATE process via `docker compose exec` — shares this directory. A dump
  // that reused a name would silently destroy the state the earlier file held
  // (issue #114: the pre-restore dump is the operator's only undo copy), and
  // an exists-check before `rename` is a cross-process race. So the name is
  // claimed atomically: the payload is written to a private temp file and
  // published with link(2), which fails with EEXIST if the name is taken
  // (rename(2) would overwrite). On EEXIST the stamp advances one second and
  // the link is retried; `createdAt` stays the real time either way.
  const tmp = join(dir, `.db-${process.pid}-${now.getTime()}.tmp`);
  writeFileSync(tmp, payload);
  try {
    for (let stamp = now; ; stamp = new Date(stamp.getTime() + 1000)) {
      const name = `db-${fileStamp(stamp)}.json.gz`;
      try {
        linkSync(tmp, join(dir, name));
        return name;
      } catch (e) {
        if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Refused before writing: the archive would not fit on the backup volume. */
export class ArchiveSpaceError extends BackupError {}

/**
 * Tar output ≈ payload + one 512-byte header per entry, padding, and the odd
 * pax extension for a long path; 2 KiB per entry is a comfortable ceiling.
 */
const TAR_PER_ENTRY_OVERHEAD = 2048;

/**
 * Incremental images archive: tars every file under `storageDir` whose mtime is
 * >= `sinceMs` into `images-<stamp>.tar` in `dir` (next to the db dumps).
 * Returns the filename, or null — writing nothing — when no file qualifies.
 * Consecutive archives form a chain; restore by untarring them oldest-first
 * into an empty images dir (duplicate entries across tars are benign in that
 * order). Archives are deliberately never pruned: each holds a unique slice.
 *
 * Refuses with `ArchiveSpaceError` — before creating any file — when the
 * estimated tar plus the upload reserve would not fit on `dir`'s volume
 * (#113): the archive is the largest single writer on `/data`, and filling
 * the volume takes uploads AND publishing down with it. `space` is injectable
 * for tests; a failing statfs is logged and the archive proceeds, the same
 * fail-open convention as `/upload`.
 */
export async function archiveImages(
  storageDir: string,
  dir: string,
  sinceMs: number,
  now: Date = new Date(),
  space: (path: string) => Promise<DiskSpace> = diskSpace,
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
  const fresh: string[] = [];
  let payloadBytes = 0;
  for (const rel of names) {
    const st = statSync(join(storageDir, rel), { throwIfNoEntry: false });
    if (st !== undefined && st.isFile() && st.mtimeMs >= sinceMs) {
      fresh.push(rel);
      payloadBytes += st.size;
    }
  }
  if (fresh.length === 0) return null;
  mkdirSync(dir, { recursive: true });
  const needed = payloadBytes + fresh.length * TAR_PER_ENTRY_OVERHEAD + UPLOAD_HEADROOM_BYTES;
  let free: number | undefined;
  try {
    ({ free } = await space(dir));
  } catch (e) {
    console.error('could not read free disk space; archiving anyway:', e);
  }
  if (free !== undefined && free < needed) {
    throw new ArchiveSpaceError(
      `not enough free disk space for the images archive (${formatBytes(free)} available, ` +
      `about ${formatBytes(needed)} required for ${fresh.length} files)`,
    );
  }
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
  // The temp is unlinked on ANY failure — a rejected tar, or the process
  // exiting mid-stream (`docker stop`'s SIGTERM ends in process.exit() without
  // waiting for an archive). A multi-GB leftover is otherwise invisible to
  // prune and the UI, and one per attempt fills /data (#113). SIGKILL is the
  // one path this cannot cover; `sweepTempFiles` reclaims those.
  const tmp = join(dir, `${name}.${process.pid}.tmp`);
  const discard = () => rmSync(tmp, { force: true });
  process.on('exit', discard);
  try {
    await createTar({ file: tmp, cwd: storageDir, portable: true }, fresh);
    renameSync(tmp, join(dir, name));
  } catch (e) {
    discard();
    throw e;
  } finally {
    process.off('exit', discard);
  }
  return name;
}

/**
 * Remove in-flight temp files a killed process left behind; returns the names
 * actually removed. Only call when no write is in progress in THIS process
 * (`createDbBackup` guards it with its `running` flag); one app process owns
 * a backup directory. Never throws: a leftover that cannot be unlinked (a
 * read-only backup dir) is logged and left for the next sweep — housekeeping
 * must not take down boot or a scheduled run.
 */
export function sweepTempFiles(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const swept: string[] = [];
  for (const name of names) {
    if (!TEMP_FILE_RE.test(name)) continue;
    try {
      rmSync(join(dir, name), { force: true });
      swept.push(name);
    } catch (e) {
      console.error(`could not remove stale backup temp file ${name}:`, e);
    }
  }
  return swept;
}

/** `images-YYYYMMDD-HHmmss.tar` → epoch ms of its (UTC) stamp. */
function archiveStampMs(name: string): number {
  const s = name.slice('images-'.length, -'.tar'.length);
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
}

/**
 * The mtime cutoff the archives on disk can vouch for: the stamp of the
 * newest `images-*.tar`, or 0 when there is none. Lets a lost or corrupt
 * `state.json` degrade to an incremental run instead of re-tarring the whole
 * corpus, and makes a hand-emptied archive dir start a fresh full chain (#113).
 *
 * @ai-note A same-second collision bumps a name FORWARD of its walk-start, so
 * the newest stamp alone could sit after the real cutoff — a gap. Every
 * archive in a run of consecutive-second stamps started at or after the
 * earliest of them, so that one is the safe answer (a few seconds of benign
 * duplicates at worst).
 */
export function archiveChainCutoff(dir: string): number {
  const stamps = listImageArchives(dir).map((f) => archiveStampMs(f.name)); // newest first
  if (stamps.length === 0) return 0;
  let cutoff = stamps[0]!;
  for (let i = 1; i < stamps.length && stamps[i] === cutoff - 1000; i++) cutoff = stamps[i]!;
  return cutoff;
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

const isTimestamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

/**
 * Reads and validates `state.json`; a missing, unparsable or malformed file
 * degrades to `{}` (logged unless simply absent), and any field that is not
 * what it claims to be is dropped. A garbage timestamp must never reach a
 * comparison as NaN: `mtimeMs >= NaN` archives nothing while the cutoff still
 * advances — a silent gap in the chain (#113).
 */
export function readState(dir: string): BackupState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('backup state.json unreadable, treating as empty:', e);
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.error('backup state.json is not an object, treating as empty');
    return {};
  }
  const r = raw as Record<string, unknown>;
  const state: BackupState = {};
  if (isTimestamp(r.lastAttemptAt)) state.lastAttemptAt = r.lastAttemptAt;
  if (isTimestamp(r.lastSuccessAt)) state.lastSuccessAt = r.lastSuccessAt;
  if (isTimestamp(r.lastImagesArchiveAt)) state.lastImagesArchiveAt = r.lastImagesArchiveAt;
  if (typeof r.lastError === 'string') state.lastError = r.lastError;
  return state;
}

export function writeState(dir: string, state: BackupState): void {
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, STATE_FILE), JSON.stringify(state, null, 2));
}

const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;
/** 1970-01-01 was a Thursday; shift so weekly windows open on Monday 00:00 UTC. */
const MONDAY_OFFSET_MS = 3 * DAY_MS;

/** Index of the calendar window (UTC day / Monday-anchored UTC week) containing `ms`. */
function scheduleWindow(schedule: Exclude<BackupSchedule, 'off'>, ms: number): number {
  return schedule === 'daily' ? Math.floor(ms / DAY_MS) : Math.floor((ms + MONDAY_OFFSET_MS) / WEEK_MS);
}

/**
 * Due once per calendar window: the first tick of a new UTC day (daily) or
 * Monday-anchored UTC week (weekly) after the last success. An elapsed-time
 * rule (`now - lastSuccessAt >= 24 h`) drifts with an hourly tick: the stamp
 * lands after the dump, so the effective period was 25 h and the run walked
 * around the clock (#113). A window missed while the app was down is caught
 * up on the next tick or boot.
 */
export function isBackupDue(state: BackupState, schedule: BackupSchedule, nowMs: number): boolean {
  if (schedule === 'off') return false;
  if (!state.lastSuccessAt) return true;
  return scheduleWindow(schedule, nowMs) > scheduleWindow(schedule, Date.parse(state.lastSuccessAt));
}

export interface DbBackup {
  dir: string;
  runNow(): Promise<BackupState>;
  /** True while a run is in flight — `POST /backups` answers 409 instead of a stale state. */
  running(): boolean;
  /** Reclaim temp files a killed process left behind; a no-op while running. */
  sweepTempFiles(): string[];
  list(): BackupFileInfo[];
  listImageArchives(): BackupFileInfo[];
  state(): BackupState;
}

export function createDbBackup(
  opts: { db: Connectable; dir: string; retention: () => number; storageDir?: string },
): DbBackup {
  let running = false;
  const sweep = (): string[] => {
    if (running) return [];
    const swept = sweepTempFiles(opts.dir);
    if (swept.length) console.error(`removed ${swept.length} stale backup temp file(s): ${swept.join(', ')}`);
    return swept;
  };
  return {
    dir: opts.dir,
    running: () => running,
    sweepTempFiles: sweep,
    list: () => listBackups(opts.dir),
    listImageArchives: () => listImageArchives(opts.dir),
    state: () => readState(opts.dir),
    async runNow() {
      if (running) return readState(opts.dir);
      // Reclaim a crashed run's leftover BEFORE writing, so a repeat attempt
      // never stacks a second multi-GB temp on top of the first.
      sweep();
      running = true;
      const state = readState(opts.dir);
      state.lastAttemptAt = new Date().toISOString();
      // Persist the attempt up front so `state()` reports THIS run's start
      // while it is in flight (the UI shows it next to "Running…"), and a
      // SIGKILLed run leaves an attempt newer than its last success behind.
      try { writeState(opts.dir, state); } catch { /* recorded again at the end */ }
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
            // Lost or corrupt state → resume from the newest tar's stamp; no
            // tar on disk at all (hand-emptied dir) → a fresh full chain. An
            // intact state next to an existing chain is trusted as-is: the
            // stamp is only a truncation or a collision bump away from it.
            const chain = archiveChainCutoff(opts.dir);
            const stored = state.lastImagesArchiveAt ? Date.parse(state.lastImagesArchiveAt) : undefined;
            const since = stored === undefined || chain === 0 ? chain : stored;
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

export interface Dump {
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

/** Parse a dump file and reject versions this code cannot restore. Shared by
 * `restoreDatabase` and the CLI's pre-restore summary, so an unrestorable file
 * is refused before anything (a pre-restore dump, a transaction) happens.
 * @ai-warning An ALLOW-LIST, not a minimum. Every DUMP_VERSION bump must be
 * added here or dumps written by the new code are unrestorable. */
export function readDump(filePath: string): Dump {
  const dump = JSON.parse(gunzipSync(readFileSync(filePath)).toString('utf8')) as Dump;
  if (![1, 2, 3, 4].includes(dump.version)) throw new BackupError(`unsupported dump version ${dump.version}`);
  return dump;
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
  const dump = readDump(filePath);
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
      // categories/tags/scheduled_at are absent from v<=3 dumps → restored at
      // their column defaults ('{}', '{}', NULL); nothing to backfill from.
      await client.query(
        `INSERT INTO posts (id, translation_key, locale, slug, title, date, country, country_code, region,
           excerpt, hero_image, coordinates, stops, route, key_facts, body_markdown, images, status, created_at, updated_at,
           published_snapshot, published_at, categories, tags, scheduled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15::jsonb,$16,$17::jsonb,$18,$19,$20,$21::jsonb,$22,
           $23::text[],$24::text[],$25)`,
        [p.id, p.translation_key, p.locale, p.slug, p.title, p.date, p.country, p.country_code, p.region,
         p.excerpt, asJsonb(p.hero_image), asJsonb(p.coordinates), asJsonb(p.stops), p.route,
         asJsonb(p.key_facts), p.body_markdown, asJsonb(p.images), p.status, p.created_at, p.updated_at,
         asJsonb(p.published_snapshot), p.published_at ?? null,
         asTextArray(p.categories), asTextArray(p.tags), p.scheduled_at ?? null],
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
