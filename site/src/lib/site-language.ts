import { z } from 'astro/zod';
import type { Locale } from '../i18n/ui.js';

export interface SiteLanguage { primary: Locale; locales: readonly Locale[] }
export const DEFAULT_LANGUAGE: SiteLanguage = { primary: 'de', locales: ['de', 'en'] };
const localeSchema = z.enum(['de', 'en']);
export const languageSchema = z.object({
  primary: localeSchema,
  locales: z.array(localeSchema).min(1).max(2),
}).strict().refine(({ primary, locales }) => locales.includes(primary) && new Set(locales).size === locales.length,
  'Enabled locales must be unique and include the primary locale')
  .transform(({ primary, locales }) => ({ primary, locales: [primary, ...locales.filter((locale) => locale !== primary)] }));

/** Missing input is the historical unit-test context, not a standalone build default. */
export function parseLanguageSnapshot(raw: string | undefined): SiteLanguage {
  if (raw === undefined) return DEFAULT_LANGUAGE;
  return languageSchema.parse(JSON.parse(raw));
}

let cachedRaw: string | undefined;
let cachedLanguage = DEFAULT_LANGUAGE;

/** Astro config establishes this from the database before loading any content or routes. */
export function siteLanguage(): SiteLanguage {
  const raw = process.env.SITE_LANGUAGE_JSON;
  if (raw !== cachedRaw) {
    const language = parseLanguageSnapshot(raw);
    cachedRaw = raw;
    cachedLanguage = language;
  }
  return cachedLanguage;
}
