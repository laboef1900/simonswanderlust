import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../src/db.js';
import { pgPostStore, type PostLocale } from '../src/posts.js';
import { pgLanguageStore } from '../src/language.js';
import { pgCommentStore } from '../src/comments.js';
import { pgCommentAdminStore, withPublicLocaleMetadata } from '../src/comments-admin.js';
import { registerPublicComments } from '../src/comments-public.js';
import { fixedWindowLimiter } from '../src/rate-limit.js';
import { publishTokens } from './publish-tokens.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('committed comment locale projection (PostgreSQL)', () => {
  it.each(['de', 'en'] as const)('keeps secondary comments private through save and failed publish with %s primary', async (primary) => {
    const schema = `comments_language_${randomUUID().replaceAll('-', '')}`;
    const owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const app = Fastify();
    try {
      await ensureSchema(pool);
      const secondary = primary === 'de' ? 'en' : 'de';
      const language = pgLanguageStore(pool);
      await language.update({ primary, locales: [primary, secondary] });
      const posts = pgPostStore(pool);
      const comments = pgCommentStore(pool);
      const moderation = pgCommentAdminStore(pool);
      registerPublicComments(app, {
        posts, comments, allowedOrigin: 'https://example.test', commentsEnabled: () => true,
        ipLimiter: fixedWindowLimiter({ max: 1000, windowMs: 60_000 }),
        globalLimiter: fixedWindowLimiter({ max: 1000, windowMs: 60_000 }),
      });
      const locale = (locale: 'de' | 'en'): PostLocale => ({
        locale, slug: `story-${locale}`, title: 'Story', excerpt: 'Excerpt', country: 'Country',
        heroImage: { src: 'https://example.test/hero', width: 640, height: 480, alt: 'Landscape' },
        bodyMarkdown: 'Story body', images: {}, omitted: locale === secondary,
      });
      let saved = await posts.upsertDraft({ translationKey: '', status: 'draft',
        shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } },
        de: locale('de'), en: locale('en'),
      });
      const tk = saved.translationKey;
      await posts.publish(tk, await publishTokens(posts, tk));
      const legacy = await comments.create({ translationKey: tk, locale: secondary, name: 'Reader', body: 'Retained secondary discussion' });
      await comments.approve(legacy.id);
      const reply = await moderation.replyAsAuthor(legacy.id, 'Author', 'Primary reply');
      expect(reply).not.toBeNull();
      if (!reply) throw new Error('expected moderation author reply');
      expect(reply.locale).toBe(primary);
      const submit = () => app.inject({ method: 'POST', url: '/comments', headers: { origin: 'https://example.test' },
        payload: { translationKey: tk, postedLocale: secondary, authorName: 'Reader', body: 'Secondary reply' } });
      const assertHidden = async () => {
        expect(await posts.getPublishedLocales(tk)).toEqual([primary]);
        expect((await submit()).statusCode).toBe(400);
        const response = await app.inject({ method: 'GET', url: `/comments?tk=${tk}` });
        expect(response.json().comments.map((row: { id: string }) => row.id)).toEqual([reply.id]);
        const admin = await withPublicLocaleMetadata(await moderation.list('approved'), posts);
        expect(admin.find((row) => row.id === legacy.id)?.publicLocale).toBe(false);
        expect(admin.find((row) => row.id === reply.id)?.publicLocale).toBe(true);
      };
      await assertHidden();
      saved = (await posts.get(tk))!;
      saved = await posts.upsertDraft({ ...saved, [secondary]: { ...saved[secondary], omitted: false, title: '' } }, saved.updatedAt);
      await expect(posts.publish(tk, await publishTokens(posts, tk))).rejects.toThrow(/title required/);
      await assertHidden();
      saved = await posts.upsertDraft({ ...saved, [secondary]: { ...saved[secondary], title: 'Translated title' } }, saved.updatedAt);
      await assertHidden();
      const stale = await publishTokens(posts, tk);
      await posts.upsertDraft({ ...saved, [secondary]: { ...saved[secondary], title: 'New translation title' } }, saved.updatedAt);
      await expect(posts.publish(tk, stale)).rejects.toThrow();
      await assertHidden();
      await posts.publish(tk, await publishTokens(posts, tk));
      expect(new Set(await posts.getPublishedLocales(tk))).toEqual(new Set([primary, secondary]));
      expect((await submit()).statusCode).toBe(201);
      const response = await app.inject({ method: 'GET', url: `/comments?tk=${tk}` });
      expect(new Set(response.json().comments.map((row: { id: string }) => row.id))).toEqual(new Set([legacy.id, reply.id]));
      for (const row of response.json().comments) expect(Object.keys(row).sort()).toEqual(['authorName', 'body', 'createdAt', 'id', 'isAuthor', 'postedLocale']);
      await posts.unpublish(tk);
      expect(await posts.getPublishedLocales(tk)).toEqual([]);
      expect((await submit()).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/comments?tk=${tk}` })).statusCode).toBe(404);
      const retained = await moderation.list('approved');
      expect(retained).toHaveLength(2);
      expect((await withPublicLocaleMetadata(retained, posts)).every((row) => !row.publicLocale)).toBe(true);
      const snapshots = await pool.query('SELECT published_snapshot FROM posts WHERE translation_key=$1', [tk]);
      expect(snapshots.rows.every((row) => row.published_snapshot !== null)).toBe(true);
    } finally {
      await app.close();
      await pool.end();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`);
      await owner.end();
    }
  });
});
