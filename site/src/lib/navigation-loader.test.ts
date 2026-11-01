import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Loader } from 'astro/loaders';
import { postgresNavigationLoader, navigationSchema } from './navigation-loader';
import { DEFAULT_NAVIGATION } from './navigation';
const db = vi.hoisted(() => ({ sql: [] as string[], config: undefined as unknown, table: true, failSnapshot: false, released: 0, ended: 0 }));
vi.mock('pg', () => ({ default: { Pool: class {
  async connect() { return this; }
  release() { db.released++; }
  async end() { db.ended++; }
  async query(sql: string) {
    db.sql.push(sql);
    if (db.failSnapshot && sql.startsWith('SET TRANSACTION')) throw new Error('expired snapshot');
    if (sql.includes('FROM site_language')) return { rows: [{ primary_locale: 'de', enabled_locales: ['de', 'en'] }] };
    if (sql.includes('to_regclass')) return { rows: [{ present: db.table ? 'site_nav' : null }] };
    if (sql.includes('FROM site_nav')) return { rows: db.config === undefined ? [] : [{ config: db.config }] };
    return { rows: [] };
  }
} } }));
afterEach(() => { vi.unstubAllEnvs(); Object.assign(db, { sql: [], config: undefined, table: true, failSnapshot: false, released: 0, ended: 0 }); });
async function load() {
  vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
  vi.stubEnv('SITE_LANGUAGE_JSON', '{"primary":"de","locales":["de","en"]}');
  vi.stubEnv('SITE_DATABASE_SNAPSHOT', '00000003-0000000A-1');
  const set = vi.fn();
  await postgresNavigationLoader().load({ store: { clear: vi.fn(), set },
    parseData: async ({ data }: { data: unknown }) => navigationSchema.parse(data), logger: { info: vi.fn() },
  } as unknown as Parameters<Loader['load']>[0]);
  return set.mock.calls[0]![0];
}
describe('navigation content loader', () => {
  it.each([true, false])('uses exactly the seeded default for absent row/table (%s)', async (table) => {
    db.table = table;
    expect((await load()).data).toEqual(DEFAULT_NAVIGATION);
    expect(db.sql[1]).toBe("SET TRANSACTION SNAPSHOT '00000003-0000000A-1'");
    expect(db.released).toBe(1); expect(db.ended).toBe(1);
  });
  it('fails malformed stored configuration instead of substituting defaults', async () => {
    db.config = { ...DEFAULT_NAVIGATION, header: [{ kind: 'external', href: { de: 'javascript:alert(1)' }, label: { de: 'Attack' } }] };
    await expect(load()).rejects.toThrow('Invalid site navigation');
    expect(db.released).toBe(1); expect(db.ended).toBe(1);
  });
  it('does not read any content when snapshot import fails and releases the connection', async () => {
    db.failSnapshot = true;
    await expect(load()).rejects.toThrow('expired snapshot');
    expect(db.sql).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', "SET TRANSACTION SNAPSHOT '00000003-0000000A-1'", 'ROLLBACK']);
    expect(db.released).toBe(1); expect(db.ended).toBe(1);
  });
});
