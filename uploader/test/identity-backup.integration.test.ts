import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { dumpDatabase, readDump, restoreDatabase, IDENTITY_DUMP_VERSION, type Connectable, type Dump } from '../src/backup.js';
import { identityFromRow, seedSiteIdentity, type IdentityRow } from '../src/site-identity.js';
import { LEGACY_IDENTITY } from '../src/site-identity-legacy.js';
import { neutralIdentity } from '../../site/src/lib/site-identity.js';
import { identityDumpRow } from './site-identity-fixture.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
maybe('identity recovery with isolated PostgreSQL state', () => {
  const schema = `identity_backup_${randomUUID().replaceAll('-', '')}`;
  let owner: DbPool;
  let pool: DbPool;
  let dir: string;
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await ensureSchema(pool);
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'identity-backup-pg-'));
    await pool.query('DELETE FROM site_identity_assets');
    await pool.query('DELETE FROM site_identity');
    await seedSiteIdentity(pool);
    await pool.query("UPDATE pages SET title='Live sentinel'");
  });
  afterEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS reject_identity_commit ON site_identity');
    await rm(dir, { recursive: true, force: true });
  });
  afterAll(async () => {
    await pool?.end();
    if (owner) { await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); }
  });
  async function stored() {
    return (await pool.query<IdentityRow>('SELECT * FROM site_identity')).rows[0]!;
  }
  async function content() {
    return {
      identity: (await pool.query('SELECT * FROM site_identity')).rows,
      assets: (await pool.query('SELECT * FROM site_identity_assets ORDER BY role')).rows,
      pages: (await pool.query('SELECT key, locale, title, body_markdown, images FROM pages ORDER BY key, locale')).rows,
      users: (await pool.query('SELECT * FROM users ORDER BY id')).rows,
      posts: (await pool.query('SELECT * FROM posts ORDER BY id')).rows,
    };
  }
  async function save(dump: Dump) {
    const file = join(dir, 'db-20261027-120000.json.gz');
    await writeFile(file, gzipSync(JSON.stringify(dump))); return file;
  }
  async function addLogo() {
    const bytes = await sharp({ create: { width: 64, height: 32, channels: 4, background: '#123456' } }).png().toBuffer();
    await pool.query('INSERT INTO site_identity_assets (role,sha256,width,height,bytes) VALUES ($1,$2,$3,$4,$5)',
      ['logo', createHash('sha256').update(bytes).digest('hex'), 64, 32, bytes]);
  }

  it('round-trips full retained DE/EN maps, metadata and PNG bytes, replacing destination-only values', async () => {
    const localized = { tagline: { de: 'Deutsch', en: 'Retained English' }, aboutRole: { en: 'Writer' },
      aboutGear: { de: 'Notebook' }, studioDescriptor: { en: 'Private studio descriptor' } };
    await pool.query(`UPDATE site_identity SET revision=9, seed_source='legacy', saved_at=now(),
      site_name='Other journal', author_name='Ada', canonical_origin='https://journal.example',
      localized=$1::jsonb, social_links=$2::jsonb`, [JSON.stringify(localized), JSON.stringify([{ label: 'Profile', url: 'https://social.example/ada' }])]);
    await addLogo();
    const before = await content();
    const file = join(dir, await dumpDatabase(pool, dir));
    const dump = readDump(file);
    expect(dump.tables.site_identity_assets![0]!.bytes).toBe((before.assets[0]!.bytes as Buffer).toString('base64'));
    await pool.query("UPDATE site_identity SET site_name='Destination', localized='{\"tagline\":{\"de\":\"Overwrite\"}}', canonical_origin=NULL");
    await pool.query('DELETE FROM site_identity_assets');
    await pool.query("UPDATE pages SET title='Destination page'");
    await restoreDatabase(pool, file);
    expect(await content()).toEqual(before);
    expect(identityFromRow(await stored()).tagline).toEqual(localized.tagline);
  });

  it.each([1, 10])('restores v%i as legacy, clears assets, keeps the live canonical and leaves saved_at unset', async (version) => {
    await pool.query("UPDATE site_identity SET site_name='Live', canonical_origin='https://destination.example', saved_at=now(), revision=7");
    await addLogo();
    const legacy: Dump = { version, createdAt: new Date().toISOString(), tables: { users: [], posts: [],
      ...(version >= 10 ? { post_routes: [] } : {}) } };
    await restoreDatabase(pool, await save(legacy));
    const row = await stored();
    expect(identityFromRow(row)).toEqual({ ...LEGACY_IDENTITY, canonicalOrigin: 'https://destination.example' });
    expect(row).toMatchObject({ seed_source: 'restored-legacy', saved_at: null, revision: 1 });
    expect((await pool.query('SELECT * FROM site_identity_assets')).rows).toEqual([]);
  });

  it('uses the legacy canonical when the destination has none, and keeps identity in the undo dump', async () => {
    const undo = join(dir, await dumpDatabase(pool, dir));
    const legacy: Dump = { version: IDENTITY_DUMP_VERSION - 1, createdAt: new Date().toISOString(),
      tables: { users: [], posts: [], post_routes: [] } };
    await restoreDatabase(pool, await save(legacy));
    expect(identityFromRow(await stored())).toEqual(LEGACY_IDENTITY);
    await restoreDatabase(pool, undo);
    expect(identityFromRow(await stored())).toEqual(neutralIdentity());
  });

  it.each([
    null, [], { tagline: { de: 'valid', en: 12 } }, { tagline: { de: 'valid', en: 'x'.repeat(161) } },
    { tagline: { fr: 'unknown' } }, { aboutGear: { en: 'x'.repeat(201) } },
  ].map((localized) => [localized]))('refuses corrupt retained locale data before changing any live table: %j', async (localized) => {
    await addLogo(); const before = await content();
    const dump = readDump(join(dir, await dumpDatabase(pool, dir)));
    dump.tables.site_identity![0]!.localized = localized;
    await expect(restoreDatabase(pool, await save(dump))).rejects.toThrow(/Invalid identity field/);
    expect(await content()).toEqual(before);
  });

  it('refuses a correctly rehashed broken PNG before destructive SQL', async () => {
    await addLogo(); const before = await content();
    const dump = readDump(join(dir, await dumpDatabase(pool, dir)));
    const asset = dump.tables.site_identity_assets![0]!;
    const broken = Buffer.from(asset.bytes as string, 'base64').subarray(0, 40);
    asset.bytes = broken.toString('base64'); asset.sha256 = createHash('sha256').update(broken).digest('hex');
    await expect(restoreDatabase(pool, await save(dump))).rejects.toThrow(/assets.png/);
    expect(await content()).toEqual(before);
  });

  it('rolls identity, assets and content back together on a transaction failure', async () => {
    const dump = readDump(join(dir, await dumpDatabase(pool, dir)));
    dump.tables.site_identity = [identityDumpRow({ ...neutralIdentity(), siteName: 'Incoming' })];
    dump.tables.pages = [];
    await addLogo(); const before = await content();
    await pool.query(`CREATE OR REPLACE FUNCTION reject_identity_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic identity commit refusal'; END $$`);
    await pool.query(`CREATE CONSTRAINT TRIGGER reject_identity_commit AFTER INSERT ON site_identity
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_identity_commit()`);
    await expect(restoreDatabase(pool, await save(dump))).rejects.toThrow();
    expect(await content()).toEqual(before);
  });

  it('captures identity and assets from the same repeatable-read view as content', async () => {
    await pool.query("UPDATE site_identity SET site_name='Before'");
    await addLogo(); const before = await content();
    let changed = false;
    const db: Connectable = {
      query: (sql, params) => pool.query(sql, params),
      async connect() {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          async query(sql, params) {
            const result = await client.query(sql, params);
            if (!changed && sql.includes('FROM site_identity ORDER')) {
              changed = true;
              await pool.query("UPDATE site_identity SET site_name='After'");
              await pool.query('DELETE FROM site_identity_assets');
              await pool.query("UPDATE pages SET title='After capture'");
            }
            return result;
          },
        };
      },
    };
    const dump = readDump(join(dir, await dumpDatabase(db, dir)));
    expect(changed).toBe(true);
    expect(dump.tables.site_identity![0]!.site_name).toBe('Before');
    expect(dump.tables.site_identity_assets).toHaveLength(1);
    expect(dump.tables.pages!.map((page) => page.title)).toEqual(before.pages.map((page) => page.title));
    expect((await stored()).site_name).toBe('After');
  });
});
