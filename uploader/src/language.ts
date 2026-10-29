import type { DbClient, DbPool } from './db.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lockPostPair, touchPostPair } from './post-pair-lock.js';
import { namespaceOf, reservation } from '../../site/src/lib/reserved-routes.js';
import { updateJourneyCoverage } from './journey-cleanup.js';

export type LanguageLocale = 'de' | 'en';
export interface LanguageConfig { primary: LanguageLocale; locales: LanguageLocale[] }
export interface LanguageState extends LanguageConfig { lockedAt: Date | null; updatedAt: Date }
export const DEFAULT_LANGUAGE: LanguageConfig = { primary: 'de', locales: ['de', 'en'] };
export class LanguageError extends Error {
  constructor(message: string, public readonly code = 'invalid_language', public readonly blockers?: LanguageBlocker[],
    public readonly owner?: { type: 'app' | 'site' | 'locale' | 'legacy' | 'page'; name: string }) { super(message); }
}
export interface LanguageBlocker { key: string; locale: LanguageLocale; field: string; reason: string }
export type LanguagePreflight = (next: LanguageConfig, client?: DbClient) => Promise<void | (() => void)>;
type ChangeHandler = (current: LanguageState, next: LanguageConfig) => void;
export interface LanguageStore {
  get(): Promise<LanguageState>;
  runExclusive<T>(fn: (state: LanguageState) => Promise<T>): Promise<T>;
  update(config: LanguageConfig, preflight?: LanguagePreflight): Promise<LanguageState>;
  /** Call only within runExclusive; publication owns the transaction. */
  markPublished(): Promise<void>;
  onChange(handler: ChangeHandler): () => void;
}

export function validateLanguage(value: unknown): LanguageConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LanguageError('Choose a supported language mode.');
  const v = value as Record<string, unknown>;
  if ((v.primary !== 'de' && v.primary !== 'en') || !Array.isArray(v.locales)
    || v.locales.length < 1 || v.locales.length > 2
    || v.locales.some((locale) => locale !== 'de' && locale !== 'en')
    || new Set(v.locales).size !== v.locales.length || !v.locales.includes(v.primary)) {
    throw new LanguageError('Choose a supported language mode.');
  }
  return { primary: v.primary, locales: [v.primary, ...v.locales.filter((locale): locale is LanguageLocale => locale !== v.primary)] };
}
export function sameLanguage(a: LanguageConfig, b: LanguageConfig): boolean {
  return a.primary === b.primary && a.locales.length === b.locales.length && a.locales.every((locale) => b.locales.includes(locale));
}
export function assertLanguageTransition(current: LanguageState, next: LanguageConfig): void {
  if (!current.lockedAt) return;
  if (current.primary !== next.primary) throw new LanguageError('The primary language is locked because stories have been published.', 'language_primary_locked');
  if (current.locales.some((locale) => !next.locales.includes(locale))) throw new LanguageError('Published language URLs cannot be removed.', 'language_locale_published');
}
export function assertLanguageNamespace(current: LanguageConfig, next: LanguageConfig, rows: readonly { locale: LanguageLocale; slug: string }[]): void {
  for (const row of rows) {
    if (!row.slug || !next.locales.includes(row.locale)) continue;
    const newPrefix = row.locale === next.primary && next.locales.some((locale) => locale === row.slug && !current.locales.includes(locale));
    if (!newPrefix && namespaceOf(row.locale, next) === namespaceOf(row.locale, current)) continue;
    const owner = reservation(namespaceOf(row.locale, next), row.slug, next);
    if (owner) throw new LanguageError(`The ${row.locale.toUpperCase()} slug "${row.slug}" is reserved by ${owner.owner}.`, 'reserved_slug',
      undefined, { type: owner.pageKind ? 'page' : owner.owner, name: owner.pageKind ?? owner.segment });
  }
}
export interface LanguageRow { primary_locale: LanguageLocale; enabled_locales: LanguageLocale[]; locked_at: Date | string | null; updated_at: Date | string }
export function languageFromRow(row: LanguageRow): LanguageState {
  const config = validateLanguage({ primary: row.primary_locale, locales: row.enabled_locales });
  const updatedAt = new Date(row.updated_at);
  const lockedAt = row.locked_at === null ? null : new Date(row.locked_at);
  if (!Number.isFinite(updatedAt.getTime()) || (lockedAt !== null && !Number.isFinite(lockedAt.getTime()))) throw new LanguageError('Invalid stored language history.');
  return { ...config, updatedAt, lockedAt };
}
export async function readLanguage(client: DbPool | DbClient, lock = false): Promise<LanguageState> {
  const result = await client.query<LanguageRow>(`SELECT primary_locale, enabled_locales,
    COALESCE(locked_at, (SELECT min(published_at) FROM posts), (SELECT min(published_at) FROM journey_locales)) AS locked_at, updated_at
    FROM site_language WHERE id = true${lock ? ' FOR UPDATE' : ''}`);
  if (result.rows.length !== 1) throw new LanguageError('Site language configuration is missing.');
  return languageFromRow(result.rows[0]!);
}

export function memoryLanguageStore(initial: LanguageConfig = DEFAULT_LANGUAGE): LanguageStore {
  let state: LanguageState = { ...validateLanguage(initial), lockedAt: null, updatedAt: new Date(0) };
  let pending: Promise<unknown> = Promise.resolve();
  const handlers = new Set<ChangeHandler>();
  const store: LanguageStore = {
    async get() { return structuredClone(state); },
    async runExclusive(fn) {
      const run = pending.catch(() => {}).then(() => fn(state));
      pending = run;
      return run;
    },
    async update(input, preflight) {
      const next = validateLanguage(input);
      return store.runExclusive(async (current) => {
        assertLanguageTransition(current, next);
        if (sameLanguage(current, next)) return structuredClone(current);
        const commit = await preflight?.(next);
        for (const handler of handlers) handler(current, next);
        commit?.();
        state = { ...next, lockedAt: current.lockedAt, updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)) };
        return structuredClone(state);
      });
    },
    async markPublished() { state.lockedAt ??= new Date(); },
    onChange(handler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
  };
  return store;
}

/** SQL callers acquire this singleton before content/route locks. No build lock is held here. */
export function pgLanguageStore(pool: DbPool): LanguageStore {
  const transactions = new AsyncLocalStorage<DbClient>();
  const handlers = new Set<ChangeHandler>();
  return {
    get: () => readLanguage(pool),
    async runExclusive(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const state = await readLanguage(client, true);
        const result = await transactions.run(client, () => fn(state));
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async update(input, preflight) {
      const next = validateLanguage(input);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await readLanguage(client, true);
        // readLanguage also derives the sticky lock from retained publication history.
        assertLanguageTransition(current, next);
        if (!sameLanguage(current, next)) {
          const claims = await client.query<{ locale: LanguageLocale; slug: string }>('SELECT locale,slug FROM posts');
          assertLanguageNamespace(current, next, claims.rows);
          const changed = await client.query<{ translation_key: string }>(`SELECT DISTINCT translation_key FROM posts
            WHERE (locale=$1 AND omitted) OR (NOT (locale=ANY($2::text[])) AND NOT omitted) ORDER BY translation_key`, [next.primary, next.locales]);
          for (const row of changed.rows) {
            await lockPostPair(client, row.translation_key);
            await client.query('SELECT locale FROM posts WHERE translation_key=$1 ORDER BY locale FOR UPDATE', [row.translation_key]);
          }
          await updateJourneyCoverage(client, next);
          await preflight?.(next, client);
          for (const row of changed.rows) {
            await client.query(`UPDATE posts SET omitted = locale <> $2 WHERE translation_key=$1
              AND (locale=$2 OR NOT (locale=ANY($3::text[])))`, [row.translation_key, next.primary, next.locales]);
            await touchPostPair(client, row.translation_key);
          }
          for (const handler of handlers) handler(current, next);
          await client.query(`UPDATE site_language SET primary_locale=$1, enabled_locales=$2, locked_at=$3,
            updated_at=GREATEST(clock_timestamp(),date_trunc('milliseconds',updated_at)+interval '1 millisecond')
            WHERE id=true`, [next.primary, next.locales, current.lockedAt]);
        }
        const saved = await readLanguage(client);
        await client.query('COMMIT');
        return saved;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async markPublished() {
      const client = transactions.getStore();
      if (!client) throw new Error('Publication requires a language transaction.');
      await client.query('UPDATE site_language SET locked_at=COALESCE(locked_at,now()) WHERE id=true');
    },
    onChange(handler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
  };
}
