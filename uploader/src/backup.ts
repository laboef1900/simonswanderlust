import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  closeSync, constants, createWriteStream, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Pack } from 'tar';
import type { BackupSchedule } from './settings.js';
import { POST_SNAPSHOT_SQL, type DbClient, type DbPool } from './db.js';
import { diskSpace, formatBytes, UPLOAD_HEADROOM_BYTES, type DiskSpace } from './disk.js';
import { isEncryptedSecret, type EncryptedSecret } from './secrets.js';
import { storedProcessOptions } from './pipeline.js';
import type { GpxFiles } from './gpx-files.js';
import {
  createRouteArchive, ROUTE_ARCHIVE_RE, routeRecoverySummary, stageRouteRestore,
  validateRouteDumpRows, validateRouteManifest, type RouteArchiveManifest,
  type RouteDumpRow, type RouteRecoverySummary, type StagedRouteRestore,
} from './gpx-backup.js';
import { publishedTrackOf, type PublishedTrackRow } from './published-track.js';
import { IdentityError, IDENTITY_LOCALIZED_FIELDS, normalizeIdentity } from '../../site/src/lib/site-identity.js';
import { identityFromRow, type IdentityRow } from './site-identity.js';
import { LEGACY_IDENTITY } from './site-identity-legacy.js';
import { IDENTITY_ASSET_ROLES, validateIdentityAsset, validateIdentityAssetMetadata, type StoredIdentityAsset } from './site-identity-assets.js';
import { DEFAULT_LANGUAGE, type LanguageConfig } from './language.js';
import { validatePublicTrack } from '../public/gpx-public-track.js';
import { validateNavigation, type Navigation } from '../../site/src/lib/navigation.js';
import { isPageKind } from '../../site/src/lib/page-kinds.js';
import { isSafePageKey } from './pages.js';
import { imagesMapError } from './body-content.js';
import { isSafeSlug } from './posts.js';
import { namespaceOf, reservation } from '../../site/src/lib/reserved-routes.js';
import { configuredOriginRoles, validateCanonicalRoles, type OriginRoles } from './canonical-origin.js';

/**
 * v8 (issue #204) added reader `comments` (no email — the spec stores none;
 * `sender_hash` is a keyed IP HMAC) and `posts.comments_enabled`. A v<=7 dump
 * has neither key: restoring it leaves an EMPTY comments table (comments
 * cannot outlive posts the dump may not contain) and comments_enabled = true
 * (the column default; the site-wide setting is the real off switch).
 * v9 adds the optional story-only `posts.title_image`; older dumps restore it as NULL.
 * v10 adds private `post_routes` and a full manifest-matched original archive.
 * These recovery sets deliberately contain private coordinates and timestamps.
 * v11 adds the singleton site identity and bounded PNG identity assets.
 * Pre-identity restores recover the legacy brand while retaining a live canonical origin.
 * v12 adds language configuration and explicit per-row omission.
 * v7 added media `format` + `encoding`, preserving JPEG-only sets and their
 * snapped retry/recovery profile across restore.
 * v6 added encrypted `app_secrets` (never the encryption master key);
 * v5 added `posts.featured`; v4 added categories/tags/scheduling;
 * v3 added `media` + `media_folders`; v2 added `pages`.
 * @ai-warning Bumping this ALSO requires widening the allow-list guard below.
 */
export const DUMP_VERSION = 13;
export const PAGES_NAV_DUMP_VERSION = 13;
export const LANGUAGE_DUMP_VERSION = 12;
/** Introduction boundary, independent of later language/content format additions. */
export const IDENTITY_DUMP_VERSION = 11;
/** Every version `readDump` accepts — an allow-list, not a minimum. */
export const SUPPORTED_DUMP_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
export const BACKUP_FILE_RE = /^db-\d{8}-\d{6}\.json\.gz$/;
export const IMAGES_ARCHIVE_RE = /^images-\d{8}-\d{6}\.tar$/;
/**
 * In-flight write of a dump, an archive or state.json (`<final>.<pid>.tmp`,
 * see `atomicWrite`). Matches neither regex above, so a leftover is never
 * listed, served or pruned — which is exactly why `sweepTempFiles` exists.
 */
const TEMP_FILE_RE = /^(?:db-\d{8}-\d{6}\.json\.gz|images-\d{8}-\d{6}\.tar|routes-\d{8}-\d{6}-[0-9a-f]{32}\.tar|state\.json)\.\d+\.tmp$|^\.db-\d+-\d+-[0-9a-f]+\.tmp$/;

export class BackupError extends Error {}

/** New formats validate all rows; old GPX artifacts retain their two-snapshot rule. */
function validatePublishedTracks(posts: readonly Record<string, unknown>[], language: LanguageConfig, legacy: boolean): void {
  const pairs = new Map<string, PublishedTrackRow[]>();
  try {
    for (const post of posts) {
      if (!post || typeof post.translation_key !== 'string' || !post.translation_key) throw new Error();
      const rows = pairs.get(post.translation_key) ?? [];
      rows.push({ locale: post.locale, status: post.status, omitted: post.omitted,
        published_at: post.published_at, published_snapshot: post.published_snapshot });
      pairs.set(post.translation_key, rows);
    }
    for (const rows of pairs.values()) {
      if (!legacy) { publishedTrackOf(rows, language); continue; }
      const tracked = rows.filter(row => row.published_snapshot !== null && typeof row.published_snapshot === 'object'
        && Object.hasOwn(row.published_snapshot, 'track'));
      if (!tracked.length) continue;
      if (rows.length !== 2 || tracked.length !== 2 || !rows.some(row => row.locale === 'de') || !rows.some(row => row.locale === 'en')) throw new Error();
      const tracks = tracked.map(row => {
        const snapshot = row.published_snapshot;
        if (!snapshot || typeof snapshot !== 'object' || !('track' in snapshot)) throw new Error();
        return validatePublicTrack(snapshot.track);
      });
      if (JSON.stringify(tracks[0]!.coordinates) !== JSON.stringify(tracks[1]!.coordinates)) throw new Error();
    }
  } catch {
    throw new BackupError('Invalid public route snapshots in backup.');
  }
}

/** Version determines recovery semantics, never the accidental presence of fields. */
export function dumpLanguage(dump: Dump): LanguageConfig {
  if (dump.version < LANGUAGE_DUMP_VERSION) return DEFAULT_LANGUAGE;
  const rows = dump.tables.site_language;
  if (!Array.isArray(rows) || rows.length !== 1) throw new BackupError('Invalid language configuration in backup.');
  const row = rows[0]!;
  if (!row || row.id !== true || (row.primary_locale !== 'de' && row.primary_locale !== 'en')
    || !Array.isArray(row.enabled_locales) || row.enabled_locales.length < 1 || row.enabled_locales.length > 2
    || row.enabled_locales.some(locale => locale !== 'de' && locale !== 'en')
    || new Set(row.enabled_locales).size !== row.enabled_locales.length
    || !row.enabled_locales.includes(row.primary_locale)
    || (row.locked_at !== null && !isIdentityTimestamp(row.locked_at))
    || !isIdentityTimestamp(row.updated_at)) throw new BackupError('Invalid language configuration in backup.');
  return { primary: row.primary_locale, locales: row.enabled_locales as ('de' | 'en')[] };
}

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
  /** Images-filesystem publication boundary, trusted only with its provenance tag. */
  lastImagesArchiveAt?: string;
  imagesCutoffSource?: 'filesystem-v1';
  routeRecovery?: RouteRecoverySummary;
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

export interface DumpOptions {
  routeFiles?: GpxFiles;
  isWritable?: () => boolean;
  /** Boot-only pre-schema recovery capture; never downgrade an active language mode. */
  preLanguageMigration?: boolean;
  prePagesMigration?: boolean;
}

/** Dump durable content, accounts, media metadata, and encrypted credentials
 * (never sessions or the master key) as one gzipped JSON file. Returns the filename.
 * @ai-note The SELECTs run on ONE client inside a REPEATABLE READ READ ONLY
 * transaction, so they see the same snapshot. Autocommit on the pool would let a
 * bulk delete of a post + its media land between two SELECTs and produce a dump
 * whose posts reference media rows that are not in it. */
export async function dumpDatabase(db: Connectable, dir: string, now: Date = new Date(), options: DumpOptions = {}): Promise<string> {
  const capture = () => captureDatabase(db, dir, now, options);
  return options.routeFiles ? options.routeFiles.gate.runExclusive(capture) : capture();
}

async function captureDatabase(db: Connectable, dir: string, now: Date, options: DumpOptions): Promise<string> {
  const writable = () => { if (options.isWritable?.() === false) throw new BackupError('storage_read_only'); };
  writable();
  const client = await db.connect();
  let users: Record<string, unknown>[];
  let posts: Record<string, unknown>[];
  let pages: Record<string, unknown>[];
  let media: Record<string, unknown>[];
  let mediaFolders: Record<string, unknown>[];
  let appSecrets: Record<string, unknown>[];
  let comments: Record<string, unknown>[];
  let siteIdentity: Record<string, unknown>[] | undefined;
  let identityAssets: Record<string, unknown>[] | undefined;
  let siteLanguage: Record<string, unknown>[] | undefined;
  let siteNav: Record<string, unknown>[] | undefined;
  let version = DUMP_VERSION;
  let routeRows: RouteDumpRow[] = [];
  let routeArchive: RouteArchiveManifest | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const languageTableExists = (await client.query("SELECT to_regclass('site_language') IS NOT NULL AS present")).rows[0]?.present === true;
    const omissionColumnExists = !options.preLanguageMigration || (await client.query(
      "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='posts'::regclass AND attname='omitted' AND NOT attisdropped) AS present",
    )).rows[0]?.present === true;
    const hasLanguage = languageTableExists && omissionColumnExists;
    if (languageTableExists && !hasLanguage) {
      const rows = (await client.query('SELECT * FROM site_language ORDER BY id')).rows;
      if (rows.length && (rows.length !== 1 || rows[0]!.primary_locale !== 'de'
        || !Array.isArray(rows[0]!.enabled_locales) || rows[0]!.enabled_locales.length !== 2
        || !rows[0]!.enabled_locales.includes('de') || !rows[0]!.enabled_locales.includes('en')
        || rows[0]!.locked_at !== null)) {
        throw new BackupError('Cannot capture an active language mode as a legacy recovery set.');
      }
    }
    if (!hasLanguage && options.preLanguageMigration) {
      const omitted = (await client.query("SELECT 1 FROM posts WHERE to_jsonb(posts)->>'omitted' = 'true' LIMIT 1")).rows;
      if (omitted.length) throw new BackupError('Cannot capture omitted stories as a legacy recovery set.');
    }
    if (hasLanguage) {
      siteLanguage = (await client.query('SELECT * FROM site_language ORDER BY id')).rows.map(row => ({
        ...row,
        locked_at: row.locked_at instanceof Date ? row.locked_at.toISOString() : row.locked_at,
        updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      }));
    } else version = IDENTITY_DUMP_VERSION; // Pre-migration recovery set.
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
         categories, tags, scheduled_at, featured, comments_enabled, title_image${hasLanguage ? ', omitted' : ''}
       FROM posts ORDER BY created_at`,
    )).rows;
    validatePublishedTracks(posts, dumpLanguage({ version, createdAt: now.toISOString(),
      tables: { users, posts, site_language: siteLanguage } }), version < LANGUAGE_DUMP_VERSION);
    comments = (await client.query(
      `SELECT id, translation_key, locale, name, body, status, is_author, sender_hash, created_at
         FROM comments ORDER BY created_at, id`,
    )).rows;
    const hasPagesNav = (await client.query("SELECT to_regclass('site_nav') IS NOT NULL AS present")).rows[0]?.present === true;
    if (hasPagesNav) {
      if (version < PAGES_NAV_DUMP_VERSION) throw new BackupError('Cannot capture page/navigation content without the complete language schema.');
      pages = (await client.query('SELECT key,locale,title,body_markdown,images,slug,status,published_at,updated_at FROM pages ORDER BY key,locale')).rows;
      siteNav = (await client.query('SELECT id,config,updated_at FROM site_nav ORDER BY id')).rows;
    } else {
      if (!options.prePagesMigration && !options.preLanguageMigration) throw new BackupError('Page/navigation schema is missing.');
      const unsafe = await client.query(`SELECT 1 FROM pages WHERE COALESCE(to_jsonb(pages)->>'slug','')<>''
        OR (key<>'about' AND to_jsonb(pages)->>'status'='published') LIMIT 1`);
      if (unsafe.rows.length) throw new BackupError('Cannot capture new page content as a legacy recovery set.');
      version = Math.min(version, LANGUAGE_DUMP_VERSION);
      pages = (await client.query('SELECT key,locale,title,body_markdown,images FROM pages ORDER BY key,locale')).rows;
    }
    // The media library's metadata. The FILES are captured by the incremental
    // images archive, not here — without these rows a restore would bring the
    // photos back but lose every folder, caption and tag, which is the worst
    // kind of partial recovery.
    media = (await client.query('SELECT * FROM media ORDER BY key')).rows;
    mediaFolders = (await client.query('SELECT path, created_at FROM media_folders ORDER BY path')).rows;
    try {
      appSecrets = (await client.query('SELECT key, ciphertext, iv, tag, updated_at FROM app_secrets ORDER BY key')).rows;
    } catch {
      throw new BackupError('Encrypted credentials could not be backed up.');
    }
    const preIdentity = options.preLanguageMigration
      && (await client.query("SELECT to_regclass('site_identity') IS NULL AS absent")).rows[0]?.absent === true;
    if (preIdentity) {
      if (hasLanguage) throw new BackupError('Cannot capture an active language mode without its identity recovery metadata.');
      version = IDENTITY_DUMP_VERSION - 1;
    } else {
      siteIdentity = (await client.query('SELECT * FROM site_identity ORDER BY id')).rows.map((row) => ({
        ...row,
        saved_at: row.saved_at instanceof Date ? row.saved_at.toISOString() : row.saved_at,
        updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      }));
      identityAssets = (await client.query(
        "SELECT role, sha256, width, height, encode(bytes, 'base64') AS bytes, created_at FROM site_identity_assets ORDER BY role",
      )).rows.map((row) => ({
        ...row,
        // PostgreSQL's base64 encoder wraps at 76 columns; dumps use canonical base64.
        bytes: typeof row.bytes === 'string' ? row.bytes.replace(/\n/g, '') : row.bytes,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      }));
      await validateIdentityAssets({ version, createdAt: now.toISOString(),
        tables: { users, posts, site_identity: siteIdentity, site_identity_assets: identityAssets } });
    }
    const rawRoutes = (await client.query(
      'SELECT translation_key, version, geometry, source_id, source_sha256, source_bytes, updated_at FROM post_routes ORDER BY translation_key',
    )).rows.map((row) => ({
      ...row, updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    }));
    validateRouteDumpRows(rawRoutes, posts);
    routeRows = rawRoutes;
    if (routeRows.length && !options.routeFiles) throw new BackupError('Private route storage is required for a complete backup.');
    if (options.routeFiles) routeArchive = await createRouteArchive(options.routeFiles, dir, routeRows, now, options.isWritable);
    writable();
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (routeArchive && options.isWritable?.() !== false) rmSync(join(dir, routeArchive.name), { force: true });
    throw e;
  } finally {
    client.release();
  }
  let temporary: string | undefined;
  let published = false;
  try {
    writable();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = gzipSync(JSON.stringify({
      version, createdAt: now.toISOString(),
      tables: { users, posts, pages, media, media_folders: mediaFolders, app_secrets: appSecrets, comments,
        post_routes: routeRows, site_identity: siteIdentity, site_identity_assets: identityAssets, site_language: siteLanguage, site_nav: siteNav },
      routeArchive,
    }));
    // Claim the final name atomically: a same-second backup or pre-restore
    // undo must never overwrite an earlier recovery set.
    const candidate = join(dir, `.db-${process.pid}-${now.getTime()}-${randomBytes(8).toString('hex')}.tmp`);
    const fd = openSync(candidate, 'wx', 0o600);
    temporary = candidate; // only remove a temp this invocation actually owns
    try { writeFileSync(fd, payload); fsyncSync(fd); } finally { closeSync(fd); }
    for (let stamp = now; ; stamp = new Date(stamp.getTime() + 1000)) {
      const name = `db-${fileStamp(stamp)}.json.gz`;
      try {
        writable();
        linkSync(temporary, join(dir, name));
        published = true;
        const directory = openSync(dir, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
        return name;
      } catch (e) {
        if (!(e instanceof Error && 'code' in e && e.code === 'EEXIST')) throw e;
      }
    }
  } finally {
    if (options.isWritable?.() !== false) {
      try { if (temporary) rmSync(temporary, { force: true }); }
      finally {
        // A final dump already visible after an fsync error must keep its
        // paired archive. A crash without that marker is swept after grace.
        if (!published && routeArchive) rmSync(join(dir, routeArchive.name), { force: true });
      }
    }
  }
}

/** Refused before writing: the archive would not fit on the backup volume. */
export class ArchiveSpaceError extends BackupError {}

/**
 * Tar output ≈ payload + one 512-byte header per entry, padding, and the odd
 * pax extension for a long path; 2 KiB per entry is a comfortable ceiling.
 */
const TAR_PER_ENTRY_OVERHEAD = 2048;

const IMAGE_BOUNDARY_FILE_RE = /^\.archive-boundary-\d+-[0-9a-f]{16}\.tmp$/;

/** Same-filesystem time avoids the kernel inode clock lag behind Date.now() (#335). */
function imageArchiveBoundary(storageDir: string): string | null {
  const marker = join(storageDir, `.archive-boundary-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let fd: number;
  try {
    fd = openSync(marker, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  try {
    // Floor, never round up: a publication in this same filesystem clock tick
    // must qualify on the next inclusive comparison.
    return new Date(Math.floor(fstatSync(fd).ctimeMs)).toISOString();
  } finally {
    try { closeSync(fd); } finally { unlinkSync(marker); }
  }
}

export interface ImageArchiveResult {
  name: string | null;
  /** Null only when the source directory is absent; never advance a cutoff then. */
  boundary: string | null;
}

/**
 * Incremental images archive: tars final files whose mtime OR ctime is >=
 * `sinceMs`. The returned boundary comes from the source filesystem before
 * enumeration; `now` labels the archive only, never the next cutoff.
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
  signal?: AbortSignal,
): Promise<ImageArchiveResult> {
  signal?.throwIfAborted();
  const boundary = imageArchiveBoundary(storageDir);
  if (boundary === null) return { name: null, boundary: null };
  // A source disappearing after the boundary is an error, not an empty walk.
  const names = readdirSync(storageDir, { recursive: true, encoding: 'utf8' });
  const fresh: string[] = [];
  let payloadBytes = 0;
  for (const rel of names) {
    // Rename preserves content mtime but advances publication ctime on our
    // supported local filesystems. Excluding temps alone would lose that final.
    if (/\.part-[0-9a-f]{8}$/.test(rel) || IMAGE_BOUNDARY_FILE_RE.test(rel)) continue;
    const st = statSync(join(storageDir, rel), { throwIfNoEntry: false });
    if (st !== undefined && st.isFile() && (st.mtimeMs >= sinceMs || st.ctimeMs >= sinceMs)) {
      fresh.push(rel);
      payloadBytes += st.size;
    }
  }
  if (fresh.length === 0) return { name: null, boundary };
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
    signal?.throwIfAborted();
    const pack = new Pack({ cwd: storageDir, portable: true, strict: true });
    const destination = createWriteStream(tmp);
    // A tar pack error can precede the destination's asynchronous open. Neither
    // that error nor finish proves the file descriptor is closed (#430).
    const closed = Promise.withResolvers<void>();
    destination.once('close', closed.resolve);
    const copying = pipeline(pack, destination);
    try {
      for (const file of fresh) pack.add(file);
      pack.end();
      await copying;
    } catch (error) {
      pack.destroy();
      destination.destroy();
      await copying.catch(() => {});
      throw error;
    } finally {
      // Node's WriteStream destruction waits for pending open/write callbacks
      // and close. Cleanup and ownership release must wait for it as well.
      await closed.promise;
    }
    // Let an already-running copy settle, but never activate its result after
    // lease loss. quiesce() waits this promise before the app pool closes.
    signal?.throwIfAborted();
    renameSync(tmp, join(dir, name));
  } catch (e) {
    try { discard(); }
    catch { console.error('could not remove unfinished images archive; cleanup deferred to the next sweep'); }
    throw e;
  } finally {
    process.off('exit', discard);
  }
  return { name, boundary };
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

function listByPattern(dir: string, re: RegExp): BackupFileInfo[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => re.test(n))
    .sort()
    .reverse()
    .map((name) => ({ name, size: lstatSync(join(dir, name)).size }));
}

export function listBackups(dir: string): BackupFileInfo[] {
  return listByPattern(dir, BACKUP_FILE_RE);
}

export function listImageArchives(dir: string): BackupFileInfo[] {
  return listByPattern(dir, IMAGES_ARCHIVE_RE);
}

export function listRouteArchives(dir: string): BackupFileInfo[] {
  const referenced = new Set<string>();
  for (const file of listBackups(dir)) {
    try {
      const manifest = readDump(join(dir, file.name)).routeArchive;
      if (manifest) referenced.add(manifest.name);
    } catch {
      // Do not advertise an incomplete set. The manifest pin reader reports
      // the blocked cleanup state independently; valid sets stay downloadable.
    }
  }
  return listByPattern(dir, ROUTE_ARCHIVE_RE).filter((file) => referenced.has(file.name));
}

/** Only the dump is a completion marker. Preserve all archives if even one
 * retained manifest cannot be trusted; never sweep during a live backup. */
export function sweepOrphanRouteArchives(dir: string, nowMs = Date.now()): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw new BackupError('Private route backup manifests are unreadable.');
  }
  const referenced = new Set<string>();
  for (const name of names) {
    if (!BACKUP_FILE_RE.test(name)) continue;
    const manifest = readDump(join(dir, name)).routeArchive;
    if (manifest) referenced.add(manifest.name);
  }
  const swept: string[] = [];
  for (const name of names) {
    if (!ROUTE_ARCHIVE_RE.test(name) || referenced.has(name)) continue;
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || nowMs - stat.mtimeMs < 60 * 60_000) continue;
    rmSync(path);
    swept.push(name);
  }
  return swept;
}

/** Retained dump manifests pin only originals that could not be archived.
 * Immutable dump identities are cached; a changed/unreadable file fails closed. */
export function createRouteManifestPinReader(dir: string): () => Promise<ReadonlySet<string>> {
  const cache = new Map<string, { fingerprint: string; pins: string[] }>();
  return async () => {
    let names: string[];
    try { names = readdirSync(dir).filter((name) => BACKUP_FILE_RE.test(name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set<string>();
      throw new BackupError('Private route backup manifests are unreadable.');
    }
    const pins = new Set<string>();
    for (const name of names) {
      const path = join(dir, name);
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new BackupError('Invalid private route backup manifest.');
      const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      let entry = cache.get(name);
      if (entry?.fingerprint !== fingerprint) {
        const dump = readDump(path);
        entry = { fingerprint, pins: (dump.routeArchive?.originals ?? [])
          .filter((source) => source.state === 'unreadable' || source.state === 'oversized').map((source) => source.sourceId) };
        cache.set(name, entry);
      }
      for (const sourceId of entry.pins) pins.add(sourceId);
    }
    const retained = new Set(names);
    for (const name of cache.keys()) if (!retained.has(name)) cache.delete(name);
    return pins;
  };
}

export function pruneBackups(dir: string, keep: number): string[] {
  const backups = listBackups(dir);
  const doomed = backups.slice(keep).map((f) => f.name);
  // Resolve every manifest before deleting anything: a malformed retained dump
  // must not make a shared archive look unreferenced.
  const manifests = new Map(backups.map((file) => [file.name, readDump(join(dir, file.name)).routeArchive?.name]));
  const retainedArchives = new Set(backups.slice(0, keep).map((file) => manifests.get(file.name)).filter(Boolean));
  for (const name of doomed) {
    rmSync(join(dir, name), { force: true });
    const archive = manifests.get(name);
    if (archive && !retainedArchives.has(archive)) rmSync(join(dir, archive), { force: true });
  }
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
  if (state.lastImagesArchiveAt && r.imagesCutoffSource === 'filesystem-v1') {
    state.imagesCutoffSource = 'filesystem-v1';
  }
  if (typeof r.lastError === 'string') state.lastError = r.lastError;
  if (r.routeRecovery && typeof r.routeRecovery === 'object' && !Array.isArray(r.routeRecovery)) {
    const recovery = r.routeRecovery as Record<string, unknown>;
    const states = ['present', 'missing', 'corrupt', 'unreadable', 'oversized'] as const;
    if (states.every((key) => Number.isSafeInteger(recovery[key]) && (recovery[key] as number) >= 0)) {
      const counts = Object.fromEntries(states.map((key) => [key, recovery[key]])) as Omit<RouteRecoverySummary, 'status'>;
      state.routeRecovery = { ...counts, status: states.slice(1).some((key) => counts[key] > 0) ? 'degraded' : 'complete' };
    }
  }
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
  /** Reclaim crashed-run temps and expired incomplete route archives; no-op while running/read-only. */
  sweepTempFiles(): string[];
  list(): BackupFileInfo[];
  listImageArchives(): BackupFileInfo[];
  listRouteArchives(): BackupFileInfo[];
  quiesce(): Promise<void>;
  state(): BackupState;
}

export function createDbBackup(
  opts: { db: Connectable; dir: string; retention: () => number; storageDir?: string; routeFiles?: GpxFiles; isWritable?: () => boolean; signal?: AbortSignal },
): DbBackup {
  let running = false;
  let stopped = false;
  let settled = Promise.resolve();
  const writable = () => !stopped && !opts.signal?.aborted && opts.isWritable?.() !== false;
  const sweep = (): string[] => {
    if (running || !writable()) return [];
    const swept = sweepTempFiles(opts.dir);
    try { swept.push(...sweepOrphanRouteArchives(opts.dir)); }
    catch { console.error('Private route archive cleanup deferred; backup manifests require attention.'); }
    if (swept.length) console.error(`removed ${swept.length} stale backup file(s): ${swept.join(', ')}`);
    return swept;
  };
  return {
    dir: opts.dir,
    running: () => running,
    sweepTempFiles: sweep,
    list: () => listBackups(opts.dir),
    listImageArchives: () => listImageArchives(opts.dir),
    listRouteArchives: () => listRouteArchives(opts.dir),
    async quiesce() { stopped = true; await settled; },
    state: () => readState(opts.dir),
    async runNow() {
      if (!writable()) throw new BackupError('storage_read_only');
      if (running) return readState(opts.dir);
      // Reclaim a crashed run's leftover BEFORE writing, so a repeat attempt
      // never stacks a second multi-GB temp on top of the first.
      sweep();
      running = true;
      const completion = Promise.withResolvers<void>();
      settled = completion.promise;
      const state = readState(opts.dir);
      state.lastAttemptAt = new Date().toISOString();
      // Recovery completeness belongs to this attempt, not the previous dump.
      // Repopulate only once this run has published its DB + originals set.
      delete state.routeRecovery;
      // Persist the attempt up front so `state()` reports THIS run's start
      // while it is in flight (the UI shows it next to "Running…"), and a
      // SIGKILLed run leaves an attempt newer than its last success behind.
      try { writeState(opts.dir, state); } catch { /* recorded again at the end */ }
      try {
        const dumpName = await dumpDatabase(opts.db, opts.dir, new Date(), { routeFiles: opts.routeFiles, isWritable: writable });
        state.routeRecovery = routeRecoverySummary(readDump(join(opts.dir, dumpName)).routeArchive);
        state.lastSuccessAt = new Date().toISOString();
        delete state.lastError;
        // The recovery set is already complete even if ownership is lost before
        // images or retention work. Preserve that evidence alongside the failure.
        if (!writable()) throw new BackupError('storage_read_only');
        // Only an explicitly filesystem-derived boundary is safe: userspace
        // timestamps (including legacy/collision-bumped archive names) can be
        // ahead of inode publication time. Untrusted state requires a full tar.
        if (opts.storageDir) {
          try {
            const trusted = state.imagesCutoffSource === 'filesystem-v1' && state.lastImagesArchiveAt;
            const since = trusted && listImageArchives(opts.dir).length > 0 ? Date.parse(trusted) : 0;
            const result = await archiveImages(opts.storageDir, opts.dir, since, new Date(), diskSpace, opts.signal);
            if (!writable()) throw new BackupError('storage_read_only');
            if (result.boundary !== null) {
              state.lastImagesArchiveAt = result.boundary;
              state.imagesCutoffSource = 'filesystem-v1';
            }
          } catch (e) {
            // Also log it: state.lastError is a single slot, and a later prune
            // failure in the same run would otherwise displace this message.
            console.error('images archive failed:', e);
            state.lastError = `images archive failed: ${(e as Error).message}`;
          }
        }
        try {
          if (!writable()) throw new BackupError('storage_read_only');
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
        if (writable()) { try { writeState(opts.dir, state); } catch { /* state write failed */ } }
        running = false;
        completion.resolve();
      }
      return { ...state };
    },
  };
}

export interface SecretDumpRow extends EncryptedSecret {
  key: string;
  updated_at: string;
}

export interface Dump {
  version: number;
  createdAt: string;
  routeArchive?: RouteArchiveManifest;
  tables: {
    users: Record<string, unknown>[];
    posts: Record<string, unknown>[];
    pages?: Record<string, unknown>[];
    media?: Record<string, unknown>[];
    media_folders?: Record<string, unknown>[];
    app_secrets?: SecretDumpRow[];
    comments?: Record<string, unknown>[];
    post_routes?: RouteDumpRow[];
    site_identity?: Record<string, unknown>[];
    site_identity_assets?: Record<string, unknown>[];
    site_language?: Record<string, unknown>[];
    site_nav?: Record<string, unknown>[];
  };
}

/** New format metadata is mandatory; legacy formats are normalized only during restore. */
function validateDumpPages(dump: Dump): void {
  if (dump.version < PAGES_NAV_DUMP_VERSION) return;
  const nav = dump.tables.site_nav;
  if (!Array.isArray(nav) || nav.length !== 1 || nav[0]!.id !== 1 || !isIdentityTimestamp(nav[0]!.updated_at)
    || !Array.isArray(dump.tables.pages)) throw new BackupError('Missing page/navigation metadata in backup.');
  try { validateNavigation(nav[0]!.config); } catch { throw new BackupError('Invalid navigation in backup.'); }
  const identities = new Set<string>(); const slugs = new Set<string>();
  const mode = dumpLanguage(dump);
  const byKey = new Map<string, Record<string, unknown>[]>();
  for (const page of dump.tables.pages) {
    if (!page || typeof page.key !== 'string' || !isSafePageKey(page.key) || (page.locale !== 'de' && page.locale !== 'en')
      || typeof page.slug !== 'string' || (page.slug !== '' && !isSafeSlug(page.slug))
      || (page.status !== 'draft' && page.status !== 'published') || typeof page.title !== 'string' || typeof page.body_markdown !== 'string'
      || imagesMapError(page.images) || !isIdentityTimestamp(page.updated_at)
      || (page.published_at !== null && !isIdentityTimestamp(page.published_at))
      || (page.key === 'about' && (page.slug !== '' || page.status !== 'published'))
      || (isPageKind(page.key) && page.status === 'published' && mode.locales.includes(page.locale) && page.published_at === null)) throw new BackupError('Invalid page metadata in backup.');
    const identity = `${page.key}:${page.locale}`; const slug = `${page.locale}:${page.slug}`;
    if (identities.has(identity) || (page.slug && slugs.has(slug))) throw new BackupError('Duplicate page identity or slug in backup.');
    identities.add(identity); if (page.slug) slugs.add(slug);
    const rows = byKey.get(page.key) ?? []; rows.push(page); byKey.set(page.key, rows);
  }
  for (const [key, rows] of byKey) if (isPageKind(key) && (rows.length !== 2 || rows[0]!.status !== rows[1]!.status)) {
    throw new BackupError('Incomplete or inconsistent page pair in backup.');
  }
}

export interface PageRecoverySummary { unresolvedNavigation: number; collisions: string[] }
export interface PageRecoveryContext { navigation: Navigation; pages: Record<string, unknown>[] }
/** Informational preflight, including live state that a legacy restore deliberately preserves. */
export function pageRecoverySummary(dump: Dump, retained?: PageRecoveryContext): PageRecoverySummary {
  const pages: Record<string, unknown>[] = dump.tables.pages
    ? dump.version >= PAGES_NAV_DUMP_VERSION ? dump.tables.pages : dump.tables.pages.map((page) => ({ ...page, slug: '', status: page.key === 'about' ? 'published' : 'draft' }))
    : retained?.pages ?? [];
  const mode = dumpLanguage(dump);
  const nav = dump.version >= PAGES_NAV_DUMP_VERSION ? validateNavigation(dump.tables.site_nav?.[0]?.config) : retained?.navigation;
  const unresolvedNavigation = nav ? (['header', 'footer', 'legal'] as const).reduce((count, slot) => count + nav[slot].filter((item) => {
    if (item.kind === 'page') return item.target !== 'about' && mode.locales.some((locale) => !pages.some((page) =>
      page.key === item.target && page.locale === locale && page.status === 'published' && typeof page.slug === 'string' && !!page.slug
      && typeof page.title === 'string' && !!page.title.trim() && typeof page.body_markdown === 'string' && !!page.body_markdown.trim()));
    return (item.kind === 'path' || item.kind === 'external') && mode.locales.some((locale) => !item.href[locale] || !item.label[locale]);
  }).length, 0) : 0;
  const collisions: string[] = [];
  for (const page of pages) {
    if (typeof page.slug !== 'string' || !page.slug || (page.locale !== 'de' && page.locale !== 'en')) continue;
    const owner = reservation(namespaceOf(page.locale, mode), page.slug, mode);
    if (owner) collisions.push(`${page.locale}/${page.slug} (page ${String(page.key)} and ${owner.owner}:${owner.segment})`);
    if (dump.tables.posts.some((post) => {
      const snapshot = post.published_snapshot;
      return post.locale === page.locale && (post.slug === page.slug || (!!snapshot && typeof snapshot === 'object' && 'slug' in snapshot && snapshot.slug === page.slug));
    })) collisions.push(`${page.locale}/${page.slug} (page ${String(page.key)} and story)`);
  }
  return { unresolvedNavigation, collisions };
}

function identityFailure(field: string): never { throw new BackupError(`Invalid identity field in backup: ${field}.`); }
function isIdentityTimestamp(value: unknown): value is string {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) return false;
  // Date.parse normalizes impossible dates such as February 30; Postgres does not.
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10);
}

/** Validate metadata and the complete stored locale maps, never an active projection.
 * Version, not field presence, decides whether legacy recovery is permitted. */
function validateDumpIdentity(dump: Dump): void {
  const rows = dump.tables.site_identity;
  const assets = dump.tables.site_identity_assets;
  if (dump.version < IDENTITY_DUMP_VERSION) {
    if (rows !== undefined || assets !== undefined) identityFailure('version');
    return;
  }
  if (!Array.isArray(rows) || rows.length !== 1) identityFailure('site_identity');
  const row = rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) identityFailure('site_identity');
  if (row.id !== true) identityFailure('id');
  if (!Number.isInteger(row.revision) || (row.revision as number) < 1 || (row.revision as number) > 2147483647) identityFailure('revision');
  if (!['neutral', 'legacy', 'restored-legacy'].includes(row.seed_source as string)) identityFailure('seed_source');
  if (row.saved_at !== null && !isIdentityTimestamp(row.saved_at)) identityFailure('saved_at');
  if (!isIdentityTimestamp(row.updated_at)) identityFailure('updated_at');
  try {
    const identity = identityFromRow(row as unknown as IdentityRow);
    row.site_name = identity.siteName;
    row.author_name = identity.authorName;
    row.canonical_origin = identity.canonicalOrigin;
    row.localized = Object.fromEntries(IDENTITY_LOCALIZED_FIELDS
      .filter((field) => Object.hasOwn(row.localized as object, field)).map((field) => [field, identity[field]]));
    row.social_links = identity.socialLinks;
  } catch (error) {
    identityFailure(error instanceof IdentityError ? error.field : 'site_identity');
  }
  if (!Array.isArray(assets) || assets.length > IDENTITY_ASSET_ROLES.length) identityFailure('site_identity_assets');
  const roles = new Set<string>();
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset) || typeof asset.role !== 'string' || !IDENTITY_ASSET_ROLES.includes(asset.role as typeof IDENTITY_ASSET_ROLES[number])
      || roles.has(asset.role)) identityFailure('assets.role');
    roles.add(asset.role);
    if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)) identityFailure('assets.sha256');
    if (!isIdentityTimestamp(asset.created_at)) identityFailure('assets.created_at');
    if (typeof asset.bytes !== 'string' || asset.bytes.length > 4 * Math.ceil(262144 / 3)) identityFailure('assets.bytes');
    const bytes = Buffer.from(asset.bytes, 'base64');
    if (!bytes.length || bytes.length > 262144 || bytes.toString('base64') !== asset.bytes) identityFailure('assets.bytes');
    try {
      validateIdentityAssetMetadata({ ...asset, bytes } as StoredIdentityAsset);
    } catch (error) {
      identityFailure(error instanceof IdentityError ? error.field : 'assets');
    }
  }
  const faviconCount = [...roles].filter((role) => role !== 'logo').length;
  if (faviconCount !== 0 && faviconCount !== 3) identityFailure('assets.favicon');
}

/** Full decoding is asynchronous in sharp. Both restore entry points call this
 * before staging files, capturing the undo set, or opening a mutation transaction.
 * `readDump` retains its synchronous structural/hash-validation API. */
export async function validateIdentityAssets(dump: Dump): Promise<void> {
  validateDumpIdentity(dump);
  for (const asset of dump.tables.site_identity_assets ?? []) {
    try {
      await validateIdentityAsset({ ...asset, bytes: Buffer.from(asset.bytes as string, 'base64') } as StoredIdentityAsset);
    } catch (error) {
      identityFailure(error instanceof IdentityError ? error.field : 'assets');
    }
  }
}

/** Parse a dump file and reject versions this code cannot restore. Shared by
 * `restoreDatabase` and the CLI's pre-restore summary, so an unrestorable file
 * is refused before anything (a pre-restore dump, a transaction) happens.
 * @ai-warning An ALLOW-LIST, not a minimum. Every DUMP_VERSION bump must be
 * added here or dumps written by the new code are unrestorable. */
export function readDump(filePath: string): Dump {
  let dump: Dump;
  try {
    const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new BackupError('Invalid backup dump file.');
      dump = JSON.parse(gunzipSync(readFileSync(fd)).toString('utf8')) as Dump;
    } finally { closeSync(fd); }
  } catch {
    // JSON errors may quote secret-bearing file contents.
    throw new BackupError('Cannot read backup dump.');
  }
  if (!dump || !SUPPORTED_DUMP_VERSIONS.includes(dump.version)) {
    throw new BackupError(`unsupported dump version ${typeof dump?.version === 'number' ? dump.version : '(invalid)'}`);
  }
  if (!dump.tables || !Array.isArray(dump.tables.users) || !Array.isArray(dump.tables.posts)) {
    throw new BackupError('Invalid backup tables.');
  }
  const language = dumpLanguage(dump);
  validatePublishedTracks(dump.tables.posts, language, dump.version < LANGUAGE_DUMP_VERSION);
  if (dump.version < LANGUAGE_DUMP_VERSION) {
    // Explicitly discard any undeclared language/omission metadata. History is
    // finalized after route-free legacy backfill inside the restore transaction.
    for (const post of dump.tables.posts) post.omitted = false;
    dump.tables.site_language = [{ id: true, primary_locale: 'de', enabled_locales: ['de', 'en'],
      // Historical dumps did not require createdAt. Recovery creates language
      // metadata for them; never let an absent/invalid date become SQL NULL.
      locked_at: null, updated_at: isIdentityTimestamp(dump.createdAt) ? dump.createdAt : new Date().toISOString() }];
  }
  if (dump.tables.media !== undefined) {
    if (!Array.isArray(dump.tables.media)) throw new BackupError('Invalid media in backup.');
    for (const row of dump.tables.media) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new BackupError('Invalid media in backup.');
      }
      if (row.format !== undefined && row.format !== null && row.format !== 'jpeg') {
        throw new BackupError('Invalid media format in backup.');
      }
      try {
        const encoding = storedProcessOptions(row.encoding);
        if (row.format === 'jpeg' && encoding?.convertJpeg !== false) {
          throw new Error('jpeg media requires its persisted conversion profile');
        }
      } catch {
        throw new BackupError('Invalid media encoding profile in backup.');
      }
    }
  }
  if (dump.tables.comments !== undefined) {
    if (!Array.isArray(dump.tables.comments)
      || dump.tables.comments.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
      throw new BackupError('Invalid comments in backup.');
    }
  }
  if (dump.tables.app_secrets !== undefined) {
    if (!Array.isArray(dump.tables.app_secrets)) throw new BackupError('Invalid encrypted credentials in backup.');
    const names = new Set<string>();
    for (const row of dump.tables.app_secrets) {
      if (!isEncryptedSecret(row) || typeof row.key !== 'string' || !row.key || row.key.includes('\0')
        || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at)) || names.has(row.key)) {
        throw new BackupError('Invalid encrypted credentials in backup.');
      }
      names.add(row.key);
    }
  }
  if (dump.version >= 10) {
    validateRouteDumpRows(dump.tables.post_routes, dump.tables.posts);
    if (dump.tables.post_routes.length) validateRouteManifest(dump.routeArchive, dump.tables.post_routes);
    else if (dump.routeArchive !== undefined) throw new BackupError('Unexpected private route archive.');
  } else if (dump.tables.post_routes !== undefined || dump.routeArchive !== undefined) {
    throw new BackupError('Private routes require a version 10 recovery set.');
  }
  validateDumpIdentity(dump);
  validateDumpPages(dump);
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

/** Mirrors the `comments_status_check` constraint in db.ts (kept local so
 * this module never imports the store). */
const COMMENT_STATUS_ALLOW: readonly string[] = ['pending', 'approved', 'rejected', 'spam'];

export interface RestoreOptions {
  routeFiles?: GpxFiles;
  originRoles?: OriginRoles;
  assertOwner?: () => Promise<void>;
}
export interface RestoreCounts {
  users: number; posts: number; pages: number; media: number; comments: number; appSecrets: number | null; routes: number;
}

/** Restore a dump inside one transaction. Deleting users cascades to sessions
 * (FK ON DELETE CASCADE), so every login is invalidated. */
export async function restoreDatabase(pool: DbPool, filePath: string, options: RestoreOptions = {}): Promise<RestoreCounts> {
  const restore = () => restoreDatabaseContents(pool, filePath, options);
  return options.routeFiles ? options.routeFiles.gate.runExclusive(restore) : restore();
}

async function restoreDatabaseContents(pool: DbPool, filePath: string, options: RestoreOptions): Promise<RestoreCounts> {
  const dump = readDump(filePath);
  await validateIdentityAssets(dump);
  const originRoles = options.originRoles ?? configuredOriginRoles();
  if (dump.version >= IDENTITY_DUMP_VERSION) {
    try { validateCanonicalRoles(dump.tables.site_identity![0]!.canonical_origin, originRoles); }
    catch (error) { identityFailure(error instanceof IdentityError ? error.field : 'site_identity'); }
  }
  const routes = dump.tables.post_routes ?? [];
  if (routes.length && !options.routeFiles) throw new BackupError('Private route storage is required for this restore.');
  let staged: StagedRouteRestore | undefined;
  let client: DbClient | undefined;
  let committing = false;
  const counts: RestoreCounts = {
    users: dump.tables.users.length, posts: dump.tables.posts.length,
    pages: dump.tables.pages?.length ?? 0, media: dump.tables.media?.length ?? 0,
    comments: dump.tables.comments?.length ?? 0, appSecrets: dump.tables.app_secrets?.length ?? null, routes: routes.length,
  };
  try {
    if (options.routeFiles) staged = await stageRouteRestore(options.routeFiles, filePath, dump.routeArchive, routes);
    client = await pool.connect();
    await options.assertOwner?.();
    await client.query('BEGIN');
    await client.query('SELECT id FROM site_language WHERE id = true FOR UPDATE');
    // Read before replacing anything. Legacy recovery keeps the destination's
    // configured domain, but never its text or assets.
    const liveOrigin = dump.version < IDENTITY_DUMP_VERSION
      ? (await client.query('SELECT canonical_origin FROM site_identity WHERE id = true')).rows[0]?.canonical_origin
      : null;
    let legacy = LEGACY_IDENTITY;
    if (dump.version < IDENTITY_DUMP_VERSION) {
      try {
        legacy = normalizeIdentity({ ...legacy, canonicalOrigin: liveOrigin ?? legacy.canonicalOrigin });
        validateCanonicalRoles(legacy.canonicalOrigin, originRoles);
      }
      catch (error) { identityFailure(error instanceof IdentityError ? error.field : 'site_identity'); }
    }
    await client.query('DELETE FROM site_identity_assets');
    await client.query('DELETE FROM site_identity');
    if (dump.version >= IDENTITY_DUMP_VERSION) {
      const row = dump.tables.site_identity![0]!;
      await client.query(
        `INSERT INTO site_identity (id, revision, seed_source, saved_at, updated_at, site_name, author_name, canonical_origin, localized, social_links)
         VALUES (true,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
        [row.revision, row.seed_source, row.saved_at, row.updated_at, row.site_name, row.author_name,
          row.canonical_origin, asJsonb(row.localized), asJsonb(row.social_links)],
      );
      for (const asset of dump.tables.site_identity_assets!) {
        await client.query(
          'INSERT INTO site_identity_assets (role, sha256, width, height, bytes, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
          [asset.role, asset.sha256, asset.width, asset.height, Buffer.from(asset.bytes as string, 'base64'), asset.created_at],
        );
      }
    } else {
      await client.query(
        `INSERT INTO site_identity (id, revision, seed_source, saved_at, site_name, author_name, canonical_origin, localized, social_links)
         VALUES (true,1,'restored-legacy',NULL,$1,$2,$3,$4::jsonb,$5::jsonb)`,
        [legacy.siteName, legacy.authorName, legacy.canonicalOrigin,
          asJsonb({ tagline: legacy.tagline, aboutRole: legacy.aboutRole, aboutGear: legacy.aboutGear,
            studioDescriptor: legacy.studioDescriptor }), asJsonb(legacy.socialLinks)],
      );
    }
    // Comments are always replaced: an older dump (no `comments` key) restores
    // an EMPTY table rather than leaving live comments attached to posts the
    // dump may not contain (comments spec M14).
    await client.query('DELETE FROM comments');
    // Operational cleanup intents survive restoration. Fresh restored source
    // identities cannot be erased by a pre-restore deletion intent.
    await client.query('DELETE FROM post_routes');
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
      // categories/tags/scheduled_at are absent from v<=3 dumps, `featured`
      // from v<=4 dumps → restored at their column defaults ('{}', '{}', NULL,
      // false); nothing to backfill from. `featured` is coerced with `=== true`
      // rather than passed through, because the column is NOT NULL and an old
      // dump has no key at all.
      await client.query(
        `INSERT INTO posts (id, translation_key, locale, slug, title, date, country, country_code, region,
           excerpt, hero_image, coordinates, stops, route, key_facts, body_markdown, images, status, created_at, updated_at,
           published_snapshot, published_at, categories, tags, scheduled_at, featured, comments_enabled, title_image, omitted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15::jsonb,$16,$17::jsonb,$18,$19,$20,$21::jsonb,$22,
           $23::text[],$24::text[],$25,$26,$27,$28::jsonb,$29)`,
        [p.id, p.translation_key, p.locale, p.slug, p.title, p.date, p.country, p.country_code, p.region,
         p.excerpt, asJsonb(p.hero_image), asJsonb(p.coordinates), asJsonb(p.stops), p.route,
         asJsonb(p.key_facts), p.body_markdown, asJsonb(p.images), p.status, p.created_at, p.updated_at,
         asJsonb(p.published_snapshot), p.published_at ?? null,
         asTextArray(p.categories), asTextArray(p.tags), p.scheduled_at ?? null, p.featured === true,
         // absent from v<=7 dumps → true (the column default); only an explicit false disables
         p.comments_enabled !== false, asJsonb(p.title_image), p.omitted],
      );
    }
    for (const route of staged?.rows ?? []) {
      await client.query(
        `INSERT INTO post_routes (translation_key, version, geometry, source_id, source_sha256, source_bytes, updated_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)`,
        [route.translation_key, route.version, asJsonb(route.geometry), route.source_id, route.source_sha256, route.source_bytes, route.updated_at],
      );
    }
    // @ai-warning A dump is a file the operator hands us, not a trusted row
    // set: `status` is mapped onto the moderation allow-list (anything else
    // becomes `pending`, never `approved`) and `is_author` must be the literal
    // boolean true — a truthy string can not mint an author-flagged row. The
    // legacy `email` column of a v8 dump written before the spec alignment is
    // deliberately dropped (the store never persists one).
    for (const c of dump.tables.comments ?? []) {
      await client.query(
        `INSERT INTO comments (id, translation_key, locale, name, email, body, status, is_author, sender_hash, created_at)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9)`,
        [c.id, c.translation_key, c.locale, c.name, c.body,
         COMMENT_STATUS_ALLOW.includes(c.status as string) ? c.status : 'pending',
         c.is_author === true, typeof c.sender_hash === 'string' ? c.sender_hash : null, c.created_at ?? new Date()],
      );
    }
    // @ai-warning: pre-snapshot dumps (v1, and v2 files written before issue
    // #20) carry no published_snapshot, so their published rows would land
    // NULL — invisible to the site loader (`published_snapshot IS NOT NULL`)
    // until ensureSchema runs at the next app start. Backfill here as well so
    // the restored database is complete before the offline restore returns.
    // Promote the restored working copy of already-published rows
    // into the snapshot. The NULL guard keeps new-format dumps intact — their
    // restored snapshots (and any unpublished draft edits) survive unchanged.
    if (dump.version < LANGUAGE_DUMP_VERSION) {
      await client.query(
        `UPDATE posts SET published_snapshot = ${POST_SNAPSHOT_SQL},
                          published_at = COALESCE(published_at, updated_at)
          WHERE status = 'published' AND published_snapshot IS NULL`,
      );
      await client.query(`UPDATE posts SET published_at = updated_at
        WHERE published_snapshot IS NOT NULL AND published_at IS NULL`);
    }
    await client.query('DELETE FROM site_language');
    const languageRow = dump.tables.site_language![0]!;
    await client.query(
      `INSERT INTO site_language (id, primary_locale, enabled_locales, locked_at, updated_at)
       VALUES (true,$1,$2::text[],${dump.version < LANGUAGE_DUMP_VERSION ? 'COALESCE((SELECT min(published_at) FROM posts),$3::timestamptz)' : '$3::timestamptz'},$4)`,
      [languageRow.primary_locale, languageRow.enabled_locales, languageRow.locked_at, languageRow.updated_at],
    );
    // A v1 dump carries no `pages` key at all — leave existing pages untouched
    // so restoring an old backup can't silently wipe content it never captured.
    if (dump.tables.pages) {
      await client.query('DELETE FROM pages');
      for (const pg of dump.tables.pages) {
        await client.query(
          `INSERT INTO pages (key, locale, title, body_markdown, images, slug, status, published_at, updated_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,now())`,
          [pg.key, pg.locale, pg.title, pg.body_markdown, asJsonb(pg.images),
            dump.version >= PAGES_NAV_DUMP_VERSION ? pg.slug : '',
            dump.version >= PAGES_NAV_DUMP_VERSION ? pg.status : pg.key === 'about' ? 'published' : 'draft',
            dump.version >= PAGES_NAV_DUMP_VERSION ? pg.published_at : pg.key === 'about' ? dump.createdAt ?? '1970-01-01T00:00:00.000Z' : null],
        );
      }
    }
    if (dump.version >= PAGES_NAV_DUMP_VERSION) {
      const row = dump.tables.site_nav![0]!;
      await client.query('DELETE FROM site_nav');
      await client.query('INSERT INTO site_nav(id,config,updated_at) VALUES(1,$1,$2)', [asJsonb(row.config), row.updated_at]);
    }
    await client.query('DELETE FROM page_revisions r WHERE NOT EXISTS(SELECT 1 FROM pages p WHERE p.key=r.key)');
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
                            taken_at, camera, lens, lat, lng, uploaded_at, uploaded_by, format, encoding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb)`,
        [m.key, m.folder, m.title, m.alt_de, m.alt_en, m.caption_de, m.caption_en, asTextArray(m.tags),
         m.width, m.height, m.orig_bytes, m.variant_bytes, m.status, m.error ?? null,
         m.taken_at ?? null, m.camera ?? null, m.lens ?? null, m.lat ?? null, m.lng ?? null,
         m.uploaded_at ?? new Date(), m.uploaded_by ?? null, m.format ?? null, asJsonb(m.encoding)],
      );
    }
    // Undefined means this snapshot never captured secrets; [] intentionally
    // clears them. Keep deletion + inserts in the SAME content transaction.
    if (dump.tables.app_secrets !== undefined) {
      try {
        await client.query('DELETE FROM app_secrets');
        for (const secret of dump.tables.app_secrets) {
          await client.query(
            'INSERT INTO app_secrets (key, ciphertext, iv, tag, updated_at) VALUES ($1,$2,$3,$4,$5)',
            [secret.key, secret.ciphertext, secret.iv, secret.tag, secret.updated_at],
          );
        }
      } catch {
        throw new BackupError('Encrypted credentials could not be restored.');
      }
    }
    await options.assertOwner?.();
    committing = true;
    await client.query('COMMIT');
    committing = false;
    return counts;
  } catch (e) {
    if (committing) {
      client?.release(true);
      client = undefined;
      // A fresh random source identity is positive evidence of this atomic
      // restore. Without it (including legacy empty-route restores), be honest
      // about uncertainty and retain both original sets.
      if (staged?.rows.length) {
        try {
          const current = (await pool.query('SELECT translation_key, source_id FROM post_routes')).rows;
          const expected = new Map(staged.rows.map((row) => [row.translation_key, row.source_id]));
          if (current.length === expected.size && current.every((row) => expected.get(row.translation_key) === row.source_id)) return counts;
        } catch { /* unavailable evidence is not a rollback */ }
      }
      throw new BackupError('Restore outcome is unknown; originals were retained. Inspect the database before retrying.');
    }
    await client?.query('ROLLBACK').catch(() => {});
    await staged?.discard();
    throw e;
  } finally {
    client?.release();
  }
}
