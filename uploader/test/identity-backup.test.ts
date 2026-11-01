import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupError, DUMP_VERSION, IDENTITY_DUMP_VERSION, readDump, validateIdentityAssets, type Dump } from '../src/backup.js';
import { normalizeIdentityUpload } from '../src/site-identity-assets.js';
import { neutralIdentity } from '../../site/src/lib/site-identity.js';
import { identityDumpRow } from './site-identity-fixture.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'identity-backup-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function fixture(): Dump {
  return { version: DUMP_VERSION, createdAt: '2026-10-27T12:00:00.000Z', tables: {
    users: [], posts: [], post_routes: [], site_identity: [identityDumpRow()], site_identity_assets: [],
    journeys: [], journey_locales: [], journey_members: [],
    pages: [], site_nav: [{ id: 1, config: { version: 1, header: [], footer: [], legal: [] }, updated_at: '2026-10-27T12:00:00.000Z' }],
    site_language: [{ id: true, primary_locale: 'de', enabled_locales: ['de', 'en'], locked_at: null, updated_at: '2026-10-27T12:00:00.000Z' }],
  } };
}
async function save(dump: Dump): Promise<string> {
  const path = join(dir, 'db-20261027-120000.json.gz');
  await writeFile(path, gzipSync(JSON.stringify(dump)));
  return path;
}
async function logo(): Promise<Record<string, unknown>> {
  const bytes = await sharp({ create: { width: 64, height: 32, channels: 4, background: '#123456' } }).png().toBuffer();
  return { role: 'logo', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.toString('base64'),
    width: 64, height: 32, created_at: '2026-10-27T12:00:00.000Z' };
}

describe('identity dump version and full-storage validation', () => {
  it('requires both tables at the recorded introduction version, never infers legacy from missing fields', async () => {
    for (const field of ['site_identity', 'site_identity_assets'] as const) {
      const dump = fixture(); dump.version = IDENTITY_DUMP_VERSION; delete dump.tables[field];
      const path = await save(dump);
      expect(() => readDump(path)).toThrow(BackupError);
    }
    const legacy = fixture(); legacy.version = IDENTITY_DUMP_VERSION - 1;
    delete legacy.tables.site_identity; delete legacy.tables.site_identity_assets;
    delete legacy.tables.journeys; delete legacy.tables.journey_locales; delete legacy.tables.journey_members;
    expect(readDump(await save(legacy)).version).toBe(IDENTITY_DUMP_VERSION - 1);
  });

  it('normalizes every retained locale without manufacturing absent locale keys', async () => {
    const dump = fixture();
    dump.tables.site_identity = [identityDumpRow({ ...neutralIdentity(), siteName: '  Cafe\u0301  ',
      tagline: { de: 'Deutsch', en: 'Retained English' }, aboutRole: { en: '  Writer ' } })];
    const row = readDump(await save(dump)).tables.site_identity![0]!;
    expect(row.site_name).toBe('Café');
    expect(row.localized).toEqual({ tagline: { de: 'Deutsch', en: 'Retained English' },
      aboutRole: { en: 'Writer' }, aboutGear: {}, studioDescriptor: {} });
  });

  const malformedRows: [string, unknown][] = [
    ['id', false], ['revision', 0], ['revision', 1.5], ['revision', 2147483648],
    ['seed_source', 'invented'], ['saved_at', 'tomorrow'], ['saved_at', undefined], ['updated_at', null],
    ['updated_at', '2026-02-30T12:00:00.000Z'], ['saved_at', '2026-10-27T24:00:00.000Z'],
    ['site_name', 'x'.repeat(81)], ['site_name', 4], ['author_name', 'x'.repeat(81)],
    ['site_name', 'Name\u202e'], ['site_name', '\tName'],
    ['canonical_origin', 'javascript:alert(1)'], ['canonical_origin', 'https://example.test/blog'],
    ['localized', null], ['localized', []], ['localized', { extra: {} }],
    ['localized', { tagline: null }], ['localized', { tagline: { fr: 'unexpected' } }],
    ['localized', { tagline: { de: 'valid', en: 4 } }],
    ['localized', { tagline: { de: 'valid', en: 'x'.repeat(161) } }],
    ['localized', { aboutRole: { en: 'x'.repeat(81) } }],
    ['localized', { aboutRole: { en: 'Writer\u0000' } }],
    ['localized', { aboutGear: { en: 'x'.repeat(201) } }],
    ['localized', { studioDescriptor: { en: 'x'.repeat(81) } }],
    ['social_links', Array.from({ length: 7 }, () => ({ label: 'Link', url: 'https://example.test' }))],
    ['social_links', [{ label: '', url: 'https://example.test' }]],
    ['social_links', [{ label: 'x'.repeat(41), url: 'https://example.test' }]],
    ...['javascript:alert(1)', 'data:text/html,hi', 'http://example.test', 'https://user:pass@example.test',
      'https://127.0.0.1', 'https://example.test/\nsecret', `https://example.test/${'x'.repeat(2049)}`]
      .map((url): [string, unknown] => ['social_links', [{ label: 'Link', url }]]),
  ];
  it.each(malformedRows)('refuses invalid stored %s without echoing values', async (field, value) => {
    const dump = fixture(); dump.tables.site_identity![0]![field] = value;
    const path = await save(dump);
    expect(() => readDump(path)).toThrow(/Invalid identity field in backup:/);
  });

  it('refuses empty or duplicate singleton rows and unexpected identity in older formats', async () => {
    for (const rows of [[], [identityDumpRow(), identityDumpRow()]]) {
      const dump = fixture(); dump.tables.site_identity = rows;
      const path = await save(dump); expect(() => readDump(path)).toThrow(/site_identity/);
    }
    const dump = fixture(); dump.version = IDENTITY_DUMP_VERSION - 1;
    const path = await save(dump); expect(() => readDump(path)).toThrow(/version/);
  });
});

describe('identity asset restore boundary', () => {
  it('round-trips canonical base64 and fully decodes a bounded PNG', async () => {
    const dump = fixture(); dump.tables.site_identity_assets = [await logo()];
    const parsed = readDump(await save(dump));
    await expect(validateIdentityAssets(parsed)).resolves.toBeUndefined();
    expect(parsed.tables.site_identity_assets).toEqual(dump.tables.site_identity_assets);
  });

  it.each(['png', 'jpeg', 'webp'] as const)('accepts normalized %s uploads through the real dump codec for every role', async (format) => {
    const source = await sharp({ create: { width: 360, height: 180, channels: 4, background: '#12345680' } })
      .withMetadata().toFormat(format).toBuffer();
    const normalized = [
      ...await normalizeIdentityUpload(source, 'logo'),
      ...await normalizeIdentityUpload(source, 'favicon'),
    ];
    const dump = fixture();
    dump.tables.site_identity_assets = normalized.map((asset) => ({
      ...asset, bytes: asset.bytes.toString('base64'), created_at: '2026-10-27T12:00:00.000Z',
    }));
    const restored = readDump(await save(dump));
    await expect(validateIdentityAssets(restored)).resolves.toBeUndefined();
    expect(restored.tables.site_identity_assets).toHaveLength(4);
    for (const asset of normalized) {
      const row = restored.tables.site_identity_assets!.find((entry) => entry.role === asset.role)!;
      expect(row).toMatchObject({ sha256: asset.sha256, width: asset.width, height: asset.height });
      expect(Buffer.from(row.bytes as string, 'base64')).toEqual(asset.bytes);
    }
  });

  it('refuses embedded image metadata rather than repairing untrusted restored bytes', async () => {
    const bytes = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#123456' } })
      .withMetadata().png().toBuffer();
    const dump = fixture();
    dump.tables.site_identity_assets = [{ ...await logo(), bytes: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex') }];
    await expect(validateIdentityAssets(readDump(await save(dump)))).rejects.toThrow(/assets.png/);
  });

  it.each([
    ['role', 'banner'], ['sha256', '0'.repeat(64)], ['width', 961], ['height', 241],
    ['width', 1.5], ['created_at', 'not a date'], ['bytes', 'not-base64'], ['bytes', 'A'.repeat(349529)],
  ])('rejects invalid asset %s', async (field, value) => {
    const dump = fixture(); const asset = await logo(); asset[field as string] = value;
    dump.tables.site_identity_assets = [asset];
    const path = await save(dump); expect(() => readDump(path)).toThrow(/assets\./);
  });

  it('rejects duplicate roles and incomplete favicon sets', async () => {
    const dump = fixture(); const asset = await logo(); dump.tables.site_identity_assets = [asset, asset];
    let path = await save(dump); expect(() => readDump(path)).toThrow(/assets.role/);
    dump.tables.site_identity_assets = [{ ...asset, role: 'favicon-32', width: 32, height: 32 }];
    path = await save(dump); expect(() => readDump(path)).toThrow(/assets.favicon/);
  });

  it('rejects a rehashed truncated PNG and decoded dimensions that disagree with the row', async () => {
    for (const truncated of [true, false]) {
      const dump = fixture(); const asset = await logo();
      if (truncated) {
        const bytes = Buffer.from(asset.bytes as string, 'base64').subarray(0, 40);
        asset.bytes = bytes.toString('base64'); asset.sha256 = createHash('sha256').update(bytes).digest('hex');
      } else asset.width = 63;
      dump.tables.site_identity_assets = [asset];
      await expect(validateIdentityAssets(readDump(await save(dump)))).rejects.toThrow(/assets.png/);
    }
  });

  it('rejects valid non-PNG bytes even with a matching digest', async () => {
    const bytes = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    const dump = fixture(); dump.tables.site_identity_assets = [{ ...await logo(),
      bytes: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }];
    const path = await save(dump); expect(() => readDump(path)).toThrow(/assets.format/);
  });
});
