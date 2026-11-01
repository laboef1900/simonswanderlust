import type { DbClient, DbPool } from './db.js';
import { readLanguage, type LanguageStore, type LanguageConfig } from './language.js';
import { lockPostPair } from './post-pair-lock.js';
import { parseJourneySnapshot } from '../../site/src/lib/journey-snapshot.js';
import { assertWorkWritable, type WorkCancellationOptions } from './work-cancellation.js';

export async function lockJourney(client: DbClient, id: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('journey:' || $1, 0))", [id]);
}
export async function touchJourney(client: DbClient, id: string): Promise<void> {
  await client.query(`UPDATE journeys SET updated_at=GREATEST(clock_timestamp(),date_trunc('milliseconds',updated_at)+interval '1 millisecond') WHERE id=$1`, [id]);
}
/** Caller holds language, then every removed pair lock. Retained drafts are NOT claims, but ARE references. */
export async function scrubJourneyReferences(client: DbClient, removedKeys: readonly string[]): Promise<void> {
  if (!removedKeys.length) return;
  const affected = await client.query<{ id: string }>(`SELECT id FROM journeys WHERE
    id IN (SELECT journey_id FROM journey_members WHERE translation_key=ANY($1::text[]))
    OR published_snapshot->'members' ?| $1::text[] ORDER BY id`, [removedKeys]);
  for (const { id } of affected.rows) await lockJourney(client, id);
  const removed = new Set(removedKeys);
  for (const { id } of affected.rows) {
    const members = await client.query<{ translation_key: string }>('SELECT translation_key FROM journey_members WHERE journey_id=$1 ORDER BY position', [id]);
    await client.query('DELETE FROM journey_members WHERE journey_id=$1', [id]);
    let position = 0;
    for (const member of members.rows) if (!removed.has(member.translation_key)) {
      await client.query('INSERT INTO journey_members(journey_id,translation_key,position) VALUES($1,$2,$3)', [id, member.translation_key, position++]);
    }
    const row = await client.query<{ published_snapshot: unknown }>('SELECT published_snapshot FROM journeys WHERE id=$1', [id]);
    if (row.rows[0]!.published_snapshot !== null) {
      const snapshot = parseJourneySnapshot(row.rows[0]!.published_snapshot);
      snapshot.members = snapshot.members.filter((key) => !removed.has(key));
      await client.query('UPDATE journeys SET published_snapshot=$2 WHERE id=$1', [id, JSON.stringify(snapshot)]);
    }
    await touchJourney(client, id);
  }
}
/** Only orphan references are repaired: incompatible language/history is an operator recovery error. */
export async function repairJourneyOrphans(pool: DbPool, ownership: WorkCancellationOptions = {}): Promise<void> {
  const client = await pool.connect();
  try {
    assertWorkWritable(ownership);
    await client.query('BEGIN');
    const mode = await readLanguage(client, true);
    const retained = await client.query<{ id: string; status: string; published_snapshot: unknown }>('SELECT id,status,published_snapshot FROM journeys');
    for (const row of retained.rows) {
      const snapshot = row.published_snapshot === null ? null : parseJourneySnapshot(row.published_snapshot);
      const locales = await client.query<{ locale: 'de' | 'en'; slug: string; omitted: boolean; published_at: Date | null }>(
        'SELECT locale,slug,omitted,published_at FROM journey_locales WHERE journey_id=$1 ORDER BY locale', [row.id]);
      if (locales.rows.length !== 2 || !locales.rows.some((locale) => locale.locale === mode.primary && !locale.omitted)
        || (row.status === 'published' && !snapshot)
        || (snapshot && (!snapshot.locales[mode.primary] || Object.keys(snapshot.locales).some((locale) => !mode.locales.includes(locale as 'de' | 'en'))))
        || locales.rows.some((locale) => {
          const committed = snapshot?.locales[locale.locale];
          return (!mode.locales.includes(locale.locale) && !locale.omitted)
            || (!!committed !== (locale.published_at !== null)) || (locale.omitted && !!committed)
            || (!!committed && committed.slug !== locale.slug);
        })) throw new Error('Journey language history requires a coherent recovery set.');
    }
    const missing = await client.query<{ translation_key: string }>(`SELECT DISTINCT reference.translation_key FROM (
      SELECT translation_key FROM journey_members UNION
      SELECT jsonb_array_elements_text(published_snapshot->'members') FROM journeys WHERE published_snapshot IS NOT NULL
    ) reference WHERE NOT EXISTS(SELECT 1 FROM posts WHERE posts.translation_key=reference.translation_key) ORDER BY reference.translation_key`);
    for (const { translation_key } of missing.rows) await lockPostPair(client, translation_key);
    await scrubJourneyReferences(client, missing.rows.map((row) => row.translation_key));
    await client.query('UPDATE site_language SET locked_at=COALESCE(locked_at,(SELECT min(published_at) FROM journey_locales)) WHERE id=true');
    assertWorkWritable(ownership);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** Called after affected post locks and before page preflight's later namespace locks. */
export async function updateJourneyCoverage(client: DbClient, next: LanguageConfig): Promise<void> {
  const changed = await client.query<{ journey_id: string }>(`SELECT DISTINCT journey_id FROM journey_locales
    WHERE (locale=$1 AND omitted) OR (NOT(locale=ANY($2::text[])) AND NOT omitted) ORDER BY journey_id`, [next.primary, next.locales]);
  for (const row of changed.rows) await lockJourney(client, row.journey_id);
  for (const row of changed.rows) {
    await client.query(`UPDATE journey_locales SET omitted=locale<>$2 WHERE journey_id=$1 AND (locale=$2 OR NOT(locale=ANY($3::text[])))`, [row.journey_id, next.primary, next.locales]);
    await touchJourney(client, row.journey_id);
  }
}

interface MemoryReferences { exists: (key: string) => boolean; cleanup: Set<(keys: ReadonlySet<string>) => void> }
const memoryReferences = new WeakMap<LanguageStore, MemoryReferences>();
export function registerMemoryJourneyPosts(language: LanguageStore, exists: (key: string) => boolean): void {
  const current = memoryReferences.get(language);
  memoryReferences.set(language, { exists, cleanup: current?.cleanup ?? new Set() });
}
export function memoryJourneyMemberExists(language: LanguageStore, key: string): boolean {
  return memoryReferences.get(language)?.exists(key) ?? false;
}
export function registerMemoryJourneyCleanup(language: LanguageStore, cleanup: (keys: ReadonlySet<string>) => void): void {
  let references = memoryReferences.get(language);
  if (!references) { references = { exists: () => false, cleanup: new Set() }; memoryReferences.set(language, references); }
  references.cleanup.add(cleanup);
}
export function scrubMemoryJourneyReferences(language: LanguageStore, keys: readonly string[]): void {
  const removed = new Set(keys);
  for (const cleanup of memoryReferences.get(language)?.cleanup ?? []) cleanup(removed);
}
