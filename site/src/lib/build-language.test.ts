import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBuildLanguage } from './build-language';

const db = vi.hoisted(() => ({
  rows: [] as { primary_locale: unknown; enabled_locales: unknown }[],
  sql: [] as string[], release: vi.fn(), end: vi.fn(), failImport: false,
}));
vi.mock('pg', () => ({ default: { Pool: class {
  async connect() { return this; }
  release = db.release;
  end = db.end;
  async query(sql: string) {
    db.sql.push(sql);
    if (sql.startsWith('SET TRANSACTION SNAPSHOT') && db.failImport) throw new Error('expired snapshot');
    return { rows: sql.startsWith('SELECT') ? db.rows : [] };
  }
} } }));
beforeEach(() => {
  db.rows = [{ primary_locale: 'en', enabled_locales: ['en'] }];
  db.sql = []; db.failImport = false; vi.clearAllMocks();
  vi.stubEnv('SITE_LANGUAGE_JSON', undefined);
  vi.stubEnv('SITE_DATABASE_SNAPSHOT', undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('Astro configuration language', () => {
  it('derives standalone/development configuration from PostgreSQL rather than DE defaults', async () => {
    expect(await resolveBuildLanguage('postgres://mocked/never-dialed')).toEqual({ primary: 'en', locales: ['en'] });
    expect(db.sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(db.sql.at(-1)).toBe('COMMIT');
    expect(db.release).toHaveBeenCalledOnce();
    expect(db.end).toHaveBeenCalledOnce();
  });
  it('imports the captured build snapshot before reading mode and verifies the handoff', async () => {
    vi.stubEnv('SITE_LANGUAGE_JSON', '{"primary":"en","locales":["en"]}');
    vi.stubEnv('SITE_DATABASE_SNAPSHOT', '00000003-0000000A-1');
    await resolveBuildLanguage('postgres://mocked/never-dialed');
    expect(db.sql[1]).toBe("SET TRANSACTION SNAPSHOT '00000003-0000000A-1'");
    expect(db.sql[2]).toContain('FROM site_language');
  });
  it('refuses a mode which differs from the captured database', async () => {
    vi.stubEnv('SITE_LANGUAGE_JSON', '{"primary":"de","locales":["de"]}');
    await expect(resolveBuildLanguage('postgres://mocked/never-dialed')).rejects.toThrow('does not match');
    expect(db.end).toHaveBeenCalledOnce();
  });
  it('never falls back to fresh reads after snapshot import failure', async () => {
    vi.stubEnv('SITE_DATABASE_SNAPSHOT', '00000003-0000000A-1');
    db.failImport = true;
    await expect(resolveBuildLanguage('postgres://mocked/never-dialed')).rejects.toThrow('expired snapshot');
    expect(db.sql.some((sql) => sql.startsWith('SELECT'))).toBe(false);
    expect(db.sql.at(-1)).toBe('ROLLBACK');
    expect(db.release).toHaveBeenCalledOnce();
    expect(db.end).toHaveBeenCalledOnce();
  });
  it('refuses missing database configuration or an uninitialized language row', async () => {
    await expect(resolveBuildLanguage(undefined)).rejects.toThrow('DATABASE_URL');
    db.rows = [];
    await expect(resolveBuildLanguage('postgres://mocked/never-dialed')).rejects.toThrow('not initialized');
  });
});
