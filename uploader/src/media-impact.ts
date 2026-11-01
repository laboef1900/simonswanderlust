import { classifyRow, type ClassifiedRow, type PostRow } from '../../site/src/lib/postgres-loader.js';
import { renderMarkdown } from '../../site/src/lib/render-markdown.js';

export interface LocaleUse { gallery: number; galleryCaptionFollowsLibrary: number; heroTitle: boolean; inline: number }
export interface StoryUse { translationKey: string; title: string; locales: { de: LocaleUse; en: LocaleUse } }
export type MediaImpact =
  | { availability: 'available'; published: StoryUse[]; drafts: StoryUse[]; newerDrafts: StoryUse[] }
  | { availability: 'unavailable' };
/** Internal only: mode and all rows are captured by one consistent store read. */
export interface MediaImpactStory {
  translationKey: string;
  title: string;
  rows: Array<{ locale: 'de' | 'en'; status: 'draft' | 'published'; requested: boolean;
    working: PostRow; published: PostRow | null }>;
}
const empty = (): LocaleUse => ({ gallery: 0, galleryCaptionFollowsLibrary: 0, heroTitle: false, inline: 0 });
const used = (use: LocaleUse) => use.gallery > 0 || use.heroTitle || use.inline > 0;
function count(row: ClassifiedRow, src: string): LocaleUse {
  const counts = empty();
  for (const use of row.gallery) {
    if (use.src !== src) continue;
    counts.gallery++;
    if (use.captionFollowsLibrary) counts.galleryCaptionFollowsLibrary++;
  }
  counts.heroTitle = row.heroImage.src === src || row.titleImage?.src === src;
  const variantPrefix = `${src}-`;
  for (const url of row.inline) {
    if (url === src || url.startsWith(variantPrefix) && /^\d+\.(?:avif|webp|jpeg)$/.test(url.slice(variantPrefix.length))) counts.inline++;
  }
  return counts;
}
const differs = (a: LocaleUse, b: LocaleUse) => a.gallery !== b.gallery
  || a.galleryCaptionFollowsLibrary !== b.galleryCaptionFollowsLibrary || a.heroTitle !== b.heroTitle || a.inline !== b.inline;

/** Fresh classification, never cached by release or snapshot digest. Failures propagate to the optional boundary. */
export async function mediaImpact(corpus: MediaImpactStory[], key: string, imageOrigin: string): Promise<MediaImpact> {
  const result: Extract<MediaImpact, { availability: 'available' }> = { availability: 'available', published: [], drafts: [], newerDrafts: [] };
  const src = `${imageOrigin.replace(/\/+$/, '')}/${key}`;
  for (const story of corpus) {
    const scopes = { published: { de: empty(), en: empty() }, drafts: { de: empty(), en: empty() }, newerDrafts: { de: empty(), en: empty() } };
    let newer = false;
    for (const row of story.rows) {
      const published = row.published ? count(await classifyRow(row.published, imageOrigin, renderMarkdown), src) : empty();
      scopes.published[row.locale] = published;
      if (!row.requested) continue;
      const working = count(await classifyRow(row.working, imageOrigin, renderMarkdown), src);
      if (row.status === 'draft') scopes.drafts[row.locale] = working;
      else if (differs(working, published)) { scopes.newerDrafts[row.locale] = working; newer = true; }
    }
    for (const scope of ['published', 'drafts', 'newerDrafts'] as const) {
      if (scope === 'newerDrafts' ? newer : used(scopes[scope].de) || used(scopes[scope].en)) {
        result[scope].push({ translationKey: story.translationKey, title: story.title, locales: scopes[scope] });
      }
    }
  }
  return result;
}
