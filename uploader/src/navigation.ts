import type { DbPool } from './db.js';
import { readLanguage, type LanguageConfig, type LanguageStore } from './language.js';
import { DEFAULT_NAVIGATION, NAV_SLOTS, validateNavigation, type Navigation, type NavSlot } from '../../site/src/lib/navigation.js';

export class NavigationError extends Error {
  constructor(public readonly code: 'invalid_navigation' | 'conflict') {
    super(code === 'conflict' ? 'Navigation changed. Reload before saving.' : 'Invalid navigation configuration.');
  }
}
export interface NavigationState { config: Navigation; updatedAt: Date; language: LanguageConfig }
export interface NavigationStore {
  get(): Promise<NavigationState>;
  save(config: unknown, updatedAt: unknown): Promise<NavigationState>;
}
export interface MemoryNavigationRow { config: Navigation; updatedAt: Date }

function candidate(input: unknown, language: LanguageConfig): Navigation {
  let config: Navigation;
  try { config = validateNavigation(input); } catch { throw new NavigationError('invalid_navigation'); }
  for (const slot of Object.keys(NAV_SLOTS) as NavSlot[]) for (const item of config[slot]) {
    if (item.kind !== 'path' && item.kind !== 'external') continue;
    for (const locale of language.locales) {
      // Omitting both fields intentionally hides an item in that locale. Half a
      // link is an authoring error, not a reason to emit a broken/unnamed link.
      if (Boolean(item.href[locale]) !== Boolean(item.label[locale])) throw new NavigationError('invalid_navigation');
    }
  }
  return config;
}
function token(value: unknown, current: Date): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new NavigationError('invalid_navigation');
  if (new Date(value).getTime() !== current.getTime()) throw new NavigationError('conflict');
}

export function memoryNavigationStore(language: LanguageStore,
  row: MemoryNavigationRow = { config: structuredClone(DEFAULT_NAVIGATION), updatedAt: new Date(0) }): NavigationStore {
  return {
    async get() { return structuredClone({ ...row, language: await language.get() }); },
    save(input, updatedAt) {
      return language.runExclusive(async (mode) => {
        token(updatedAt, row.updatedAt);
        const config = candidate(input, mode);
        row.config = config;
        row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
        return structuredClone({ ...row, language: mode });
      });
    },
  };
}

/** The existing site_nav singleton, not settings.json and not a process-local production cache. */
export function pgNavigationStore(pool: DbPool): NavigationStore {
  return {
    async get() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const language = await readLanguage(client);
        const { rows } = await client.query<{ config: unknown; updated_at: Date }>('SELECT config, updated_at FROM site_nav WHERE id=1');
        if (!rows[0]) throw new Error('Navigation singleton is missing');
        const state = { config: validateNavigation(rows[0].config), updatedAt: rows[0].updated_at, language };
        await client.query('COMMIT');
        return state;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async save(input, updatedAt) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const language = await readLanguage(client, true);
        const { rows } = await client.query<{ config: unknown; updated_at: Date }>('SELECT config, updated_at FROM site_nav WHERE id=1 FOR UPDATE');
        if (!rows[0]) throw new Error('Navigation singleton is missing');
        token(updatedAt, rows[0].updated_at);
        const config = candidate(input, language);
        const saved = await client.query<{ updated_at: Date }>(`UPDATE site_nav SET config=$1,
          updated_at=GREATEST(clock_timestamp(),date_trunc('milliseconds',updated_at)+interval '1 millisecond') WHERE id=1 RETURNING updated_at`, [JSON.stringify(config)]);
        await client.query('COMMIT');
        return { config, updatedAt: saved.rows[0]!.updated_at, language };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
  };
}
