import { randomUUID } from 'node:crypto';
import type { DbPool, DbClient } from './db.js';
import { isSafeSlug, type HeroImage, type PostStore } from './posts.js';
import type { MediaStore } from './media-store.js';
import { readLanguage, type LanguageConfig, type LanguageStore } from './language.js';
import { assertSafeKey } from './storage.js';
import { lockPostPair } from './post-pair-lock.js';
import { lockJourney, touchJourney, memoryJourneyMemberExists, registerMemoryJourneyCleanup } from './journey-cleanup.js';
import { isCanonicalJourneyHero, parseJourneySnapshot, type JourneySnapshot } from '../../site/src/lib/journey-snapshot.js';
import { heroImageError } from './body-content.js';
import { assertWorkWritable, type WorkCancellationOptions } from './work-cancellation.js';

export interface JourneyLocale { slug: string; title: string; intro: string; heroImage: HeroImage | null; omitted: boolean; publishedAt: Date | null }
export interface JourneyDraft { de: Omit<JourneyLocale, 'publishedAt'>; en: Omit<JourneyLocale, 'publishedAt'>; members: string[] }
export interface StoredJourney extends Omit<JourneyDraft, 'de' | 'en'> {
  id: string; status: 'draft' | 'published'; de: JourneyLocale; en: JourneyLocale;
  publishedSnapshot: JourneySnapshot | null; publishedAt: Date | null; createdAt: Date; updatedAt: Date; hasUnpublishedChanges: boolean;
}
export class JourneyError extends Error {
  constructor(message: string, public readonly code = 'invalid_journey', public readonly locale?: 'de' | 'en', public readonly owner?: { id: string; title: string }) { super(message); }
}
export interface JourneyStore {
  list(): Promise<StoredJourney[]>;
  get(id: string): Promise<StoredJourney | null>;
  claiming(member: string): Promise<StoredJourney | null>;
  create(input: JourneyDraft): Promise<StoredJourney>;
  save(id: string, input: JourneyDraft, baseUpdatedAt: Date, confirmSlugChange?: boolean): Promise<StoredJourney>;
  publish(id: string, baseUpdatedAt: Date): Promise<StoredJourney>;
  unpublish(id: string): Promise<StoredJourney>;
  remove(id: string): Promise<StoredJourney>;
}
const LOCALES = ['de', 'en'] as const;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function heroKey(hero: HeroImage, imageBase: string, locale?: 'de' | 'en'): string {
  try {
    const base = new URL(imageBase);
    const url = new URL(hero.src);
    const prefix = `${imageBase}/`;
    if (!isCanonicalJourneyHero(hero) || url.origin !== base.origin || !hero.src.startsWith(prefix)) throw new Error();
    const key = hero.src.slice(prefix.length);
    assertSafeKey(key);
    if (hero.src !== `${imageBase}/${key}`) throw new Error();
    return key;
  } catch { throw new JourneyError('Choose a canonical hosted hero image.', 'invalid_journey', locale); }
}
export function validateJourneyDraft(value: unknown, imageBase: string): JourneyDraft {
  if (!isObject(value) || Object.keys(value).some((key) => !['de', 'en', 'members'].includes(key))
    || !Array.isArray(value.members) || value.members.length > 50
    || value.members.some((key) => typeof key !== 'string' || !key || key.includes('\0'))) throw new JourneyError('Invalid journey fields.');
  if (new Set(value.members).size !== value.members.length) throw new JourneyError('Choose each story once.', 'duplicate_member');
  const locales = {} as Pick<JourneyDraft, 'de' | 'en'>;
  for (const locale of LOCALES) {
    const row = value[locale];
    if (!isObject(row) || Object.keys(row).some((key) => !['slug', 'title', 'intro', 'heroImage', 'omitted'].includes(key))
      || typeof row.omitted !== 'boolean' || typeof row.slug !== 'string' || (row.slug !== '' && !isSafeSlug(row.slug))
      || row.slug.length > 100 || typeof row.title !== 'string' || row.title.length > 200
      || typeof row.intro !== 'string' || row.intro.length > 2000 || row.intro.includes('\0')) throw new JourneyError('Invalid journey locale fields.', 'invalid_journey', locale);
    let hero: HeroImage | null = null;
    if (row.heroImage !== null && row.heroImage !== undefined) {
      if (!isObject(row.heroImage) || heroImageError(row.heroImage) || Object.keys(row.heroImage).some((key) => !['src', 'width', 'height', 'alt', 'format', 'focus'].includes(key))) throw new JourneyError('Invalid hero image.', 'invalid_journey', locale);
      if (row.heroImage.src !== '') {
        if (!isCanonicalJourneyHero(row.heroImage)) throw new JourneyError('Invalid hero image.', 'invalid_journey', locale);
        heroKey(row.heroImage, imageBase, locale); hero = structuredClone(row.heroImage);
      }
    }
    locales[locale] = { slug: row.slug, title: row.title.replace(/\p{C}/gu, ''), intro: row.intro, heroImage: hero, omitted: row.omitted };
  }
  return { ...locales, members: [...value.members] as string[] };
}
function assertBase(journey: StoredJourney, base: Date): void {
  if (!(base instanceof Date) || !Number.isFinite(base.getTime()) || journey.updatedAt.getTime() !== base.getTime()) throw new JourneyError('Journey changed. Reload before saving.', 'conflict');
}
function coverage(journey: StoredJourney, mode: LanguageConfig): void {
  if (journey[mode.primary].omitted) throw new JourneyError('The primary language cannot be omitted.', 'invalid_journey', mode.primary);
  for (const locale of LOCALES) {
    if (journey[locale].omitted && journey[locale].publishedAt) throw new JourneyError('A previously published translation cannot be omitted.', 'locale_published', locale);
    if (!mode.locales.includes(locale) && !journey[locale].omitted) throw new JourneyError('Disabled translations must remain omitted.', 'invalid_journey', locale);
  }
}
function workingSnapshot(journey: StoredJourney, mode: LanguageConfig): JourneySnapshot {
  return { version: 1, members: [...journey.members], locales: Object.fromEntries(mode.locales.filter((locale) => !journey[locale].omitted).map((locale) => {
    const { slug, title, intro, heroImage } = journey[locale];
    return [locale, { slug, title, intro, heroImage }];
  })) } as JourneySnapshot;
}
function withChanges(journey: StoredJourney, mode: LanguageConfig): StoredJourney {
  const snapshot = journey.publishedSnapshot;
  journey.hasUnpublishedChanges = snapshot !== null && (
    JSON.stringify(journey.members) !== JSON.stringify(snapshot.members)
    || LOCALES.some((locale) => {
      const working = journey[locale];
      const committed = snapshot.locales[locale];
      const requested = mode.locales.includes(locale) && !working.omitted;
      if (requested !== !!committed) return true;
      if (!requested || !committed) return false;
      const hero = working.heroImage;
      const old = committed.heroImage;
      return working.slug !== committed.slug || working.title !== committed.title || working.intro !== committed.intro
        || !hero || hero.src !== old.src || hero.width !== old.width || hero.height !== old.height || hero.alt !== old.alt
        || hero.format !== old.format || hero.focus?.x !== old.focus?.x || hero.focus?.y !== old.focus?.y;
    }));
  return journey;
}
function applyDraft(existing: StoredJourney, draft: JourneyDraft, mode: LanguageConfig, confirm = false): StoredJourney {
  const next: StoredJourney = { ...existing, members: draft.members,
    de: { ...draft.de, publishedAt: existing.de.publishedAt }, en: { ...draft.en, publishedAt: existing.en.publishedAt } };
  for (const locale of LOCALES) {
    if (existing[locale].slug === next[locale].slug) continue;
    if (existing[locale].publishedAt) throw new JourneyError('A previously published slug cannot change.', 'slug_locked', locale);
    if (existing[locale].slug && !confirm) throw new JourneyError('Confirm the draft URL change.', 'slug_change_unconfirmed', locale);
  }
  coverage(next, mode); return next;
}
function emptyJourney(id: string, draft: JourneyDraft): StoredJourney {
  const now = new Date();
  return { ...draft, id, status: 'draft', de: { ...draft.de, publishedAt: null }, en: { ...draft.en, publishedAt: null }, publishedSnapshot: null,
    publishedAt: null, createdAt: now, updatedAt: now, hasUnpublishedChanges: false };
}
function claimKeys(journey: StoredJourney): Set<string> {
  return new Set([...journey.members, ...(journey.status === 'published' ? journey.publishedSnapshot?.members ?? [] : [])]);
}
async function validatePublication(journey: StoredJourney, mode: LanguageConfig, media: MediaStore, imageBase: string, client?: DbClient): Promise<JourneySnapshot> {
  coverage(journey, mode);
  if (!journey.members.length) throw new JourneyError('Choose at least one story.', 'journey_empty');
  for (const locale of mode.locales) {
    const row = journey[locale]; if (row.omitted) continue;
    if (!row.title.trim() || !row.intro.trim() || !row.slug || !row.heroImage || !row.heroImage.alt) throw new JourneyError('Title, intro, slug, hero and hero alt text are required.', 'invalid_journey', locale);
    const key = heroKey(row.heroImage, imageBase, locale);
    if ((await media.get(key, client))?.status !== 'ready') throw new JourneyError('Choose an existing ready hero image.', 'journey_hero_not_ready', locale);
  }
  return parseJourneySnapshot(workingSnapshot(journey, mode));
}
function checkOtherClaims(journey: StoredJourney, others: Iterable<StoredJourney>, mode: LanguageConfig): void {
  for (const other of others) {
    if (other.id === journey.id) continue;
    for (const locale of LOCALES) if (journey[locale].slug && journey[locale].slug === other[locale].slug) throw new JourneyError('This journey slug is already used.', 'duplicate_slug', locale);
    const claims = claimKeys(other);
    if (journey.members.some((key) => claims.has(key))) throw new JourneyError('Publish or unpublish the other journey first.', 'story_in_other_journey', undefined, { id: other.id, title: other[mode.primary].title });
  }
}

export function memoryJourneyStore(posts: PostStore, language: LanguageStore, media: MediaStore, imageBase: string): JourneyStore {
  if (posts.language !== language) throw new Error('Journeys and posts must share the language transaction.');
  const rows = new Map<string, StoredJourney>();
  registerMemoryJourneyCleanup(language, (removed) => {
    for (const journey of rows.values()) {
      if (!journey.members.some((key) => removed.has(key)) && !journey.publishedSnapshot?.members.some((key) => removed.has(key))) continue;
      journey.members = journey.members.filter((key) => !removed.has(key));
      if (journey.publishedSnapshot) journey.publishedSnapshot.members = journey.publishedSnapshot.members.filter((key) => !removed.has(key));
      journey.updatedAt = new Date(Math.max(Date.now(), journey.updatedAt.getTime() + 1));
    }
  });
  language.onChange((_current, next) => {
    for (const journey of rows.values()) {
      let changed = false;
      for (const locale of LOCALES) {
        const omitted = locale === next.primary ? false : !next.locales.includes(locale) ? true : journey[locale].omitted;
        if (omitted !== journey[locale].omitted) { journey[locale].omitted = omitted; changed = true; }
      }
      if (changed) journey.updatedAt = new Date(Math.max(Date.now(), journey.updatedAt.getTime() + 1));
    }
  });
  const need = (id: string): StoredJourney => { const row = rows.get(id); if (!row) throw new JourneyError('Journey not found.', 'not_found'); return structuredClone(row); };
  async function mutate(id: string, action: 'create' | 'save' | 'publish' | 'unpublish' | 'remove', input?: JourneyDraft, base?: Date, confirm?: boolean): Promise<StoredJourney> {
    return language.runExclusive(async (mode) => {
      const draft = input ? validateJourneyDraft(input, imageBase) : undefined;
      let journey = action === 'create' ? emptyJourney(id, draft!) : need(id);
      if (action === 'save' || action === 'publish') assertBase(journey, base!);
      if (action === 'save') journey = applyDraft(journey, draft!, mode, confirm);
      if (action === 'create' || action === 'save' || action === 'publish') {
        coverage(journey, mode);
        for (const key of journey.members) if (!memoryJourneyMemberExists(language, key)) throw new JourneyError('A selected story no longer exists.', 'unknown_member');
        checkOtherClaims(journey, rows.values(), mode);
      }
      if (action === 'publish') {
        journey.publishedSnapshot = await validatePublication(journey, mode, media, imageBase);
        journey.status = 'published'; journey.publishedAt ??= new Date();
        for (const locale of mode.locales) if (!journey[locale].omitted) journey[locale].publishedAt ??= new Date();
        await language.markPublished();
      }
      if (action === 'unpublish') journey.status = 'draft';
      if (action === 'remove') rows.delete(id);
      else { journey.updatedAt = new Date(Math.max(Date.now(), journey.updatedAt.getTime() + 1)); rows.set(id, structuredClone(journey)); }
      return structuredClone(withChanges(journey, mode));
    });
  }
  const store: JourneyStore = {
    list: () => language.runExclusive(async (mode) => [...rows.values()].map((row) => withChanges(structuredClone(row), mode)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())),
    get: (id) => language.runExclusive(async (mode) => rows.has(id) ? withChanges(need(id), mode) : null),
    claiming: (member) => language.runExclusive(async (mode) => { const row = [...rows.values()].find((entry) => claimKeys(entry).has(member)); return row ? withChanges(structuredClone(row), mode) : null; }),
    create: (draft) => mutate(randomUUID(), 'create', draft), save: (id, draft, base, confirm) => mutate(id, 'save', draft, base, confirm),
    publish: (id, base) => mutate(id, 'publish', undefined, base), unpublish: (id) => mutate(id, 'unpublish'), remove: (id) => mutate(id, 'remove'),
  };
  return store;
}

interface JourneyRow { id: string; status: 'draft' | 'published'; published_snapshot: unknown; published_at: Date | null; created_at: Date; updated_at: Date }
interface LocaleRow { locale: 'de' | 'en'; slug: string; title: string; intro: string; hero_image: HeroImage | null; omitted: boolean; published_at: Date | null }
async function readJourney(client: DbClient, id: string, mode: LanguageConfig): Promise<StoredJourney | null> {
  const result = await client.query<JourneyRow>('SELECT id,status,published_snapshot,published_at,created_at,updated_at FROM journeys WHERE id=$1', [id]);
  const row = result.rows[0]; if (!row) return null;
  const locales = await client.query<LocaleRow>('SELECT locale,slug,title,intro,hero_image,omitted,published_at FROM journey_locales WHERE journey_id=$1 ORDER BY locale', [id]);
  if (locales.rows.length !== 2) throw new JourneyError('Invalid stored journey locale coverage.');
  const content = Object.fromEntries(locales.rows.map((locale) => [locale.locale, { slug: locale.slug, title: locale.title, intro: locale.intro, heroImage: locale.hero_image, omitted: locale.omitted, publishedAt: locale.published_at }])) as Pick<StoredJourney, 'de' | 'en'>;
  const members = await client.query<{ translation_key: string }>('SELECT translation_key FROM journey_members WHERE journey_id=$1 ORDER BY position', [id]);
  return withChanges({ id: row.id, status: row.status, ...content, members: members.rows.map((member) => member.translation_key),
    publishedSnapshot: row.published_snapshot === null ? null : parseJourneySnapshot(row.published_snapshot), publishedAt: row.published_at,
    createdAt: row.created_at, updatedAt: row.updated_at, hasUnpublishedChanges: false }, mode);
}
export function pgJourneyStore(pool: DbPool, media: MediaStore, imageBase: string, ownership: WorkCancellationOptions = {}): JourneyStore {
  async function read<T>(fn: (client: DbClient, mode: LanguageConfig) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); const result = await fn(client, await readLanguage(client)); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async function mutate(id: string, action: 'create' | 'save' | 'publish' | 'unpublish' | 'remove', input?: JourneyDraft, base?: Date, confirm?: boolean): Promise<StoredJourney> {
    const client = await pool.connect();
    try {
      assertWorkWritable(ownership);
      await client.query('BEGIN');
      const mode = await readLanguage(client, true);
      // Persist a recovered history-derived latch before deletion can remove its last source.
      if (mode.lockedAt) await client.query('UPDATE site_language SET locked_at=COALESCE(locked_at,$1) WHERE id=true', [mode.lockedAt]);
      const draft = input ? validateJourneyDraft(input, imageBase) : undefined;
      const current = await readJourney(client, id, mode);
      if (action !== 'create' && !current) throw new JourneyError('Journey not found.', 'not_found');
      if (action === 'create' || action === 'save' || action === 'publish') {
        const keys = new Set([...(draft?.members ?? []), ...(current?.members ?? []), ...(current?.publishedSnapshot?.members ?? [])]);
        for (const key of [...keys].sort()) await lockPostPair(client, key);
      }
      await lockJourney(client, id);
      let journey = action === 'create' ? emptyJourney(id, draft!) : (await readJourney(client, id, mode))!;
      if (action === 'save' || action === 'publish') assertBase(journey, base!);
      if (action === 'save') journey = applyDraft(journey, draft!, mode, confirm);
      if (action === 'create' || action === 'save' || action === 'publish') {
        coverage(journey, mode);
        const found = await client.query<{ translation_key: string }>('SELECT DISTINCT translation_key FROM posts WHERE translation_key=ANY($1::text[])', [journey.members]);
        if (found.rows.length !== journey.members.length) throw new JourneyError('A selected story no longer exists.', 'unknown_member');
        const conflicting = await client.query<{ id: string }>(`SELECT id FROM journeys WHERE id<>$1 AND
          (id IN(SELECT journey_id FROM journey_members WHERE translation_key=ANY($2::text[])) OR
          (status='published' AND published_snapshot->'members' ?| $2::text[])) ORDER BY id LIMIT 1`, [id, journey.members]);
        if (conflicting.rows[0]) {
          const owner = (await readJourney(client, conflicting.rows[0].id, mode))!;
          throw new JourneyError('Publish or unpublish the other journey first.', 'story_in_other_journey', undefined, { id: owner.id, title: owner[mode.primary].title });
        }
        for (const locale of LOCALES) if (journey[locale].slug) {
          const duplicate = await client.query('SELECT 1 FROM journey_locales WHERE journey_id<>$1 AND locale=$2 AND slug=$3', [id, locale, journey[locale].slug]);
          if (duplicate.rowCount) throw new JourneyError('This journey slug is already used.', 'duplicate_slug', locale);
        }
      }
      if (action === 'publish') {
        journey.publishedSnapshot = await validatePublication(journey, mode, media, imageBase, client);
        journey.status = 'published'; journey.publishedAt ??= new Date();
        for (const locale of mode.locales) if (!journey[locale].omitted) journey[locale].publishedAt ??= new Date();
        await client.query('UPDATE site_language SET locked_at=COALESCE(locked_at,now()) WHERE id=true');
      }
      if (action === 'unpublish') journey.status = 'draft';
      if (action === 'remove') await client.query('DELETE FROM journeys WHERE id=$1', [id]);
      else {
        await client.query(`INSERT INTO journeys(id,status,published_snapshot,published_at) VALUES($1,$2,$3,$4)
          ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,published_snapshot=EXCLUDED.published_snapshot,published_at=EXCLUDED.published_at`, [id, journey.status, journey.publishedSnapshot ? JSON.stringify(journey.publishedSnapshot) : null, journey.publishedAt]);
        for (const locale of LOCALES) {
          const row = journey[locale];
          await client.query(`INSERT INTO journey_locales(journey_id,locale,slug,title,intro,hero_image,omitted,published_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT(journey_id,locale) DO UPDATE SET slug=EXCLUDED.slug,title=EXCLUDED.title,intro=EXCLUDED.intro,hero_image=EXCLUDED.hero_image,omitted=EXCLUDED.omitted,published_at=EXCLUDED.published_at`,
          [id, locale, row.slug, row.title, row.intro, row.heroImage ? JSON.stringify(row.heroImage) : null, row.omitted, row.publishedAt]);
        }
        await client.query('DELETE FROM journey_members WHERE journey_id=$1', [id]);
        for (const [position, key] of journey.members.entries()) await client.query('INSERT INTO journey_members(journey_id,translation_key,position) VALUES($1,$2,$3)', [id, key, position]);
        await touchJourney(client, id);
        journey = (await readJourney(client, id, mode))!;
      }
      assertWorkWritable(ownership);
      await client.query('COMMIT'); return withChanges(journey, mode);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  const store: JourneyStore = {
    list: () => read(async (client, mode) => { const ids = await client.query<{ id: string }>('SELECT id FROM journeys ORDER BY updated_at DESC,id'); return Promise.all(ids.rows.map(async ({ id }) => (await readJourney(client, id, mode))!)); }),
    get: (id) => read((client, mode) => readJourney(client, id, mode)),
    claiming: (member) => read(async (client, mode) => {
      const result = await client.query<{ id: string }>(`SELECT id FROM journeys WHERE id IN(SELECT journey_id FROM journey_members WHERE translation_key=$1)
        OR (status='published' AND published_snapshot->'members' ? $1) ORDER BY id LIMIT 1`, [member]);
      return result.rows[0] ? readJourney(client, result.rows[0].id, mode) : null;
    }),
    create: (draft) => mutate(randomUUID(), 'create', draft), save: (id, draft, base, confirm) => mutate(id, 'save', draft, base, confirm),
    publish: (id, base) => mutate(id, 'publish', undefined, base), unpublish: (id) => mutate(id, 'unpublish'), remove: (id) => mutate(id, 'remove'),
  };
  return store;
}
