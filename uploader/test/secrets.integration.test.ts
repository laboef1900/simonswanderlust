import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgSecretsStore } from '../src/secrets.js';
import { dumpDatabase, readDump, restoreDatabase, type Connectable } from '../src/backup.js';
import { runCli } from './run-cli.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('encrypted secrets and backup v6 (Postgres)', () => {
  let pool: DbPool;
  let dir: string;
  const key = randomBytes(32);
  beforeAll(async () => {
    pool = createPool(url as string);
    await ensureSchema(pool);
    dir = await mkdtemp(join(tmpdir(), 'secrets-int-'));
  });
  beforeEach(async () => { await pool.query('DELETE FROM app_secrets'); });
  afterAll(async () => { await pool.end(); await rm(dir, { recursive: true, force: true }); });

  it('matches memory lifecycle semantics and can replace/delete corrupt ciphertext', async () => {
    const store = pgSecretsStore(pool, key);
    expect(await store.get('ai_api_key')).toBeNull();
    expect(await store.has('ai_api_key')).toBe(false);
    await store.set('ai_api_key', 'first-fixture');
    await store.set('ai_api_key', 'replacement-fixture');
    expect(await store.get('ai_api_key')).toBe('replacement-fixture');
    expect(await pgSecretsStore(pool, undefined).has('ai_api_key')).toBe(true);
    const wrong = pgSecretsStore(pool, randomBytes(32));
    await expect(wrong.get('ai_api_key')).rejects.toThrow('AI API key is unavailable');
    await pool.query("UPDATE app_secrets SET tag = repeat('0', 32) WHERE key = 'ai_api_key'");
    await expect(store.get('ai_api_key')).rejects.toThrow('AI API key is unavailable');
    expect(await store.has('ai_api_key')).toBe(true);
    await store.set('ai_api_key', 'repaired-fixture');
    expect(await store.get('ai_api_key')).toBe('repaired-fixture');
    await store.delete('ai_api_key');
    await store.delete('ai_api_key');
    expect(await store.get('ai_api_key')).toBeNull();
    expect(await store.has('ai_api_key')).toBe(false);
  });

  it('preserves the previous encrypted row and sanitizes a rejected replacement', async () => {
    const store = pgSecretsStore(pool, key);
    await store.set('ai_api_key', 'keep-fixture');
    const original = (await pool.query('SELECT ciphertext FROM app_secrets')).rows[0].ciphertext as string;
    // Constrain the envelope, not a mocked query: a real ON CONFLICT update fails.
    await pool.query(`ALTER TABLE app_secrets ADD CONSTRAINT test_keep_ciphertext CHECK (ciphertext = '${original}')`);
    try {
      await expect(store.set('ai_api_key', 'rejected-fixture')).rejects.toThrow('AI credential storage is unavailable');
      expect(await store.get('ai_api_key')).toBe('keep-fixture');
    } finally {
      await pool.query('ALTER TABLE app_secrets DROP CONSTRAINT test_keep_ciphertext');
    }
  });

  it('restores ciphertext and timestamps without a master key, then decrypts with the original key', async () => {
    const store = pgSecretsStore(pool, key);
    await store.set('ai_api_key', 'roundtrip-fixture');
    const before = (await pool.query('SELECT * FROM app_secrets ORDER BY key')).rows;
    const file = join(dir, await dumpDatabase(pool, dir));
    const dump = readDump(file);
    expect(dump.version).toBe(6);
    const raw = gunzipSync(await readFile(file)).toString('utf8');
    expect(raw).not.toContain('roundtrip-fixture');
    expect(raw).not.toContain(key.toString('hex'));
    await store.set('ai_api_key', 'changed-fixture');
    expect((await restoreDatabase(pool, file)).appSecrets).toBe(1);
    expect((await pool.query('SELECT * FROM app_secrets ORDER BY key')).rows).toEqual(before);
    expect(await store.get('ai_api_key')).toBe('roundtrip-fixture');
  });

  it('captures secrets from the same repeatable-read snapshot as content', async () => {
    const store = pgSecretsStore(pool, key);
    await store.set('ai_api_key', 'snapshot-fixture');
    const db: Connectable = {
      query: (sql, params) => pool.query(sql, params),
      async connect() {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          async query(sql, params) {
            const result = await client.query(sql, params);
            if (sql.includes('FROM users')) await store.set('ai_api_key', 'later-fixture');
            return result;
          },
        };
      },
    };
    const file = join(dir, await dumpDatabase(db, dir));
    expect(await store.get('ai_api_key')).toBe('later-fixture');
    await restoreDatabase(pool, file);
    expect(await store.get('ai_api_key')).toBe('snapshot-fixture');
  });

  it.each([1, 2, 3, 4, 5, 6])('preserves existing secrets when version %i omits the table', async (version) => {
    const store = pgSecretsStore(pool, key);
    await store.set('ai_api_key', 'keep-fixture');
    const before = (await pool.query('SELECT * FROM app_secrets')).rows;
    const file = join(dir, 'db-20260101-000000.json.gz');
    await writeFile(file, gzipSync(JSON.stringify({ version, createdAt: new Date().toISOString(), tables: { users: [], posts: [] } })));
    expect((await restoreDatabase(pool, file)).appSecrets).toBeNull();
    expect((await pool.query('SELECT * FROM app_secrets')).rows).toEqual(before);
    expect(await store.get('ai_api_key')).toBe('keep-fixture');
  });

  it('distinguishes an intentionally empty table from an absent or malformed table', async () => {
    const store = pgSecretsStore(pool, key);
    await store.set('ai_api_key', 'keep-fixture');
    const file = join(dir, 'db-20260102-000000.json.gz');
    const row = (await pool.query('SELECT * FROM app_secrets')).rows[0];
    for (const app_secrets of [null, {}, [{ ciphertext: 'invalid' }], [row, row]]) {
      await writeFile(file, gzipSync(JSON.stringify({ version: 6, tables: { users: [], posts: [], app_secrets } })));
      await expect(restoreDatabase(pool, file)).rejects.toThrow('Invalid encrypted credentials');
      expect(await store.get('ai_api_key')).toBe('keep-fixture');
    }
    await writeFile(file, gzipSync(JSON.stringify({ version: 6, tables: { users: [], posts: [], app_secrets: [] } })));
    expect((await restoreDatabase(pool, file)).appSecrets).toBe(0);
    expect(await store.get('ai_api_key')).toBeNull();
  });

  it('rolls back content deletion and the prior secret when a valid-envelope insert fails', async () => {
    const store = pgSecretsStore(pool, key);
    await store.set('ai_api_key', 'keep-fixture');
    await pool.query("INSERT INTO pages (key,locale,title,body_markdown) VALUES ('about','de','rollback sentinel','body') ON CONFLICT (key,locale) DO UPDATE SET title = EXCLUDED.title");
    const file = join(dir, await dumpDatabase(pool, dir));
    const dump = readDump(file);
    dump.tables.pages = [];
    dump.tables.app_secrets![0]!.key = 'rejected-fixture';
    await writeFile(file, gzipSync(JSON.stringify(dump)));
    await pool.query("ALTER TABLE app_secrets ADD CONSTRAINT test_reject_secret CHECK (key <> 'rejected-fixture')");
    try {
      await expect(restoreDatabase(pool, file)).rejects.toThrow('Encrypted credentials could not be restored');
      expect(await store.get('ai_api_key')).toBe('keep-fixture');
      expect((await pool.query("SELECT title FROM pages WHERE key='about' AND locale='de'")).rows[0].title).toBe('rollback sentinel');
    } finally {
      await pool.query('ALTER TABLE app_secrets DROP CONSTRAINT test_reject_secret');
    }
  });

  it('the restore CLI names encrypted replacement and its pre-dump retains the prior key', async () => {
    const store = pgSecretsStore(pool, key);
    await store.set('ai_api_key', 'incoming-fixture');
    const file = join(dir, await dumpDatabase(pool, dir));
    await store.set('ai_api_key', 'undo-fixture');
    const backupDir = join(dir, 'undo');
    const result = await runCli(['restore', '--yes', file], { DATABASE_URL: url!, BACKUP_DIR: backupDir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('app_secrets: replace 1 live rows with 1 encrypted rows');
    expect(result.stdout).not.toContain('incoming-fixture');
    expect(result.stdout).not.toContain('undo-fixture');
    const undo = result.stdout.match(/pre-restore dump written: (.+)/)?.[1];
    expect(undo).toBeDefined();
    await restoreDatabase(pool, undo!);
    expect(await store.get('ai_api_key')).toBe('undo-fixture');
  }, 30_000);

  it('the CLI explicitly preserves secrets omitted by a legacy dump', async () => {
    const store = pgSecretsStore(pool, key);
    await store.set('ai_api_key', 'legacy-preserved-fixture');
    const file = join(dir, 'db-20260103-000000.json.gz');
    await writeFile(file, gzipSync(JSON.stringify({ version: 5, tables: { users: [], posts: [] } })));
    const result = await runCli(['restore', '--yes', file], { DATABASE_URL: url!, BACKUP_DIR: join(dir, 'legacy-undo') });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('app_secrets preserved: absent from dump.');
    expect(result.stdout).not.toContain('app_secrets: replace');
    expect(await store.get('ai_api_key')).toBe('legacy-preserved-fixture');
  }, 30_000);
});
