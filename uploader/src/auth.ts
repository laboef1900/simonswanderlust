import { timingSafeEqual } from 'node:crypto';

/** Constant-time bearer-token check. Returns false if no token is configured. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!token || !header) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
