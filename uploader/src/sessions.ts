import { createHash, randomBytes } from 'node:crypto';

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

export interface SessionStore {
  create(userId: string, ttlMs: number): Promise<string>;
  find(rawToken: string): Promise<Session | null>;
  destroy(rawToken: string): Promise<void>;
  sweepExpired(): Promise<void>;
}

export function memorySessionStore(): SessionStore {
  const byHash = new Map<string, Session>();
  return {
    async create(userId, ttlMs) {
      const raw = randomBytes(32).toString('hex');
      const id = hashToken(raw);
      byHash.set(id, { id, userId, expiresAt: new Date(Date.now() + ttlMs) });
      return raw;
    },
    async find(rawToken) {
      if (!rawToken) return null;
      const id = hashToken(rawToken);
      const s = byHash.get(id);
      if (!s) return null;
      if (s.expiresAt.getTime() <= Date.now()) { byHash.delete(id); return null; }
      return s;
    },
    async destroy(rawToken) {
      if (rawToken) byHash.delete(hashToken(rawToken));
    },
    async sweepExpired() {
      const now = Date.now();
      for (const [k, v] of byHash) if (v.expiresAt.getTime() <= now) byHash.delete(k);
    },
  };
}

import type { DbPool } from './db.js';

interface SessionRow { id: string; user_id: string; expires_at: Date }

export function pgSessionStore(pool: DbPool): SessionStore {
  return {
    async create(userId, ttlMs) {
      const raw = randomBytes(32).toString('hex');
      const id = hashToken(raw);
      const expiresAt = new Date(Date.now() + ttlMs);
      await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1,$2,$3)', [id, userId, expiresAt]);
      return raw;
    },
    async find(rawToken) {
      if (!rawToken) return null;
      const id = hashToken(rawToken);
      const { rows } = await pool.query<SessionRow>('SELECT id, user_id, expires_at FROM sessions WHERE id = $1', [id]);
      const row = rows[0];
      if (!row) return null;
      if (row.expires_at.getTime() <= Date.now()) {
        await pool.query('DELETE FROM sessions WHERE id = $1', [id]);
        return null;
      }
      return { id: row.id, userId: row.user_id, expiresAt: row.expires_at };
    },
    async destroy(rawToken) {
      if (rawToken) await pool.query('DELETE FROM sessions WHERE id = $1', [hashToken(rawToken)]);
    },
    async sweepExpired() {
      await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    },
  };
}
