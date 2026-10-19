import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DbClient, DbPool } from './db.js';

export class SecretsError extends Error {
  constructor(public readonly code: 'encryption_key_unconfigured' | 'ai_secret_unavailable' | 'ai_secret_store_unavailable') {
    super(code === 'encryption_key_unconfigured'
      ? 'ENCRYPTION_KEY not configured in .env'
      : code === 'ai_secret_unavailable'
        ? 'AI API key is unavailable. Ask an administrator to check or replace it.'
        : 'AI credential storage is unavailable. Reload settings before retrying.');
  }
}

/** Undefined is optional; an explicitly empty or malformed bootstrap key is an error. */
export function parseEncryptionKey(value: string | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('ENCRYPTION_KEY must contain exactly 64 hexadecimal characters.');
  }
  return Buffer.from(value, 'hex');
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** Buffer.from(hex) silently truncates malformed input; validate BEFORE decoding. */
export function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.ciphertext === 'string' && /^(?:[0-9a-f]{2})*$/.test(row.ciphertext)
    && typeof row.iv === 'string' && /^[0-9a-f]{24}$/.test(row.iv)
    && typeof row.tag === 'string' && /^[0-9a-f]{32}$/.test(row.tag);
}

function requireKey(key: Buffer | undefined): Buffer {
  if (key === undefined) throw new SecretsError('encryption_key_unconfigured');
  if (key.length !== 32) throw new SecretsError('ai_secret_unavailable');
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', requireKey(key), iv, { authTagLength: 16 });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext: ciphertext.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
  } catch {
    throw new SecretsError('ai_secret_unavailable');
  }
}

export function decryptSecret(ciphertext: string, iv: string, tag: string, key: Buffer): string {
  try {
    if (!isEncryptedSecret({ ciphertext, iv, tag })) throw new Error('invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', requireKey(key), Buffer.from(iv, 'hex'), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    // Authentication in final() MUST succeed before any plaintext is returned.
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretsError('ai_secret_unavailable');
  }
}

export interface SecretsStore {
  get(key: string): Promise<string | null>;
  set(key: string, plaintext: string): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  /**
   * Boot-only registry migration (spec §5 step 2): in ONE transaction, copy the
   * legacy row's envelope to every target that has no row yet, then delete the
   * legacy row. Pure SQL — no master key, no decryption; envelopes carry no
   * AAD, so a copy decrypts under its new name. Returns whether it existed.
   */
  migrateLegacyKey(legacyKey: string, targetKeys: string[]): Promise<boolean>;
}

export function pgSecretsStore(pool: DbPool, encryptionKey: Buffer | undefined): SecretsStore {
  // Never retain a driver error/cause: Postgres detail may contain an encrypted row.
  async function query(sql: string, values: string[]) {
    try { return await pool.query(sql, values); }
    catch { throw new SecretsError('ai_secret_store_unavailable'); }
  }
  return {
    async get(key) {
      const master = requireKey(encryptionKey);
      const { rows } = await query('SELECT ciphertext, iv, tag FROM app_secrets WHERE key = $1', [key]);
      if (!rows.length) return null;
      const row: unknown = rows[0];
      if (!isEncryptedSecret(row)) throw new SecretsError('ai_secret_unavailable');
      return decryptSecret(row.ciphertext, row.iv, row.tag, master);
    },
    async set(key, plaintext) {
      const encrypted = encryptSecret(plaintext, requireKey(encryptionKey));
      await query(
        `INSERT INTO app_secrets (key, ciphertext, iv, tag) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
           tag = EXCLUDED.tag, updated_at = now()`,
        [key, encrypted.ciphertext, encrypted.iv, encrypted.tag],
      );
    },
    async delete(key) {
      requireKey(encryptionKey);
      await query('DELETE FROM app_secrets WHERE key = $1', [key]);
    },
    async has(key) {
      return (await query('SELECT 1 FROM app_secrets WHERE key = $1', [key])).rows.length !== 0;
    },
    async migrateLegacyKey(legacyKey, targetKeys) {
      let client: DbClient;
      try { client = await pool.connect(); }
      catch { throw new SecretsError('ai_secret_store_unavailable'); }
      try {
        await client.query('BEGIN');
        // FOR UPDATE: a concurrent writer of the legacy row cannot slip between copy and delete.
        const { rows } = await client.query('SELECT 1 FROM app_secrets WHERE key = $1 FOR UPDATE', [legacyKey]);
        if (rows.length === 0) {
          await client.query('COMMIT');
          return false;
        }
        for (const target of targetKeys) {
          if (target === legacyKey) continue;
          // DO NOTHING: a slot that already holds a key (a rerun, or one set
          // since) is never overwritten by the legacy envelope.
          await client.query(
            `INSERT INTO app_secrets (key, ciphertext, iv, tag)
             SELECT $2::text, ciphertext, iv, tag FROM app_secrets WHERE key = $1
             ON CONFLICT (key) DO NOTHING`,
            [legacyKey, target],
          );
        }
        await client.query('DELETE FROM app_secrets WHERE key = $1', [legacyKey]);
        await client.query('COMMIT');
        return true;
      } catch {
        // Never retain the driver error: its detail may quote an envelope.
        await client.query('ROLLBACK').catch(() => {});
        throw new SecretsError('ai_secret_store_unavailable');
      } finally {
        client.release();
      }
    },
  };
}

/** Test-only semantic implementation; production must always use pgSecretsStore. */
export function memorySecretsStore(): SecretsStore {
  const values = new Map<string, string>();
  return {
    async get(key) { return values.get(key) ?? null; },
    async set(key, plaintext) { values.set(key, plaintext); },
    async delete(key) { values.delete(key); },
    async has(key) { return values.has(key); },
    async migrateLegacyKey(legacyKey, targetKeys) {
      const legacy = values.get(legacyKey);
      if (legacy === undefined) return false;
      for (const target of targetKeys) if (!values.has(target)) values.set(target, legacy);
      values.delete(legacyKey);
      return true;
    },
  };
}
