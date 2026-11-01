import { z } from 'astro/zod';
import { MAX_GALLERY_TEXT } from '../../../uploader/public/gallery-photo-line.js';
import { isPageKind } from './page-kinds.js';
import type { Locale } from '../i18n/ui.js';

export const pageDataSchema = z.object({
  key: z.enum(['about', 'contact', 'privacy', 'legal']),
  locale: z.enum(['de', 'en']),
  slug: z.string(),
  title: z.string(),
}).superRefine((page, context) => {
  if (page.key === 'about') {
    if (page.slug !== '') context.addIssue({ code: 'custom', message: 'About must retain its fixed route', path: ['slug'] });
  } else {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(page.slug)) context.addIssue({ code: 'custom', message: 'Published page requires a valid slug', path: ['slug'] });
    if (!page.title.trim()) context.addIssue({ code: 'custom', message: 'Published page requires a title', path: ['title'] });
  }
});
export type PageData = z.infer<typeof pageDataSchema>;
export interface PublicPage { id: string; data: PageData; body?: string }

// Same dimensions/text contract as uploader imagesMapError, checked again at the DB boundary.
const image = z.object({
  width: z.number().int().positive(), height: z.number().int().positive(),
  alt: z.string().max(MAX_GALLERY_TEXT).nullish().transform((value) => value ?? undefined),
  caption: z.string().max(MAX_GALLERY_TEXT).nullish().transform((value) => value ?? undefined),
  format: z.literal('jpeg').optional(),
});
export const publishedPageRowSchema = z.object({
  key: z.string(), locale: z.enum(['de', 'en']), slug: z.string(), title: z.string(),
  status: z.literal('published'), body_markdown: z.string(),
  images: z.record(z.string(), image).nullable(),
}).superRefine((row, context) => {
  const result = pageDataSchema.safeParse(row);
  if (!result.success) for (const issue of result.error.issues) context.addIssue({ ...issue });
  if (row.key !== 'about' && !row.body_markdown.trim()) {
    context.addIssue({ code: 'custom', message: 'Published page requires a body', path: ['body_markdown'] });
  }
});

/** Filter eligibility before parsing: private/unknown rows never enter a content collection. */
export function publishedPageRows(rows: unknown[], locales: readonly Locale[]) {
  const published = rows.filter((value) => {
    if (!value || typeof value !== 'object') return false;
    const row = value as Record<string, unknown>;
    return row.status === 'published' && typeof row.key === 'string' && isPageKind(row.key)
      && locales.includes(row.locale as Locale);
  }).map((row) => publishedPageRowSchema.parse(row));
  for (const key of new Set(published.map((row) => row.key))) {
    if (key === 'about') continue;
    for (const locale of locales) {
      if (!published.some((row) => row.key === key && row.locale === locale)) {
        throw new Error(`Missing published page translation: ${key}/${locale}`);
      }
    }
  }
  return published;
}
