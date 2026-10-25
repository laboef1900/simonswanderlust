import { randomUUID } from 'node:crypto';
import type { DbClient, DbPool } from './db.js';
import { lockPostPair, touchPostPair } from './post-pair-lock.js';
import { validateGeometry, type PrivateGeometry } from '../public/gpx-geometry.js';
import { GpxError } from './gpx-errors.js';
import { safePairHash, SOURCE_ID_RE, type OriginalSource } from './gpx-files.js';

export interface RouteTokens { baseVersion: string | null; baseUpdatedAt: string }
export interface PrivateRouteRecord { version: string; geometry: PrivateGeometry | null; source: OriginalSource; updatedAt: Date }
export interface CleanupIntent { sourceId: string; pairHash: string }
export interface GpxStore {
  get(tk: string): Promise<PrivateRouteRecord | null>;
  attach(tk: string, tokens: RouteTokens, geometry: PrivateGeometry, source: OriginalSource, confirmReplace: boolean, isWritable?: () => boolean): Promise<PrivateRouteRecord>;
  detach(tk: string, tokens: RouteTokens, isWritable?: () => boolean): Promise<PrivateRouteRecord>;
  isReferenced(sourceId: string): Promise<boolean>;
  cleanupIntents(): Promise<CleanupIntent[]>;
  removeCleanupIntent(sourceId: string): Promise<void>;
  removeOrphanRows(isWritable?: () => boolean): Promise<void>;
}
interface RouteRow {
  translation_key: string; version: string; geometry: PrivateGeometry | null;
  source_id: string; source_sha256: string; source_bytes: number; updated_at: Date;
}
const COLUMNS = 'translation_key, version, geometry, source_id, source_sha256, source_bytes, updated_at';
function record(row: RouteRow): PrivateRouteRecord {
  if (row.geometry !== null) validateGeometry(row.geometry);
  if (!SOURCE_ID_RE.test(row.source_id) || !/^[0-9a-f]{64}$/.test(row.source_sha256) || !Number.isInteger(row.source_bytes) || row.source_bytes < 1 || row.source_bytes > 5 * 1024 * 1024) throw new GpxError('gpx_invalid_source', 500);
  return { version: row.version, geometry: row.geometry, source: { translationKey: row.translation_key, sourceId: row.source_id, sha256: row.source_sha256, bytes: row.source_bytes }, updatedAt: row.updated_at };
}

/** Only a lost COMMIT can produce this error. Callers MUST retain both originals. */
export class GpxCommitUnknownError extends GpxError {
  constructor() { super('gpx_outcome_unknown', 503); }
}

export function pgGpxStore(pool: DbPool): GpxStore {
  async function mutate(tk: string, tokens: RouteTokens, change: { geometry: PrivateGeometry; source: OriginalSource; confirmReplace: boolean } | null, isWritable: () => boolean): Promise<PrivateRouteRecord> {
    if (change) {
      validateGeometry(change.geometry);
      if (change.source.translationKey !== tk || !SOURCE_ID_RE.test(change.source.sourceId) || !/^[0-9a-f]{64}$/.test(change.source.sha256) || !Number.isInteger(change.source.bytes) || change.source.bytes < 1 || change.source.bytes > 5 * 1024 * 1024) throw new GpxError('gpx_invalid_source', 400);
    }
    if (!isWritable()) throw new GpxError('storage_read_only', 503);
    const client = await pool.connect();
    const version = randomUUID();
    let committing = false;
    let released = false;
    try {
      await client.query('BEGIN');
      await lockPostPair(client, tk);
      const posts = await client.query<{ locale: string; updated_at: Date }>("SELECT locale, updated_at FROM posts WHERE translation_key=$1 ORDER BY locale FOR UPDATE", [tk]);
      if (posts.rows.length !== 2 || posts.rows[0]?.locale !== 'de' || posts.rows[1]?.locale !== 'en') throw new GpxError('gpx_post_not_found', 404);
      const old = (await client.query<RouteRow>(`SELECT ${COLUMNS} FROM post_routes WHERE translation_key=$1 FOR UPDATE`, [tk])).rows[0];
      const updated = Math.max(...posts.rows.map((row) => row.updated_at.getTime()));
      if ((old?.version ?? null) !== tokens.baseVersion || updated !== Date.parse(tokens.baseUpdatedAt)) throw new GpxError('gpx_conflict', 409);
      if (change && old && !change.confirmReplace) throw new GpxError('gpx_replace_unconfirmed', 409);
      if (!change && !old) throw new GpxError('gpx_route_not_found', 404);
      const updatedAt = await touchPostPair(client, tk);
      if (change) {
        await client.query(`INSERT INTO post_routes (translation_key,version,geometry,source_id,source_sha256,source_bytes,updated_at)
          VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) ON CONFLICT (translation_key) DO UPDATE SET
          version=EXCLUDED.version,geometry=EXCLUDED.geometry,source_id=EXCLUDED.source_id,
          source_sha256=EXCLUDED.source_sha256,source_bytes=EXCLUDED.source_bytes,updated_at=EXCLUDED.updated_at`,
        [tk, version, JSON.stringify(change.geometry), change.source.sourceId, change.source.sha256, change.source.bytes, updatedAt]);
        if (old && old.source_id !== change.source.sourceId) await enqueueRouteCleanup(client, [{ sourceId: old.source_id, pairHash: safePairHash(tk) }]);
      } else {
        await client.query('UPDATE post_routes SET version=$2,geometry=NULL,updated_at=$3 WHERE translation_key=$1', [tk, version, updatedAt]);
      }
      const row = (await client.query<RouteRow>(`SELECT ${COLUMNS} FROM post_routes WHERE translation_key=$1`, [tk])).rows[0]!;
      if (!isWritable()) throw new GpxError('storage_read_only', 503);
      committing = true;
      await client.query('COMMIT');
      return record(row);
    } catch (error) {
      if (committing) {
        client.release(new Error('gpx_commit_uncertain'));
        released = true;
        // A fresh connection, not the failed transaction, resolves only positive evidence.
        try {
          const current = (await pool.query<RouteRow>(`SELECT ${COLUMNS} FROM post_routes WHERE translation_key=$1`, [tk])).rows[0];
          if (current?.version === version && (!change || current.source_id === change.source.sourceId)) return record(current);
        } catch { /* Retain files when the database cannot resolve the outcome. */ }
        throw new GpxCommitUnknownError();
      }
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { if (!released) client.release(); }
  }
  return {
    async get(tk) {
      const rows = await pool.query<RouteRow & { post_count: number }>(`SELECT r.*, p.post_count FROM
        (SELECT count(*)::int AS post_count FROM posts WHERE translation_key=$1 AND locale IN ('de','en')) p
        LEFT JOIN post_routes r ON r.translation_key=$1`, [tk]);
      const row = rows.rows[0];
      if (!row || row.post_count !== 2) throw new GpxError('gpx_post_not_found', 404);
      return row.version ? record(row) : null;
    },
    attach: (tk, tokens, geometry, source, confirmReplace, isWritable = () => true) => mutate(tk, tokens, { geometry, source, confirmReplace }, isWritable),
    detach: (tk, tokens, isWritable = () => true) => mutate(tk, tokens, null, isWritable),
    async isReferenced(sourceId) {
      return (await pool.query('SELECT 1 FROM post_routes WHERE source_id=$1 LIMIT 1', [sourceId])).rows.length !== 0;
    },
    async cleanupIntents() {
      return (await pool.query<{ source_id: string; pair_hash: string }>('SELECT source_id,pair_hash FROM route_cleanup ORDER BY requested_at LIMIT 100')).rows.map((row) => ({ sourceId: row.source_id, pairHash: row.pair_hash }));
    },
    async removeCleanupIntent(sourceId) { await pool.query('DELETE FROM route_cleanup WHERE source_id=$1', [sourceId]); },
    async removeOrphanRows(isWritable = () => true) {
      const candidates = await pool.query<{ translation_key: string }>(`SELECT r.translation_key FROM post_routes r WHERE
        (SELECT count(*) FROM posts p WHERE p.translation_key=r.translation_key AND p.locale IN ('de','en'))<>2`);
      for (const { translation_key: tk } of candidates.rows) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN'); await lockPostPair(client, tk);
          const posts = await client.query('SELECT locale FROM posts WHERE translation_key=$1 ORDER BY locale FOR UPDATE', [tk]);
          if (posts.rows.length !== 2) {
            const row = (await client.query<{ source_id: string }>('DELETE FROM post_routes WHERE translation_key=$1 RETURNING source_id', [tk])).rows[0];
            if (row) await enqueueRouteCleanup(client, [{ sourceId: row.source_id, pairHash: safePairHash(tk) }]);
          }
          if (!isWritable()) throw new GpxError('storage_read_only', 503);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
      }
    },
  };
}

/** Called inside the post-delete transaction while the route file gate is held. */
export async function enqueueRouteCleanup(client: DbClient, sources: ReadonlyArray<CleanupIntent>): Promise<void> {
  for (const source of sources) {
    if (!SOURCE_ID_RE.test(source.sourceId) || !/^[0-9a-f]{64}$/.test(source.pairHash)) throw new GpxError('gpx_invalid_source', 500);
    await client.query('INSERT INTO route_cleanup (source_id,pair_hash,requested_at) VALUES ($1,$2,clock_timestamp()) ON CONFLICT (source_id) DO NOTHING', [source.sourceId, source.pairHash]);
  }
}
