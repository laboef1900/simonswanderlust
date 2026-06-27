import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importWxr } from '../src/wp-import.js';
import { memoryPostStore } from '../src/posts.js';

const xml = readFileSync(join(process.cwd(), 'test/fixtures/wxr-sample.xml'), 'utf8');
const stubRehost = async (_url: string, _key: string, _alt: string) => ({ src: 'https://img/x', width: 100, height: 80 });

describe('importWxr', () => {
  it('creates a draft pair with preserved slugs, placeholders, and re-hosted images', async () => {
    const store = memoryPostStore();
    const s = await importWxr(xml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: stubRehost });
    expect(s).toMatchObject({ imported: 1, updated: 0, skipped: 0 });
    const list = await store.list();
    const first = list[0]!;
    expect(first).toMatchObject({ slugDe: 'rhodos-abenteuer', slugEn: 'rhodes-adventure', status: 'draft' });
    const pair = await store.get(first.translationKey);
    expect(pair!.shared).toMatchObject({ date: '2021-07-25', country: '', countryCode: 'XX', region: 'europe' });
    expect(pair!.de.heroImage.src).toBe('https://img/x');
    expect(pair!.de.bodyMarkdown).toContain('## Überschrift');
    expect(pair!.de.bodyMarkdown).toContain('![Strand](https://img/x)'); // body image rewritten
    expect(pair!.de.images['https://img/x']).toEqual({ width: 100, height: 80 });
  });

  it('rewrites all occurrences of a duplicated body image ref', async () => {
    const dupXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <item>
    <title>Dup DE</title>
    <wp:post_name><![CDATA[dup-test]]></wp:post_name>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_date><![CDATA[2021-07-25 00:00:00]]></wp:post_date>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <content:encoded><![CDATA[<p>First</p><img src="https://wp/dup.jpg"><p>Second</p><img src="https://wp/dup.jpg">]]></content:encoded>
    <category domain="language" nicename="de"><![CDATA[Deutsch]]></category>
    <category domain="post_translations" nicename="pll_dup"><![CDATA[pll_dup]]></category>
  </item>
  <item>
    <title>Dup EN</title>
    <wp:post_name><![CDATA[dup-test-en]]></wp:post_name>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_date><![CDATA[2021-07-25 00:00:00]]></wp:post_date>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <content:encoded><![CDATA[<p>First</p><img src="https://wp/dup.jpg"><p>Second</p><img src="https://wp/dup.jpg">]]></content:encoded>
    <category domain="language" nicename="en"><![CDATA[English]]></category>
    <category domain="post_translations" nicename="pll_dup"><![CDATA[pll_dup]]></category>
  </item>
</channel>
</rss>`;
    const dupRehost = async (_url: string, _key: string, _alt: string) => ({ src: 'https://img/dup', width: 10, height: 10 });
    const store = memoryPostStore();
    await importWxr(dupXml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: dupRehost });
    const tk = (await store.list())[0]!.translationKey;
    const pair = await store.get(tk);
    const deBody = pair!.de.bodyMarkdown;
    // both occurrences rewritten
    expect(deBody.split('https://img/dup').length - 1).toBe(2);
    // no original WP URL remains
    expect(deBody).not.toContain('https://wp/dup.jpg');
  });

  it('skips a group whose slug is unsafe (path-traversal defense) without storing it', async () => {
    const evilXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <item>
    <title>Evil DE</title>
    <wp:post_name><![CDATA[../../../etc/evil]]></wp:post_name>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_date><![CDATA[2021-07-25 00:00:00]]></wp:post_date>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <content:encoded><![CDATA[<p>x</p>]]></content:encoded>
    <category domain="language" nicename="de"><![CDATA[Deutsch]]></category>
    <category domain="post_translations" nicename="pll_evil"><![CDATA[pll_evil]]></category>
  </item>
  <item>
    <title>Evil EN</title>
    <wp:post_name><![CDATA[ok-en]]></wp:post_name>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_date><![CDATA[2021-07-25 00:00:00]]></wp:post_date>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <content:encoded><![CDATA[<p>x</p>]]></content:encoded>
    <category domain="language" nicename="en"><![CDATA[English]]></category>
    <category domain="post_translations" nicename="pll_evil"><![CDATA[pll_evil]]></category>
  </item>
</channel>
</rss>`;
    const store = memoryPostStore();
    const rehostSpy = async () => { throw new Error('rehost must not be called for an unsafe slug'); };
    const s = await importWxr(evilXml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: rehostSpy });
    expect(s.imported).toBe(0);
    expect(s.skipped).toBe(1);
    expect(s.warnings.join(' ')).toMatch(/slug/i);
    expect(await store.list()).toHaveLength(0);
  });

  it('is idempotent (re-run updates, no duplicate) and skips published posts', async () => {
    const store = memoryPostStore();
    await importWxr(xml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: stubRehost });
    const again = await importWxr(xml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: stubRehost });
    expect(again).toMatchObject({ imported: 0, updated: 1 });
    expect(await store.list()).toHaveLength(1);
    // publish it, then re-import → skipped, content untouched
    const tk = (await store.list())[0]!.translationKey;
    await store.publish(tk);
    const third = await importWxr(xml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: stubRehost });
    expect(third.skipped).toBe(1);
    expect(third.warnings.join(' ')).toMatch(/published/);
  });
});
