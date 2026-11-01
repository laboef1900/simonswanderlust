import type { DbClient } from './db.js';
import type { LanguageStore, LanguageLocale } from './language.js';
export interface SlugClaim { type: 'page' | 'story'; name: string; locale: LanguageLocale; slug: string; bodyMarkdown?: string }
/** All content writers hold the language singleton first; namespace locks follow content locks. */
export async function lockContentNamespaces(client: DbClient): Promise<void> {
  for (const key of [28801, 28802, 28803]) await client.query('SELECT pg_advisory_xact_lock(288, $1)', [key]);
}
const memoryClaims = new WeakMap<LanguageStore, Set<() => Iterable<SlugClaim>>>();
export function registerMemoryClaims(language: LanguageStore, claims: () => Iterable<SlugClaim>): void {
  let sources = memoryClaims.get(language);
  if (!sources) { sources = new Set(); memoryClaims.set(language, sources); }
  sources.add(claims);
}
/** Invoked inside language.runExclusive, so checking and changing claims is one serial operation. */
export function memorySlugOwner(language: LanguageStore, locale: LanguageLocale, slug: string, type?: SlugClaim['type'], except?: string): SlugClaim | null {
  if (!slug) return null;
  for (const source of memoryClaims.get(language) ?? []) for (const claim of source()) {
    if (claim.locale === locale && claim.slug === slug && (!type || claim.type === type) && claim.name !== except) return claim;
  }
  return null;
}
/** Same working/retained corpus as Postgres's best-effort deletion impact query. */
export function memoryStoryBodies(language: LanguageStore): string[] {
  const bodies: string[] = [];
  for (const source of memoryClaims.get(language) ?? []) for (const claim of source()) {
    if (claim.type === 'story' && claim.bodyMarkdown) bodies.push(claim.bodyMarkdown);
  }
  return bodies;
}
