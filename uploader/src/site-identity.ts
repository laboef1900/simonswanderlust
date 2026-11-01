import type pg from 'pg';
import { IdentityError, IDENTITY_LOCALIZED_FIELDS, normalizeIdentity, neutralIdentity, type Identity, type IdentityLocale } from '../../site/src/lib/site-identity.js';
import { LEGACY_IDENTITY } from './site-identity-legacy.js';
import { memoryLanguageStore, readLanguage, type LanguageStore } from './language.js';
import { identityAssetRoles, validateIdentityAssetGroup, type IdentityAssetGroup, type StoredIdentityAsset } from './site-identity-assets.js';

export type IdentitySeedSource = 'neutral' | 'legacy' | 'restored-legacy';
export interface IdentityRow {
  id: boolean;
  revision: number;
  seed_source: IdentitySeedSource;
  saved_at: Date | string | null;
  updated_at: Date | string;
  site_name: string;
  author_name: string;
  canonical_origin: string | null;
  localized: unknown;
  social_links: unknown;
}
export interface IdentityRecord {
  revision: number;
  savedAt: string | null;
  seedSource: IdentitySeedSource;
  identity: Identity;
}
export interface IdentityAssetState { logo: boolean; favicon: boolean }
function assetState(roles: readonly string[]): IdentityAssetState {
  return { logo: roles.includes('logo'), favicon: identityAssetRoles('favicon').every((role) => roles.includes(role)) };
}
export interface SiteIdentityStore {
  /** A detached cached record; request-time reads never touch Postgres. */
  get(): IdentityRecord;
  update(revision: number, input: unknown): Promise<IdentityRecord>;
  getAssetState(): IdentityAssetState;
  replaceAssets(revision: number, group: IdentityAssetGroup, assets: readonly StoredIdentityAsset[]): Promise<IdentityRecord>;
}
export class IdentityConflictError extends Error {
  readonly code = 'identity_conflict';
  constructor() { super('Site identity changed. Reload before saving.'); }
}
export function identityFromRow(row: IdentityRow): Identity {
  const localized = row.localized;
  if (!localized || typeof localized !== 'object' || Array.isArray(localized)) throw new IdentityError('localized');
  for (const key of Object.keys(localized)) if (!(IDENTITY_LOCALIZED_FIELDS as readonly string[]).includes(key)) throw new IdentityError('localized');
  return normalizeIdentity({ ...neutralIdentity(), ...localized, siteName: row.site_name, authorName: row.author_name, canonicalOrigin: row.canonical_origin, socialLinks: row.social_links });
}
function fromRow(row: IdentityRow): IdentityRecord {
  if (!Number.isInteger(row.revision) || row.revision < 1) throw new IdentityError('revision');
  if (!['neutral', 'legacy', 'restored-legacy'].includes(row.seed_source)) throw new IdentityError('seedSource');
  return { revision: row.revision, savedAt: row.saved_at === null ? null : new Date(row.saved_at).toISOString(), seedSource: row.seed_source, identity: identityFromRow(row) };
}
function localized(identity: Identity) {
  return Object.fromEntries(IDENTITY_LOCALIZED_FIELDS.map((field) => [field, identity[field]]));
}
/** Active edits cannot overwrite retained locale values. */
export function mergeIdentityEdit(current: Identity, input: unknown, locales: readonly IdentityLocale[] = ['de', 'en']): Identity {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new IdentityError('identity');
  const value = input as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...value };
  for (const field of IDENTITY_LOCALIZED_FIELDS) {
    const map = value[field];
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new IdentityError(field);
    for (const key of Object.keys(map)) if (!locales.includes(key as IdentityLocale)) throw new IdentityError(field);
    merged[field] = { ...Object.fromEntries(Object.entries(current[field]).filter(([locale]) => !locales.includes(locale as IdentityLocale))), ...map };
  }
  return normalizeIdentity(merged);
}
export async function seedSiteIdentity(pool: pg.Pool, options: { legacy?: Identity; bootstrapBlogOrigin?: string | null; log?: (message: string) => void } = {}): Promise<void> {
  const legacy = normalizeIdentity(options.legacy ?? LEGACY_IDENTITY);
  let bootstrap = options.bootstrapBlogOrigin ?? null;
  if (bootstrap !== null) {
    try { bootstrap = normalizeIdentity({ ...neutralIdentity(), canonicalOrigin: bootstrap }).canonicalOrigin; }
    catch (error) {
      if (!(error instanceof IdentityError)) throw error;
      (options.log ?? console.warn)('identity: ignoring invalid bootstrapBlogOrigin.');
      bootstrap = null;
    }
  }
  await pool.query(`
    INSERT INTO site_identity (id, seed_source, site_name, author_name, canonical_origin, localized, social_links)
    SELECT true, CASE WHEN e.existing THEN 'legacy' ELSE 'neutral' END,
      CASE WHEN e.existing THEN $1 ELSE '' END, CASE WHEN e.existing THEN $2 ELSE '' END,
      COALESCE($6, CASE WHEN e.existing THEN $5 END),
      CASE WHEN e.existing THEN $3::jsonb ELSE '{}'::jsonb END,
      CASE WHEN e.existing THEN $4::jsonb ELSE '[]'::jsonb END
    FROM (SELECT EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM posts) AS existing) e
    ON CONFLICT (id) DO NOTHING`,
  [legacy.siteName, legacy.authorName, JSON.stringify(localized(legacy)), JSON.stringify(legacy.socialLinks), legacy.canonicalOrigin, bootstrap]);
}
export async function pgSiteIdentityStore(pool: pg.Pool): Promise<SiteIdentityStore> {
  const initial = await pool.query<IdentityRow>('SELECT * FROM site_identity WHERE id = true');
  if (!initial.rows[0]) throw new IdentityError('identity');
  let current = fromRow(initial.rows[0]);
  const initialAssets = await pool.query<{ role: string }>('SELECT role FROM site_identity_assets');
  let assets = assetState(initialAssets.rows.map((row) => row.role));
  let assetRevision = current.revision;
  return {
    get: () => structuredClone(current),
    getAssetState: () => ({ ...assets }),
    async replaceAssets(revision, group, replacements) {
      await validateIdentityAssetGroup(group, replacements);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<IdentityRow>('SELECT * FROM site_identity WHERE id = true FOR UPDATE');
        if (locked.rows[0]?.revision !== revision) throw new IdentityConflictError();
        await client.query('DELETE FROM site_identity_assets WHERE role = ANY($1::text[])', [identityAssetRoles(group)]);
        for (const asset of replacements) {
          await client.query('INSERT INTO site_identity_assets (role, sha256, width, height, bytes) VALUES ($1,$2,$3,$4,$5)',
            [asset.role, asset.sha256, asset.width, asset.height, asset.bytes]);
        }
        const result = await client.query<IdentityRow>('UPDATE site_identity SET revision=revision+1, updated_at=now() WHERE id=true RETURNING *');
        const saved = fromRow(result.rows[0]!);
        const roles = await client.query<{ role: string }>('SELECT role FROM site_identity_assets');
        const nextAssets = assetState(roles.rows.map((row) => row.role));
        await client.query('COMMIT');
        if (saved.revision > current.revision) current = saved;
        if (saved.revision > assetRevision) { assets = nextAssets; assetRevision = saved.revision; }
        return structuredClone(saved);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async update(revision, input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const language = await readLanguage(client, true);
        const locked = await client.query<IdentityRow>('SELECT * FROM site_identity WHERE id = true FOR UPDATE');
        const row = locked.rows[0];
        if (!row || row.revision !== revision) throw new IdentityConflictError();
        const next = mergeIdentityEdit(identityFromRow(row), input, language.locales);
        const result = await client.query<IdentityRow>(`UPDATE site_identity SET site_name=$1, author_name=$2,
          localized=$3::jsonb, social_links=$4::jsonb, canonical_origin=$5, revision=revision+1, saved_at=now(), updated_at=now()
          WHERE id = true RETURNING *`, [next.siteName, next.authorName, JSON.stringify(localized(next)), JSON.stringify(next.socialLinks), next.canonicalOrigin]);
        const saved = fromRow(result.rows[0]!);
        await client.query('COMMIT');
        // Concurrent commits must never let a slower response roll the cache backwards.
        if (saved.revision > current.revision) current = saved;
        return structuredClone(saved);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
  };
}
/** In-memory implementation shares the exact write validator for route/unit fixtures. */
export function memorySiteIdentityStore(identity: Identity = neutralIdentity(), language: LanguageStore = memoryLanguageStore()): SiteIdentityStore {
  let current: IdentityRecord = { revision: 1, savedAt: null, seedSource: 'neutral', identity: normalizeIdentity(identity) };
  let assets: IdentityAssetState = { logo: false, favicon: false };
  return {
    get: () => structuredClone(current),
    getAssetState: () => ({ ...assets }),
    async replaceAssets(revision, group, replacements) {
      await validateIdentityAssetGroup(group, replacements);
      if (revision !== current.revision) throw new IdentityConflictError();
      assets = { ...assets, [group]: replacements.length > 0 };
      current = { ...current, revision: revision + 1 };
      return structuredClone(current);
    },
    async update(revision, input) {
      return language.runExclusive(async (mode) => {
      if (revision !== current.revision) throw new IdentityConflictError();
      current = { ...current, revision: revision + 1, savedAt: new Date().toISOString(), identity: mergeIdentityEdit(current.identity, input, mode.locales) };
      return structuredClone(current);
      });
    },
  };
}
