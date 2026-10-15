import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  decryptSecret, encryptSecret, isEncryptedSecret, memorySecretsStore, parseEncryptionKey, pgSecretsStore,
} from '../src/secrets.js';
import { createPool } from '../src/db.js';

// All values here are disposable fixtures, never external-provider credentials.
describe('encrypted secrets', () => {
  it('authenticates a Unicode roundtrip and never reuses an IV for a replacement', () => {
    const key = randomBytes(32);
    const text = 'fixture — Grüße';
    const first = encryptSecret(text, key);
    const next = encryptSecret(text, key);
    expect(isEncryptedSecret(first)).toBe(true);
    expect(first.iv).not.toBe(next.iv);
    expect(first.ciphertext).not.toBe(next.ciphertext);
    expect(decryptSecret(first.ciphertext, first.iv, first.tag, key)).toBe(text);
    const empty = encryptSecret('', key);
    expect(decryptSecret(empty.ciphertext, empty.iv, empty.tag, key)).toBe('');
  });

  it('rejects tampering of every authenticated component and the wrong key without returning plaintext', () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret('test-only-credential', key);
    for (const field of ['ciphertext', 'iv', 'tag'] as const) {
      const changed = { ...encrypted, [field]: (encrypted[field][0] === '0' ? '1' : '0') + encrypted[field].slice(1) };
      expect(() => decryptSecret(changed.ciphertext, changed.iv, changed.tag, key)).toThrow('AI API key is unavailable');
    }
    expect(() => decryptSecret(encrypted.ciphertext, encrypted.iv, encrypted.tag, randomBytes(32))).toThrow('AI API key is unavailable');
    expect(() => decryptSecret(encrypted.ciphertext + 'zz', encrypted.iv, encrypted.tag, key)).toThrow();
    expect(() => decryptSecret(encrypted.ciphertext, encrypted.iv, encrypted.tag.slice(2), key)).toThrow();
    expect(() => encryptSecret('fixture', Buffer.alloc(31))).toThrow();
  });

  it('distinguishes absent bootstrap configuration from every malformed supplied value', () => {
    expect(parseEncryptionKey(undefined)).toBeUndefined();
    for (const invalid of ['', ' ', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), ' ' + 'a'.repeat(64)]) {
      expect(() => parseEncryptionKey(invalid)).toThrow('exactly 64 hexadecimal');
    }
    expect(parseEncryptionKey('AB'.repeat(32))).toEqual(Buffer.alloc(32, 0xab));
  });

  it('refuses malformed bootstrap configuration before attempting an unavailable database', async () => {
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/unused', ENCRYPTION_KEY: 'malformed-private-fixture' },
      timeout: 15000,
    }).then(() => null, (error: unknown) => error as { code: number; stderr: string });
    expect(result?.code).toBe(1);
    expect(result?.stderr).toContain('ENCRYPTION_KEY must contain exactly 64 hexadecimal characters');
    expect(result?.stderr).not.toContain('malformed-private-fixture');
    expect(result?.stderr).not.toContain('ECONNREFUSED');
  }, 20000);

  it('the real store fails closed before database access when encryption is absent', async () => {
    const pool = createPool('postgres://invalid:invalid@127.0.0.1:1/unused');
    const store = pgSecretsStore(pool, undefined);
    try {
      await expect(store.get('ai_api_key')).rejects.toThrow('ENCRYPTION_KEY not configured in .env');
      await expect(store.set('ai_api_key', 'fixture')).rejects.toThrow('ENCRYPTION_KEY not configured in .env');
      await expect(store.delete('ai_api_key')).rejects.toThrow('ENCRYPTION_KEY not configured in .env');
    } finally { await pool.end(); }
  });

  it('memory stores preserve the lifecycle contract without sharing state across instances', async () => {
    const store = memorySecretsStore();
    const other = memorySecretsStore();
    expect(await store.get('ai_api_key')).toBeNull();
    expect(await store.has('ai_api_key')).toBe(false);
    await store.set('ai_api_key', 'first');
    await store.set('ai_api_key', 'replacement');
    expect(await store.get('ai_api_key')).toBe('replacement');
    expect(await store.has('ai_api_key')).toBe(true);
    expect(await other.get('ai_api_key')).toBeNull();
    await store.delete('ai_api_key');
    await store.delete('ai_api_key');
    expect(await store.get('ai_api_key')).toBeNull();
    expect(await store.has('ai_api_key')).toBe(false);
  });
});
