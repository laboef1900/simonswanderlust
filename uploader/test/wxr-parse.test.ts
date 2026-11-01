import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWxr, WxrParseError } from '../src/wxr-parse.js';

const xml = readFileSync(join(process.cwd(), 'test/fixtures/wxr-sample.xml'), 'utf8');

describe('parseWxr', () => {
  it('extracts only published posts, paired DE/EN, with fields', () => {
    const { posts, attachments, untranslated } = parseWxr(xml);
    expect(untranslated).toEqual([]);
    expect(posts).toHaveLength(2); // the draft is excluded
    const de = posts.find((p) => p.locale === 'de')!;
    expect(de).toMatchObject({ group: 'pll_grp1', slug: 'rhodos-abenteuer', title: 'Rhodos Abenteuer', date: '2021-07-25', excerpt: 'Kurzfassung DE', thumbnailId: '100' });
    expect(de.contentHtml).toContain('<h2>Überschrift</h2>');
    expect(posts.find((p) => p.locale === 'en')!.slug).toBe('rhodes-adventure');
    expect(attachments.get('100')).toBe('https://wp.example/uploads/hero.jpg');
  });

  it.each(['de', 'en'] as const)('keys untagged single-language posts by WordPress id in %s', (primary) => {
    const body = `<rss><channel><item><wp:post_type>post</wp:post_type><wp:status>publish</wp:status>
      <wp:post_id>123</wp:post_id><wp:post_name>story</wp:post_name><title>Story</title></item></channel></rss>`;
    expect(parseWxr(body, { primary, locales: [primary] }).posts).toMatchObject([
      { group: 'wp:123', locale: primary, slug: 'story' },
    ]);
    expect(parseWxr(body).rejected).toEqual([{ slug: 'story', reason: 'no language' }]);
  });

  it('reassembles adjacent CDATA sections without adding separators to scalar fields', () => {
    const split = 'left,]]]]><![CDATA[> middle\nline, ]]]]><![CDATA[>right';
    const source = `<rss><channel>${(['de', 'en'] as const).map((locale) => `<item>
      <wp:post_type>post</wp:post_type><wp:status>publish</wp:status>
      <category domain="language" nicename="${locale}"/>
      <category domain="post_translations" nicename="split"/>
      <wp:post_name>split-${locale}</wp:post_name>
      <title><![CDATA[${split}]]></title>
      <excerpt:encoded><![CDATA[${split}]]></excerpt:encoded>
      <content:encoded><![CDATA[<p>a[[x]]]]><![CDATA[>b</p>]]></content:encoded>
    </item>`).join('')}</channel></rss>`;
    expect(parseWxr(source).posts.map(({ locale, title, excerpt, contentHtml }) =>
      ({ locale, title, excerpt, contentHtml }))).toEqual(['de', 'en'].map((locale) => ({
      locale, title: 'left,]]> middle\nline, ]]>right',
      excerpt: 'left,]]> middle\nline, ]]>right', contentHtml: '<p>a[[x]]>b</p>',
    })));
  });

  it.each([
    ['<![CDATA[One, uninterrupted\nsection]]>', 'One, uninterrupted\nsection'],
    ['Ordinary &amp; text', 'Ordinary & text'],
    ['<![CDATA[]]>', ''],
    ['', ''],
  ])('preserves scalar field decoding for %s', (field, expected) => {
    const source = `<rss><channel><item>
      <wp:post_type>post</wp:post_type><wp:status>publish</wp:status>
      <category domain="language" nicename="de"/>
      <category domain="post_translations" nicename="scalar"/>
      <wp:post_name>scalar</wp:post_name><title>${field}</title>
      <content:encoded>${field}</content:encoded>
    </item></channel></rss>`;
    expect(parseWxr(source).posts[0]).toMatchObject({
      title: expected, contentHtml: expected, excerpt: '', thumbnailId: null,
    });
  });

  it('reports a published known-language post without a translation group separately', () => {
    const noGroupWxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <item>
      <title>Non-bilingual post</title>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:status><![CDATA[publish]]></wp:status>
      <wp:post_name><![CDATA[non-bilingual-post]]></wp:post_name>
      <wp:post_date><![CDATA[2021-08-01 10:00:00]]></wp:post_date>
      <category domain="language" nicename="de"><![CDATA[Deutsch]]></category>
    </item>
  </channel>
</rss>`;
    expect(parseWxr(noGroupWxr)).toEqual({
      posts: [], attachments: new Map(), skippedLocale: [], rejected: [],
      untranslated: [{ locale: 'de', slug: 'non-bilingual-post' }],
    });
  });

  it('reports absent or empty groups individually, preserving decoded slug text without requiring IDs', () => {
    const slugs = ['g1', 'g1', 'Ä-%2F-<b>{locale}$&</b>'];
    const items = slugs.map((slug, index) => `<item>
      <wp:post_type>post</wp:post_type><wp:status>publish</wp:status>
      <wp:post_name><![CDATA[${slug}]]></wp:post_name>
      <category domain="language" nicename="${index === 1 ? 'en' : 'de'}"/>
      ${index ? '<category domain="post_translations" nicename=""/>' : ''}
    </item>`).join('');
    expect(parseWxr(`<rss><channel>${items}</channel></rss>`)).toEqual({
      posts: [], attachments: new Map(), skippedLocale: [], rejected: [],
      untranslated: slugs.map((slug, index) => ({ locale: index === 1 ? 'en' : 'de', slug })),
    });
  });

  it.each([
    ['post', 'draft', 'de'],
    ['post', 'private', 'en'],
    ['page', 'publish', 'de'],
    ['attachment', 'publish', 'en'],
    ['post', 'publish', 'fr'],
    ['post', 'publish', ''],
  ])('excludes %s / %s / language %s from both post collections', (type, status, locale) => {
    for (const group of ['', '<category domain="post_translations" nicename="g1"/>']) {
      const parsed = parseWxr(`<rss><channel><item>
        <wp:post_type>${type}</wp:post_type><wp:status>${status}</wp:status>
        <wp:post_name>excluded</wp:post_name>
        ${locale ? `<category domain="language" nicename="${locale}"/>` : ''}
        ${group}
      </item></channel></rss>`);
      expect(parsed.posts).toEqual([]);
      expect(parsed.untranslated).toEqual([]);
    }
  });

  // Issue #143: the parser's own throws (a truncated download cuts a CDATA or
  // a tag; a bad DOCTYPE; the entity caps) were plain Errors that reached the
  // global handler as a 500. They are one typed error with a fixed message and
  // the parser's detail kept aside for the log.
  it('throws WxrParseError for a truncated export, a malformed DOCTYPE or the entity cap, detail kept off the message', () => {
    const truncated = xml.slice(0, Math.floor(xml.length / 2));
    const entityBomb = `<!DOCTYPE r [${Array.from({ length: 2000 }, (_, i) => `<!ENTITY e${i} "x">`).join('')}]><rss/>`;
    for (const bad of [truncated, '<!DOCTYPE rss [<!ELEMENT>]><rss/>', '<rss version="2.0><channel/></rss>', entityBomb]) {
      let caught: unknown;
      try { parseWxr(bad); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(WxrParseError);
      expect((caught as WxrParseError).message).toBe('export is not well-formed XML');
      expect((caught as WxrParseError).detail).not.toBe('');
    }
  });
});
