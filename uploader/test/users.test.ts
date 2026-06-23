import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, memoryUserStore, UserExistsError } from '../src/users.js';

describe('password hashing', () => {
  it('produces a scrypt string that is not the plaintext', () => {
    const h = hashPassword('hunter2');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h).not.toContain('hunter2');
  });
  it('verifies the correct password and rejects a wrong one', () => {
    const h = hashPassword('hunter2');
    expect(verifyPassword('hunter2', h)).toBe(true);
    expect(verifyPassword('nope', h)).toBe(false);
  });
  it('rejects a malformed stored hash', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

describe('memoryUserStore', () => {
  it('creates, counts, finds (case-insensitive) and lists', async () => {
    const s = memoryUserStore();
    expect(await s.count()).toBe(0);
    const u = await s.create({ username: 'Simon', password: 'pw', isAdmin: true });
    expect(u.isAdmin).toBe(true);
    expect(await s.count()).toBe(1);
    expect(await s.countAdmins()).toBe(1);
    expect((await s.findByUsername('simon'))?.id).toBe(u.id);
    expect((await s.findById(u.id))?.username).toBe('Simon');
    expect(await s.list()).toHaveLength(1);
  });
  it('rejects a duplicate username case-insensitively', async () => {
    const s = memoryUserStore();
    await s.create({ username: 'Simon', password: 'pw', isAdmin: false });
    await expect(s.create({ username: 'simon', password: 'x', isAdmin: false })).rejects.toBeInstanceOf(UserExistsError);
  });
  it('removes a user', async () => {
    const s = memoryUserStore();
    const u = await s.create({ username: 'a', password: 'pw', isAdmin: false });
    await s.remove(u.id);
    expect(await s.count()).toBe(0);
  });
});
