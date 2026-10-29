import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../src/db.js';
import { pgUploadReceiptStore, type UploadReceipt, type UploadResult } from '../src/upload-receipts.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const schema = `upload_receipts_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  cleanup.push(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
  await ensureSchema(pool);
  const owner = randomUUID(); const other = randomUUID();
  await pool.query(`INSERT INTO users(id,username,password_hash) VALUES ($1,'owner','unused'),($2,'other','unused')`, [owner, other]);
  const receipt: UploadReceipt = { userId: owner, uploadId: randomUUID(), mediaKey: 'library/photo-12345678', sha256: 'a'.repeat(64),
    identity: { key: '', filename: 'photo.jpg', title: 'Initial', alt: 'Original alt', folder: '' },
    frozen: { baseKey: 'library/photo', encoding: {}, ext: 'jpg', width: 8, height: 6, bytes: 100 },
    state: 'pending', incarnation: randomUUID(), claim: randomUUID(), generation: 0, reason: null, originalRetained: true, result: null };
  await pool.query('INSERT INTO media(key,title) VALUES ($1,$2)', [receipt.mediaKey, 'Curated title']);
  const result: UploadResult = { key: receipt.mediaKey, src: 'https://images.test/' + receipt.mediaKey, width: 8, height: 6,
    status: 'processing', folder: '', snippet: 'heroImage: existing result' };
  return { pool, owner, other, receipt, result, store: pgUploadReceiptStore(pool) };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('Postgres upload receipt durability', () => {
  it('keeps an immutable account-scoped identity and cascades account deletion without deleting another owner’s receipt', async () => {
    const { pool, owner, other, receipt, store } = await fixture();
    expect(await store.insert(receipt)).toEqual(receipt);
    expect(await store.get(other, receipt.uploadId)).toBeNull();
    expect(await store.insert({ ...receipt, sha256: 'b'.repeat(64), mediaKey: 'different' })).toEqual(receipt);
    await store.insert({ ...receipt, userId: other });
    await pool.query('DELETE FROM users WHERE id=$1', [owner]);
    expect(await store.get(owner, receipt.uploadId)).toBeNull();
    expect(await store.get(other, receipt.uploadId)).toMatchObject({ userId: other, uploadId: receipt.uploadId });
    await expect(store.insert(receipt)).rejects.toMatchObject({ code: '23503' });
  });
  it('allows only one execution claim and rolls back duplicate metadata when acceptance fails', async () => {
    const { pool, receipt, result, store } = await fixture(); await store.insert(receipt);
    const next = [0, 1].map(() => ({ ...receipt, claim: randomUUID(), incarnation: randomUUID() }));
    const changed = await Promise.all(next.map(row => store.replace(receipt, row)));
    expect(changed.filter(Boolean)).toHaveLength(1);
    const winner = next[changed.indexOf(true)]!;
    expect(await store.accept(receipt, async () => { throw new Error('A stale execution must not run metadata writes'); })).toBe(false);
    await expect(store.accept(winner, async client => {
      await client!.query('UPDATE media SET title=$2 WHERE key=$1', [receipt.mediaKey, 'Should roll back']);
      throw new Error('Simulated finalization failure');
    })).rejects.toThrow('Simulated finalization failure');
    expect((await pool.query('SELECT title FROM media WHERE key=$1', [receipt.mediaKey])).rows[0].title).toBe('Curated title');
    expect((await store.get(receipt.userId, receipt.uploadId))?.state).toBe('pending');
    expect(await store.accept(winner, async client => {
      await client!.query('UPDATE media SET title=$2 WHERE key=$1', [receipt.mediaKey, 'Accepted title']);
      return result;
    })).toBe(true);
    expect((await store.get(receipt.userId, receipt.uploadId))?.result).toEqual(result);
    expect((await pool.query('SELECT title FROM media WHERE key=$1', [receipt.mediaKey])).rows[0].title).toBe('Accepted title');
  });
  it('commits media removal and gone together, or rolls both back; stale recovery cannot revive either', async () => {
    const { pool, receipt, result, store } = await fixture(); await store.insert(receipt);
    await store.accept(receipt, async () => result);
    await expect(store.removeMedia(receipt.mediaKey, async client => {
      await client!.query('DELETE FROM media WHERE key=$1', [receipt.mediaKey]);
      throw new Error('Delete failed');
    })).rejects.toThrow('Delete failed');
    expect((await store.get(receipt.userId, receipt.uploadId))?.state).toBe('accepted');
    expect((await pool.query('SELECT key FROM media WHERE key=$1', [receipt.mediaKey])).rowCount).toBe(1);
    await store.removeMedia(receipt.mediaKey, async client => { await client!.query('DELETE FROM media WHERE key=$1', [receipt.mediaKey]); });
    expect(await store.get(receipt.userId, receipt.uploadId)).toMatchObject({ state: 'gone', result: null });
    expect(await store.replace(receipt, { ...receipt, claim: randomUUID() })).toBe(false);
    expect(await store.accept(receipt, async () => result)).toBe(false);
    expect((await pool.query('SELECT key FROM media WHERE key=$1', [receipt.mediaKey])).rowCount).toBe(0);
  });
  it('uses bounded keyset pages without losing later pending work', async () => {
    const { receipt, store } = await fixture();
    const expected = Array.from({ length: 103 }, () => ({ ...receipt, uploadId: randomUUID() }));
    for (const row of expected) await store.insert(row);
    const first = await store.pending(null, 999); expect(first).toHaveLength(100);
    const second = await store.pending(first.at(-1)!, 999); expect(second).toHaveLength(3);
    expect(new Set([...first, ...second].map(row => row.uploadId))).toEqual(new Set(expected.map(row => row.uploadId)));
    expect(await store.counts()).toEqual({ pending: 103, blocked: 0 });
  });
});
