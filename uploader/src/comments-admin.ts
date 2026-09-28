import { randomUUID } from 'node:crypto';
import type { DbPool } from './db.js';
import type { Locale } from './posts.js';
import { cleanBody, cleanName, CommentError, type CommentStatus } from './comments.js';

/**
 * Admin-side comment moderation (spec 2026-09-14-comments-design.md, phase 3,
 * SPEC-ADM-001). Deliberately a SEPARATE type from the public `PublicComment`:
 * the admin shape carries the email and `isAuthor`, and must never be handed to
 * anything that renders public output.
 *
 * Author replies are FLAT siblings: they copy the parent's
 * (translation_key, locale) and carry no parent pointer (threading is out of
 * scope). They are inserted `approved` with `is_author = true` — they never
 * pass through the pending queue.
 * @ai-warning Every route using this store must be `requireAdmin`; `name`,
 * `email` and `body` are untrusted reader text — paint them with textContent.
 */
export interface AdminComment {
  id: string;
  translationKey: string;
  locale: Locale;
  name: string;
  email: string | null;
  body: string;
  status: CommentStatus;
  isAuthor: boolean;
  createdAt: Date;
}

export interface CommentAdminStore {
  list(status: CommentStatus): Promise<AdminComment[]>;
  /** false when the id is unknown. */
  setStatus(id: string, status: CommentStatus): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  /** null when the parent is unknown. */
  replyAsAuthor(parentId: string, authorName: string, body: unknown): Promise<AdminComment | null>;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LIST_LIMIT = 500;

export function isCommentStatus(v: unknown): v is CommentStatus {
  return v === 'pending' || v === 'approved';
}

export { CommentError };

export function memoryCommentAdminStore(seed: AdminComment[] = []): CommentAdminStore & { all(): AdminComment[]; add(c: AdminComment): void } {
  const rows: AdminComment[] = seed.map((r) => ({ ...r }));
  return {
    async list(status) {
      return rows.filter((r) => r.status === status)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, LIST_LIMIT).map((r) => ({ ...r }));
    },
    async setStatus(id, status) {
      const r = rows.find((x) => x.id === id);
      if (!r) return false;
      r.status = status;
      return true;
    },
    async remove(id) {
      const i = rows.findIndex((x) => x.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
    async replyAsAuthor(parentId, authorName, rawBody) {
      const body = cleanBody(rawBody);
      const name = cleanName(authorName);
      const p = rows.find((x) => x.id === parentId);
      if (!p) return null;
      const reply: AdminComment = {
        id: randomUUID(), translationKey: p.translationKey, locale: p.locale, name, email: null,
        body, status: 'approved', isAuthor: true, createdAt: new Date(),
      };
      rows.push(reply);
      return { ...reply };
    },
    all() { return rows.map((r) => ({ ...r })); },
    add(c) { rows.push({ ...c }); },
  };
}

interface Row {
  id: string; translation_key: string; locale: Locale; name: string; email: string | null;
  body: string; status: CommentStatus; is_author: boolean; created_at: Date;
}
const toAdmin = (r: Row): AdminComment => ({
  id: r.id, translationKey: r.translation_key, locale: r.locale, name: r.name, email: r.email,
  body: r.body, status: r.status, isAuthor: r.is_author, createdAt: r.created_at,
});
const COLS = 'id, translation_key, locale, name, email, body, status, is_author, created_at';

/**
 * Additive, idempotent migration for the `is_author` flag (NOT NULL DEFAULT
 * false, so existing reader rows need no rewrite). Also safe to run from
 * ensureSchema; the store runs it once lazily so it works before that wiring.
 */
export async function ensureCommentAdminSchema(pool: DbPool): Promise<void> {
  await pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_author boolean NOT NULL DEFAULT false`);
}

export function pgCommentAdminStore(pool: DbPool): CommentAdminStore {
  let ready: Promise<void> | null = null;
  const init = () => {
    ready ??= ensureCommentAdminSchema(pool).catch((e) => { ready = null; throw e; });
    return ready;
  };
  return {
    async list(status) {
      await init();
      const { rows } = await pool.query<Row>(
        `SELECT ${COLS} FROM comments WHERE status = $1 ORDER BY created_at ASC, id ASC LIMIT ${LIST_LIMIT}`,
        [status],
      );
      return rows.map(toAdmin);
    },
    async setStatus(id, status) {
      if (!UUID_RE.test(id) || !isCommentStatus(status)) return false;
      await init();
      const res = await pool.query(`UPDATE comments SET status = $2 WHERE id = $1`, [id, status]);
      return (res.rowCount ?? 0) > 0;
    },
    async remove(id) {
      if (!UUID_RE.test(id)) return false;
      await init();
      const res = await pool.query(`DELETE FROM comments WHERE id = $1`, [id]);
      return (res.rowCount ?? 0) > 0;
    },
    async replyAsAuthor(parentId, authorName, rawBody) {
      const body = cleanBody(rawBody);
      const name = cleanName(authorName);
      if (!UUID_RE.test(parentId)) return null;
      await init();
      // status and is_author are literals: a reply is never pending.
      const { rows } = await pool.query<Row>(
        `INSERT INTO comments (id, translation_key, locale, name, email, body, status, is_author)
         SELECT $1, translation_key, locale, $2, NULL, $3, 'approved', true FROM comments WHERE id = $4
         RETURNING ${COLS}`,
        [randomUUID(), name, body, parentId],
      );
      return rows[0] ? toAdmin(rows[0]) : null;
    },
  };
}
