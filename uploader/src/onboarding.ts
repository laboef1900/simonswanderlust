import type { DbPool, DbClient } from './db.js';
import { StorageReadOnlyError } from './storage-owner.js';
import { identityConfigured } from './site-identity.js';
import { readLanguage, type LanguageConfig } from './language.js';

export const RETIRED_REASONS = ['existing-schema', 'existing-accounts', 'existing-content', 'existing-data', 'restored-content', 'finished'] as const;
export type RetiredReason = typeof RETIRED_REASONS[number];
export type OnboardingState =
  | { schemaVersion: 1; state: 'eligible'; reason: 'fresh'; evaluatedAt: string; dismissedAt: string | null; retiredAt: null }
  | { schemaVersion: 1; state: 'retired'; reason: RetiredReason; evaluatedAt: string; dismissedAt: null; retiredAt: string };
export type OnboardingAction = 'dismiss' | 'resume' | 'finish';
export type StepId = 'account' | 'identity' | 'photo' | 'story' | 'publish';
export type StepState = 'done' | 'todo' | 'in_progress' | 'attention';
export type OnboardingLanguage = LanguageConfig & { lockedAt: string | null; updatedAt: string };
export type OnboardingView = { status: 'retired' } | { status: 'open' | 'dismissed'; complete: boolean; language: OnboardingLanguage; steps: { id: StepId; state: StepState; required: boolean; href: string | null }[] };
export interface OnboardingProgress { language: OnboardingLanguage; identity: boolean; ready: boolean; processing: boolean; attention: boolean; story: boolean; published: boolean; newest: string | null; newestDraft: string | null }
export interface OnboardingStore { read(): Promise<OnboardingView>; act(action: OnboardingAction): Promise<OnboardingView> }
export class OnboardingError extends Error {
  constructor(readonly code: 'onboarding_retired' | 'onboarding_incomplete') { super(code); }
}
const invalid = () => new Error('Invalid onboarding state.');
function timestamp(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') throw invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalid();
  return date.toISOString();
}
export function decodeOnboardingRow(row: Record<string, unknown>): OnboardingState {
  if (row.singleton !== true || row.schema_version !== 1) throw invalid();
  const evaluatedAt = timestamp(row.evaluated_at);
  if (row.state === 'eligible' && row.reason === 'fresh' && row.retired_at === null) {
    return { schemaVersion: 1, state: 'eligible', reason: 'fresh', evaluatedAt, dismissedAt: row.dismissed_at === null ? null : timestamp(row.dismissed_at), retiredAt: null };
  }
  if (row.state === 'retired' && RETIRED_REASONS.includes(row.reason as RetiredReason) && row.dismissed_at === null) {
    return { schemaVersion: 1, state: 'retired', reason: row.reason as RetiredReason, evaluatedAt, dismissedAt: null, retiredAt: timestamp(row.retired_at) };
  }
  throw invalid();
}
export function onboardingView(state: OnboardingState, progress?: OnboardingProgress): OnboardingView {
  if (state.state === 'retired') return { status: 'retired' };
  if (!progress) throw invalid();
  const editor = (key: string) => '/admin/editor.html?tk=' + encodeURIComponent(key);
  return {
    status: state.dismissedAt === null ? 'open' : 'dismissed',
    complete: progress.ready && progress.story && progress.published,
    language: { primary: progress.language.primary, locales: [...progress.language.locales],
      lockedAt: progress.language.lockedAt, updatedAt: progress.language.updatedAt },
    steps: [
      { id: 'account', state: 'done', required: false, href: null },
      { id: 'identity', state: progress.identity ? 'done' : 'todo', required: false, href: '/admin/settings.html#identity' },
      { id: 'photo', state: progress.ready ? 'done' : progress.processing ? 'in_progress' : progress.attention ? 'attention' : 'todo', required: true, href: '/admin/media.html' },
      { id: 'story', state: progress.story ? 'done' : 'todo', required: true, href: progress.newest === null ? '/admin/editor.html' : editor(progress.newest) },
      { id: 'publish', state: progress.published ? 'done' : 'todo', required: true, href: progress.newestDraft === null ? '/admin/posts.html' : editor(progress.newestDraft) },
    ],
  };
}
export async function readOnboardingState(client: Pick<DbClient, 'query'>, lock = false): Promise<OnboardingState | null> {
  const result = await client.query('SELECT * FROM onboarding_state' + (lock ? ' FOR UPDATE' : ''));
  if (result.rows.length > 1) throw invalid();
  return result.rows.length === 0 ? null : decodeOnboardingRow(result.rows[0]);
}
export async function readOnboardingProgress(client: DbClient): Promise<OnboardingProgress> {
  const identity = await identityConfigured(client);
  // Use this transaction's snapshot, including the history-derived publication lock.
  const language = await readLanguage(client);
  const { rows } = await client.query(`SELECT
    EXISTS(SELECT 1 FROM media WHERE status='ready') AS ready,
    EXISTS(SELECT 1 FROM media WHERE status='processing') AS processing,
    EXISTS(SELECT 1 FROM media WHERE status IN ('failed','missing')) AS attention,
    EXISTS(SELECT 1 FROM posts) AS story,
    EXISTS(SELECT 1 FROM posts WHERE status='published') AS published,
    (SELECT translation_key FROM posts ORDER BY created_at DESC, translation_key ASC, locale ASC LIMIT 1) AS newest,
    (SELECT translation_key FROM posts WHERE status='draft' ORDER BY created_at DESC, translation_key ASC, locale ASC LIMIT 1) AS "newestDraft"`);
  return { identity, ...rows[0], language: { primary: language.primary, locales: language.locales,
    lockedAt: language.lockedAt?.toISOString() ?? null, updatedAt: language.updatedAt.toISOString() } };
}
function transition(state: OnboardingState, action: OnboardingAction, progress: OnboardingProgress, now: string): OnboardingState {
  if (state.state === 'retired') throw new OnboardingError('onboarding_retired');
  if (action === 'finish') {
    if (!progress.ready || !progress.story || !progress.published) throw new OnboardingError('onboarding_incomplete');
    return { schemaVersion: 1, state: 'retired', reason: 'finished', evaluatedAt: state.evaluatedAt, dismissedAt: null, retiredAt: now };
  }
  return { ...state, dismissedAt: action === 'dismiss' ? state.dismissedAt ?? now : null };
}
export function pgOnboardingStore(pool: DbPool, isWritable: () => boolean): OnboardingStore {
  async function run(action?: OnboardingAction): Promise<OnboardingView> {
    if (action && !isWritable()) throw new StorageReadOnlyError();
    const client = await pool.connect();
    try {
      await client.query(action ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state = await readOnboardingState(client, action !== undefined);
      if (!state) throw invalid();
      if (state.state === 'retired') {
        if (action) throw new OnboardingError('onboarding_retired');
        await client.query('COMMIT');
        return { status: 'retired' };
      }
      const progress = await readOnboardingProgress(client);
      let next = state as OnboardingState;
      if (action) {
        const time = await client.query('SELECT transaction_timestamp() AS now');
        next = transition(state, action, progress, timestamp(time.rows[0].now));
        if (!isWritable()) throw new StorageReadOnlyError();
        await client.query(`UPDATE onboarding_state SET state=$1, reason=$2, dismissed_at=$3, retired_at=$4 WHERE singleton=true AND state='eligible'`, [next.state, next.reason, next.dismissedAt, next.retiredAt]);
        if (!isWritable()) throw new StorageReadOnlyError();
      }
      await client.query('COMMIT');
      return onboardingView(next, progress);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return {
    read: () => run(),
    async act(action) {
      // REPEATABLE READ rejects a row changed while FOR UPDATE waited. Only an
      // explicit PostgreSQL serialization abort is safe to re-evaluate; never
      // replay a connection/COMMIT acknowledgement failure.
      for (let attempt = 0; ; attempt++) {
        try { return await run(action); }
        catch (error) {
          if (attempt >= 2 || !(error instanceof Error) || !('code' in error) || error.code !== '40001') throw error;
        }
      }
    },
  };
}
/** Snapshot supplier is synchronous: memory fixtures cannot mix asynchronously changing stores. */
export function memoryOnboardingStore(options: { state: OnboardingState | null; progress: () => OnboardingProgress; isWritable?: () => boolean; now?: () => Date }): OnboardingStore {
  let state = structuredClone(options.state);
  return {
    async read() {
      if (!state) throw invalid();
      return onboardingView(state, state.state === 'eligible' ? structuredClone(options.progress()) : undefined);
    },
    async act(action) {
      if (options.isWritable && !options.isWritable()) throw new StorageReadOnlyError();
      if (!state) throw invalid();
      if (state.state === 'retired') throw new OnboardingError('onboarding_retired');
      const progress = structuredClone(options.progress());
      state = transition(state, action, progress, (options.now?.() ?? new Date()).toISOString());
      return onboardingView(state, progress);
    },
  };
}
