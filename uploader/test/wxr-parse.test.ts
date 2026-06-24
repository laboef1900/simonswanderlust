import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWxr } from '../src/wxr-parse.js';

const xml = readFileSync(join(process.cwd(), 'test/fixtures/wxr-sample.xml'), 'utf8');

describe('parseWxr', () => {
  it('extracts only published posts, paired DE/EN, with fields', () => {
    const { posts, attachments } = parseWxr(xml);
    expect(posts).toHaveLength(2); // the draft is excluded
    const de = posts.find((p) => p.locale === 'de')!;
    expect(de).toMatchObject({ group: 'pll_grp1', slug: 'rhodos-abenteuer', title: 'Rhodos Abenteuer', date: '2021-07-25', excerpt: 'Kurzfassung DE', thumbnailId: '100' });
    expect(de.contentHtml).toContain('<h2>Überschrift</h2>');
    expect(posts.find((p) => p.locale === 'en')!.slug).toBe('rhodes-adventure');
    expect(attachments.get('100')).toBe('https://wp.example/uploads/hero.jpg');
  });

  it('skips (not crashes) a published post that has a language but no post_translations group', () => {
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
    expect(() => parseWxr(noGroupWxr)).not.toThrow();
    expect(parseWxr(noGroupWxr).posts).toHaveLength(0);
  });
});
