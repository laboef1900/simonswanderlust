import { parseWxr, type ParsedPost } from './wxr-parse.js';
import { htmlToMarkdown } from './wp-content.js';
import { rehostImage, type RehostResult } from './wp-images.js';
import type { ImageDims, PostLocale, PostPair, PostStore } from './posts.js';

export interface ImportSummary { imported: number; updated: number; skipped: number; warnings: string[] }
export interface ImportDeps {
  postStore: PostStore; storageDir: string; baseUrl: string;
  rehost?: (url: string, key: string, alt: string) => Promise<RehostResult>;
}

const PLACEHOLDER_HERO = { src: '', width: 0, height: 0, alt: '' };

/** A short, slug-safe key segment from an image URL's filename. */
function nameFromUrl(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url;
  const segment = withoutQuery.split('/').pop() ?? 'image';
  const base = segment.replace(/\.[a-z0-9]+$/i, '');
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
}

async function buildLocale(
  p: ParsedPost, attachments: Map<string, string>,
  rehost: (url: string, key: string, alt: string) => Promise<RehostResult>,
  warnings: string[],
): Promise<PostLocale> {
  // hero from the featured image
  let heroImage = { ...PLACEHOLDER_HERO };
  const heroUrl = p.thumbnailId ? attachments.get(p.thumbnailId) : undefined;
  if (heroUrl) {
    try { const r = await rehost(heroUrl, `trips/${p.slug}/hero`, p.title); heroImage = { src: r.src, width: r.width, height: r.height, alt: p.title }; }
    catch (e) { warnings.push(`hero for ${p.slug}: ${(e as Error).message}`); }
  }
  // body: convert, then re-host each markdown image and rewrite the ref
  let body = htmlToMarkdown(p.contentHtml);
  const images: Record<string, ImageDims> = {};
  for (const m of [...body.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)]) {
    const full = m[0]; const alt = m[1] ?? ''; const url = m[2];
    if (!url || !/^https?:\/\//.test(url)) continue;
    try {
      const r = await rehost(url, `trips/${p.slug}/${nameFromUrl(url)}`, alt);
      body = body.replaceAll(full, `![${alt}](${r.src})`);
      images[r.src] = { width: r.width, height: r.height };
    } catch (e) { warnings.push(`image ${url} for ${p.slug}: ${(e as Error).message}`); }
  }
  return { locale: p.locale, slug: p.slug, title: p.title, excerpt: p.excerpt, heroImage, bodyMarkdown: body, images };
}

export async function importWxr(xml: string, deps: ImportDeps): Promise<ImportSummary> {
  const { attachments, posts } = parseWxr(xml);
  const rehost = deps.rehost ?? ((url, key, alt) => rehostImage(url, key, alt, { storageDir: deps.storageDir, baseUrl: deps.baseUrl }));
  const summary: ImportSummary = { imported: 0, updated: 0, skipped: 0, warnings: [] };

  // existing posts by slug → status/key (for idempotency + published-skip)
  const existing = await deps.postStore.list();
  const bySlug = new Map<string, { translationKey: string; status: 'draft' | 'published' }>();
  for (const s of existing) { bySlug.set(s.slugDe, s); bySlug.set(s.slugEn, s); }

  const groups = new Map<string, ParsedPost[]>();
  for (const p of posts) { const g = groups.get(p.group) ?? []; g.push(p); groups.set(p.group, g); }

  for (const [group, members] of groups) {
    const de = members.find((m) => m.locale === 'de');
    const en = members.find((m) => m.locale === 'en');
    if (!de || !en) { summary.skipped++; summary.warnings.push(`group ${group}: missing ${de ? 'en' : 'de'} translation (${members.map((m) => m.slug).join(', ')})`); continue; }
    const prior = bySlug.get(de.slug) ?? bySlug.get(en.slug);
    if (prior?.status === 'published') { summary.skipped++; summary.warnings.push(`${de.slug}/${en.slug}: already published — not overwritten`); continue; }
    try {
      const pair: PostPair = {
        translationKey: prior?.translationKey ?? '',
        status: 'draft',
        shared: { date: de.date, country: '', countryCode: 'XX', region: 'europe', coordinates: { lat: 0, lng: 0 } },
        de: await buildLocale(de, attachments, rehost, summary.warnings),
        en: await buildLocale(en, attachments, rehost, summary.warnings),
      };
      await deps.postStore.upsertDraft(pair);
      if (prior) summary.updated++; else summary.imported++;
    } catch (e) { summary.skipped++; summary.warnings.push(`${de.slug}/${en.slug}: ${(e as Error).message}`); }
  }
  return summary;
}
