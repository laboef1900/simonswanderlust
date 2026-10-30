import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, type DbPool } from '../src/db.js';
import { memoryLanguageStore, pgLanguageStore, type LanguageConfig, type LanguageStore } from '../src/language.js';
import { memoryPostStore, pgPostStore, type PostPair, type PostStore } from '../src/posts.js';
import { memoryMediaStore, type MediaStore } from '../src/media-store.js';
import { memoryJourneyStore, pgJourneyStore, validateJourneyDraft, type JourneyDraft, type JourneyStore, type StoredJourney } from '../src/journeys.js';
import { parseJourneySnapshot } from '../../site/src/lib/journey-snapshot.js';
import { repairJourneyOrphans } from '../src/journey-cleanup.js';

const imageBase = 'https://images.test';
const modes: LanguageConfig[] = [ { primary: 'de', locales: ['de', 'en'] }, { primary: 'en', locales: ['en', 'de'] }, { primary: 'de', locales: ['de'] }, { primary: 'en', locales: ['en'] } ];
function story(): PostPair {
  const id = randomUUID();
  const locale = (locale: 'de' | 'en') => ({ locale, slug: `story-${locale}-${id}`, title: `Story ${locale}`, country: 'Test', excerpt: 'Excerpt', bodyMarkdown: 'Body', images: {}, heroImage: { src: `${imageBase}/photo`, width: 800, height: 600, alt: 'View' } });
  return { translationKey: '', status: 'draft', shared: { date: '2026-10-28', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } }, de: locale('de'), en: locale('en') };
}
function draft(members: string[], mode: LanguageConfig = modes[0]!): JourneyDraft {
  const id = randomUUID();
  const locale = (locale: 'de' | 'en') => ({ slug: `trip-${locale}-${id}`, title: `Journey ${locale}`, intro: 'First paragraph.\n\nSecond paragraph.', omitted: !mode.locales.includes(locale), heroImage: { src: `${imageBase}/photo`, width: 800, height: 600, alt: 'View', focus: { x: 23, y: 78 } } });
  return { de: locale('de'), en: locale('en'), members };
}
function input(row: StoredJourney): JourneyDraft {
  const { publishedAt: _de, ...de } = row.de; const { publishedAt: _en, ...en } = row.en;
  return structuredClone({ de, en, members: row.members });
}

for (const backend of ['memory', 'pg'] as const) {
  (backend === 'pg' && !process.env.TEST_DATABASE_URL ? describe.skip : describe)(`${backend} journey store contract`, () => {
    let owner: DbPool | undefined; let pool: DbPool | undefined; let schema: string | undefined;
    let language: LanguageStore; let posts: PostStore; let media: MediaStore; let journeys: JourneyStore;
    beforeEach(async () => {
      media = memoryMediaStore({ baseUrl: imageBase });
      await media.upsert({ key: 'photo', width: 800, height: 600, origBytes: 1, status: 'ready', exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
      if (backend === 'pg') {
        owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
        schema = `journey_${randomUUID().replaceAll('-', '')}`;
        await owner.query(`CREATE SCHEMA ${schema}`);
        pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
        await ensureSchema(pool); language = pgLanguageStore(pool); posts = pgPostStore(pool); journeys = pgJourneyStore(pool, media, imageBase);
      } else {
        language = memoryLanguageStore(); posts = memoryPostStore({ language }); journeys = memoryJourneyStore(posts, language, media, imageBase);
      }
    });
    afterEach(async () => { await pool?.end(); if (schema) await owner?.query(`DROP SCHEMA ${schema} CASCADE`); await owner?.end(); pool = undefined; owner = undefined; schema = undefined; });
    async function keys(count = 3): Promise<string[]> { const result: string[] = []; for (let i = 0; i < count; i++) result.push((await posts.upsertDraft(story())).translationKey); return result; }

    it('creates, orders, snapshots, saves privately, unpublishes and deletes without touching stories', async () => {
      const members = await keys(); const original = await journeys.create(draft(members));
      expect(original.status).toBe('draft');
      const reordered = await journeys.save(original.id, { ...input(original), members: [...members].reverse() }, original.updatedAt);
      expect(reordered.members).toEqual([...members].reverse()); expect(reordered.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
      await expect(journeys.save(original.id, input(original), original.updatedAt)).rejects.toMatchObject({ code: 'conflict' });
      await expect(journeys.publish(original.id, original.updatedAt)).rejects.toMatchObject({ code: 'conflict' });
      const published = await journeys.publish(original.id, reordered.updatedAt);
      expect(published.hasUnpublishedChanges).toBe(false);
      expect(published.publishedSnapshot?.members).toEqual(reordered.members);
      expect(published.publishedSnapshot?.locales.de?.heroImage.focus).toEqual({ x: 23, y: 78 });
      const changed = input(published); changed.de.intro = 'Unpublished secret';
      const saved = await journeys.save(original.id, changed, published.updatedAt);
      expect(saved.hasUnpublishedChanges).toBe(true); expect(saved.publishedSnapshot).toEqual(published.publishedSnapshot);
      const unpublished = await journeys.unpublish(original.id); expect(unpublished.publishedSnapshot).toEqual(published.publishedSnapshot);
      await journeys.remove(original.id); expect(await journeys.get(original.id)).toBeNull();
      for (const key of members) expect(await posts.get(key)).not.toBeNull();
      expect((await language.get()).lockedAt).toBeInstanceOf(Date);
    });

    it.each(modes)('requires explicit complete requested coverage in $primary / $locales', async (mode) => {
      await language.update(mode); const members = await keys(1); const initial = draft(members, mode);
      initial[mode.primary].omitted = true;
      await expect(journeys.create(initial)).rejects.toMatchObject({ code: 'invalid_journey' }); initial[mode.primary].omitted = false;
      for (const locale of mode.locales) {
        const incomplete = structuredClone(initial); incomplete[locale].intro = ' \n ';
        const row = await journeys.create(incomplete);
        await expect(journeys.publish(row.id, row.updatedAt)).rejects.toMatchObject({ code: 'invalid_journey', locale });
        await journeys.remove(row.id);
      }
      const row = await journeys.create(initial); const published = await journeys.publish(row.id, row.updatedAt);
      expect(Object.keys(published.publishedSnapshot!.locales).sort()).toEqual([...mode.locales].sort());
      expect((await language.get()).lockedAt).toBeInstanceOf(Date); // all member stories are drafts: dormant still latches.
      await journeys.unpublish(row.id);
      await expect(language.update({ primary: mode.primary === 'de' ? 'en' : 'de', locales: ['de', 'en'] })).rejects.toMatchObject({ code: 'language_primary_locked' });
      const before = (await journeys.get(row.id))!; const renamed = input(before); renamed[mode.primary].slug = 'changed-url';
      await expect(journeys.save(row.id, renamed, before.updatedAt, true)).rejects.toMatchObject({ code: 'slug_locked' });
    });

    it('keeps explicit secondary omission and publication history separate from working coverage', async () => {
      const initial = draft(await keys(1)); initial.en.omitted = true; initial.en.intro = '';
      const created = await journeys.create(initial); const published = await journeys.publish(created.id, created.updatedAt);
      const translated = input(published); translated.en.omitted = false; translated.en.slug = 'translated';
      const saved = await journeys.save(created.id, translated, published.updatedAt, true);
      expect(saved.hasUnpublishedChanges).toBe(true); expect(saved.en.publishedAt).toBeNull(); expect(saved.publishedSnapshot?.locales.en).toBeUndefined();
      await expect(journeys.publish(created.id, saved.updatedAt)).rejects.toMatchObject({ code: 'invalid_journey', locale: 'en' });
      translated.en.intro = 'Translated intro'; const ready = await journeys.save(created.id, translated, saved.updatedAt);
      const bilingual = await journeys.publish(created.id, ready.updatedAt); expect(bilingual.publishedSnapshot?.locales.en).toBeDefined();
      const unpublished = await journeys.unpublish(created.id); const omitted = input(unpublished); omitted.en.omitted = true;
      await expect(journeys.save(created.id, omitted, unpublished.updatedAt)).rejects.toMatchObject({ code: 'locale_published' });
    });

    it('retains disabled content and changes tokens when prepublication coverage changes', async () => {
      const original = await journeys.create(draft(await keys(1)));
      await language.update({ primary: 'de', locales: ['de'] }); const disabled = (await journeys.get(original.id))!;
      expect(disabled.en).toEqual({ ...original.en, omitted: true }); expect(disabled.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
      await expect(journeys.save(original.id, input(original), original.updatedAt)).rejects.toMatchObject({ code: 'conflict' });
      await language.update(modes[0]!); expect((await journeys.get(original.id))?.en.omitted).toBe(true);
    });

    it('rejects duplicate, unknown, over-limit and conflicting membership including snapshot-only claims', async () => {
      const members = await keys(2);
      await expect(journeys.create(draft([members[0]!, members[0]!]))).rejects.toMatchObject({ code: 'duplicate_member' });
      await expect(journeys.create(draft(['missing']))).rejects.toMatchObject({ code: 'unknown_member' });
      await expect(journeys.create(draft(Array.from({ length: 51 }, (_, i) => `key-${i}`)))).rejects.toMatchObject({ code: 'invalid_journey' });
      const a = await journeys.create(draft(members)); await expect(journeys.create(draft([members[0]!]))).rejects.toMatchObject({ code: 'story_in_other_journey' });
      const published = await journeys.publish(a.id, a.updatedAt);
      const changed = await journeys.save(a.id, { ...input(published), members: [members[1]!] }, published.updatedAt);
      await expect(journeys.create(draft([members[0]!]))).rejects.toMatchObject({ code: 'story_in_other_journey', owner: { id: a.id } });
      await journeys.publish(a.id, changed.updatedAt); await expect(journeys.create(draft([members[0]!]))).resolves.toBeTruthy();
      const empty = await journeys.create(draft([])); await expect(journeys.publish(empty.id, empty.updatedAt)).rejects.toMatchObject({ code: 'journey_empty' });
    });

    it('scrubs every retained snapshot including unpublished A while B claims S and compacts order', async () => {
      const members = await keys(); let a = await journeys.create(draft(members)); a = await journeys.publish(a.id, a.updatedAt);
      a = await journeys.unpublish(a.id); a = await journeys.save(a.id, { ...input(a), members: [members[0]!, members[2]!] }, a.updatedAt);
      const b = await journeys.create(draft([members[1]!]));
      await posts.remove(members[1]!);
      const repairedA = (await journeys.get(a.id))!; const repairedB = (await journeys.get(b.id))!;
      expect(repairedA.members).toEqual([members[0], members[2]]); expect(repairedA.publishedSnapshot?.members).toEqual(repairedA.members);
      expect(repairedB.members).toEqual([]); expect(repairedA.updatedAt.getTime()).toBeGreaterThan(a.updatedAt.getTime());
      expect(repairedB.updatedAt.getTime()).toBeGreaterThan(b.updatedAt.getTime());
      await expect(journeys.save(b.id, input(b), b.updatedAt)).rejects.toMatchObject({ code: 'conflict' });
      if (pool) expect((await pool.query<{ position: number }>('SELECT position FROM journey_members WHERE journey_id=$1 ORDER BY position', [a.id])).rows.map((row) => row.position)).toEqual([0, 1]);
    });
    it('keeps an emptied published snapshot dormant and never clears the language latch on deletion', async () => {
      const [member] = await keys(1);
      let row = await journeys.create(draft([member!])); row = await journeys.publish(row.id, row.updatedAt);
      await posts.remove(member!);
      const dormant = (await journeys.get(row.id))!;
      expect(dormant.status).toBe('published'); expect(dormant.publishedSnapshot?.members).toEqual([]);
      expect(parseJourneySnapshot(dormant.publishedSnapshot).members).toEqual([]);
      if (pool) await pool.query('UPDATE site_language SET locked_at=NULL WHERE id=true');
      expect((await language.get()).lockedAt).toBeInstanceOf(Date);
      await journeys.remove(row.id);
      expect((await language.get()).lockedAt).toBeInstanceOf(Date);
      await expect(language.update({ primary: 'en', locales: ['en'] })).rejects.toMatchObject({ code: 'language_primary_locked' });
    });

    it('requires confirmation only for never-published nonempty slug changes and enforces uniqueness', async () => {
      const a = await journeys.create(draft([])); const change = input(a); change.de.slug = 'renamed';
      await expect(journeys.save(a.id, change, a.updatedAt)).rejects.toMatchObject({ code: 'slug_change_unconfirmed' });
      await journeys.save(a.id, change, a.updatedAt, true);
      const duplicate = draft([]); duplicate.de.slug = 'renamed'; await expect(journeys.create(duplicate)).rejects.toMatchObject({ code: 'duplicate_slug' });
    });

    it.each(['https://images.test.evil/photo', 'https://elsewhere.test/photo', `${imageBase}/photo-640.webp`, `${imageBase}/photo?q=1`, `${imageBase}/photo#x`, 'https://user:password@images.test/photo', `${imageBase}/../photo`, `${imageBase}/bad%20key`])('rejects malformed/noncanonical hero %s on save', async (src) => {
      const value = draft([]); value.de.heroImage!.src = src;
      await expect(journeys.create(value)).rejects.toMatchObject({ code: 'invalid_journey', locale: 'de' });
    });
    it('rejects suffixed hero on an existing working-copy save without altering its token', async () => {
      const row = await journeys.create(draft(await keys(1)));
      const changed = input(row); changed.de.heroImage!.src = `${imageBase}/photo-640.webp`;
      await expect(journeys.save(row.id, changed, row.updatedAt)).rejects.toMatchObject({ code: 'invalid_journey', locale: 'de' });
      expect(await journeys.get(row.id)).toEqual(row);
    });
    if (backend === 'pg') it('rechecks a stored hero at Publish instead of trusting a past save', async () => {
      const row = await journeys.create(draft(await keys(1)));
      await pool!.query(`UPDATE journey_locales SET hero_image=jsonb_set(hero_image,'{src}',to_jsonb($2::text)) WHERE journey_id=$1 AND locale='de'`, [row.id, `${imageBase}/photo-640.webp`]);
      await expect(journeys.publish(row.id, row.updatedAt)).rejects.toMatchObject({ code: 'invalid_journey', locale: 'de' });
      expect((await journeys.get(row.id))?.publishedSnapshot).toBeNull();
      expect((await language.get()).lockedAt).toBeNull();
    });
    it.each(['processing', 'missing', 'failed', 'unknown'] as const)('requires a known ready hero, not %s', async (status) => {
      const value = draft(await keys(1)); if (status === 'unknown') value.de.heroImage!.src = `${imageBase}/unknown`; else await media.setStatus('photo', status);
      const row = await journeys.create(value); await expect(journeys.publish(row.id, row.updatedAt)).rejects.toMatchObject({ code: 'journey_hero_not_ready' });
      expect((await language.get()).lockedAt).toBeNull(); expect((await journeys.get(row.id))?.publishedSnapshot).toBeNull();
    });
    it('keeps published hero use after working replacement and unpublication', async () => {
      let row = await journeys.create(draft(await keys(1))); row = await journeys.publish(row.id, row.updatedAt);
      const value = input(row); value.de.heroImage = null; value.en.heroImage = null;
      row = await journeys.save(row.id, value, row.updatedAt); await journeys.unpublish(row.id);
      const corpus = await journeys.list();
      expect(corpus[0]?.de.heroImage).toBeNull();
      expect(corpus[0]?.publishedSnapshot?.locales.de?.heroImage.src).toBe(`${imageBase}/photo`);
    });
    if (backend === 'pg') it('repairs boot orphans without changing coverage and refuses incompatible mode', async () => {
      const members = await keys(); let row = await journeys.create(draft(members)); row = await journeys.publish(row.id, row.updatedAt);
      await pool!.query('DELETE FROM posts WHERE translation_key=$1', [members[1]]);
      await repairJourneyOrphans(pool!); const repaired = (await journeys.get(row.id))!;
      expect(repaired.members).toEqual([members[0], members[2]]); expect(repaired.publishedSnapshot?.members).toEqual(repaired.members);
      expect(repaired.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime());
      await repairJourneyOrphans(pool!); expect((await journeys.get(row.id))?.updatedAt).toEqual(repaired.updatedAt);
      await pool!.query("UPDATE site_language SET primary_locale='en',enabled_locales=ARRAY['en'] WHERE id=true");
      await expect(repairJourneyOrphans(pool!)).rejects.toThrow('coherent recovery');
      expect((await pool!.query('SELECT published_snapshot FROM journeys WHERE id=$1', [row.id])).rows[0].published_snapshot).toEqual(repaired.publishedSnapshot);
    });
  });
}

describe('strict journey boundaries', () => {
  it('refuses unknown keys and forged publication history', () => {
    const value = draft([]); expect(() => validateJourneyDraft({ ...value, status: 'published' }, imageBase)).toThrow();
    expect(() => validateJourneyDraft({ ...value, de: { ...value.de, publishedAt: new Date() } }, imageBase)).toThrow();
  });
  it('shares strict snapshot parsing and the existing hero type including focus', () => {
    const value = draft(['story']); const { omitted: _omitted, ...locale } = value.de;
    const snapshot = { version: 1, members: ['story'], locales: { de: locale } };
    expect(parseJourneySnapshot(snapshot).locales.de?.heroImage.focus).toEqual({ x: 23, y: 78 });
    for (const corrupt of [ { ...snapshot, private: true }, { ...snapshot, members: ['story', 'story'] }, { ...snapshot, version: 2 }, { ...snapshot, locales: {} }, { ...snapshot, locales: { de: { ...locale, intro: ' ' } } }, { ...snapshot, locales: { de: { ...locale, heroImage: { ...locale.heroImage, src: `${imageBase}/photo-640.webp` } } } } ]) expect(() => parseJourneySnapshot(corrupt)).toThrow('Invalid journey snapshot.');
    expect(parseJourneySnapshot({ ...snapshot, members: [] }).members).toEqual([]);
  });
});
