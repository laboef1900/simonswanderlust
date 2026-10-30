import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { assertDatabaseSnapshot } from './database-snapshot';
import { withLoaderSnapshot } from './loader-pool';

function connection(failImport = false) {
  const sql: string[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (text: string) => {
      sql.push(text);
      if (failImport && text.startsWith('SET TRANSACTION')) throw new Error('invalid snapshot identifier');
      return { rows: [{ body: 'captured' }] };
    }), release,
  };
  const connect = vi.fn(async () => client);
  return { pool: { connect } as unknown as pg.Pool, client, sql, release, connect };
}

describe('imported build database snapshot', () => {
  it.each(['', ' ', "00000003-0000000A-1';SELECT 1--", 'not-a-snapshot'])('refuses invalid supplied snapshot %j before connecting', async (id) => {
    const db = connection();
    await expect(withLoaderSnapshot(db.pool, async () => 'unused', id)).rejects.toThrow('Invalid SITE_DATABASE_SNAPSHOT');
    expect(db.connect).not.toHaveBeenCalled();
  });
  it('imports before any content read and pins every related read to one client', async () => {
    const db = connection();
    const rows = await withLoaderSnapshot(db.pool, async (client) => {
      const first = await client.query('SELECT body FROM pages');
      await client.query('SELECT caption_en FROM media');
      return first.rows;
    }, '00000003-0000000A-1');
    expect(rows).toEqual([{ body: 'captured' }]);
    expect(db.sql).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', "SET TRANSACTION SNAPSHOT '00000003-0000000A-1'", 'SELECT body FROM pages', 'SELECT caption_en FROM media', 'COMMIT']);
    expect(db.connect).toHaveBeenCalledTimes(1);
    expect(db.release).toHaveBeenCalledOnce();
  });
  it('rolls back an unavailable exported snapshot without invoking or retrying the reader', async () => {
    const db = connection(true);
    const reader = vi.fn();
    await expect(withLoaderSnapshot(db.pool, reader, '00000003-0000000A-1')).rejects.toThrow('invalid snapshot identifier');
    expect(reader).not.toHaveBeenCalled();
    expect(db.sql.at(-1)).toBe('ROLLBACK');
    expect(db.release).toHaveBeenCalledOnce();
  });
  it('allows standalone reads only when the snapshot is absent', async () => {
    const db = connection();
    await withLoaderSnapshot(db.pool, client => client.query('SELECT 1'), undefined);
    expect(db.sql).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT 1', 'COMMIT']);
    expect(() => assertDatabaseSnapshot('00000003-0000000A-1')).not.toThrow();
  });
});
