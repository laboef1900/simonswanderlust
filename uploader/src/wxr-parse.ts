import { XMLParser } from 'fast-xml-parser';
import { DEFAULT_LANGUAGE, type LanguageConfig } from './language.js';

export interface ParsedPost {
  group: string; locale: 'de' | 'en'; slug: string; title: string;
  date: string; excerpt: string; contentHtml: string; thumbnailId: string | null;
}
export interface ParsedWxr {
  attachments: Map<string, string>;
  posts: ParsedPost[];
  skippedLocale: { slug: string; locale: string }[];
  rejected: { slug: string; reason: string }[];
}

type Node = Record<string, unknown>;
const cd = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'object') { const o = v as Node; return String(o.__cdata ?? o['#text'] ?? ''); }
  return String(v);
};
const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * The upload is not well-formed XML — an unclosed tag or CDATA (a truncated
 * download of a real export passes the route's `<rss` sniff), a bad DOCTYPE,
 * or fast-xml-parser's entity caps. The parser's own message names the byte
 * offset and quotes the surrounding text, so it stays in `cause` for the log;
 * the route answers 400 with this message (issue #143).
 */
export class WxrParseError extends Error {
  /** The parser's own message, for the log — never for the client. */
  readonly detail: string;
  constructor(cause: unknown) {
    super('export is not well-formed XML', { cause });
    this.name = 'WxrParseError';
    this.detail = cause instanceof Error ? cause.message : String(cause);
  }
}

export function parseWxr(xml: string, language: LanguageConfig = DEFAULT_LANGUAGE): ParsedWxr {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, cdataPropName: '__cdata', trimValues: true });
  let doc: { rss?: { channel?: { item?: unknown } } };
  try { doc = parser.parse(xml) as typeof doc; } catch (e) { throw new WxrParseError(e); }
  const items = arr(doc.rss?.channel?.item) as Node[];
  const attachments = new Map<string, string>();
  const posts: ParsedPost[] = [];
  const skippedLocale: ParsedWxr['skippedLocale'] = [];
  const rejected: ParsedWxr['rejected'] = [];
  for (const it of items) {
    const type = cd(it['wp:post_type']);
    if (type === 'attachment') {
      const id = cd(it['wp:post_id']); const url = cd(it['wp:attachment_url']);
      if (id && url) attachments.set(id, url);
      continue;
    }
    if (type !== 'post' || cd(it['wp:status']) !== 'publish') continue;
    const cats = arr(it.category) as Node[];
    const lang = cats.find((c) => c['@_domain'] === 'language')?.['@_nicename'];
    const translationGroup = cats.find((c) => c['@_domain'] === 'post_translations')?.['@_nicename'];
    const slug = cd(it['wp:post_name']);
    if (typeof lang === 'string' && lang !== '' && !language.locales.includes(lang as 'de' | 'en')) {
      skippedLocale.push({ slug, locale: lang });
      continue;
    }
    const tagged = (lang === 'de' || lang === 'en') && typeof translationGroup === 'string' && translationGroup !== '';
    const id = cd(it['wp:post_id']);
    if (!tagged && (language.locales.length !== 1 || !id)) {
      rejected.push({ slug, reason: language.locales.length !== 1 ? 'no language' : 'missing post id' });
      continue;
    }
    const locale = tagged ? lang : language.primary;
    const group = tagged ? translationGroup : `wp:${id}`;
    const metas = arr(it['wp:postmeta']) as Node[];
    const thumb = metas.find((m) => cd(m['wp:meta_key']) === '_thumbnail_id');
    posts.push({
      group, locale, slug, title: cd(it.title),
      date: cd(it['wp:post_date']).slice(0, 10), excerpt: cd(it['excerpt:encoded']),
      contentHtml: cd(it['content:encoded']),
      thumbnailId: thumb ? cd(thumb['wp:meta_value']) : null,
    });
  }
  return { attachments, posts, skippedLocale, rejected };
}
