import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/users.js';

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
