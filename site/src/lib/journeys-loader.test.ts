import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Loader } from 'astro/loaders';
import { journeyEntries, postgresJourneysLoader } from './journeys-loader';
import { hero, modes } from '../../test/journey-fixtures';
import type { JourneySnapshotLocale } from './journey-snapshot';
const db = vi.hoisted(() => ({
  sql: [] as string[], rows: [] as { id: string; published_snapshot: unknown }[],
  fail: '', released: vi.fn(), ended: vi.fn(), connected: vi.fn(),
  language: { primary_locale: 'de', enabled_locales: ['de', 'en'] },
}));
vi.mock('pg', () => ({ default: { Pool: class {
  async connect() { db.connected(); return this; }
  release(broken: boolean) { db.released(broken); }
  async end() { db.ended(); }
  async query(sql: string) {
    db.sql.push(sql);
    if (db.fail && sql.includes(db.fail)) throw new Error('expired snapshot or query timeout');
    if (sql.includes('FROM site_language')) return { rows: [db.language] };
    if (sql.includes('FROM journeys')) return { rows: db.rows };
    return { rows: [] };
  }
} } }));
const snapshot = () => ({ version: 1, members: ['a', 'draft-secret'], locales: {
  de: { slug: 'trip', title: 'Published DE', intro: 'Published introduction', heroImage: hero },
  en: { slug: 'trip', title: 'Published EN', intro: 'Published introduction', heroImage: hero },
} });
async function load() {
  const set = vi.fn();
  await postgresJourneysLoader().load({
    store: { clear: vi.fn(), set }, parseData: async ({ data }: { data: unknown }) => data, logger: { info: vi.fn() },
  } as unknown as Parameters<Loader['load']>[0]);
  return set.mock.calls.map(([entry]) => entry);
}
afterEach(() => {
  vi.unstubAllEnvs(); vi.clearAllMocks(); db.sql = []; db.rows = []; db.fail = '';
  db.language = { primary_locale: 'de', enabled_locales: ['de', 'en'] };
});
describe('snapshot-only journey loader', () => {
  it.each(modes)('imports the build epoch before its sole content query in $primary / $locales', async (language) => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    vi.stubEnv('SITE_LANGUAGE_JSON', JSON.stringify(language));
    vi.stubEnv('SITE_DATABASE_SNAPSHOT', '00000003-0000000A-1');
    db.language = { primary_locale: language.primary, enabled_locales: [...language.locales] };
    db.rows = [{ id: 'id', published_snapshot: snapshot() }];
    const entries = await load();
    expect(entries.map((entry) => entry.id)).toEqual(language.locales.map((locale) => `${locale}/trip`));
    expect(db.sql[1]).toBe("SET TRANSACTION SNAPSHOT '00000003-0000000A-1'");
    expect(db.sql.filter((sql) => sql.includes('FROM journeys'))).toEqual([
      "SELECT id, published_snapshot FROM journeys WHERE status = 'published' AND published_snapshot IS NOT NULL",
    ]);
    expect(db.sql.join(' ')).not.toMatch(/journey_locales|journey_members|post_routes|FROM posts/);
    expect(db.released).toHaveBeenCalledExactlyOnceWith(false);
    expect(db.ended).toHaveBeenCalledOnce();
  });
  it('has no draft output when the published query returns no rows', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    expect(await load()).toEqual([]);
  });
  it.each(['', 'unsafe snapshot'])('refuses supplied invalid epoch %j without opening a connection', async (epoch) => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed'); vi.stubEnv('SITE_DATABASE_SNAPSHOT', epoch);
    await expect(load()).rejects.toThrow();
    expect(db.connected).not.toHaveBeenCalled(); expect(db.ended).toHaveBeenCalledOnce();
    expect(db.sql).toEqual([]);
  });
  it.each(['SET TRANSACTION SNAPSHOT', 'FROM journeys'])('rolls back and releases on %s failure without fresh reads', async (fail) => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed'); vi.stubEnv('SITE_DATABASE_SNAPSHOT', '00000003-0000000A-1');
    db.fail = fail;
    await expect(load()).rejects.toThrow('expired snapshot or query timeout');
    expect(db.sql.at(-1)).toBe('ROLLBACK'); expect(db.released).toHaveBeenCalledExactlyOnceWith(false);
    expect(db.connected).toHaveBeenCalledOnce(); expect(db.ended).toHaveBeenCalledOnce();
  });
  it('rejects malformed snapshots inside the transaction and releases the connection', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://mocked/never-dialed');
    db.rows = [{ id: 'id', published_snapshot: { ...snapshot(), workingSecret: 'never emit' } }];
    await expect(load()).rejects.toThrow('Invalid journey snapshot');
    expect(db.sql.at(-1)).toBe('ROLLBACK'); expect(db.released).toHaveBeenCalledOnce();
  });
  it.each([
    { title: 'A\u0001private control' },
    { intro: '   ' },
    { workingBody: 'private working copy' },
    { heroImage: { ...hero, src: hero.src + '?private=1' } },
    { heroImage: { ...hero, focus: { x: 23, y: 71, privateCoordinate: 12 } } },
  ])('uses the shared strict snapshot boundary for every committed locale (%j)', (invalid) => {
    const valid = snapshot();
    const malformed = { ...valid, locales: { ...valid.locales, en: { ...valid.locales.en, ...invalid } } };
    // A disabled locale is never emitted, but cannot weaken the shared stored-snapshot contract.
    expect(() => journeyEntries({ id: 'id', published_snapshot: malformed }, modes[2]!, 'https://public.example'))
      .toThrow('Invalid journey snapshot');
  });
  it('preserves the authoring snapshot hero type through the public projection', () => {
    const locale: JourneySnapshotLocale = snapshot().locales.de;
    const projected = journeyEntries({ id: 'id', published_snapshot: {
      version: 1, members: ['a'], locales: { de: locale },
    } }, modes[2]!, 'https://public.example')[0]!;
    expect(projected.data.heroImage).toEqual({ ...locale.heroImage, src: 'https://public.example/photos/journey' });
  });
  it('retargets only a valid canonical base and preserves dimensions/focus', () => {
    const entries = journeyEntries({ id: 'id', published_snapshot: snapshot() }, modes[0]!, 'https://public.example');
    expect(entries[0]!.data.heroImage).toEqual({ ...hero, src: 'https://public.example/photos/journey' });
    const bad = snapshot(); bad.locales.de.heroImage = { ...hero, src: hero.src + '-640.webp' };
    expect(() => journeyEntries({ id: 'id', published_snapshot: bad }, modes[0]!, 'https://public.example')).toThrow();
  });
});
