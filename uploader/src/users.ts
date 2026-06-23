import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import type { DbPool } from './db.js';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const ns = parts[1];
  const rs = parts[2];
  const ps = parts[3];
  const saltHex = parts[4];
  const hashHex = parts[5];
  if (!ns || !rs || !ps || !saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = scryptSync(password, salt, expected.length, { N: Number(ns), r: Number(rs), p: Number(ps) });
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  isAdmin: boolean;
  createdAt: Date;
}
export interface NewUser {
  username: string;
  password: string;
  isAdmin: boolean;
}
export class UserExistsError extends Error {}

export interface UserStore {
  count(): Promise<number>;
  countAdmins(): Promise<number>;
  findByUsername(username: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  list(): Promise<User[]>;
  create(u: NewUser): Promise<User>;
  remove(id: string): Promise<void>;
}

export function memoryUserStore(): UserStore {
  const byId = new Map<string, User>();
  const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return {
    async count() { return byId.size; },
    async countAdmins() { return [...byId.values()].filter((u) => u.isAdmin).length; },
    async findByUsername(username) {
      return [...byId.values()].find((u) => sameName(u.username, username)) ?? null;
    },
    async findById(id) { return byId.get(id) ?? null; },
    async list() {
      return [...byId.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async create({ username, password, isAdmin }) {
      if ([...byId.values()].some((u) => sameName(u.username, username))) {
        throw new UserExistsError('username already exists');
      }
      const user: User = { id: randomUUID(), username, passwordHash: hashPassword(password), isAdmin, createdAt: new Date() };
      byId.set(user.id, user);
      return user;
    },
    async remove(id) { byId.delete(id); },
  };
}

interface UserRow { id: string; username: string; password_hash: string; is_admin: boolean; created_at: Date }
function rowToUser(r: UserRow): User {
  return { id: r.id, username: r.username, passwordHash: r.password_hash, isAdmin: r.is_admin, createdAt: r.created_at };
}

export function pgUserStore(pool: DbPool): UserStore {
  return {
    async count() {
      const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
      const row = rows[0];
      if (!row) throw new Error('COUNT query returned no rows');
      return Number(row.n);
    },
    async countAdmins() {
      const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM users WHERE is_admin');
      const row = rows[0];
      if (!row) throw new Error('COUNT query returned no rows');
      return Number(row.n);
    },
    async findByUsername(username) {
      const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE lower(username) = lower($1) LIMIT 1', [username]);
      return rows[0] ? rowToUser(rows[0]) : null;
    },
    async findById(id) {
      const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] ? rowToUser(rows[0]) : null;
    },
    async list() {
      const { rows } = await pool.query<UserRow>('SELECT * FROM users ORDER BY created_at ASC');
      return rows.map(rowToUser);
    },
    async create({ username, password, isAdmin }) {
      const id = randomUUID();
      try {
        const { rows } = await pool.query<UserRow>(
          'INSERT INTO users (id, username, password_hash, is_admin) VALUES ($1,$2,$3,$4) RETURNING *',
          [id, username, hashPassword(password), isAdmin],
        );
        const row = rows[0];
        if (!row) throw new Error('INSERT RETURNING returned no rows');
        return rowToUser(row);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new UserExistsError('username already exists');
        throw e;
      }
    },
    async remove(id) {
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    },
  };
}
