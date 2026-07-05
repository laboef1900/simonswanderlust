import { describe, expect, it } from 'vitest';
import { memorySessionStore, hashToken } from '../src/sessions.js';

describe('memorySessionStore', () => {
  it('creates a token and finds the session by the raw token', async () => {
    const s = memorySessionStore();
    const token = await s.create('user-1', 60_000);
    expect(typeof token).toBe('string');
    const found = await s.find(token);
    expect(found?.userId).toBe('user-1');
  });
  it('returns null for an unknown or empty token', async () => {
    const s = memorySessionStore();
    expect(await s.find('nope')).toBeNull();
    expect(await s.find('')).toBeNull();
  });
  it('treats an expired session as not found', async () => {
    const s = memorySessionStore();
    const token = await s.create('user-1', -1); // already expired
    expect(await s.find(token)).toBeNull();
  });
  it('destroys a session', async () => {
    const s = memorySessionStore();
    const token = await s.create('user-1', 60_000);
    await s.destroy(token);
    expect(await s.find(token)).toBeNull();
  });
  it('destroyAllForUser removes all sessions of that user, no others', async () => {
    const s = memorySessionStore();
    const t1 = await s.create('user-1', 60_000);
    const t2 = await s.create('user-1', 60_000);
    const other = await s.create('user-2', 60_000);
    await s.destroyAllForUser('user-1');
    expect(await s.find(t1)).toBeNull();
    expect(await s.find(t2)).toBeNull();
    expect((await s.find(other))?.userId).toBe('user-2');
  });
  it('hashToken is deterministic and not the raw token', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe('abc');
  });
});
