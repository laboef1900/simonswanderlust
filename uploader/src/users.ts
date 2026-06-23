import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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
