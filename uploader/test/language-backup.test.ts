import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupError, DUMP_VERSION, LANGUAGE_DUMP_VERSION, SUPPORTED_DUMP_VERSIONS, dumpLanguage, readDump, type Dump } from '../src/backup.js';
import { DEFAULT_LANGUAGE, type LanguageConfig } from '../src/language.js';
import { parseRestoreArgs, requiresLanguageAcceptance } from '../src/cli.js';
import { identityDumpRow } from './site-identity-fixture.js';
import { DEFAULT_NAVIGATION } from '../../site/src/lib/navigation.js';

const stamp = '2026-10-27T12:00:00.000Z';
const modes: LanguageConfig[] = [
  { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] },
  { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] },
];
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'language-backup-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const track = { version: 1, type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]]] };
function fixture(language: LanguageConfig): Dump {
  return { version: DUMP_VERSION, createdAt: stamp, tables: {
    users: [], post_routes: [], site_identity: [identityDumpRow()], site_identity_assets: [],
    pages: [], site_nav: [{ id: 1, config: DEFAULT_NAVIGATION, updated_at: stamp }],
    site_language: [{ id: true, primary_locale: language.primary, enabled_locales: language.locales, locked_at: stamp, updated_at: stamp }],
    posts: (['de', 'en'] as const).map(locale => ({ translation_key: 'story', locale,
      omitted: locale !== language.primary, status: locale === language.primary ? 'published' : 'draft',
      published_at: locale === language.primary ? stamp : null,
      published_snapshot: locale === language.primary ? { track } : null,
    })),
  } };
}
async function save(dump: Dump): Promise<string> {
  const path = join(dir, 'db-20261027-120000.json.gz');
  await writeFile(path, gzipSync(JSON.stringify(dump)));
  return path;
}

describe('version-aware language and snapshot recovery', () => {
  it.each(modes)('preserves mode and primary-only snapshots: $primary/$locales', async language => {
    const dump = fixture(language);
    expect(readDump(await save(dump))).toEqual(dump);
    const secondary = dump.tables.posts.find(row => row.locale !== language.primary)!;
    secondary.omitted = false; // un-omit + Save is not publication
    expect(readDump(await save(dump))).toEqual(dump);
    dump.tables.posts.find(row => row.locale === language.primary)!.status = 'draft';
    expect(readDump(await save(dump))).toEqual(dump); // retained artifact after Unpublish
    if (language.locales.length === 2) {
      secondary.published_at = stamp;
      secondary.published_snapshot = { track };
      expect(readDump(await save(dump))).toEqual(dump);
    }
  });

  it.each(['missing-language', 'missing-language-timestamp', 'invalid-language-timestamp', 'duplicate-locale', 'unknown-locale', 'primary-disabled', 'missing-row', 'duplicate-row', 'omitted-primary', 'omitted-history', 'disabled-snapshot', 'secondary-without-primary', 'history-without-snapshot', 'published-without-history', 'missing-track', 'private-track', 'different-track'])(
    'refuses %s before restore can acquire a client', async kind => {
      const dump = fixture({ primary: 'de', locales: ['de', 'en'] });
      const primary = dump.tables.posts[0]!;
      const secondary = dump.tables.posts[1]!;
      const config = dump.tables.site_language![0]!;
      if (kind === 'missing-language') delete dump.tables.site_language;
      if (kind === 'missing-language-timestamp') delete config.updated_at;
      if (kind === 'invalid-language-timestamp') config.updated_at = 'invalid';
      if (kind === 'duplicate-locale') config.enabled_locales = ['de', 'de'];
      if (kind === 'unknown-locale') config.enabled_locales = ['de', 'fr'];
      if (kind === 'primary-disabled') config.enabled_locales = ['en'];
      if (kind === 'missing-row') dump.tables.posts.pop();
      if (kind === 'duplicate-row') secondary.locale = 'de';
      if (kind === 'omitted-primary') primary.omitted = true;
      if (kind === 'omitted-history') secondary.published_at = stamp;
      if (kind === 'history-without-snapshot') primary.published_snapshot = null;
      if (kind === 'published-without-history') primary.published_at = null;
      if (['disabled-snapshot', 'secondary-without-primary', 'missing-track', 'private-track', 'different-track'].includes(kind)) {
        secondary.omitted = false; secondary.published_at = stamp; secondary.published_snapshot = { track };
        if (kind === 'disabled-snapshot') config.enabled_locales = ['de'];
        if (kind === 'secondary-without-primary') { primary.published_at = null; primary.published_snapshot = null; primary.status = 'draft'; }
        if (kind === 'missing-track') secondary.published_snapshot = {};
        if (kind === 'private-track') secondary.published_snapshot = { track: { ...track, source_id: 'private' } };
        if (kind === 'different-track') secondary.published_snapshot = { track: { ...track, coordinates: [[[5, 6], [7, 8]]] } };
      }
      const path = await save(dump);
      expect(() => readDump(path)).toThrow(BackupError);
    },
  );

  it.each(SUPPORTED_DUMP_VERSIONS.filter(version => version < LANGUAGE_DUMP_VERSION))('explicitly normalizes legacy v%i, retaining its two-snapshot GPX rule', async version => {
    const dump = fixture(DEFAULT_LANGUAGE);
    dump.version = version;
    for (const row of dump.tables.posts) {
      row.omitted = true; // not a declared field in the historical version
      row.published_snapshot = { track }; row.published_at = stamp; row.status = 'published';
    }
    delete dump.tables.site_language;
    if (version < 11) { delete dump.tables.site_identity; delete dump.tables.site_identity_assets; }
    if (version < 10) delete dump.tables.post_routes;
    const restored = readDump(await save(dump));
    expect(dumpLanguage(restored)).toEqual(DEFAULT_LANGUAGE);
    expect(restored.tables.posts.every(row => row.omitted === false)).toBe(true);
    expect(restored.tables.site_language?.[0]).toMatchObject({ primary_locale: 'de', enabled_locales: ['de', 'en'] });
    dump.tables.posts[1]!.published_snapshot = null;
    const invalid = await save(dump);
    expect(() => readDump(invalid)).toThrow(BackupError);
  });

  describe.each(SUPPORTED_DUMP_VERSIONS.filter(version => version < LANGUAGE_DUMP_VERSION))('legacy v%i language timestamp', version => {
    it.each([undefined, null, 'invalid'])('normalizes optional historical createdAt=%j without trusting undeclared language data', async createdAt => {
      const dump = fixture(DEFAULT_LANGUAGE);
      dump.version = version;
      dump.tables.posts = [];
      dump.tables.site_language = [{ primary_locale: 'en', enabled_locales: ['en'], updated_at: null }];
      if (version < 11) { delete dump.tables.site_identity; delete dump.tables.site_identity_assets; }
      if (version < 10) delete dump.tables.post_routes;
      const path = join(dir, 'legacy.json.gz');
      await writeFile(path, gzipSync(JSON.stringify({ ...dump, createdAt })));
      const before = Date.now();
      const restored = readDump(path);
      const recovered = restored.tables.site_language![0]!;
      expect(recovered).toMatchObject({ id: true, primary_locale: 'de', enabled_locales: ['de', 'en'], locked_at: null });
      const recoveredAt = Date.parse(String(recovered.updated_at));
      expect(recoveredAt).toBeGreaterThanOrEqual(before);
      expect(recoveredAt).toBeLessThanOrEqual(Date.now());
    });
  });
});

describe('offline cross-mode confirmation', () => {
  it('parses the independent flag on either side of the path', () => {
    for (const args of [['--yes', 'dump', '--accept-language-change'], ['--accept-language-change', '--yes', 'dump']]) {
      expect(parseRestoreArgs(args)).toEqual({ yes: true, acceptLanguageChange: true, file: 'dump' });
    }
    expect(parseRestoreArgs(['--yes', 'dump']).acceptLanguageChange).toBe(false);
  });
  it.each(modes)('requires acceptance for every locked mode mismatch: $primary/$locales', live => {
    for (const restored of modes) {
      const same = live.primary === restored.primary && live.locales.length === restored.locales.length;
      expect(requiresLanguageAcceptance({ ...live, lockedAt: new Date(stamp) }, restored)).toBe(!same);
      expect(requiresLanguageAcceptance({ ...live, lockedAt: null }, restored)).toBe(false);
    }
    expect(requiresLanguageAcceptance({ ...live, lockedAt: new Date(stamp) }, { ...live, locales: [...live.locales].reverse() })).toBe(false);
  });
});
