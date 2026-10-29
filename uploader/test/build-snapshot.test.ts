import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createSiteBuilder } from '../src/build.js';
import { withBuildSnapshot } from '../src/build-snapshot.js';
import type { IdentityRow } from '../src/site-identity.js';

const identity: IdentityRow = {
  id: true, revision: 1, seed_source: 'neutral', saved_at: null, updated_at: new Date(0),
  site_name: '', author_name: '', canonical_origin: null, localized: {}, social_links: [],
};
const languageRow = { primary_locale: 'en', enabled_locales: ['en', 'de'], locked_at: null, updated_at: new Date(0) };
function capturePool(languageRows: unknown[], databaseSnapshot = '00000003-0000000A-1', identityRow: IdentityRow = identity) {
  const connection = new EventEmitter();
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('BEGIN ')) return { rows: [] };
    if (sql === 'SELECT pg_export_snapshot() AS snapshot') return { rows: [{ snapshot: databaseSnapshot }] };
    if (sql === 'SELECT * FROM site_identity WHERE id = true') return { rows: [identityRow] };
    if (sql.includes('FROM site_language')) return { rows: languageRows };
    if (sql.includes('FROM site_identity_assets')) return { rows: [] };
    throw new Error(`Unexpected capture query: ${sql}`);
  });
  const client = Object.assign(connection, { release, query });
  const connect = vi.fn(async () => client);
  return { pool: { connect } as unknown as pg.Pool, release, query, connect };
}

describe('build language capture integrity', () => {
  it.each([
    { baseUrl: 'https://blog.example', imgHost: 'images.example' },
    { baseUrl: 'https://cdn.example', imgHost: 'BLOG.example:443' },
    { baseUrl: 'https://cdn.example', imgHost: 'user@images.example' },
  ])('refuses captured canonical conflicting with actual image roles %j before invoking the build', async originRoles => {
    const fixture = capturePool([languageRow], undefined, { ...identity, canonical_origin: 'https://blog.example' });
    const consume = vi.fn(async () => {});
    await expect(withBuildSnapshot(fixture.pool, { timeoutMs: 5000, originRoles }, consume))
      .rejects.toMatchObject({ code: 'invalid_identity', field: 'canonicalOrigin' });
    expect(consume).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('captures a normalized canonical separately from the image URL and routing authority', async () => {
    const fixture = capturePool([languageRow], undefined, { ...identity, canonical_origin: 'https://BÜCHER.example:443/' });
    await withBuildSnapshot(fixture.pool, { timeoutMs: 5000,
      originRoles: { baseUrl: 'https://cdn.example', imgHost: 'images.example' } }, async snapshot => {
      expect(snapshot.identity.canonicalOrigin).toBe('https://xn--bcher-kva.example');
      expect(snapshot.language).toEqual({ primary: 'en', locales: ['en', 'de'] });
    });
  });
  it('captures normalized language from the same exporter connection, without history in the child contract', async () => {
    const fixture = capturePool([{ ...languageRow, enabled_locales: ['de', 'en'] }]);
    await withBuildSnapshot(fixture.pool, { timeoutMs: 5000 }, async snapshot => {
      expect(snapshot.language).toEqual({ primary: 'en', locales: ['en', 'de'] });
      expect(snapshot.databaseSnapshot).toBe('00000003-0000000A-1');
      expect(fixture.release).not.toHaveBeenCalled();
    });
    expect(fixture.connect).toHaveBeenCalledTimes(1);
    expect(fixture.query.mock.calls[0]).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY']);
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['de', 'en'] as const)('excludes disabled localized identity from the %s-only snapshot', async primary => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const localized = {
      tagline: { [primary]: 'Public tagline', [secondary]: 'PRIVATE_DISABLED_TAGLINE' },
      aboutRole: { [primary]: 'Public role', [secondary]: 'PRIVATE_DISABLED_ROLE' },
      aboutGear: { [primary]: 'Public gear', [secondary]: 'PRIVATE_DISABLED_GEAR' },
      studioDescriptor: { [primary]: 'PRIVATE_ADMIN_DESCRIPTOR' },
    };
    const fixture = capturePool(
      [{ ...languageRow, primary_locale: primary, enabled_locales: [primary] }],
      '00000003-0000000A-1',
      { ...identity, localized },
    );
    await withBuildSnapshot(fixture.pool, { timeoutMs: 5000 }, async snapshot => {
      expect(snapshot.language).toEqual({ primary, locales: [primary] });
      expect(snapshot.identity.locales).toEqual([primary]);
      expect(snapshot.identity.tagline).toEqual({ [primary]: 'Public tagline' });
      expect(snapshot.identity.aboutRole).toEqual({ [primary]: 'Public role' });
      expect(snapshot.identity.aboutGear).toEqual({ [primary]: 'Public gear' });
      expect(JSON.stringify(snapshot.identity)).not.toContain('PRIVATE_');
    });
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([
    { name: 'missing singleton', rows: [] },
    { name: 'duplicate singleton', rows: [languageRow, languageRow] },
    { name: 'unknown primary', rows: [{ ...languageRow, primary_locale: 'fr' }] },
    { name: 'disabled primary', rows: [{ ...languageRow, enabled_locales: ['de'] }] },
    { name: 'duplicate enabled locale', rows: [{ ...languageRow, enabled_locales: ['en', 'en'] }] },
    { name: 'invalid history', rows: [{ ...languageRow, updated_at: 'not-a-date' }] },
  ])('fails closed for $name and preserves the live release while releasing the exporter', async ({ rows }) => {
    const root = await mkdtemp(join(tmpdir(), 'language-capture-'));
    const siteAppDir = join(root, 'app');
    const releasesRoot = join(root, 'site');
    await mkdir(siteAppDir);
    const runBuild = vi.fn(async (outDir: string) => {
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, 'index.html'), 'previous release');
    });
    const fixture = capturePool(rows);
    try {
      expect((await createSiteBuilder({ siteAppDir, releasesRoot, runBuild }).build()).ok).toBe(true);
      runBuild.mockClear();
      const outcome = await createSiteBuilder({ siteAppDir, releasesRoot, runBuild, pool: fixture.pool }).build();
      expect(outcome.ok).toBe(false);
      expect(runBuild).not.toHaveBeenCalled();
      expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(await readFile(join(releasesRoot, 'current', 'index.html'), 'utf8')).toBe('previous release');
      expect(await readdir(join(siteAppDir, '.build-tmp')).catch(() => [])).toEqual([]);
      expect((await readdir(join(releasesRoot, 'releases'))).filter(name => name.endsWith('.partial'))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['', 'invalid snapshot', "00000003-0000000A-1'; SELECT 1"] )('never consumes malformed exported snapshot %j', async value => {
    const fixture = capturePool([languageRow], value);
    const consume = vi.fn(async () => {});
    await expect(withBuildSnapshot(fixture.pool, { timeoutMs: 5000 }, consume)).rejects.toThrow();
    expect(consume).not.toHaveBeenCalled();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
