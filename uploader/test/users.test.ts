import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, memoryUserStore, UserExistsError, DUMMY_STORED_HASH, PasswordPolicyError, usernamePolicyViolation } from '../src/users.js';

describe('username policy (#131)', () => {
  it('accepts plain ASCII identifiers up to 64 characters', () => {
    for (const ok of ['simon', 'S.imon-1_', 'a', 'x'.repeat(64)]) expect(usernamePolicyViolation(ok)).toBeNull();
  });
  it('rejects empty, over-long, whitespace, markup, and non-ASCII names', () => {
    expect(usernamePolicyViolation('')).toMatch(/between 1 and 64/);
    expect(usernamePolicyViolation('x'.repeat(65))).toMatch(/between 1 and 64/);
    for (const bad of ['si mon', '<img src=x onerror=alert(1)>', 'simon@example.com', 'аdmin', 'simon\n']) {
      expect(usernamePolicyViolation(bad)).toMatch(/may only contain/);
    }
  });
});

describe('password hashing', () => {
  it('produces a scrypt string that is not the plaintext', () => {
    const h = hashPassword('hunter2hunter2');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h).not.toContain('hunter2hunter2');
  });
  it('verifies the correct password and rejects a wrong one', () => {
    const h = hashPassword('hunter2hunter2');
    expect(verifyPassword('hunter2hunter2', h)).toBe(true);
    expect(verifyPassword('nope', h)).toBe(false);
  });
  it('rejects a malformed stored hash', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
  });
  it('hashPassword enforces the length policy on both ends (the stores and the CLI inherit it)', () => {
    const longPassword = 'a'.repeat(1025);
    expect(() => hashPassword(longPassword)).toThrow(PasswordPolicyError);
    expect(() => hashPassword('elevenchars')).toThrow(/between 12 and 1024 characters/);
    expect(() => hashPassword('twelve-chars')).not.toThrow();
    const validHash = hashPassword('validPassword1');
    expect(verifyPassword(longPassword, validHash)).toBe(false);
  });
  it('setPassword with a policy-violating password leaves the old hash valid', async () => {
    const s = memoryUserStore();
    const u = await s.create({ username: 'a', password: 'old-password-1', isAdmin: false });
    await expect(s.setPassword(u.id, 'x')).rejects.toBeInstanceOf(PasswordPolicyError);
    expect(verifyPassword('old-password-1', (await s.findById(u.id))!.passwordHash)).toBe(true);
  });
  it('exports a valid DUMMY_STORED_HASH for timing-safe user checks', () => {
    expect(typeof DUMMY_STORED_HASH).toBe('string');
    expect(DUMMY_STORED_HASH.startsWith('scrypt$')).toBe(true);
  });
});

describe('memoryUserStore', () => {
  it('creates, counts, finds (case-insensitive) and lists', async () => {
    const s = memoryUserStore();
    expect(await s.count()).toBe(0);
    const u = await s.create({ username: 'Simon', password: 'password123456', isAdmin: true });
    expect(u.isAdmin).toBe(true);
    expect(await s.count()).toBe(1);
    expect(await s.countAdmins()).toBe(1);
    expect((await s.findByUsername('simon'))?.id).toBe(u.id);
    expect((await s.findById(u.id))?.username).toBe('Simon');
    expect(await s.list()).toHaveLength(1);
  });
  it('rejects a duplicate username case-insensitively', async () => {
    const s = memoryUserStore();
    await s.create({ username: 'Simon', password: 'password123456', isAdmin: false });
    await expect(s.create({ username: 'simon', password: 'password-x-1234', isAdmin: false })).rejects.toBeInstanceOf(UserExistsError);
  });
  it('removes a user', async () => {
    const s = memoryUserStore();
    const u = await s.create({ username: 'a', password: 'password123456', isAdmin: false });
    await s.remove(u.id);
    expect(await s.count()).toBe(0);
  });
  it('setPassword replaces the stored hash (old rejected, new verifies)', async () => {
    const s = memoryUserStore();
    const u = await s.create({ username: 'a', password: 'old-password-1', isAdmin: false });
    await s.setPassword(u.id, 'new-password-1');
    const after = await s.findById(u.id);
    expect(verifyPassword('old-password-1', after!.passwordHash)).toBe(false);
    expect(verifyPassword('new-password-1', after!.passwordHash)).toBe(true);
  });
  it('setPassword throws for an unknown id', async () => {
    const s = memoryUserStore();
    await expect(s.setPassword('nope', 'password123456')).rejects.toThrow('user not found');
  });
});
