import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema } from '../src/db.js';
import { memoryPostStore, pgPostStore, type PostPair } from '../src/posts.js';
import { memoryPageStore, pgPageStore, type PagePair } from '../src/pages.js';
import { publishTokens } from './publish-tokens.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const story = (): PostPair => {
  const locale = (locale: 'de' | 'en') => ({ locale, slug: `story-${locale}`, title: 'Story', country: 'Germany', excerpt: 'A journey',
    bodyMarkdown: 'Complete story', images: {}, heroImage: { src: 'https://images.test/hero', width: 800, height: 600, alt: 'Landscape' } });
  return { translationKey: randomUUID(), status: 'draft', shared: { date: '2026-10-27', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') };
};
const page = (): PagePair => ({ key: 'about', de: { locale: 'de', title: 'About', bodyMarkdown: 'Local text', images: {} }, en: { locale: 'en', title: 'About', bodyMarkdown: 'English', images: {} } });
async function fixture(database: boolean) {
  if (!database) { const posts = memoryPostStore(); return { posts, pages: memoryPageStore(posts.language) }; }
  const schema = `receipts_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  cleanup.push(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
  await ensureSchema(pool);
  return { posts: pgPostStore(pool), pages: pgPageStore(pool) };
}
for (const database of [false, true]) {
  const suite = database && !process.env.TEST_DATABASE_URL ? describe.skip : describe;
  suite(`${database ? 'Postgres' : 'memory'} write receipts`, () => {
    it('serializes simultaneous create identities before duplicate-slug validation', async () => {
      const { posts } = await fixture(database);
      const input = story(); const ownerUserId = randomUUID();
      const results = await Promise.allSettled([1, 2].map(() => posts.upsertDraft(input, undefined, { createOnly: true, receipt: { saveId: randomUUID(), ownerUserId } })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'already_exists' } });
      expect(await posts.list()).toHaveLength(1);
      await expect(posts.upsertDraft({ ...input, de: { ...input.de, title: 'Must not replace' } }, undefined, { createOnly: true })).rejects.toMatchObject({ code: 'already_exists' });
      expect((await posts.get(input.translationKey))?.de.title).toBe('Story');
    });
    it('returns only the requesting writer’s latest receipt with its own content and token', async () => {
      const { posts } = await fixture(database); const ownerUserId = randomUUID(); const stranger = randomUUID();
      const receipt = { ownerUserId, saveId: randomUUID() };
      const saved = await posts.upsertDraft(story(), undefined, { receipt });
      expect(await posts.getForSave(saved.translationKey, ownerUserId)).toEqual({ content: saved, ownerUserId, lastSaveId: receipt.saveId });
      expect(await posts.getForSave(saved.translationKey, stranger)).toEqual({ content: saved, ownerUserId: stranger, lastSaveId: null });
      const read = posts.getForSave(saved.translationKey, ownerUserId);
      const nextReceipt = { ownerUserId, saveId: randomUUID() };
      const next = await posts.upsertDraft({ ...saved, de: { ...saved.de, title: 'Next' } }, saved.updatedAt, { receipt: nextReceipt });
      const snapshot = await read;
      expect(snapshot).not.toBeNull();
      if (snapshot?.lastSaveId === receipt.saveId) expect(snapshot.content).toEqual(saved);
      else expect(snapshot).toEqual({ content: next, ownerUserId, lastSaveId: nextReceipt.saveId });
      await expect(posts.upsertDraft(saved, saved.updatedAt, { receipt })).rejects.toMatchObject({ code: 'conflict' });
      expect((await posts.getForSave(saved.translationKey, ownerUserId))?.lastSaveId).toBe(nextReceipt.saveId);
    });
    it('invalidates receipts for importer writes, publish and unpublish without putting them in revisions', async () => {
      const { posts } = await fixture(database); const ownerUserId = randomUUID();
      let saved = await posts.upsertDraft(story(), undefined, { receipt: { ownerUserId, saveId: randomUUID() } });
      saved = await posts.upsertDraft(saved);
      expect((await posts.getForSave(saved.translationKey, ownerUserId))?.lastSaveId).toBeNull();
      saved = await posts.upsertDraft(saved, saved.updatedAt, { receipt: { ownerUserId, saveId: randomUUID() } });
      await posts.publish(saved.translationKey, await publishTokens(posts, saved.translationKey));
      expect((await posts.getForSave(saved.translationKey, ownerUserId))?.lastSaveId).toBeNull();
      saved = (await posts.get(saved.translationKey))!;
      await posts.upsertDraft(saved, saved.updatedAt, { receipt: { ownerUserId, saveId: randomUUID() } });
      await posts.unpublish(saved.translationKey);
      expect((await posts.getForSave(saved.translationKey, ownerUserId))?.lastSaveId).toBeNull();
      for (const revision of await posts.listRevisions(saved.translationKey)) {
        const value = await posts.getRevision(saved.translationKey, revision.id);
        expect(JSON.stringify(value)).not.toMatch(/lastSaveId|ownerUserId|last_save/);
      }
    });
    it('atomically pairs generic page content with receipt and refuses concurrent initial saves', async () => {
      const { pages } = await fixture(database); const ownerUserId = randomUUID();
      const receipt = { ownerUserId, saveId: randomUUID() };
      const input = page();
      const outcomes = await Promise.allSettled([1, 2].map(() => pages.save(input, undefined, { expectAbsent: true, receipt })));
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
      const saved = await pages.get(input.key);
      expect(await pages.getForSave(input.key, ownerUserId)).toEqual({ content: saved, ownerUserId, lastSaveId: receipt.saveId });
      expect((await pages.getForSave(input.key, randomUUID())).lastSaveId).toBeNull();
      const read = pages.getForSave(input.key, ownerUserId);
      const next = await pages.save({ ...input, de: { ...input.de, title: 'External writer' } }, saved.updatedAt!);
      const snapshot = await read;
      if (snapshot.lastSaveId === receipt.saveId) expect(snapshot.content).toEqual(saved);
      else expect(snapshot).toEqual({ content: next, ownerUserId, lastSaveId: null });
      expect((await pages.getForSave(input.key, ownerUserId)).lastSaveId).toBeNull();
    });
  });
}
