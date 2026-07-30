import { parseWxr, type ParsedPost } from './wxr-parse.js';
import { htmlToMarkdown } from './wp-content.js';
import { rehostImage, type RehostResult } from './wp-images.js';
import { isSafeSlug, type ImageDims, type PostLocale, type PostPair, type PostStore } from './posts.js';
import { rewriteFences } from './body-content.js';

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

/**
 * Re-host `url` once per translation pair.
 *
 * @ai-warning A DE/EN pair is two rows describing the SAME trip, so its two
 * bodies reference the same photos — 650 distinct images arrived as 1,338
 * fetch+encode calls in the 2026-06-24 export, each pair byte-identical. The
 * cache is scoped to one pair (created per group in importWxr), never global:
 * two different trips that happen to reuse a photo still get their own copy
 * under their own slug, so deleting one trip cannot strip another's images.
 * Within a pair that risk does not exist — `upsertDraft` writes both rows
 * under one translation_key and they are created and deleted together.
 *
 * Consequence: the stored key comes from whichever locale is built first (de),
 * so an EN post's photos live under the DE slug. That is deliberate.
 */
type RehostFn = (url: string, key: string, alt: string) => Promise<RehostResult>;

function sharedRehost(rehost: RehostFn): RehostFn {
  const byUrl = new Map<string, Promise<RehostResult>>();
  return (url, key, alt) => {
    const hit = byUrl.get(url);
    if (hit) return hit;
    const p = rehost(url, key, alt);
    byUrl.set(url, p);
    return p;
  };
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

  // Gallery fences (from Elementor slideshows). Two passes over the SAME
  // scanner `normalizeGalleryFences` uses, because re-hosting is async and
  // rewriteFences is not: pass 1 collects the URLs, pass 2 substitutes.
  // @ai-warning: reuse `rewriteFences` rather than matching fences here. #75
  // already had to pin a second scanner (public/gallery-fence.js) against it
  // with gallery-fence-parity.test.ts; a third copy would silently disagree
  // about where a fence ends and drop or corrupt an author's photos.
  const galleryUrls: string[] = [];
  rewriteFences(body, (line) => {
    const url = (line.split('|')[0] ?? '').trim();
    if (/^https?:\/\//.test(url) && !galleryUrls.includes(url)) galleryUrls.push(url);
    return line;
  });
  const rehosted = new Map<string, RehostResult>();
  for (const url of galleryUrls) {
    try {
      rehosted.set(url, await rehost(url, `trips/${p.slug}/${nameFromUrl(url)}`, ''));
    } catch (e) { warnings.push(`gallery image ${url} for ${p.slug}: ${(e as Error).message}`); }
  }
  body = rewriteFences(body, (line) => {
    const fields = line.split('|').map((f) => f.trim());
    const url = fields[0] ?? '';
    const r = rehosted.get(url);
    if (!r) return line; // fetch failed — keep the original so nothing is lost
    images[r.src] = { width: r.width, height: r.height };
    return [r.src, `${r.width}x${r.height}`, ...fields.slice(1)].join(' | ');
  });
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
    // @ai-warning: validate slugs at the import boundary BEFORE re-hosting images
    // or writing to the DB — an unsafe slug would otherwise become a storage path
    // segment (traversal) and a live URL.
    if (!isSafeSlug(de.slug) || !isSafeSlug(en.slug)) {
      summary.skipped++; summary.warnings.push(`group ${group}: unsafe slug (${de.slug} / ${en.slug}) — skipped`); continue;
    }
    const prior = bySlug.get(de.slug) ?? bySlug.get(en.slug);
    if (prior?.status === 'published') { summary.skipped++; summary.warnings.push(`${de.slug}/${en.slug}: already published — not overwritten`); continue; }
    try {
      // One cache per pair: de and en describe the same trip and share photos.
      const pairRehost = sharedRehost(rehost);
      const pair: PostPair = {
        translationKey: prior?.translationKey ?? '',
        status: 'draft',
        shared: { date: de.date, country: '', countryCode: 'XX', region: 'europe', coordinates: { lat: 0, lng: 0 } },
        de: await buildLocale(de, attachments, pairRehost, summary.warnings),
        en: await buildLocale(en, attachments, pairRehost, summary.warnings),
      };
      await deps.postStore.upsertDraft(pair);
      if (prior) summary.updated++; else summary.imported++;
    } catch (e) { summary.skipped++; summary.warnings.push(`${de.slug}/${en.slug}: ${(e as Error).message}`); }
  }
  return summary;
}
