import { isDeepStrictEqual } from 'node:util';
import { lstat, opendir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ABOUT_SEED, REGIONS, ensureSchema, ensureOnboardingSchema, type DbClient, type DbPool } from './db.js';
import { identityFromRow, seedSiteIdentity, type IdentityRow } from './site-identity.js';
import { neutralIdentity } from '../../site/src/lib/site-identity.js';
import { readOnboardingState, type RetiredReason } from './onboarding.js';
import { readRestoreFence } from './onboarding-fence.js';
import { DEFAULT_LANGUAGE, languageFromRow, type LanguageRow } from './language.js';

export interface OnboardingPaths { storageDir: string; settingsPath: string; backupDir: string; siteDir: string }
export interface BootEvidence { priorSchema: boolean; accounts: boolean; content: boolean }
const CONTENT_TABLES = ['posts', 'post_revisions', 'post_routes', 'route_cleanup', 'media', 'media_folders', 'comments', 'import_jobs', 'app_secrets', 'page_revisions', 'site_identity_assets'] as const;
const CORE_TABLES = ['users', 'sessions', ...CONTENT_TABLES, 'pages', 'site_identity', 'site_language'] as const;
type Query = Pick<DbClient, 'query'>;

async function tableInventory(db: Query): Promise<Map<string, string>> {
  const result = await db.query<{ name: string; kind: string }>(`SELECT c.relname AS name, c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f')`);
  return new Map(result.rows.map((row) => [row.name, row.kind]));
}
async function inspectEvidence(db: Query, tables: Map<string, string>): Promise<BootEvidence> {
  const evidence: BootEvidence = { priorSchema: CORE_TABLES.some((table) => tables.has(table)), accounts: false, content: false };
  if (tables.has('users')) evidence.accounts = (await db.query('SELECT EXISTS(SELECT 1 FROM users) AS found')).rows[0].found;
  for (const table of CONTENT_TABLES) {
    if (tables.has(table) && (await db.query(`SELECT EXISTS(SELECT 1 FROM ${table}) AS found`)).rows[0].found) { evidence.content = true; break; }
  }
  if (tables.has('pages')) {
    const pages = await db.query('SELECT key, locale, title, body_markdown, images FROM pages');
    evidence.content ||= pages.rows.some((row) => {
      if (row.key !== 'about' || (row.locale !== 'de' && row.locale !== 'en')) return true;
      const seed = ABOUT_SEED[row.locale as 'de' | 'en'];
      return row.title !== seed.title || row.body_markdown !== seed.body || !isDeepStrictEqual(row.images, {});
    });
  }
  if (tables.has('site_identity')) {
    const identities = await db.query<IdentityRow>('SELECT * FROM site_identity');
    if (identities.rows.length > 1) throw new Error('Invalid identity singleton.');
    for (const row of identities.rows) {
      identityFromRow(row);
      if (row.id !== true) throw new Error('Invalid identity singleton.');
      evidence.content ||= row.saved_at !== null;
    }
  }
  return evidence;
}
/** Capture before ensureSchema's orphan sweeps, while the process owns storage. */
export async function captureBootEvidence(pool: DbPool, assertOwner: () => void | Promise<void>): Promise<BootEvidence> {
  await assertOwner();
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await tableInventory(client);
    const existing = tables.has('onboarding_state') ? await readOnboardingState(client) : null;
    const evidence = existing
      ? { priorSchema: true, accounts: false, content: false }
      : await inspectEvidence(client, tables);
    await assertOwner();
    await client.query('COMMIT');
    return evidence;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
/** The only bootstrap-only boundary: every installed backup-required singleton joins here. */
export async function initializeApplicationSchema(pool: DbPool, assertOwner: () => void | Promise<void>): Promise<void> {
  await assertOwner();
  await ensureSchema(pool);
  await assertOwner();
  await seedSiteIdentity(pool);
  await assertOwner();
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function directoryHasEvidence(path: string, structural: readonly string[] = []): Promise<boolean> {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
  const directory = await opendir(path);
  try {
    for await (const entry of directory) {
      if (!structural.includes(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) return true;
      if (await directoryHasEvidence(join(path, entry.name))) return true;
    }
    return false;
  } finally { await directory.close().catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ERR_DIR_CLOSED') throw error; }); }
}
export async function hasExistingOnboardingData(paths: OnboardingPaths): Promise<boolean> {
  if (await exists(resolve(paths.settingsPath)) || await exists(resolve(paths.settingsPath) + '.pre-ai-registry')) return true;
  for (const path of [paths.storageDir, paths.backupDir, paths.siteDir]) if (await directoryHasEvidence(resolve(path))) return true;
  // Match createGpxFiles' configured root, including relative STORAGE_DIR forms.
  return directoryHasEvidence(resolve(dirname(paths.storageDir), 'routes'), ['originals', 'pending']);
}

/** A restore's retirement is separate from, and always precedes, content replacement. */
export async function retireOnboarding(pool: DbPool, assertOwner: () => void | Promise<void>): Promise<void> {
  await assertOwner();
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await ensureOnboardingSchema(client);
    const state = await readOnboardingState(client, true);
    if (state?.state !== 'retired') {
      await assertOwner();
      await client.query(`INSERT INTO onboarding_state (singleton,state,reason,evaluated_at,retired_at)
        VALUES (true,'retired','restored-content',transaction_timestamp(),transaction_timestamp())
        ON CONFLICT (singleton) DO UPDATE SET state='retired',reason='restored-content',dismissed_at=NULL,retired_at=transaction_timestamp()
        WHERE onboarding_state.state='eligible'`);
    }
    await assertOwner();
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
async function initializeOnboardingSnapshot(pool: DbPool, paths: OnboardingPaths, before: BootEvidence, assertOwner: () => void | Promise<void>): Promise<void> {
  await assertOwner();
  const fenced = await readRestoreFence(paths.storageDir);
  if (fenced) { await retireOnboarding(pool, assertOwner); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const state = await readOnboardingState(client, true);
    if (state === null) {
      const current = await inspectEvidence(client, await tableInventory(client));
      let reason: RetiredReason | null = null;
      if (before.accounts || current.accounts) reason = 'existing-accounts';
      else if (before.content || current.content) reason = 'existing-content';
      else if (await hasExistingOnboardingData(paths)) reason = 'existing-data';
      else if (before.priorSchema) reason = 'existing-schema';
      await assertOwner();
      await client.query(`INSERT INTO onboarding_state (singleton,state,reason,evaluated_at,retired_at)
        VALUES (true,$1,$2,transaction_timestamp(),CASE WHEN $1='retired' THEN transaction_timestamp() ELSE NULL END)
        ON CONFLICT (singleton) DO NOTHING`, [reason ? 'retired' : 'eligible', reason ?? 'fresh']);
      // Conflicts can never overwrite an earlier classification. Validate the committed winner.
      if (!await readOnboardingState(client)) throw new Error('Onboarding initialization did not persist.');
    }
    await assertOwner();
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function initializeOnboarding(pool: DbPool, paths: OnboardingPaths, before: BootEvidence, assertOwner: () => void | Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await initializeOnboardingSnapshot(pool, paths, before, assertOwner); return; }
    catch (error) {
      // A conflicting initializer can make the singleton invisible to this RR
      // snapshot. PostgreSQL's explicit serialization abort permits a new read
      // of the winner, never an overwrite or a retry of an uncertain commit.
      if (attempt >= 2 || !(error instanceof Error) || !('code' in error) || error.code !== '40001') throw error;
    }
  }
}

/** Column types admitted before offline bootstrap. Unknown or malformed schema needs backed-up operator recovery. */
const BOOTSTRAP_COLUMNS: Record<string, Record<string, string>> = {
  users: { id: 'uuid', username: 'text', password_hash: 'text', is_admin: 'boolean', created_at: 'timestamp with time zone' },
  sessions: { id: 'text', user_id: 'uuid', created_at: 'timestamp with time zone', expires_at: 'timestamp with time zone' },
  posts: { id: 'uuid', translation_key: 'text', locale: 'text', slug: 'text', title: 'text', date: 'date', country: 'text', country_code: 'text', region: 'text', excerpt: 'text', hero_image: 'jsonb', coordinates: 'jsonb', title_image: 'jsonb', stops: 'jsonb', route: 'text', key_facts: 'jsonb', body_markdown: 'text', images: 'jsonb', status: 'text', featured: 'boolean', comments_enabled: 'boolean', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone', published_snapshot: 'jsonb', published_at: 'timestamp with time zone', categories: 'text[]', tags: 'text[]', scheduled_at: 'timestamp with time zone', omitted: 'boolean' },
  post_revisions: { id: 'uuid', translation_key: 'text', snapshot: 'jsonb', saved_at: 'timestamp with time zone' },
  post_routes: { translation_key: 'text', version: 'uuid', geometry: 'jsonb', source_id: 'uuid', source_sha256: 'text', source_bytes: 'integer', updated_at: 'timestamp with time zone' },
  route_cleanup: { source_id: 'uuid', pair_hash: 'text', requested_at: 'timestamp with time zone' },
  pages: { key: 'text', locale: 'text', title: 'text', body_markdown: 'text', images: 'jsonb', updated_at: 'timestamp with time zone' },
  page_revisions: { id: 'uuid', key: 'text', snapshot: 'jsonb', saved_at: 'timestamp with time zone' },
  media: { key: 'text', folder: 'text', title: 'text', alt_de: 'text', alt_en: 'text', caption_de: 'text', caption_en: 'text', tags: 'text[]', width: 'integer', height: 'integer', orig_bytes: 'bigint', variant_bytes: 'bigint', status: 'text', error: 'text', taken_at: 'timestamp with time zone', camera: 'text', lens: 'text', lat: 'double precision', lng: 'double precision', format: 'text', encoding: 'jsonb', uploaded_at: 'timestamp with time zone', uploaded_by: 'uuid' },
  media_folders: { path: 'text', created_at: 'timestamp with time zone' },
  import_jobs: { id: 'uuid', status: 'text', started_by: 'text', started_at: 'timestamp with time zone', updated_at: 'timestamp with time zone', finished_at: 'timestamp with time zone', progress: 'jsonb', summary: 'jsonb', error: 'text' },
  app_secrets: { key: 'text', ciphertext: 'text', iv: 'text', tag: 'text', updated_at: 'timestamp with time zone' },
  site_identity: { id: 'boolean', revision: 'integer', seed_source: 'text', saved_at: 'timestamp with time zone', updated_at: 'timestamp with time zone', site_name: 'text', author_name: 'text', canonical_origin: 'text', localized: 'jsonb', social_links: 'jsonb' },
  site_identity_assets: { role: 'text', sha256: 'text', width: 'integer', height: 'integer', bytes: 'bytea', created_at: 'timestamp with time zone' },
  site_language: { id: 'boolean', primary_locale: 'text', enabled_locales: 'text[]', locked_at: 'timestamp with time zone', updated_at: 'timestamp with time zone' },
  comments: { id: 'uuid', translation_key: 'text', locale: 'text', name: 'text', email: 'text', body: 'text', status: 'text', is_author: 'boolean', sender_hash: 'text', created_at: 'timestamp with time zone' },
  onboarding_state: { singleton: 'boolean', schema_version: 'smallint', state: 'text', reason: 'text', evaluated_at: 'timestamp with time zone', dismissed_at: 'timestamp with time zone', retired_at: 'timestamp with time zone' },
};
const ADDITIVE_COLUMNS: Record<string, readonly string[]> = { posts: ['published_snapshot','published_at','categories','tags','scheduled_at','title_image','featured','comments_enabled','omitted'], media: ['format','encoding'], comments: ['is_author'] };
const NULLABLE_COLUMNS: Record<string, readonly string[]> = {
  posts: ['title_image','stops','route','key_facts','published_snapshot','published_at','scheduled_at'],
  post_routes: ['geometry'], media: ['error','taken_at','camera','lens','lat','lng','format','encoding','uploaded_by'],
  import_jobs: ['finished_at','summary','error'], site_identity: ['saved_at','canonical_origin'],
  comments: ['email','sender_hash'], site_language: ['locked_at'], onboarding_state: ['dismissed_at','retired_at'],
};
const PRIMARY_KEYS: Record<string, readonly string[]> = {
  users: ['id'], sessions: ['id'], posts: ['id'], post_revisions: ['id'], post_routes: ['translation_key'],
  route_cleanup: ['source_id'], pages: ['key','locale'], page_revisions: ['id'], media: ['key'], media_folders: ['path'],
  import_jobs: ['id'], app_secrets: ['key'], site_identity: ['id'], site_identity_assets: ['role'],
  comments: ['id'], site_language: ['id'], onboarding_state: ['singleton'],
};
const BOOTSTRAP_DEFAULTS: Record<string, Record<string, string>> = {
  users: { is_admin: 'false', created_at: 'now()' }, sessions: { created_at: 'now()' },
  posts: { images: "'{}'::jsonb", status: "'draft'::text", featured: 'false', comments_enabled: 'true', created_at: 'now()', updated_at: 'now()', categories: "'{}'::text[]", tags: "'{}'::text[]", omitted: 'false' },
  post_revisions: { saved_at: 'now()' }, route_cleanup: { requested_at: 'now()' },
  pages: { title: "''::text", body_markdown: "''::text", images: "'{}'::jsonb", updated_at: 'now()' },
  page_revisions: { saved_at: 'now()' },
  media: { folder: "''::text", title: "''::text", alt_de: "''::text", alt_en: "''::text", caption_de: "''::text", caption_en: "''::text", tags: "'{}'::text[]", width: '0', height: '0', orig_bytes: '0', variant_bytes: '0', status: "'processing'::text", uploaded_at: 'now()' },
  media_folders: { created_at: 'now()' }, import_jobs: { started_at: 'now()', updated_at: 'now()' },
  app_secrets: { updated_at: 'now()' },
  site_identity: { id: 'true', revision: '1', updated_at: 'now()', site_name: "''::text", author_name: "''::text", localized: "'{}'::jsonb", social_links: "'[]'::jsonb" },
  site_identity_assets: { created_at: 'now()' }, comments: { status: "'pending'::text", is_author: 'false', created_at: 'now()' },
  site_language: { id: 'true', updated_at: 'now()' },
  onboarding_state: { singleton: 'true', schema_version: '1' },
};

// PostgreSQL's deparsed expressions for ensureSchema's current CHECKs. Keep
// exact expressions: accepting merely the constraint name would admit changed
// semantics. Column dependencies allow only recognized partial bootstrap shapes.
const BOOTSTRAP_CHECKS: Record<string, { columns: readonly string[]; expression: string }[]> = {
  posts: [
    { columns: ['locale'], expression: "(locale = ANY (ARRAY['de'::text, 'en'::text]))" },
    { columns: ['country_code'], expression: '(char_length(country_code) = 2)' },
    { columns: ['region'], expression: `(region = ANY (ARRAY[${REGIONS.map((region) => `'${region}'::text`).join(', ')}]))` },
    { columns: ['status'], expression: "(status = ANY (ARRAY['draft'::text, 'published'::text]))" },
    { columns: ['omitted', 'status', 'published_snapshot', 'published_at'], expression: "((NOT omitted) OR ((status = 'draft'::text) AND (published_snapshot IS NULL) AND (published_at IS NULL)))" },
  ],
  post_routes: [
    { columns: ['source_sha256'], expression: "(source_sha256 ~ '^[0-9a-f]{64}$'::text)" },
    { columns: ['source_bytes'], expression: '((source_bytes >= 1) AND (source_bytes <= 5242880))' },
  ],
  route_cleanup: [{ columns: ['pair_hash'], expression: "(pair_hash ~ '^[0-9a-f]{64}$'::text)" }],
  pages: [{ columns: ['locale'], expression: "(locale = ANY (ARRAY['de'::text, 'en'::text]))" }],
  media: [
    { columns: ['status'], expression: "(status = ANY (ARRAY['processing'::text, 'ready'::text, 'failed'::text, 'missing'::text]))" },
    { columns: ['format'], expression: "((format IS NULL) OR (format = 'jpeg'::text))" },
    { columns: ['format', 'encoding'], expression: "((format IS NULL) OR COALESCE(((encoding ->> 'convertJpeg'::text) = 'false'::text), false))" },
  ],
  import_jobs: [{ columns: ['status'], expression: "(status = ANY (ARRAY['running'::text, 'done'::text, 'failed'::text, 'interrupted'::text]))" }],
  site_identity: [
    { columns: ['id'], expression: 'id' },
    { columns: ['revision'], expression: '(revision >= 1)' },
    { columns: ['seed_source'], expression: "(seed_source = ANY (ARRAY['neutral'::text, 'legacy'::text, 'restored-legacy'::text]))" },
    { columns: ['site_name'], expression: '(char_length(site_name) <= 80)' },
    { columns: ['author_name'], expression: '(char_length(author_name) <= 80)' },
    { columns: ['canonical_origin'], expression: '((canonical_origin IS NULL) OR (char_length(canonical_origin) <= 300))' },
  ],
  site_identity_assets: [
    { columns: ['role'], expression: "(role = ANY (ARRAY['logo'::text, 'favicon-32'::text, 'favicon-192'::text, 'apple-touch-180'::text]))" },
    { columns: ['sha256'], expression: "(sha256 ~ '^[0-9a-f]{64}$'::text)" },
    { columns: ['width'], expression: '((width >= 1) AND (width <= 1024))' },
    { columns: ['height'], expression: '((height >= 1) AND (height <= 1024))' },
    { columns: ['bytes'], expression: '(octet_length(bytes) <= 262144)' },
  ],
  site_language: [
    { columns: ['id'], expression: 'id' },
    { columns: ['primary_locale'], expression: "(primary_locale = ANY (ARRAY['de'::text, 'en'::text]))" },
    { columns: ['enabled_locales'], expression: "(((cardinality(enabled_locales) >= 1) AND (cardinality(enabled_locales) <= 2)) AND (enabled_locales <@ ARRAY['de'::text, 'en'::text]) AND ((cardinality(enabled_locales) = 1) OR (enabled_locales[1] <> enabled_locales[2])) AND (array_position(enabled_locales, NULL::text) IS NULL))" },
    { columns: ['primary_locale', 'enabled_locales'], expression: '(primary_locale = ANY (enabled_locales))' },
  ],
  comments: [
    { columns: ['locale'], expression: "(locale = ANY (ARRAY['de'::text, 'en'::text]))" },
    { columns: ['name'], expression: '((char_length(name) >= 1) AND (char_length(name) <= 80))' },
    { columns: ['body'], expression: '((char_length(body) >= 1) AND (char_length(body) <= 2000))' },
    { columns: ['status'], expression: "(status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'spam'::text]))" },
  ],
  onboarding_state: [
    { columns: ['singleton'], expression: 'singleton' },
    { columns: ['schema_version'], expression: '(schema_version = 1)' },
    { columns: ['state'], expression: "(state = ANY (ARRAY['eligible'::text, 'retired'::text]))" },
    { columns: ['state', 'reason', 'retired_at', 'dismissed_at'], expression: "(((state = 'eligible'::text) AND (reason = 'fresh'::text) AND (retired_at IS NULL)) OR ((state = 'retired'::text) AND (reason = ANY (ARRAY['existing-schema'::text, 'existing-accounts'::text, 'existing-content'::text, 'existing-data'::text, 'restored-content'::text, 'finished'::text])) AND (retired_at IS NOT NULL) AND (dismissed_at IS NULL)))" },
  ],
};
interface BootstrapConstraint {
  kind: string; columns: string[]; expression: string | null;
  deferrable: boolean; deferred: boolean; validated: boolean; enforced: boolean;
  local: boolean; inherited: number; no_inherit: boolean;
  reference_table: string | null; reference_same_schema: boolean | null; reference_columns: string[];
  update_action: string; delete_action: string; match_type: string; delete_columns: number[] | null;
}
async function assertBootstrapConstraints(db: Query, table: string, columns: Set<string>): Promise<void> {
  const result = await db.query<BootstrapConstraint>(`SELECT c.contype AS kind,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,pos)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.pos) AS columns,
    pg_get_expr(c.conbin,c.conrelid) AS expression,
    c.condeferrable AS deferrable, c.condeferred AS deferred, c.convalidated AS validated,
    c.conenforced AS enforced, c.conislocal AS local, c.coninhcount AS inherited, c.connoinherit AS no_inherit,
    ref.relname AS reference_table, ref.relnamespace=own.relnamespace AS reference_same_schema,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,pos)
      JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.pos) AS reference_columns,
    c.confupdtype AS update_action, c.confdeltype AS delete_action, c.confmatchtype AS match_type,
    c.confdelsetcols AS delete_columns
    FROM pg_constraint c JOIN pg_class own ON own.oid=c.conrelid
    LEFT JOIN pg_class ref ON ref.oid=c.confrelid WHERE c.conrelid=to_regclass($1)`, [table]);
  const checks = new Set((BOOTSTRAP_CHECKS[table] ?? [])
    .filter((check) => check.columns.every((column) => columns.has(column))).map((check) => check.expression));
  const notNull = new Set([...columns].filter((column) => !NULLABLE_COLUMNS[table]?.includes(column)));
  let primary = false;
  let foreign = false;
  const expectedForeign = table === 'sessions' ? ['user_id', 'c'] : table === 'media' ? ['uploaded_by', 'n'] : null;
  for (const constraint of result.rows) {
    if (constraint.deferrable || constraint.deferred || !constraint.validated || !constraint.enforced
      || !constraint.local || constraint.inherited !== 0
      || constraint.no_inherit !== ['p', 'f'].includes(constraint.kind)) throw new Error('Preparation refuses modified constraint enforcement.');
    if (constraint.kind === 'c' && constraint.expression !== null && checks.delete(constraint.expression)) continue;
    if (constraint.kind === 'n' && constraint.columns.length === 1 && notNull.delete(constraint.columns[0]!)) continue;
    if (constraint.kind === 'p' && !primary && isDeepStrictEqual(constraint.columns, PRIMARY_KEYS[table])) {
      primary = true;
      continue;
    }
    if (constraint.kind === 'f' && expectedForeign && !foreign
      && isDeepStrictEqual(constraint.columns, [expectedForeign[0]])
      && constraint.reference_table === 'users' && constraint.reference_same_schema === true
      && isDeepStrictEqual(constraint.reference_columns, ['id'])
      && constraint.update_action === 'a' && constraint.delete_action === expectedForeign[1]
      && constraint.match_type === 's' && constraint.delete_columns === null) {
      foreign = true;
      continue;
    }
    throw new Error('Preparation refuses an unknown constraint.');
  }
  if (!primary || checks.size || notNull.size || foreign !== (expectedForeign !== null)) throw new Error('Preparation refuses missing bootstrap constraints.');
}

// Exact installed definitions, not just names: IF NOT EXISTS will leave a
// same-name altered index untouched. Missing standalone indexes are safe for
// ensureSchema to create; unknown or changed existing indexes are not.
const BOOTSTRAP_INDEXES: Record<string, Record<string, { unique: boolean; definition: string }>> = {
  users: { users_username_lower_idx: { unique: true, definition: 'btree (lower(username))' } },
  sessions: { sessions_user_id_idx: { unique: false, definition: 'btree (user_id)' } },
  posts: {
    posts_locale_slug_idx: { unique: true, definition: "btree (locale, slug) WHERE (slug <> ''::text)" },
    posts_translation_key_idx: { unique: false, definition: 'btree (translation_key)' },
    posts_categories_idx: { unique: false, definition: 'gin (categories)' },
    posts_tags_idx: { unique: false, definition: 'gin (tags)' },
    posts_tk_locale_idx: { unique: true, definition: 'btree (translation_key, locale)' },
  },
  post_revisions: { post_revisions_tk_saved_idx: { unique: false, definition: 'btree (translation_key, saved_at DESC)' } },
  page_revisions: { page_revisions_key_saved_idx: { unique: false, definition: 'btree (key, saved_at DESC)' } },
  media: {
    media_folder_idx: { unique: false, definition: 'btree (folder)' },
    media_taken_at_idx: { unique: false, definition: 'btree (taken_at DESC NULLS LAST)' },
    media_uploaded_idx: { unique: false, definition: 'btree (uploaded_at DESC)' },
    media_tags_idx: { unique: false, definition: 'gin (tags)' },
    media_status_idx: { unique: false, definition: "btree (status) WHERE (status <> 'ready'::text)" },
  },
  import_jobs: { import_jobs_started_idx: { unique: false, definition: 'btree (started_at DESC)' } },
  comments: {
    comments_post_idx: { unique: false, definition: 'btree (translation_key, locale, status, created_at)' },
    comments_status_idx: { unique: false, definition: 'btree (status, created_at)' },
  },
};
const BOOTSTRAP_INDEX_NAMES = new Set(Object.values(BOOTSTRAP_INDEXES).flatMap(indexes => Object.keys(indexes)));
interface BootstrapIndex {
  name: string; target: string; definition: string; primary: boolean;
  valid: boolean; ready: boolean; live: boolean; immediate: boolean; exclusion: boolean;
}
async function assertBootstrapIndexes(db: Query, table: string): Promise<void> {
  const indexes = await db.query<BootstrapIndex>(`SELECT idx.relname AS name,
    format('%I ON %I.%I',idx.relname,n.nspname,t.relname) AS target,
    pg_get_indexdef(i.indexrelid) AS definition, i.indisprimary AS primary,
    i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live,
    i.indimmediate AS immediate, i.indisexclusion AS exclusion
    FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE i.indrelid=to_regclass($1)`, [table]);
  for (const index of indexes.rows) {
    const expected = index.primary
      ? { unique: true, definition: `btree (${PRIMARY_KEYS[table]!.join(', ')})` }
      : BOOTSTRAP_INDEXES[table]?.[index.name];
    if (!expected || (index.primary && BOOTSTRAP_INDEX_NAMES.has(index.name))
      || !index.valid || !index.ready || !index.live || !index.immediate || index.exclusion
      || index.definition !== `CREATE ${expected.unique ? 'UNIQUE ' : ''}INDEX ${index.target} USING ${expected.definition}`) {
      throw new Error('Preparation refuses unknown or modified bootstrap indexes.');
    }
  }
}
export async function assertBootstrapOnlyTarget(pool: DbPool, assertOwner: () => void | Promise<void>): Promise<void> {
  await assertOwner();
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = await tableInventory(client);
    // IF NOT EXISTS accepts any same-name relation, even a sequence with no
    // owning table yet. Missing indexes are safe only when their names are free.
    const collisions = await client.query(`SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[]) AND c.relkind<>'i'`,
    [[...BOOTSTRAP_INDEX_NAMES]]);
    if (collisions.rows.length) throw new Error('Preparation refuses occupied bootstrap index names.');
    for (const [table, kind] of tables) {
      const expected = BOOTSTRAP_COLUMNS[table];
      if (!expected || kind !== 'r') throw new Error('Preparation refuses unknown application tables.');
      const columns = await client.query<{ name: string; type: string; not_null: boolean; default_value: string | null }>(
        `SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS not_null,
          pg_get_expr(d.adbin,d.adrelid) AS default_value
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped`, [table]);
      const names = new Set(columns.rows.map((column) => column.name));
      if (columns.rows.some((column) => expected[column.name] !== column.type
          || column.not_null === (NULLABLE_COLUMNS[table]?.includes(column.name) ?? false)
          || column.default_value !== (BOOTSTRAP_DEFAULTS[table]?.[column.name] ?? null))
        || Object.keys(expected).some((name) => !names.has(name) && !ADDITIVE_COLUMNS[table]?.includes(name))) throw new Error('Preparation refuses an unknown table shape.');
      await assertBootstrapConstraints(client, table, names);
      await assertBootstrapIndexes(client, table);
      const policies = await client.query(`SELECT 1 FROM pg_class WHERE oid=to_regclass($1)
        AND (relrowsecurity OR relforcerowsecurity)
        UNION ALL SELECT 1 FROM pg_rewrite WHERE ev_class=to_regclass($1) LIMIT 1`, [table]);
      if (policies.rows.length) throw new Error('Preparation refuses row policies or rewrite rules.');
      const triggers = await client.query('SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass($1) AND NOT tgisinternal LIMIT 1', [table]);
      if (triggers.rows.length) throw new Error('Preparation refuses application triggers.');
      if (table !== 'pages' && table !== 'site_identity' && table !== 'site_language' && table !== 'onboarding_state'
        && (await client.query(`SELECT EXISTS(SELECT 1 FROM ${table}) AS found`)).rows[0].found) throw new Error('Preparation requires an empty bootstrap-only target.');
    }
    const evidence = await inspectEvidence(client, tables);
    if (evidence.accounts || evidence.content) throw new Error('Preparation refuses existing owner content.');
    if (tables.has('site_identity')) {
      const rows = await client.query<IdentityRow>('SELECT * FROM site_identity');
      for (const row of rows.rows) {
        if (row.revision !== 1 || row.seed_source !== 'neutral' || row.saved_at !== null || !isDeepStrictEqual(identityFromRow(row), neutralIdentity())) throw new Error('Preparation refuses non-default identity.');
      }
    }
    if (tables.has('site_language')) {
      const rows = await client.query<LanguageRow>('SELECT primary_locale, enabled_locales, locked_at, updated_at FROM site_language');
      for (const row of rows.rows) {
        // Missing seeds are recoverable; configured modes or publication history
        // are owner state, not a preparation shortcut. Validate stored dates too.
        const language = languageFromRow(row);
        if (language.lockedAt !== null || !isDeepStrictEqual({ primary: row.primary_locale, locales: row.enabled_locales }, DEFAULT_LANGUAGE)) {
          throw new Error('Preparation refuses non-default language.');
        }
      }
    }
    if (tables.has('onboarding_state')) {
      const state = await readOnboardingState(client);
      if (state && state.state !== 'retired') throw new Error('Preparation refuses eligible onboarding metadata.');
    }
    await assertOwner();
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
