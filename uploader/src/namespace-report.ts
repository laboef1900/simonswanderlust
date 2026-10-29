import type { DbPool } from './db.js';
import { readLanguage, type LanguageLocale } from './language.js';
import { namespaceOf, reservation } from '../../site/src/lib/reserved-routes.js';
import { isPageKind } from '../../site/src/lib/page-kinds.js';
/** Read-only rollout report. Never repairs, renames or deletes owner content. */
export async function reportNamespaceCollisions(pool: DbPool, log: (message: string) => void): Promise<void> {
  const mode = await readLanguage(pool);
  const rows = await pool.query<{ type: string; name: string; locale: LanguageLocale; slug: string }>(`
    SELECT 'story' AS type,translation_key AS name,locale,slug FROM posts
    UNION SELECT 'story',translation_key,locale,published_snapshot->>'slug' FROM posts WHERE published_snapshot IS NOT NULL
    UNION SELECT 'page',key,locale,slug FROM pages`);
  const unknown = new Set<string>();
  for (const row of rows.rows) {
    if (row.type === 'page' && !isPageKind(row.name)) unknown.add(row.name);
    if (!row.slug) continue;
    const namespace = namespaceOf(row.locale, mode);
    const owner = reservation(namespace, row.slug, mode);
    if (owner) log(`reserved-route collision: ${namespace}/${row.slug} (${owner.owner}:${owner.segment}) held by ${row.type}`);
  }
  for (const key of unknown) log(`Unknown page kind retained inert: ${key}`);
}
