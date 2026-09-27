import { randomUUID } from 'node:crypto';
import type { DbPool } from './db.js';
import type { Locale } from './posts.js';

/**
 * Reader comments store (spec docs/superpowers/specs/2026-09-14-comments-design.md,
 * phase 1). Every comment is PRE-MODERATED: `create` always writes a `pending`
 * row, whatever the caller passes, and `listApproved` only ever returns
 * `approved` rows (oldest first). Rejection is a hard delete, so no third
 * status exists.
 * @ai-warning Reader input is untrusted. Cleaning (control-character strip,
 * trim) happens BEFORE the length check, and bodies are stored as plain text —
 * never render them as HTML.
 */
export type CommentStatus = 'pending' | 'approved';

export const NAME_MAX = 80;
export const BODY_MAX = 2000;
export const EMAIL_MAX = 254;

export interface NewComment {
  translationKey: string;
  locale: Locale;
  name: string;
  body: string;
  email?: string | null;
  /** Keyed HMAC of the sender IP (never the raw IP). */
  senderHash?: string | null;
}

export interface Comment {
  id: string;
  translationKey: string;
  locale: Locale;
  name: string;
  email: string | null;
  body: string;
  status: CommentStatus;
  createdAt: Date;
}

/** Public shape — never carries the email or sender hash. */
export interface PublicComment {
  id: string;
  name: string;
  body: string;
  createdAt: Date;
}

export class CommentError extends Error {}

export interface CommentStore {
  /** Always stores a `pending` row. */
  create(input: NewComment): Promise<Comment>;
  /** Approved comments for one post/locale, oldest first. */
  listApproved(translationKey: string, locale: Locale): Promise<PublicComment[]>;
  approve(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
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

function cleanInput(input: NewComment) {
  if (typeof input.translationKey !== 'string' || input.translationKey === '') throw new CommentError('translationKey required');
  if (input.locale !== 'de' && input.locale !== 'en') throw new CommentError('locale must be de or en');
  return {
    translationKey: input.translationKey,
    locale: input.locale,
    name: cleanName(input.name),
    body: cleanBody(input.body),
    email: cleanEmail(input.email),
    senderHash: typeof input.senderHash === 'string' ? input.senderHash : null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function memoryCommentStore(): CommentStore & { all(): Comment[]; removeForPost(tk: string): void } {
  const rows: (Comment & { seq: number })[] = [];
  let seq = 0;
  return {
    async create(input) {
      const c = cleanInput(input);
      const row = {
        id: randomUUID(), translationKey: c.translationKey, locale: c.locale, name: c.name,
        email: c.email, body: c.body, status: 'pending' as const, createdAt: new Date(), seq: seq++,
      };
      rows.push(row);
      const { seq: _s, ...out } = row;
      return { ...out };
    },
    async listApproved(tk, locale) {
      return rows
        .filter((r) => r.status === 'approved' && r.translationKey === tk && r.locale === locale)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq)
        .map((r) => ({ id: r.id, name: r.name, body: r.body, createdAt: r.createdAt }));
    },
    async approve(id) {
      const r = rows.find((x) => x.id === id);
      if (!r) return false;
      r.status = 'approved';
      return true;
    },
    async remove(id) {
      const i = rows.findIndex((x) => x.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
    all() { return rows.map(({ seq: _s, ...r }) => ({ ...r })); },
    removeForPost(tk) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.translationKey === tk) rows.splice(i, 1);
    },
  };
}

export function pgCommentStore(pool: DbPool): CommentStore {
  return {
    async create(input) {
      const c = cleanInput(input);
      // status is a literal, never a parameter: nothing a caller passes can
      // create a non-pending row.
      const { rows } = await pool.query<{ id: string; created_at: Date }>(
        `INSERT INTO comments (id, translation_key, locale, name, email, body, status, sender_hash)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7) RETURNING id, created_at`,
        [randomUUID(), c.translationKey, c.locale, c.name, c.email, c.body, c.senderHash],
      );
      const r = rows[0]!;
      return {
        id: r.id, translationKey: c.translationKey, locale: c.locale, name: c.name,
        email: c.email, body: c.body, status: 'pending', createdAt: r.created_at,
      };
    },
    async listApproved(tk, locale) {
      // Email and sender hash are deliberately not selected.
      const { rows } = await pool.query<{ id: string; name: string; body: string; created_at: Date }>(
        `SELECT id, name, body, created_at FROM comments
          WHERE translation_key = $1 AND locale = $2 AND status = 'approved'
          ORDER BY created_at ASC, id ASC`,
        [tk, locale],
      );
      return rows.map((r) => ({ id: r.id, name: r.name, body: r.body, createdAt: r.created_at }));
    },
    async approve(id) {
      if (!UUID_RE.test(id)) return false;
      const res = await pool.query(`UPDATE comments SET status = 'approved' WHERE id = $1`, [id]);
      return (res.rowCount ?? 0) > 0;
    },
    async remove(id) {
      if (!UUID_RE.test(id)) return false;
      const res = await pool.query(`DELETE FROM comments WHERE id = $1`, [id]);
      return (res.rowCount ?? 0) > 0;
    },
  };
}
