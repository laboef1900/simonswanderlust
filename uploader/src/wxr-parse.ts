import { XMLParser } from 'fast-xml-parser';

export interface ParsedPost {
  group: string; locale: 'de' | 'en'; slug: string; title: string;
  date: string; excerpt: string; contentHtml: string; thumbnailId: string | null;
}
export interface ParsedWxr { attachments: Map<string, string>; posts: ParsedPost[] }

type Node = Record<string, unknown>;
const cd = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'object') { const o = v as Node; return String(o.__cdata ?? o['#text'] ?? ''); }
  return String(v);
};
const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function parseWxr(xml: string): ParsedWxr {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, cdataPropName: '__cdata', trimValues: true });
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: unknown } } };
  const items = arr(doc.rss?.channel?.item) as Node[];
  const attachments = new Map<string, string>();
  const posts: ParsedPost[] = [];
  for (const it of items) {
    const type = cd(it['wp:post_type']);
    if (type === 'attachment') {
      const id = cd(it['wp:post_id']); const url = cd(it['wp:attachment_url']);
      if (id && url) attachments.set(id, url);
      continue;
    }
    if (type !== 'post' || cd(it['wp:status']) !== 'publish') continue;
    const cats = arr(it.category) as Node[];
    const lang = cats.find((c) => c['@_domain'] === 'language')?.['@_nicename'] as string | undefined;
    const group = cats.find((c) => c['@_domain'] === 'post_translations')?.['@_nicename'] as string | undefined;
    if ((lang !== 'de' && lang !== 'en') || !group) continue;
    const metas = arr(it['wp:postmeta']) as Node[];
    const thumb = metas.find((m) => cd(m['wp:meta_key']) === '_thumbnail_id');
    posts.push({
      group, locale: lang, slug: cd(it['wp:post_name']), title: cd(it.title),
      date: cd(it['wp:post_date']).slice(0, 10), excerpt: cd(it['excerpt:encoded']),
      contentHtml: cd(it['content:encoded']),
      thumbnailId: thumb ? cd(thumb['wp:meta_value']) : null,
    });
  }
  return { attachments, posts };
}
