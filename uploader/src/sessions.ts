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
