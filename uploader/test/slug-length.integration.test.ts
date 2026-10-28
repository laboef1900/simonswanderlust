import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../src/db.js';
import { pgPostStore, type PostPair } from '../src/posts.js';
import { memoryMediaStore } from '../src/media-store.js';
import { buildServer } from '../src/server.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryPageStore } from '../src/pages.js';
import { memorySecretsStore } from '../src/secrets.js';
import { createSettingsStore, defaultSettings } from '../src/settings.js';
import { createEncodeQueue } from '../src/encode-queue.js';
import { createWorkLock } from '../src/work-lock.js';
import { createDbBackup } from '../src/backup.js';
import { publishBody, publishTokens } from './publish-tokens.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const fixture = (): PostPair => ({
  translationKey: '', status: 'draft',
  shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } },
  de: { locale: 'de', slug: 'synthetic-de', title: 'Synthetic', country: 'Test', excerpt: 'Excerpt', heroImage: { src: 'https://legacy.test/hero', width: 640, height: 480, alt: 'View' }, bodyMarkdown: 'Synthetic text', images: {} },
  en: { locale: 'en', slug: 'synthetic-en', title: 'Synthetic', country: 'Test', excerpt: 'Excerpt', heroImage: { src: 'https://legacy.test/hero', width: 640, height: 480, alt: 'View' }, bodyMarkdown: 'Synthetic text', images: {} },
});

maybe('slug length at real PostgreSQL boundaries (#353)', () => {
  let owner: pg.Pool;
  let pool: pg.Pool;
  let schema: string;
  beforeEach(async () => {
    schema = `slug_length_${randomUUID().replaceAll('-', '')}`;
    owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await ensureSchema(pool);
  });
  afterEach(async () => {
    await pool.end();
    await owner.query(`DROP SCHEMA ${schema} CASCADE`);
    await owner.end();
  });

  it.each(['de', 'en'] as const)('enforces %s direct-store lengths with no partial rows/revisions on refusal', async (locale) => {
    const posts = pgPostStore(pool);
    for (const length of [250, 251, 252, 8192]) {
      const input = fixture();
      input[locale].slug = 'a'.repeat(length);
      if (length <= 251) {
        const saved = await posts.upsertDraft(input);
        expect((await posts.get(saved.translationKey))?.[locale].slug).toBe(input[locale].slug);
        await posts.publish(saved.translationKey, await publishTokens(posts, saved.translationKey));
        const snapshots = await pool.query('SELECT published_snapshot FROM posts WHERE translation_key=$1 AND locale=$2', [saved.translationKey, locale]);
        expect(snapshots.rows[0].published_snapshot.slug).toBe(input[locale].slug);
        await posts.remove(saved.translationKey);
      } else {
        const message = `${locale}.slug must be at most 251 ASCII bytes (received ${length})`;
        await expect(posts.upsertDraft(input)).rejects.toThrow(message);
        expect((await pool.query('SELECT * FROM posts')).rows).toEqual([]);
        const saved = await posts.upsertDraft(fixture());
        const before = (await pool.query('SELECT * FROM posts ORDER BY locale')).rows;
        await expect(posts.upsertDraft({ ...input, translationKey: saved.translationKey })).rejects.toThrow(message);
        expect((await pool.query('SELECT * FROM posts ORDER BY locale')).rows).toEqual(before);
        expect(await posts.listRevisions(saved.translationKey)).toEqual([]);
        await posts.remove(saved.translationKey);
      }
    }
    const unset = fixture();
    unset[locale].slug = '';
    expect((await posts.upsertDraft(unset))[locale].slug).toBe('');
  });

  it.each([
    ['single', 'de', 'published'], ['single', 'en', 'published'],
    ['bulk', 'de', 'published'], ['bulk', 'en', 'published'],
    ['single', 'de', 'draft'], ['single', 'en', 'draft'],
    ['bulk', 'de', 'draft'], ['bulk', 'en', 'draft'],
  ] as const)('%s refuses legacy %s slugs (%s) and inventories working/snapshot URLs without mutation', async (mode, locale, status) => {
    const root = await mkdtemp(join(tmpdir(), 'slug-length-'));
    const posts = pgPostStore(pool);
    const users = memoryUserStore();
    const sessions = memorySessionStore();
    const media = memoryMediaStore({ baseUrl: 'https://images.test' });
    const queue = createEncodeQueue({ store: media, storageDir: join(root, 'images'), lock: createWorkLock() });
    let builds = 0;
    const app = buildServer({
      storageDir: join(root, 'images'), siteDir: join(root, 'site'), backupDir: join(root, 'mdx'),
      baseUrl: 'https://images.test', imgHost: 'images.test', users, sessions, posts, media,
      pages: memoryPageStore(), secrets: memorySecretsStore(), encodeQueue: queue,
      settings: createSettingsStore({ path: join(root, 'settings.json'), defaults: defaultSettings() }),
      dbBackup: createDbBackup({ db: pool, dir: join(root, 'backup'), retention: () => 10 }),
      dbCheck: async () => { await pool.query('SELECT 1'); },
      builder: { hasRelease: () => true, quiesce: async () => {}, build: async () => { builds++; return { ok: true, release: 'synthetic' }; } },
    });
    try {
      const admin = await users.create({ username: 'slug-admin', password: 'synthetic-password', isAdmin: true });
      const cookies = { sid: await sessions.create(admin.id, 60_000) };
      const saved = await posts.upsertDraft(fixture());
      const tk = saved.translationKey;
      await posts.publish(tk, await publishTokens(posts, tk));
      // Synthetic legacy data only: neither the inventory nor production code repairs it.
      const working = 'w'.repeat(252);
      const published = 'p'.repeat(253);
      await pool.query("UPDATE posts SET slug=$3, published_snapshot=jsonb_set(published_snapshot, '{slug}', to_jsonb($4::text)) WHERE translation_key=$1 AND locale=$2", [tk, locale, working, published]);
      if (status === 'draft') await posts.unpublish(tk);
      const rows = async () => (await pool.query('SELECT * FROM posts ORDER BY locale')).rows;
      const before = await rows();
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const inventory = await client.query(await readFile('scripts/slug-length-inventory.sql', 'utf8'));
        await client.query('COMMIT');
        expect(inventory.rows).toHaveLength(4);
        expect(inventory.rows.filter(row => row.rollout === 'blocked')).toEqual([
          { translation_key: tk, locale, status, source: 'published_snapshot', slug: published, slug_bytes: 253, url: `https://simonswanderlust.com/${locale === 'en' ? 'en/' : ''}${published}/`, rollout: 'blocked' },
          { translation_key: tk, locale, status, source: 'working', slug: working, slug_bytes: 252, url: `https://simonswanderlust.com/${locale === 'en' ? 'en/' : ''}${working}/`, rollout: 'blocked' },
        ]);
      } finally { client.release(); }
      expect(await rows()).toEqual(before);
      const response = await app.inject(mode === 'single'
        ? { method: 'POST', url: `/posts/${tk}/publish`, cookies, payload: await publishBody(posts, tk) }
        : { method: 'POST', url: '/posts/bulk', cookies, payload: { action: 'publish', keys: [tk] } });
      if (mode === 'single') expect(response.statusCode).toBe(400);
      else expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
      expect(response.body).toContain(`${locale}.slug must be at most 251 ASCII bytes (received 252)`);
      expect(await rows()).toEqual(before);
      expect(await posts.listRevisions(tk)).toEqual([]);
      expect(builds).toBe(0);
      expect(await readdir(root)).not.toContain('mdx');
    } finally {
      await app.close(); await queue.quiesce();
      await rm(root, { recursive: true, force: true });
    }
  });
});
