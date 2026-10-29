import type { DbClient, DbPool } from './db.js';
import type { ProcessOptions } from './pipeline.js';
import type { ImageOutputFormat } from './variants.js';

export const UPLOAD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface UploadIdentity { key: string; filename: string; title: string; alt: string; folder: string }
export interface UploadResult {
  key: string; src: string; width: number; height: number; status: string;
  folder: string; snippet: string; duplicate?: boolean; format?: ImageOutputFormat;
}
export interface UploadReceipt {
  userId: string; uploadId: string; mediaKey: string; sha256: string;
  identity: UploadIdentity;
  frozen: { baseKey: string; encoding: ProcessOptions; ext: string; width: number; height: number; bytes: number; format?: ImageOutputFormat };
  state: 'pending' | 'accepted' | 'retryable' | 'gone';
  incarnation: string; claim: string; generation: number;
  reason: 'queue_full' | 'recovery_required' | null;
  originalRetained: boolean; result: UploadResult | null;
}
export type ReceiptCursor = Pick<UploadReceipt, 'userId' | 'uploadId'>;
export interface UploadReceiptStore {
  get(userId: string, uploadId: string): Promise<UploadReceipt | null>;
  insert(receipt: UploadReceipt): Promise<UploadReceipt>;
  /** CAS includes incarnation, execution claim, state and generation. Gone cannot revive. */
  replace(previous: UploadReceipt, next: UploadReceipt): Promise<boolean>;
  pending(after: ReceiptCursor | null, limit: number): Promise<UploadReceipt[]>;
  counts(): Promise<{ pending: number; blocked: number }>;
  /** Patch duplicate metadata and stamp its accepted response in one transaction. */
  accept(previous: UploadReceipt, result: (client?: DbClient) => Promise<UploadResult>): Promise<boolean>;
  /** Called under key admission, never while acquiring a receipt mutex. */
  removeMedia(key: string, remove: (client?: DbClient) => Promise<void>): Promise<void>;
}
const sameClaim = (a: UploadReceipt, b: UploadReceipt) => a.claim === b.claim && a.incarnation === b.incarnation
  && a.generation === b.generation && a.state === b.state;
const id = (r: ReceiptCursor) => `${r.userId}:${r.uploadId}`;

export function memoryUploadReceiptStore(): UploadReceiptStore {
  const rows = new Map<string, UploadReceipt>();
  return {
    async get(userId, uploadId) { return structuredClone(rows.get(id({ userId, uploadId })) ?? null); },
    async insert(receipt) {
      const key = id(receipt);
      if (!rows.has(key)) rows.set(key, structuredClone(receipt));
      return structuredClone(rows.get(key)!);
    },
    async replace(previous, next) {
      const current = rows.get(id(previous));
      if (!current || !sameClaim(current, previous) || current.state === 'gone') return false;
      rows.set(id(previous), structuredClone(next));
      return true;
    },
    async pending(after, limit) {
      return [...rows.values()].filter((r) => r.state === 'pending' && (!after || id(r) > id(after)))
        .sort((a, b) => id(a) < id(b) ? -1 : 1).slice(0, limit).map((r) => structuredClone(r));
    },
    async counts() {
      const pending = [...rows.values()].filter((r) => r.state === 'pending');
      return { pending: pending.length, blocked: pending.filter((r) => r.reason === 'recovery_required').length };
    },
    async accept(previous, result) {
      const current = rows.get(id(previous));
      if (!current || !sameClaim(current, previous) || current.state !== 'pending') return false;
      const saved = await result();
      // Deletion and acceptance share media-key admission in both stores.
      if (rows.get(id(previous)) !== current) return false;
      rows.set(id(previous), { ...structuredClone(previous), state: 'accepted', reason: null, result: saved });
      return true;
    },
    async removeMedia(key, remove) {
      await remove();
      for (const [k, r] of rows) if (r.mediaKey === key) rows.set(k, { ...r, state: 'gone', result: null });
    },
  };
}

interface ReceiptRow {
  user_id: string; upload_id: string; media_key: string; sha256: string;
  identity: UploadIdentity; frozen: UploadReceipt['frozen']; state: UploadReceipt['state'];
  incarnation: string; claim: string; generation: number; reason: UploadReceipt['reason'];
  original_retained: boolean; result: UploadResult | null;
}
function fromRow(r: ReceiptRow): UploadReceipt {
  return { userId: r.user_id, uploadId: r.upload_id, mediaKey: r.media_key, sha256: r.sha256,
    identity: r.identity, frozen: r.frozen, state: r.state, incarnation: r.incarnation,
    claim: r.claim, generation: r.generation, reason: r.reason, originalRetained: r.original_retained, result: r.result };
}
const CLAIM = `user_id=$1 AND upload_id=$2 AND incarnation=$3 AND claim=$4 AND generation=$5 AND state=$6`;
const claimValues = (r: UploadReceipt) => [r.userId, r.uploadId, r.incarnation, r.claim, r.generation, r.state];
export function pgUploadReceiptStore(pool: DbPool): UploadReceiptStore {
  async function transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function get(userId: string, uploadId: string): Promise<UploadReceipt | null> {
    const { rows } = await pool.query<ReceiptRow>('SELECT * FROM upload_receipts WHERE user_id=$1 AND upload_id=$2', [userId, uploadId]);
    return rows[0] ? fromRow(rows[0]) : null;
  }
  return {
    get,
    async insert(r) {
      await pool.query(`INSERT INTO upload_receipts
        (user_id,upload_id,media_key,sha256,identity,frozen,state,incarnation,claim,generation,reason,original_retained,result)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (user_id,upload_id) DO NOTHING`,
      [r.userId,r.uploadId,r.mediaKey,r.sha256,JSON.stringify(r.identity),JSON.stringify(r.frozen),r.state,
        r.incarnation,r.claim,r.generation,r.reason,r.originalRetained,JSON.stringify(r.result)]);
      const saved = await get(r.userId, r.uploadId);
      if (!saved) throw new Error('upload receipt unavailable');
      return saved;
    },
    async replace(previous, next) {
      if (previous.state === 'gone') return false;
      const res = await pool.query(`UPDATE upload_receipts SET state=$7, incarnation=$8, claim=$9,
        generation=$10, reason=$11, original_retained=$12, result=$13::jsonb WHERE ${CLAIM}`,
      [...claimValues(previous), next.state,next.incarnation,next.claim,next.generation,next.reason,next.originalRetained,JSON.stringify(next.result)]);
      return res.rowCount === 1;
    },
    async pending(after, limit) {
      const { rows } = await pool.query<ReceiptRow>(`SELECT * FROM upload_receipts WHERE state='pending'
        ${after ? 'AND (user_id,upload_id) > ($1::uuid,$2::uuid)' : ''}
        ORDER BY user_id, upload_id LIMIT ${after ? '$3' : '$1'}`,
      after ? [after.userId, after.uploadId, Math.min(limit, 100)] : [Math.min(limit, 100)]);
      return rows.map(fromRow);
    },
    async counts() {
      const { rows } = await pool.query<{ pending: string; blocked: string }>(`SELECT count(*) AS pending,
        count(*) FILTER (WHERE reason='recovery_required') AS blocked FROM upload_receipts WHERE state='pending'`);
      return { pending: Number(rows[0]?.pending ?? 0), blocked: Number(rows[0]?.blocked ?? 0) };
    },
    async accept(previous, result) {
      if (previous.state !== 'pending') return false;
      return transaction(async (client) => {
        const locked = await client.query(`SELECT 1 FROM upload_receipts WHERE ${CLAIM} FOR UPDATE`, claimValues(previous));
        if (locked.rowCount !== 1) return false;
        const saved = await result(client);
        await client.query(`UPDATE upload_receipts SET state='accepted', reason=NULL, result=$7::jsonb WHERE ${CLAIM}`,
          [...claimValues(previous), JSON.stringify(saved)]);
        return true;
      });
    },
    async removeMedia(key, remove) {
      await transaction(async (client) => {
        await client.query(`UPDATE upload_receipts SET state='gone', result=NULL WHERE media_key=$1`, [key]);
        await remove(client);
      });
    },
  };
}
