import { TEST_TRUST } from './trusted-proxy-fixture.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../src/db.js';
import { pgPostStore, type PostLocale } from '../src/posts.js';
import { pgMediaStore } from '../src/media-store.js';
import { buildServer } from '../src/server.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryPageStore } from '../src/pages.js';
import { memorySecretsStore } from '../src/secrets.js';
import { createSettingsStore, defaultSettings } from '../src/settings.js';
import { createEncodeQueue } from '../src/encode-queue.js';
import { createWorkLock } from '../src/work-lock.js';
import { createDbBackup } from '../src/backup.js';
import { publishBody } from './publish-tokens.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const origin = 'https://images.test';
const exif = { takenAt: null, camera: null, lens: null, lat: null, lng: null };

maybe('renderer-based publication readiness (real PostgreSQL, #334)', () => {
  it.each(['single', 'bulk'] as const)('%s preserves snapshots on refusal and publishes with unused failed metadata', async (mode) => {
    const schema = `readiness_${randomUUID().replaceAll('-', '')}`;
    const owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const root = await mkdtemp(join(tmpdir(), 'publish-readiness-'));
    const posts = pgPostStore(pool);
    const media = pgMediaStore(pool, { baseUrl: origin });
    const users = memoryUserStore();
    const sessions = memorySessionStore();
    const queue = createEncodeQueue({ store: media, storageDir: join(root, 'images'), lock: createWorkLock() });
    let builds = 0;
    const app = buildServer({
      trustProxy: TEST_TRUST,
      storageDir: join(root, 'images'), siteDir: join(root, 'site'), backupDir: join(root, 'mdx'),
      baseUrl: origin, imgHost: 'images.test', users, sessions, posts, media,
      pages: memoryPageStore(), secrets: memorySecretsStore(), encodeQueue: queue,
      settings: createSettingsStore({ path: join(root, 'settings.json'), defaults: defaultSettings() }),
      dbBackup: createDbBackup({ db: pool, dir: join(root, 'backup'), retention: () => 10 }),
      dbCheck: async () => { await pool.query('SELECT 1'); },
      builder: { hasRelease: () => true, quiesce: async () => {}, build: async () => { builds++; return { ok: true, release: 'test' }; } },
    });
    try {
      await ensureSchema(pool);
      await mkdir(join(root, 'images'), { recursive: true });
      const admin = await users.create({ username: 'readiness-admin', password: 'synthetic-password', isAdmin: true });
      const cookies = { sid: await sessions.create(admin.id, 60_000) };
      for (const key of ['hero', 'title', 'ready']) await media.upsert({ key, status: 'ready', width: 640, height: 480, origBytes: 1, exif, uploadedBy: null });
      const locale = (locale: 'de' | 'en'): PostLocale => ({ locale, slug: `${locale}-readiness`, title: 'Readiness story', country: 'Test', excerpt: 'Synthetic excerpt',
        heroImage: { src: `${origin}/hero`, width: 640, height: 480, alt: 'Hero' },
        titleImage: { src: `${origin}/title`, width: 640, height: 480, alt: 'Title' },
        bodyMarkdown: 'Initial published text', images: {} });
      const draft = await posts.upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') });
      const tk = draft.translationKey;
      const publish = async () => mode === 'single'
        ? app.inject({ method: 'POST', url: `/posts/${tk}/publish`, cookies, payload: await publishBody(posts, tk) })
        : app.inject({ method: 'POST', url: '/posts/bulk', cookies, payload: { action: 'publish', keys: [tk], baseLanguageUpdatedAt: (await posts.language.get()).updatedAt.toISOString() } });
      const snapshots = async () => (await pool.query('SELECT locale,status,published_snapshot,published_at FROM posts WHERE translation_key=$1 ORDER BY locale', [tk])).rows;
      const refused = async () => {
        const response = await publish();
        if (mode === 'single') expect(response.statusCode).toBe(409);
        else expect(response.json()).toMatchObject({ succeeded: 0, failed: 1 });
      };
      await media.upsert({ key: 'body', status: 'failed', width: 640, height: 480, origBytes: 1, exif, uploadedBy: null });
      await posts.upsertDraft({ ...draft, en: { ...draft.en, bodyMarkdown: `![View](${origin}/body-640.webp)` } });
      await refused();
      for (const row of await snapshots()) expect(row).toMatchObject({ status: 'draft', published_snapshot: null, published_at: null });
      expect(builds).toBe(0);
      await posts.upsertDraft({ ...(await posts.get(tk))!, en: draft.en });
      expect((await publish()).statusCode).toBe(200);
      expect(builds).toBe(1);
      const before = await snapshots();
      for (const status of ['processing', 'failed', 'missing'] as const) {
        await media.upsert({ key: 'body', status, width: 640, height: 480, origBytes: 1, exif, uploadedBy: null });
        for (const format of ['avif', 'webp', 'jpeg']) {
          for (const bodyMarkdown of [`![View](${origin}/body-640.${format})`, `<picture><source srcset="${origin}/body-640.${format} 1x"><img src="${origin}/ready-640.webp"></picture>`]) {
            const current = (await posts.get(tk))!;
            await posts.upsertDraft({ ...current, en: { ...current.en, bodyMarkdown } });
            await refused();
            expect(await snapshots()).toEqual(before);
            expect(builds).toBe(1);
          }
        }
      }
      const current = (await posts.get(tk))!;
      const bodyMarkdown = `![Ready](${origin}/ready-640.webp)\n\n<img src="${origin}/legacy-640.jpeg">`;
      await posts.upsertDraft({ ...current, en: { ...current.en, bodyMarkdown, images: { [`${origin}/body`]: { width: 640, height: 480 } } } });
      const accepted = await publish();
      expect(accepted.statusCode).toBe(200);
      if (mode === 'bulk') expect(accepted.json()).toMatchObject({ succeeded: 1, failed: 0 });
      expect(builds).toBe(2);
      const after = await snapshots();
      expect(after.find(row => row.locale === 'en')?.published_snapshot).toMatchObject({ body_markdown: bodyMarkdown });
      expect(after.every(row => row.status === 'published')).toBe(true);
    } finally {
      await app.close(); await queue.quiesce(); await pool.end();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
