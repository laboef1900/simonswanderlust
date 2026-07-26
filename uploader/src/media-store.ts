/**
 * The media library's database layer: metadata ABOUT the image files on disk.
 *
 * @ai-warning The filesystem stays the source of truth for a file's
 * existence. A `media` row is metadata about a file under STORAGE_DIR, never
 * the other way round — that is what preserves the property ARCHITECTURE.md
 * relies on: photos survive a database loss. `media-sync.ts` reconciles the two.
 *
 * @ai-context docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md
 *   — issue #64.
 */
import { randomUUID } from 'node:crypto';
import type { DbPool } from './db.js';
import type { MediaExif } from './exif.js';

export type MediaStatus = 'processing' | 'ready' | 'failed' | 'missing';
/**
 * A FIXED ENUM, never a raw error message.
 * @ai-warning libvips embeds filesystem paths in its errors and the library UI
 * displays this field — the real error is logged to stdout only, matching the
 * global error handler's contract.
 */
export type MediaError = 'decode_failed' | 'encode_failed' | 'write_failed' | 'no_space';

export interface MediaItem {
  key: string;
  src: string;                 // `${baseUrl}/${key}`
  thumbSrc: string | null;     // server-derived; see thumbWidth()
  folder: string; title: string;
  alt: { de: string; en: string };
  caption: { de: string; en: string };
  tags: string[];
  width: number; height: number;        // 0 = unknown (unreadable probe)
  origBytes: number; variantBytes: number;
  status: MediaStatus; error: MediaError | null;
  exif: MediaExif;                       // lat/lng redacted for non-admins
  uploadedAt: Date;
  uploadedBy: string | null;             // redacted for non-admins
}

export interface NewMediaItem {
  key: string; folder?: string; title?: string;
  alt?: { de?: string; en?: string }; caption?: { de?: string; en?: string };
  tags?: string[];
  width: number; height: number; origBytes: number;
  status: MediaStatus;                   // required — no implicit default
  exif: MediaExif;
  uploadedBy: string | null;
}

export type MediaPatch = Partial<Pick<NewMediaItem, 'folder' | 'title' | 'alt' | 'caption' | 'tags'>>;

export interface MediaQuery {
  folder?: string; recursive?: boolean;
  q?: string; tag?: string; status?: MediaStatus;
  sort?: 'uploaded' | 'taken' | 'title' | 'key';
  order?: 'asc' | 'desc';
  page?: number; pageSize?: number;
}

export interface MediaStore {
  list(q: MediaQuery): Promise<{ items: MediaItem[]; total: number }>;
  get(key: string): Promise<MediaItem | null>;
  upsert(item: NewMediaItem): Promise<MediaItem>;
  patch(key: string, fields: MediaPatch): Promise<MediaItem>;
  move(keys: string[], folder: string): Promise<number>;
  remove(key: string): Promise<void>;
  /** Publish gate: which of these keys are not `ready` (unknown keys are NOT returned). */
  notReadyKeys(keys: string[]): Promise<Set<string>>;
  /** Claim one `processing` row for encoding, oldest first; null when the queue is empty. */
  claimNextProcessing(): Promise<MediaItem | null>;
  setStatus(key: string, s: MediaStatus, e?: MediaError): Promise<void>;
  setVariantBytes(key: string, bytes: number): Promise<void>;
  folders(): Promise<string[]>;
  createFolder(path: string): Promise<void>;
  renameFolder(from: string, to: string): Promise<number>;
  deleteFolder(path: string): Promise<void>;
  /** Keys with a row but no matching file on disk are marked missing by media-sync. */
  allKeys(): Promise<string[]>;
}

export class MediaStoreError extends Error {
  code?: string;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * One folder-path segment. Unicode letter/digit at both ends; the interior may
 * additionally use space, hyphen, underscore and dot.
 *
 * @ai-warning Deliberately excludes control/format characters (bidi overrides,
 * zero-width joiners), HTML and URL metacharacters, path traversal, and the
 * SQL `LIKE` wildcard `%`. `assertSafeKey`'s narrowness is not reusable here
 * because folder names are human-facing and must allow "Patagonien Süd".
 *
 * `_` — the OTHER LIKE wildcard — is deliberately allowed, because `trip_1` is
 * an ordinary folder name and no folder value ever reaches a LIKE pattern:
 * subtree matching uses `starts_with()` (see `where()` below) and free-text
 * search escapes its wildcards in `likePattern()`. Should a `LIKE folder || …`
 * ever be introduced, this must be revisited — that is the whole reason
 * `starts_with` is used instead.
 */
const SAFE_FOLDER_SEG = /^[\p{L}\p{N}](?:[\p{L}\p{N} _.\-]{0,62}[\p{L}\p{N}])?$/u;
export const MAX_FOLDER_DEPTH = 6;
export const MAX_FOLDER_LEN = 200;
/** A GIN index stores one entry per array element, so both are capped. */
export const MAX_TAGS = 30;
export const MAX_TAG_LEN = 40;
/** Unbounded LIMIT would materialize the whole table per request. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;
const MAX_TEXT = 1000;

export function assertSafeFolder(path: string): void {
  if (typeof path !== 'string') throw new MediaStoreError('folder path must be a string');
  if (path === '') return;                                   // root
  if (path.length > MAX_FOLDER_LEN) throw new MediaStoreError('folder path too long');
  if (path.normalize('NFC') !== path) throw new MediaStoreError('folder path must be NFC');
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(path)) throw new MediaStoreError('folder path has control/format characters');
  const segs = path.split('/');
  if (segs.length > MAX_FOLDER_DEPTH) throw new MediaStoreError('folder nesting too deep');
  for (const s of segs) {
    if (!SAFE_FOLDER_SEG.test(s)) throw new MediaStoreError(`invalid folder segment "${s}"`);
  }
}

function cleanText(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, MAX_TEXT) : '';
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const clean = t.replace(/[\p{C}]/gu, '').trim().slice(0, MAX_TAG_LEN);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Every ancestor of a folder path, root-first, excluding '' — for upserting the tree. */
export function folderAncestry(path: string): string[] {
  if (path === '') return [];
  const segs = path.split('/');
  return segs.map((_, i) => segs.slice(0, i + 1).join('/'));
}

/**
 * @ai-warning An allow-list MAP, not raw input. `sort` and `order` are SQL
 * identifiers/keywords, which `pg` cannot parameterize, and the TypeScript
 * union type is erased at runtime while the value arrives from a query string.
 * Own-property lookup only — a bare index would resolve 'constructor' to
 * something truthy.
 */
const SORT_COL = { uploaded: 'uploaded_at', taken: 'taken_at', title: 'title', key: 'key' } as const;

export function sortColumn(sort: unknown): string {
  return typeof sort === 'string' && Object.prototype.hasOwnProperty.call(SORT_COL, sort)
    ? SORT_COL[sort as keyof typeof SORT_COL]
    : SORT_COL.uploaded;
}

export function pageSizeOf(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

/**
 * Escape the `LIKE` wildcards in a search term.
 * @ai-note A bare `_` is otherwise a single-character wildcard, and a pattern
 * like `%a%a%a%a%a%a` is a cheap authenticated CPU sink on the process that
 * also serves the blog. Used with `ILIKE $n ESCAPE '\'`.
 */
export function likePattern(q: unknown): string {
  return `%${String(q ?? '').replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * The width of the thumbnail that actually EXISTS for a photo.
 *
 * @ai-warning Server-derived on purpose. `variantWidths()` never upscales, so
 * a photo narrower than 640px has no `-640.webp` — only `-<intrinsic>.webp`. A
 * client deriving this would be a third copy of the width contract, which the
 * codebase deliberately keeps in exactly two cross-referenced places
 * (uploader/src/variants.ts and site/src/lib/images.ts).
 */
export function thumbWidth(width: number): number | null {
  if (!Number.isInteger(width) || width <= 0) return null;
  return Math.min(640, width);
}

function thumbSrcFor(baseUrl: string, key: string, width: number, status: MediaStatus): string | null {
  // A photo still encoding (or failed) has no variant files yet — offering a
  // URL that 404s would just produce broken images in the library grid.
  if (status !== 'ready') return null;
  const w = thumbWidth(width);
  return w === null ? null : `${baseUrl}/${key}-${w}.webp`;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Strip the fields a non-admin author must not see.
 *
 * @ai-warning `GET /media` is session-level (the gallery picker needs authors
 * to browse) where `GET /images` used to be admin-only. Handing every author
 * the GPS coordinates of every photo through a lower gate would undo the
 * Phase 0 privacy fix, so lat/lng and uploadedBy are redacted here. Tests
 * assert the REDACTION, not just the status code.
 */
export function redactForNonAdmin(item: MediaItem): MediaItem {
  return { ...item, exif: { ...item.exif, lat: null, lng: null }, uploadedBy: null };
}

// ---------------------------------------------------------------------------
// In-memory store (mirrors pgMediaStore so the suites run without a database)
// ---------------------------------------------------------------------------

/** The stored shape: everything but the two URLs, which are derived on read. */
type MemRow = Omit<MediaItem, 'src' | 'thumbSrc'>;

export interface MediaStoreOptions { baseUrl: string }

function applyQuery(rows: MemRow[], q: MediaQuery): MemRow[] {
  const needle = String(q.q ?? '').trim().toLowerCase();
  const folder = q.folder;
  return rows.filter((r) => {
    if (folder !== undefined) {
      if (q.recursive) {
        if (folder !== '' && r.folder !== folder && !r.folder.startsWith(`${folder}/`)) return false;
      } else if (r.folder !== folder) return false;
    }
    if (q.status && r.status !== q.status) return false;
    if (q.tag && !r.tags.includes(q.tag)) return false;
    if (needle) {
      const hay = [r.key, r.title, r.alt.de, r.alt.en, r.caption.de, r.caption.en, ...r.tags]
        .join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export function memoryMediaStore(opts: MediaStoreOptions): MediaStore {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const rows = new Map<string, MemRow>();
  const folderSet = new Set<string>();

  const toItem = (r: MemRow): MediaItem => ({
    ...structuredClone(r),
    src: `${baseUrl}/${r.key}`,
    thumbSrc: thumbSrcFor(baseUrl, r.key, r.width, r.status),
  });
  const need = (key: string): MemRow => {
    const r = rows.get(key);
    if (!r) throw new MediaStoreError('media not found', 'not_found');
    return r;
  };
  const addFolders = (path: string) => folderAncestry(path).forEach((p) => folderSet.add(p));

  return {
    async list(q) {
      const filtered = applyQuery([...rows.values()], q);
      const col = sortColumn(q.sort);
      const dir = q.order === 'asc' ? 1 : -1;
      const keyOf = (r: MemRow): string | number => {
        if (col === 'taken_at') return r.exif.takenAt ? r.exif.takenAt.getTime() : -Infinity;
        if (col === 'title') return r.title;
        if (col === 'key') return r.key;
        return r.uploadedAt.getTime();
      };
      const sorted = filtered.slice().sort((a, b) => {
        const ka = keyOf(a); const kb = keyOf(b);
        const cmp = typeof ka === 'string' ? ka.localeCompare(String(kb)) : Number(ka) - Number(kb);
        return dir * cmp || a.key.localeCompare(b.key); // stable tiebreak
      });
      const size = pageSizeOf(q.pageSize);
      const page = Math.max(1, Math.floor(Number(q.page) || 1));
      return { items: sorted.slice((page - 1) * size, page * size).map(toItem), total: filtered.length };
    },
    async get(key) {
      const r = rows.get(key);
      return r ? toItem(r) : null;
    },
    async upsert(item) {
      assertSafeFolder(item.folder ?? '');
      const existing = rows.get(item.key);
      const row: MemRow = {
        key: item.key,
        folder: item.folder ?? existing?.folder ?? '',
        title: cleanText(item.title ?? existing?.title ?? ''),
        alt: {
          de: cleanText(item.alt?.de ?? existing?.alt.de ?? ''),
          en: cleanText(item.alt?.en ?? existing?.alt.en ?? ''),
        },
        caption: {
          de: cleanText(item.caption?.de ?? existing?.caption.de ?? ''),
          en: cleanText(item.caption?.en ?? existing?.caption.en ?? ''),
        },
        tags: item.tags ? normalizeTags(item.tags) : existing?.tags ?? [],
        width: item.width, height: item.height,
        origBytes: item.origBytes,
        variantBytes: existing?.variantBytes ?? 0,
        status: item.status, error: null,
        exif: { ...item.exif },
        uploadedAt: existing?.uploadedAt ?? new Date(),
        uploadedBy: item.uploadedBy ?? existing?.uploadedBy ?? null,
      };
      rows.set(item.key, row);
      addFolders(row.folder);
      return toItem(row);
    },
    async patch(key, fields) {
      const r = need(key);
      if (fields.folder !== undefined) { assertSafeFolder(fields.folder); r.folder = fields.folder; addFolders(fields.folder); }
      if (fields.title !== undefined) r.title = cleanText(fields.title);
      if (fields.alt) r.alt = { de: cleanText(fields.alt.de ?? r.alt.de), en: cleanText(fields.alt.en ?? r.alt.en) };
      if (fields.caption) r.caption = { de: cleanText(fields.caption.de ?? r.caption.de), en: cleanText(fields.caption.en ?? r.caption.en) };
      if (fields.tags !== undefined) r.tags = normalizeTags(fields.tags);
      return toItem(r);
    },
    async move(keys, folder) {
      assertSafeFolder(folder);
      let n = 0;
      for (const k of keys) {
        const r = rows.get(k);
        if (!r) continue;
        r.folder = folder; n++;
      }
      addFolders(folder);
      return n;
    },
    async remove(key) { rows.delete(key); },
    async notReadyKeys(keys) {
      const out = new Set<string>();
      for (const k of keys) {
        const r = rows.get(k);
        if (r && r.status !== 'ready') out.add(k);
      }
      return out;
    },
    async claimNextProcessing() {
      const pending = [...rows.values()]
        .filter((r) => r.status === 'processing')
        .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime());
      return pending[0] ? toItem(pending[0]) : null;
    },
    async setStatus(key, s, e) {
      const r = rows.get(key);
      if (!r) return;
      r.status = s;
      r.error = s === 'failed' ? e ?? null : null;
    },
    async setVariantBytes(key, bytes) {
      const r = rows.get(key);
      if (r) r.variantBytes = bytes;
    },
    async folders() {
      return [...folderSet].sort((a, b) => a.localeCompare(b));
    },
    async createFolder(path) {
      assertSafeFolder(path);
      if (path === '') return;
      addFolders(path);
    },
    async renameFolder(from, to) {
      assertSafeFolder(from); assertSafeFolder(to);
      if (from === '' || to === '') throw new MediaStoreError('cannot rename the root folder');
      if (from === to) return 0;
      if (to === from || to.startsWith(`${from}/`)) {
        throw new MediaStoreError('cannot move a folder into itself', 'invalid');
      }
      if (folderSet.has(to)) throw new MediaStoreError('target folder already exists', 'exists');
      let n = 0;
      for (const r of rows.values()) {
        // Exact match plus prefix rewrite — `Iceland` moves `Iceland/*` but
        // never `Iceland 2024`.
        if (r.folder === from) { r.folder = to; n++; }
        else if (r.folder.startsWith(`${from}/`)) { r.folder = to + r.folder.slice(from.length); n++; }
      }
      for (const f of [...folderSet]) {
        if (f === from) { folderSet.delete(f); folderSet.add(to); }
        else if (f.startsWith(`${from}/`)) { folderSet.delete(f); folderSet.add(to + f.slice(from.length)); }
      }
      addFolders(to);
      return n;
    },
    async deleteFolder(path) {
      assertSafeFolder(path);
      if (path === '') throw new MediaStoreError('cannot delete the root folder');
      const used = [...rows.values()].some((r) => r.folder === path || r.folder.startsWith(`${path}/`));
      const hasChild = [...folderSet].some((f) => f.startsWith(`${path}/`));
      if (used || hasChild) throw new MediaStoreError('folder is not empty', 'not_empty');
      folderSet.delete(path);
    },
    async allKeys() { return [...rows.keys()].sort(); },
  };
}

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

interface MediaRow {
  key: string; folder: string; title: string;
  alt_de: string; alt_en: string; caption_de: string; caption_en: string;
  tags: string[] | null;
  width: number; height: number;
  orig_bytes: string | number; variant_bytes: string | number;
  status: MediaStatus; error: MediaError | null;
  taken_at: Date | null; camera: string | null; lens: string | null;
  lat: number | null; lng: number | null;
  uploaded_at: Date; uploaded_by: string | null;
}

function rowToItem(r: MediaRow, baseUrl: string): MediaItem {
  return {
    key: r.key,
    src: `${baseUrl}/${r.key}`,
    thumbSrc: thumbSrcFor(baseUrl, r.key, r.width, r.status),
    folder: r.folder, title: r.title,
    alt: { de: r.alt_de, en: r.alt_en },
    caption: { de: r.caption_de, en: r.caption_en },
    tags: r.tags ?? [],
    width: r.width, height: r.height,
    // bigint comes back as a string from node-postgres.
    origBytes: Number(r.orig_bytes), variantBytes: Number(r.variant_bytes),
    status: r.status, error: r.error,
    exif: { takenAt: r.taken_at, camera: r.camera, lens: r.lens, lat: r.lat, lng: r.lng },
    uploadedAt: r.uploaded_at, uploadedBy: r.uploaded_by,
  };
}

const COLS = `key, folder, title, alt_de, alt_en, caption_de, caption_en, tags, width, height,
              orig_bytes, variant_bytes, status, error, taken_at, camera, lens, lat, lng,
              uploaded_at, uploaded_by`;

export function pgMediaStore(pool: DbPool, opts: MediaStoreOptions): MediaStore {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');

  /** Build the shared WHERE clause for list(); returns SQL plus bind values. */
  function where(q: MediaQuery): { sql: string; values: unknown[] } {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (q.folder !== undefined) {
      assertSafeFolder(q.folder);
      if (q.recursive && q.folder !== '') {
        // @ai-warning: starts_with(), never `LIKE folder || '/%'`. A folder
        // literally named `%` would make LIKE match the entire library — the
        // segment regex already excludes `%`, but this is an irreversible bulk
        // read/write path and defence in depth is cheap.
        values.push(q.folder);
        clauses.push(`(folder = $${values.length} OR starts_with(folder, $${values.length} || '/'))`);
      } else if (!q.recursive) {
        values.push(q.folder);
        clauses.push(`folder = $${values.length}`);
      }
    }
    if (q.status) { values.push(q.status); clauses.push(`status = $${values.length}`); }
    if (q.tag) { values.push(q.tag); clauses.push(`$${values.length} = ANY(tags)`); }
    if (q.q !== undefined && String(q.q).trim() !== '') {
      values.push(likePattern(q.q));
      const i = values.length;
      clauses.push(`(key ILIKE $${i} ESCAPE '\\' OR title ILIKE $${i} ESCAPE '\\'
                     OR alt_de ILIKE $${i} ESCAPE '\\' OR alt_en ILIKE $${i} ESCAPE '\\'
                     OR caption_de ILIKE $${i} ESCAPE '\\' OR caption_en ILIKE $${i} ESCAPE '\\')`);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
  }

  async function getRow(key: string): Promise<MediaRow | null> {
    const { rows } = await pool.query<MediaRow>(`SELECT ${COLS} FROM media WHERE key = $1`, [key]);
    return rows[0] ?? null;
  }

  async function ensureFolders(path: string): Promise<void> {
    for (const p of folderAncestry(path)) {
      await pool.query(`INSERT INTO media_folders (path) VALUES ($1) ON CONFLICT (path) DO NOTHING`, [p]);
    }
  }

  return {
    async list(q) {
      const { sql, values } = where(q);
      const col = sortColumn(q.sort);
      const dir = q.order === 'asc' ? 'ASC' : 'DESC';
      const size = pageSizeOf(q.pageSize);
      const page = Math.max(1, Math.floor(Number(q.page) || 1));
      const countRes = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM media ${sql}`, values);
      const { rows } = await pool.query<MediaRow>(
        // `col` and `dir` are allow-listed constants, never interpolated input.
        `SELECT ${COLS} FROM media ${sql}
          ORDER BY ${col} ${dir} NULLS LAST, key ASC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, size, (page - 1) * size],
      );
      return { items: rows.map((r) => rowToItem(r, baseUrl)), total: Number(countRes.rows[0]?.n ?? 0) };
    },
    async get(key) {
      const r = await getRow(key);
      return r ? rowToItem(r, baseUrl) : null;
    },
    async upsert(item) {
      const folder = item.folder ?? '';
      assertSafeFolder(folder);
      await ensureFolders(folder);
      // COALESCE on update keeps text a caller omitted (a re-upload of the same
      // bytes must not blank an existing title/alt), while status/dimensions
      // always take the new value.
      await pool.query(
        `INSERT INTO media (key, folder, title, alt_de, alt_en, caption_de, caption_en, tags,
                            width, height, orig_bytes, status, error,
                            taken_at, camera, lens, lat, lng, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,NULL,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (key) DO UPDATE SET
           folder = EXCLUDED.folder,
           title = CASE WHEN EXCLUDED.title = '' THEN media.title ELSE EXCLUDED.title END,
           alt_de = CASE WHEN EXCLUDED.alt_de = '' THEN media.alt_de ELSE EXCLUDED.alt_de END,
           alt_en = CASE WHEN EXCLUDED.alt_en = '' THEN media.alt_en ELSE EXCLUDED.alt_en END,
           caption_de = CASE WHEN EXCLUDED.caption_de = '' THEN media.caption_de ELSE EXCLUDED.caption_de END,
           caption_en = CASE WHEN EXCLUDED.caption_en = '' THEN media.caption_en ELSE EXCLUDED.caption_en END,
           tags = CASE WHEN cardinality(EXCLUDED.tags) = 0 THEN media.tags ELSE EXCLUDED.tags END,
           width = EXCLUDED.width, height = EXCLUDED.height, orig_bytes = EXCLUDED.orig_bytes,
           status = EXCLUDED.status, error = NULL,
           taken_at = EXCLUDED.taken_at, camera = EXCLUDED.camera, lens = EXCLUDED.lens,
           lat = EXCLUDED.lat, lng = EXCLUDED.lng`,
        [
          item.key, folder, cleanText(item.title), cleanText(item.alt?.de), cleanText(item.alt?.en),
          cleanText(item.caption?.de), cleanText(item.caption?.en), normalizeTags(item.tags),
          item.width, item.height, item.origBytes, item.status,
          item.exif.takenAt, item.exif.camera, item.exif.lens, item.exif.lat, item.exif.lng,
          item.uploadedBy,
        ],
      );
      const saved = await getRow(item.key);
      if (!saved) throw new MediaStoreError('failed to save media row');
      return rowToItem(saved, baseUrl);
    },
    async patch(key, fields) {
      const sets: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, value: unknown, cast = '') => {
        values.push(value);
        sets.push(`${col} = $${values.length}${cast}`);
      };
      if (fields.folder !== undefined) { assertSafeFolder(fields.folder); await ensureFolders(fields.folder); set('folder', fields.folder); }
      if (fields.title !== undefined) set('title', cleanText(fields.title));
      if (fields.alt?.de !== undefined) set('alt_de', cleanText(fields.alt.de));
      if (fields.alt?.en !== undefined) set('alt_en', cleanText(fields.alt.en));
      if (fields.caption?.de !== undefined) set('caption_de', cleanText(fields.caption.de));
      if (fields.caption?.en !== undefined) set('caption_en', cleanText(fields.caption.en));
      if (fields.tags !== undefined) set('tags', normalizeTags(fields.tags), '::text[]');
      if (sets.length > 0) {
        values.push(key);
        const res = await pool.query(`UPDATE media SET ${sets.join(', ')} WHERE key = $${values.length}`, values);
        if (res.rowCount === 0) throw new MediaStoreError('media not found', 'not_found');
      }
      const saved = await getRow(key);
      if (!saved) throw new MediaStoreError('media not found', 'not_found');
      return rowToItem(saved, baseUrl);
    },
    async move(keys, folder) {
      assertSafeFolder(folder);
      if (keys.length === 0) return 0;
      await ensureFolders(folder);
      const res = await pool.query(`UPDATE media SET folder = $1 WHERE key = ANY($2::text[])`, [folder, keys]);
      return res.rowCount ?? 0;
    },
    async remove(key) {
      await pool.query(`DELETE FROM media WHERE key = $1`, [key]);
    },
    async notReadyKeys(keys) {
      if (keys.length === 0) return new Set();
      const { rows } = await pool.query<{ key: string }>(
        `SELECT key FROM media WHERE key = ANY($1::text[]) AND status <> 'ready'`, [keys],
      );
      return new Set(rows.map((r) => r.key));
    },
    async claimNextProcessing() {
      // The single-process deployment means no two workers race here, but
      // FOR UPDATE SKIP LOCKED costs nothing and keeps this correct if that
      // ever changes.
      const { rows } = await pool.query<MediaRow>(
        `SELECT ${COLS} FROM media WHERE status = 'processing'
          ORDER BY uploaded_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      return rows[0] ? rowToItem(rows[0], baseUrl) : null;
    },
    async setStatus(key, s, e) {
      await pool.query(`UPDATE media SET status = $1, error = $2 WHERE key = $3`, [s, s === 'failed' ? e ?? null : null, key]);
    },
    async setVariantBytes(key, bytes) {
      await pool.query(`UPDATE media SET variant_bytes = $1 WHERE key = $2`, [bytes, key]);
    },
    async folders() {
      const { rows } = await pool.query<{ path: string }>(`SELECT path FROM media_folders ORDER BY path`);
      return rows.map((r) => r.path);
    },
    async createFolder(path) {
      assertSafeFolder(path);
      if (path === '') return;
      await ensureFolders(path);
    },
    async renameFolder(from, to) {
      assertSafeFolder(from); assertSafeFolder(to);
      if (from === '' || to === '') throw new MediaStoreError('cannot rename the root folder');
      if (from === to) return 0;
      if (to.startsWith(`${from}/`)) throw new MediaStoreError('cannot move a folder into itself', 'invalid');
      const exists = await pool.query(`SELECT 1 FROM media_folders WHERE path = $1`, [to]);
      if ((exists.rowCount ?? 0) > 0) throw new MediaStoreError('target folder already exists', 'exists');
      // Exact match plus prefix rewrite, via starts_with() rather than LIKE —
      // see the @ai-warning in where(). `Iceland` moves `Iceland/*` but never
      // `Iceland 2024`.
      const res = await pool.query(
        `UPDATE media SET folder = $2 || substr(folder, length($1) + 1)
          WHERE folder = $1 OR starts_with(folder, $1 || '/')`, [from, to],
      );
      await pool.query(
        `UPDATE media_folders SET path = $2 || substr(path, length($1) + 1)
          WHERE path = $1 OR starts_with(path, $1 || '/')`, [from, to],
      );
      // AFTER the rewrite, never before: inserting `to` first would make the
      // UPDATE above collide with the row it just created (media_folders.path
      // is the primary key). This only fills in ancestors when `to` is nested
      // deeper than `from` — e.g. renaming `a` to `x/y` needs `x`.
      await ensureFolders(to);
      return res.rowCount ?? 0;
    },
    async deleteFolder(path) {
      assertSafeFolder(path);
      if (path === '') throw new MediaStoreError('cannot delete the root folder');
      const used = await pool.query(
        `SELECT 1 FROM media WHERE folder = $1 OR starts_with(folder, $1 || '/') LIMIT 1`, [path],
      );
      const child = await pool.query(
        `SELECT 1 FROM media_folders WHERE starts_with(path, $1 || '/') LIMIT 1`, [path],
      );
      if ((used.rowCount ?? 0) > 0 || (child.rowCount ?? 0) > 0) {
        throw new MediaStoreError('folder is not empty', 'not_empty');
      }
      await pool.query(`DELETE FROM media_folders WHERE path = $1`, [path]);
    },
    async allKeys() {
      const { rows } = await pool.query<{ key: string }>(`SELECT key FROM media ORDER BY key`);
      return rows.map((r) => r.key);
    },
  };
}

/** Storage key for a bulk-library upload; `contentHashKey` then appends `-<hash8>`.
 *
 * @ai-warning Deliberately NOT derived from the virtual folder: folders are
 * renameable, storage keys are immutable, and coupling them would desynchronise
 * on the first rename. Editor uploads keep their existing
 * `trips/<slug>/hero` keys unchanged.
 *
 * @ai-note This exists because KEY_RE / SAFE_KEY_RE are lowercase-only, so a
 * Leica's `L1002345.JPG` is a 400 today — bulk upload has no post slug to
 * derive a key from, so the server derives one.
 */
export function libraryKey(filename: string, now: Date): string {
  const base = String(filename ?? '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics left by NFKD
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `library/${now.getUTCFullYear()}/${base || 'photo'}`;
}
