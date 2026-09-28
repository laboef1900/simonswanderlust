import { randomUUID } from 'node:crypto';
import type { DbPool } from './db.js';
import type { Locale } from './posts.js';

/**
 * Reader comments store (spec docs/superpowers/specs/2026-09-14-comments-design.md,
 * phase 1, issue #204). Every comment is PRE-MODERATED: `create` always writes
 * a `pending` row, whatever the caller passes, and `listApproved` only ever
 * returns `approved` rows (oldest first). Moderation moves a row through
 * `setStatus` (approved / rejected / spam); `remove` is the hard delete.
 * One flat thread per translation_key: an author reply (`replyAsAuthor`) is an
 * ordinary sibling row that is born `approved` with `is_author = true`.
 * @ai-warning Reader input is untrusted. Cleaning (control-character strip,
 * trim) happens BEFORE the length check, and bodies are stored as plain text —
 * never render them as HTML.
 * @ai-note The spec stores NO email: an `email` on the input is validated for
 * shape (so a route can reject garbage) but never persisted — every row reads
 * back with `email: null`. `sender_hash` is a keyed HMAC of the IP (never the
 * raw IP), used only for rate limiting.
 */
export type CommentStatus = 'pending' | 'approved' | 'rejected' | 'spam';
export const COMMENT_STATUSES: readonly CommentStatus[] = ['pending', 'approved', 'rejected', 'spam'];
export const isCommentStatus = (v: unknown): v is CommentStatus =>
  typeof v === 'string' && (COMMENT_STATUSES as readonly string[]).includes(v);

/** Display name of the blog's author on `replyAsAuthor` rows (spec M6). */
export const AUTHOR_NAME = 'Simon';

export const NAME_MAX = 80;
export const BODY_MAX = 2000;
export const EMAIL_MAX = 254;

export interface NewComment {
  translationKey: string;
  locale: Locale;
  name: string;
  body: string;
  /** Accepted for validation only — never stored (spec: no email column). */
  email?: string | null;
  /** Keyed HMAC of the sender IP (never the raw IP). */
  senderHash?: string | null;
}

export interface Comment {
  id: string;
  translationKey: string;
  /** The locale the reader posted from (`posted_locale` in the spec). */
  locale: Locale;
  name: string;
  /** Always null: email is not persisted. Kept for consumer compatibility. */
  email: string | null;
  body: string;
  status: CommentStatus;
  isAuthor: boolean;
  createdAt: Date;
}

/** Public shape — never carries the sender hash. */
export interface PublicComment {
  id: string;
  name: string;
  body: string;
  isAuthor: boolean;
  createdAt: Date;
}

export interface AdminListQuery {
  status?: CommentStatus;
  translationKey?: string;
  limit?: number;
  offset?: number;
}

export class CommentError extends Error {}

export interface CommentStore {
  /** Always stores a `pending` row. */
  create(input: NewComment): Promise<Comment>;
  /** Approved comments for one post's thread, oldest first. One flat thread
   * per translation_key (spec M2): without `locale` every posted locale is
   * returned; with it, only rows posted from that locale. */
  listApproved(translationKey: string, locale?: Locale): Promise<PublicComment[]>;
  /** Moderation queue, newest first; defaults to `pending`. */
  listForAdmin(q?: AdminListQuery): Promise<Comment[]>;
  setStatus(id: string, status: CommentStatus): Promise<boolean>;
  approve(id: string): Promise<boolean>;
  /** Inserts an `approved`, `is_author` sibling in the post's thread. */
  replyAsAuthor(input: { translationKey: string; body: string; postedLocale?: Locale }): Promise<Comment>;
  remove(id: string): Promise<boolean>;
  /** Delete-with-post: every row of the thread. Returns the number removed. */
  removeByTranslationKey(translationKey: string): Promise<number>;
}

const len = (s: string) => [...s].length;

/** Strip every Unicode control/format/unassigned char (`\p{C}`), trim. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') throw new CommentError('name must be a string');
  const s = raw.replace(/\p{C}/gu, '').trim();
  if (len(s) < 1 || len(s) > NAME_MAX) throw new CommentError(`name must be 1-${NAME_MAX} characters`);
  return s;
}

/** Like cleanName but keeps line breaks (normalized to `\n`) so paragraphs survive. */
export function cleanBody(raw: unknown): string {
  if (typeof raw !== 'string') throw new CommentError('body must be a string');
  const s = raw.replace(/\r\n?/g, '\n').replace(/[^\S\n]*\n/g, '\n').replace(/(?!\n)\p{C}/gu, '').trim();
  if (len(s) < 1 || len(s) > BODY_MAX) throw new CommentError(`body must be 1-${BODY_MAX} characters`);
  return s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function cleanEmail(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new CommentError('email must be a string');
  const s = raw.replace(/\p{C}/gu, '').trim();
  if (s === '') return null;
  if (s.length > EMAIL_MAX || !EMAIL_RE.test(s)) throw new CommentError('email is invalid');
  return s;
}

function cleanLocale(v: unknown): Locale {
  if (v !== 'de' && v !== 'en') throw new CommentError('locale must be de or en');
  return v;
}

function cleanKey(v: unknown): string {
  if (typeof v !== 'string' || v === '') throw new CommentError('translationKey required');
  return v;
}

function cleanInput(input: NewComment) {
  const translationKey = cleanKey(input.translationKey);
  const locale = cleanLocale(input.locale);
  cleanEmail(input.email); // validated, deliberately discarded
  return {
    translationKey,
    locale,
    name: cleanName(input.name),
    body: cleanBody(input.body),
    senderHash: typeof input.senderHash === 'string' ? input.senderHash : null,
  };
}

function cleanQuery(q: AdminListQuery = {}) {
  const status = q.status === undefined ? 'pending' : q.status;
  if (!isCommentStatus(status)) throw new CommentError('invalid status');
  const limit = q.limit === undefined ? 50 : q.limit;
  const offset = q.offset === undefined ? 0 : q.offset;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new CommentError('limit must be 1-200');
  if (!Number.isInteger(offset) || offset < 0) throw new CommentError('offset must be >= 0');
  const translationKey = q.translationKey === undefined ? undefined : cleanKey(q.translationKey);
  return { status, limit, offset, translationKey };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toPublic = (r: Comment): PublicComment => ({ id: r.id, name: r.name, body: r.body, isAuthor: r.isAuthor, createdAt: r.createdAt });

export function memoryCommentStore(): CommentStore & { all(): Comment[]; removeForPost(tk: string): void } {
  const rows: (Comment & { seq: number })[] = [];
  let seq = 0;
  const strip = ({ seq: _s, ...r }: Comment & { seq: number }): Comment => ({ ...r });
  const store: CommentStore & { all(): Comment[]; removeForPost(tk: string): void } = {
    async create(input) {
      const c = cleanInput(input);
      const row = {
        id: randomUUID(), translationKey: c.translationKey, locale: c.locale, name: c.name,
        email: null, body: c.body, status: 'pending' as const, isAuthor: false, createdAt: new Date(), seq: seq++,
      };
      rows.push(row);
      return strip(row);
    },
    async listApproved(tk, locale) {
      return rows
        .filter((r) => r.status === 'approved' && r.translationKey === tk && (locale === undefined || r.locale === locale))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq)
        .map(toPublic);
    },
    async listForAdmin(q) {
      const c = cleanQuery(q);
      return rows
        .filter((r) => r.status === c.status && (c.translationKey === undefined || r.translationKey === c.translationKey))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.seq - a.seq)
        .slice(c.offset, c.offset + c.limit)
        .map(strip);
    },
    async setStatus(id, status) {
      if (!isCommentStatus(status)) throw new CommentError('invalid status');
      const r = rows.find((x) => x.id === id);
      if (!r) return false;
      r.status = status;
      return true;
    },
    approve(id) { return store.setStatus(id, 'approved'); },
    async replyAsAuthor(input) {
      const row = {
        id: randomUUID(), translationKey: cleanKey(input.translationKey),
        locale: input.postedLocale === undefined ? 'de' as const : cleanLocale(input.postedLocale),
        name: AUTHOR_NAME, email: null, body: cleanBody(input.body),
        status: 'approved' as const, isAuthor: true, createdAt: new Date(), seq: seq++,
      };
      rows.push(row);
      return strip(row);
    },
    async remove(id) {
      const i = rows.findIndex((x) => x.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
    async removeByTranslationKey(tk) {
      const before = rows.length;
      store.removeForPost(tk);
      return before - rows.length;
    },
    all() { return rows.map(strip); },
    removeForPost(tk) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.translationKey === tk) rows.splice(i, 1);
    },
  };
  return store;
}

interface Row {
  id: string; translation_key: string; locale: Locale; name: string; body: string;
  status: CommentStatus; is_author: boolean; created_at: Date;
}
const ROW_COLS = 'id, translation_key, locale, name, body, status, is_author, created_at';
const fromRow = (r: Row): Comment => ({
  id: r.id, translationKey: r.translation_key, locale: r.locale, name: r.name, email: null,
  body: r.body, status: r.status, isAuthor: r.is_author, createdAt: r.created_at,
});

export function pgCommentStore(pool: DbPool): CommentStore {
  const store: CommentStore = {
    async create(input) {
      const c = cleanInput(input);
      // status / is_author are literals, never parameters: nothing a caller
      // passes can create a non-pending or author-flagged row.
      const { rows } = await pool.query<Row>(
        `INSERT INTO comments (id, translation_key, locale, name, email, body, status, is_author, sender_hash)
         VALUES ($1,$2,$3,$4,NULL,$5,'pending',false,$6) RETURNING ${ROW_COLS}`,
        [randomUUID(), c.translationKey, c.locale, c.name, c.body, c.senderHash],
      );
      return fromRow(rows[0]!);
    },
    async listApproved(tk, locale) {
      // The sender hash is deliberately not selected.
      const { rows } = await pool.query<Row>(
        `SELECT ${ROW_COLS} FROM comments
          WHERE translation_key = $1 AND status = 'approved' AND ($2::text IS NULL OR locale = $2)
          ORDER BY created_at ASC, id ASC`,
        [tk, locale === undefined ? null : cleanLocale(locale)],
      );
      return rows.map(fromRow).map(toPublic);
    },
    async listForAdmin(q) {
      const c = cleanQuery(q);
      const { rows } = await pool.query<Row>(
        `SELECT ${ROW_COLS} FROM comments
          WHERE status = $1 AND ($2::text IS NULL OR translation_key = $2)
          ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
        [c.status, c.translationKey ?? null, c.limit, c.offset],
      );
      return rows.map(fromRow);
    },
    async setStatus(id, status) {
      if (!isCommentStatus(status)) throw new CommentError('invalid status');
      if (!UUID_RE.test(id)) return false;
      const res = await pool.query(`UPDATE comments SET status = $2 WHERE id = $1`, [id, status]);
      return (res.rowCount ?? 0) > 0;
    },
    approve(id) { return store.setStatus(id, 'approved'); },
    async replyAsAuthor(input) {
      const tk = cleanKey(input.translationKey);
      const locale = input.postedLocale === undefined ? 'de' : cleanLocale(input.postedLocale);
      const body = cleanBody(input.body);
      const { rows } = await pool.query<Row>(
        `INSERT INTO comments (id, translation_key, locale, name, email, body, status, is_author, sender_hash)
         VALUES ($1,$2,$3,$4,NULL,$5,'approved',true,NULL) RETURNING ${ROW_COLS}`,
        [randomUUID(), tk, locale, AUTHOR_NAME, body],
      );
      return fromRow(rows[0]!);
    },
    async remove(id) {
      if (!UUID_RE.test(id)) return false;
      const res = await pool.query(`DELETE FROM comments WHERE id = $1`, [id]);
      return (res.rowCount ?? 0) > 0;
    },
    async removeByTranslationKey(tk) {
      const res = await pool.query(`DELETE FROM comments WHERE translation_key = $1`, [cleanKey(tk)]);
      return res.rowCount ?? 0;
    },
  };
  return store;
}
