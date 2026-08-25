import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { importWxr, type ImportDeps } from '../src/wp-import.js';
import { memoryPostStore, type PostStore } from '../src/posts.js';
import { createRehostResume, rehostImage, type RehostResult } from '../src/wp-images.js';
import { FetchError } from '../src/safe-fetch.js';

const xml = readFileSync(join(process.cwd(), 'test/fixtures/wxr-sample.xml'), 'utf8');
const stubRehost = async (_url: string, _key: string, _alt: string) => ({ src: 'https://img/x', width: 100, height: 80 });

// ---- WXR builders for the hardening suites (issue #85) -------------------
// Deliberately WITHOUT a `_thumbnail_id`, so every fetch in these tests is a
// body image: the hero slot is never resumed (see wp-images.test.ts) and would
// otherwise add an untracked fetch to every assertion.

const wxr = (items: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
${items}
</channel>
</rss>`;

const item = (loc: 'de' | 'en', slug: string, group: string, html: string): string => `  <item>
    <title>${slug}</title>
    <wp:post_name><![CDATA[${slug}]]></wp:post_name>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_date><![CDATA[2021-07-25 00:00:00]]></wp:post_date>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <content:encoded><![CDATA[${html}]]></content:encoded>
    <category domain="language" nicename="${loc}"><![CDATA[${loc}]]></category>
    <category domain="post_translations" nicename="${group}"><![CDATA[${group}]]></category>
  </item>`;

const imgs = (...urls: string[]): string => urls.map((u) => `<img src="${u}" alt="a" />`).join('');

const pairOf = (
  group: string, deSlug: string, enSlug: string, deHtml: string, enHtml = '<p>x</p>',
): string => wxr(`${item('de', deSlug, group, deHtml)}\n${item('en', enSlug, group, enHtml)}`);

/** A pair WITH a featured image, so the hero slot is exercised. */
const pairWithHero = (heroUrl: string, deImgs: string[]): string => wxr([
  `  <item>
    <title>hero</title>
    <wp:post_id><![CDATA[900]]></wp:post_id>
    <wp:post_type><![CDATA[attachment]]></wp:post_type>
    <wp:status><![CDATA[inherit]]></wp:status>
    <wp:attachment_url><![CDATA[${heroUrl}]]></wp:attachment_url>
  </item>`,
  item('de', 'de-1', 'gh', imgs(...deImgs)).replace(
    '\n  </item>',
    '\n    <wp:postmeta><wp:meta_key><![CDATA[_thumbnail_id]]></wp:meta_key><wp:meta_value><![CDATA[900]]></wp:meta_value></wp:postmeta>\n  </item>',
  ),
  item('en', 'en-1', 'gh', '<p>x</p>'),
].join('\n'));

/**
 * A fake clock, a recording `sleep`, and a scriptable `rehost`.
 *
 * `sleep` advances the clock, so the elapsed gate composes exactly as it does in
 * production. No fake timers: there is one `vi.useFakeTimers()` in this whole
 * tree and nothing keeps real fs/sharp/pg work ticking under it.
 */
function harness(opts: { fail?: (url: string, attempt: number) => unknown; costMs?: number } = {}) {
  const order: string[] = [];
  const calls: string[] = [];
  const keys: string[] = [];
  const sleeps: number[] = [];
  const attempts = new Map<string, number>();
  let clock = 0;
  return {
    order, calls, keys, sleeps,
    now: () => clock,
    sleep: async (ms: number) => { order.push(`sleep:${ms}`); sleeps.push(ms); clock += ms; },
    rehost: async (url: string, key: string, _alt: string): Promise<RehostResult> => {
      const n = attempts.get(url) ?? 0;
      attempts.set(url, n + 1);
      order.push(`fetch:${url}`);
      calls.push(url);
      keys.push(key);
      clock += opts.costMs ?? 0;
      const err = opts.fail?.(url, n);
      if (err) throw err;
      return { src: `https://img/${key}`, width: 100, height: 80 };
    },
  };
}

const run = (
  body: string, h: ReturnType<typeof harness>, extra: Partial<ImportDeps> = {}, store: PostStore = memoryPostStore(),
) => importWxr(body, {
  postStore: store, storageDir: '/tmp', baseUrl: 'https://img',
  rehost: h.rehost, sleep: h.sleep, now: h.now, delayMs: 0, retries: 0, ...extra,
});

describe('importWxr', () => {
  it('creates a draft pair with preserved slugs, placeholders, and re-hosted images', async () => {
    const store = memoryPostStore();
    const s = await importWxr(xml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: stubRehost });
    expect(s).toMatchObject({ imported: 1, updated: 0, skippedPublished: 0, rejected: 0, failed: 0 });
    const list = await store.list();
    const first = list[0]!;
    expect(first).toMatchObject({ slugDe: 'rhodos-abenteuer', slugEn: 'rhodes-adventure', status: 'draft' });
    const pair = await store.get(first.translationKey);
    expect(pair!.shared).toMatchObject({ date: '2021-07-25', countryCode: 'XX', region: 'europe' });
    // country is per-locale and left blank for the author to fill in per language.
    expect(pair!.de.country).toBe('');
    expect(pair!.en.country).toBe('');
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

  it('re-hosts every photo of an Elementor gallery and keeps its lightbox title as alt', async () => {
    const anchor = (href: string, title: string) =>
      `<a href="${href}" data-elementor-open-lightbox="yes" data-elementor-lightbox-slideshow="g1" data-elementor-lightbox-title="${title}"></a>`;
    const body = `<p>Intro</p>${anchor('https://wp/one.jpg', 'Hoatzin')}${anchor('https://wp/two.jpg', 'Kingfisher')}`;
    const galleryXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
${['de', 'en']
  .map(
    (loc) => `  <item>
    <title>Gal ${loc}</title>
    <wp:post_name><![CDATA[gal-${loc}]]></wp:post_name>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_date><![CDATA[2021-07-25 00:00:00]]></wp:post_date>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <content:encoded><![CDATA[${body}]]></content:encoded>
    <category domain="language" nicename="${loc}"><![CDATA[${loc}]]></category>
    <category domain="post_translations" nicename="pll_gal"><![CDATA[pll_gal]]></category>
  </item>`,
  )
  .join('\n')}
</channel>
</rss>`;
    const seen: string[] = [];
    const rehost = async (url: string, _key: string, _alt: string) => {
      seen.push(url);
      return { src: `https://img/${url.endsWith('one.jpg') ? 'one' : 'two'}`, width: 640, height: 480 };
    };
    const store = memoryPostStore();
    await importWxr(galleryXml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost });

    // a photo shared by both translations is fetched and encoded ONCE
    expect(seen.filter((u) => u === 'https://wp/one.jpg')).toHaveLength(1);
    expect(seen.filter((u) => u === 'https://wp/two.jpg')).toHaveLength(1);

    const pair = (await store.get((await store.list())[0]!.translationKey))!;
    const de = pair.de.bodyMarkdown;
    expect(de).not.toContain('https://wp/');            // no WordPress URL survives
    expect(de).toContain('```gallery\nhttps://img/one\nhttps://img/two\n```'); // normalized to bare URLs
    expect(pair.de.images['https://img/one']).toEqual({ width: 640, height: 480, alt: 'Hoatzin' });
    expect(pair.de.images['https://img/two']).toEqual({ width: 640, height: 480, alt: 'Kingfisher' });
    // ...and both locales point at that single copy
    expect(pair.en.bodyMarkdown).toContain('```gallery\nhttps://img/one\nhttps://img/two\n```');
    expect(pair.en.images['https://img/one']).toEqual({ width: 640, height: 480, alt: 'Hoatzin' });
  });

  it('stores a shared photo under one key, taken from the locale processed first', async () => {
    const anchor = (href: string) =>
      `<a href="${href}" data-elementor-lightbox-slideshow="g1" data-elementor-lightbox-title="t"></a>`;
    const xmlPair = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
${['de', 'en']
  .map(
    (loc) => `  <item>
    <title>K ${loc}</title>
    <wp:post_name><![CDATA[key-${loc}]]></wp:post_name>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_date><![CDATA[2021-07-25 00:00:00]]></wp:post_date>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <content:encoded><![CDATA[${anchor('https://wp/shared.jpg')}]]></content:encoded>
    <category domain="language" nicename="${loc}"><![CDATA[${loc}]]></category>
    <category domain="post_translations" nicename="pll_k"><![CDATA[pll_k]]></category>
  </item>`,
  )
  .join('\n')}
</channel>
</rss>`;
    const keys: string[] = [];
    const store = memoryPostStore();
    await importWxr(xmlPair, {
      postStore: store, storageDir: '/tmp', baseUrl: 'https://img',
      rehost: async (_u, key) => { keys.push(key); return { src: 'https://img/s', width: 1, height: 1 }; },
    });
    expect(keys).toEqual(['trips/key-de/shared']);
  });

  it('rejects a group whose slug is unsafe (path-traversal defense) without storing it', async () => {
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
    expect(s).toMatchObject({ updated: 0, skippedPublished: 0, rejected: 1, failed: 0 });
    expect(s.warnings.join(' ')).toMatch(/slug/i);
    expect(await store.list()).toHaveLength(0);
  });

  it('is idempotent (re-run updates, no duplicate) and skips published posts', async () => {
    const store = memoryPostStore();
    await importWxr(xml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: stubRehost });
    const again = await importWxr(xml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: stubRehost });
    expect(again).toMatchObject({ imported: 0, updated: 1, skippedPublished: 0, rejected: 0, failed: 0 });
    expect(await store.list()).toHaveLength(1);
    // publish it, then re-import → skippedPublished, content untouched
    const tk = (await store.list())[0]!.translationKey;
    await store.publish(tk);
    const third = await importWxr(xml, { postStore: store, storageDir: '/tmp', baseUrl: 'https://img', rehost: stubRehost });
    expect(third).toMatchObject({ imported: 0, updated: 0, skippedPublished: 1, rejected: 0, failed: 0 });
    expect(third.warnings.join(' ')).toMatch(/published/);
  });
});

/**
 * Issue #85: throttle, bounded retry, honest accounting, resumability.
 *
 * @ai-context docs/superpowers/specs/2026-07-30-wxr-import-hardening-design.md
 */
describe('importWxr pacing', () => {
  it('spaces distinct fetches by the delay, and never sleeps before the first', async () => {
    const h = harness();
    await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg', 'https://wp/b.jpg', 'https://wp/c.jpg')), h, { delayMs: 1200 });
    expect(h.order).toEqual([
      'fetch:https://wp/a.jpg', 'sleep:1200',
      'fetch:https://wp/b.jpg', 'sleep:1200',
      'fetch:https://wp/c.jpg',
    ]);
  });

  // sharedRehost dedups by URL within a pair, and the gate sits BELOW it. The
  // 2026-06-24 export was ~650 photos arriving as 1,338 calls; pacing above the
  // memo would sleep 1,338 times for 665 fetches.
  it('does not pace a photo the other locale already fetched', async () => {
    const h = harness();
    await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg'), imgs('https://wp/a.jpg')), h, { delayMs: 1200 });
    expect(h.order).toEqual(['fetch:https://wp/a.jpg']);
    expect(h.calls).toEqual(['https://wp/a.jpg']);
  });

  // An elapsed gate, not a flat sleep: a fetch+encode that already took longer
  // than the delay has satisfied it, so the throttle costs nothing.
  it('charges nothing when the fetch itself outlasted the delay', async () => {
    const h = harness({ costMs: 5000 });
    await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg', 'https://wp/b.jpg')), h, { delayMs: 1200 });
    expect(h.sleeps).toEqual([]);
  });
});

describe('importWxr retry', () => {
  const network = () => new FetchError('request failed for x: socket hang up', 'network');

  it('retries a transient failure with the documented backoff, then succeeds', async () => {
    const h = harness({ fail: (_u, attempt) => (attempt < 2 ? network() : null) });
    const s = await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg')), h, { retries: 3 });
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([5000, 15000]);
    expect(s.images).toEqual({ total: 1, hosted: 1, failed: 0 });
  });

  it('does not retry the SSRF guard, a bad URL, or an oversized response', async () => {
    for (const kind of ['blocked', 'invalid-url', 'too-large'] as const) {
      const h = harness({ fail: () => new FetchError('nope', kind) });
      const s = await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg')), h, { retries: 3 });
      expect(h.calls, kind).toHaveLength(1);
      expect(h.sleeps, kind).toEqual([]);
      expect(s.images, kind).toEqual({ total: 1, hosted: 0, failed: 1 });
    }
  });

  it('does not retry a permanently dead host', async () => {
    const h = harness({ fail: () => new FetchError('request failed for x: getaddrinfo', 'network', { code: 'ENOTFOUND' }) });
    await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg')), h, { retries: 3 });
    expect(h.calls).toHaveLength(1);
  });

  it('retries a 429 and a 5xx but not a 404', async () => {
    for (const [status, expected] of [[429, 2], [503, 2], [404, 1]] as const) {
      const h = harness({ fail: (_u, attempt) => (attempt < 1 ? new FetchError('x', 'http', { status }) : null) });
      await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg')), h, { retries: 3 });
      expect(h.calls, String(status)).toHaveLength(expected);
    }
  });

  // processImage and storeVariants throw plain Errors. sharp runs with
  // failOn:'none' and 2+2x|widths| pipelines per image inside a 4608 MiB
  // container, so re-decoding the same hostile buffer is amplification, not
  // recovery. Only the FETCH is retried.
  it('never retries a non-fetch failure such as a decode or a full disk', async () => {
    const h = harness({ fail: () => new Error('Input buffer contains unsupported image format') });
    await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg')), h, { retries: 3 });
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  // @ai-warning sharedRehost stores the PROMISE before awaiting and never
  // deletes it on rejection, so it memoises rejections. Retry must stay BELOW
  // it or the second locale gets the settled rejection instantly while the
  // first burns the full backoff, and both report the same failure.
  it('retries once per pair, not once per locale, and reports one failure', async () => {
    const h = harness({ fail: () => network() });
    const s = await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg'), imgs('https://wp/a.jpg')), h, { retries: 3 });
    expect(h.calls).toHaveLength(4); // 1 + 3 retries, not 8
    expect(s.images).toEqual({ total: 1, hosted: 0, failed: 1 });
    expect(s.warnings.filter((w) => w.includes('https://wp/a.jpg'))).toHaveLength(1);
  });
});

describe('importWxr blast-radius bounds', () => {
  const network = () => new FetchError('boom', 'network');

  // Bounds RETRIES, not first attempts: first attempts are the legitimate work
  // (one per distinct image) and capping them would break a large export.
  it('stops retrying once the retry budget is spent, but keeps first attempts', async () => {
    const h = harness({ fail: () => network() });
    const s = await run(
      pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg', 'https://wp/b.jpg', 'https://wp/c.jpg')),
      h, { retries: 3, retryBudget: 2 },
    );
    // 3 first attempts + exactly 2 retries anywhere
    expect(h.calls).toHaveLength(5);
    expect(s.images).toEqual({ total: 3, hosted: 0, failed: 3 });
    expect(s.warnings.join(' ')).toMatch(/retry budget/i);
  });

  it('stops fetching a host after too many consecutive failures', async () => {
    const h = harness({ fail: (u) => (u.includes('dead') ? network() : null) });
    const urls = [1, 2, 3, 4, 5].map((n) => `https://dead/${n}.jpg`);
    const s = await run(
      pairOf('g', 'de-1', 'en-1', imgs(...urls, 'https://live/ok.jpg')), h,
      { retries: 0, hostFailureLimit: 3 },
    );
    // 3 attempts against the dead host, then it is abandoned; the other host is untouched.
    expect(h.calls.filter((u) => u.includes('dead'))).toHaveLength(3);
    expect(h.calls).toContain('https://live/ok.jpg');
    expect(s.images).toEqual({ total: 6, hosted: 1, failed: 5 });
    expect(s.warnings.join(' ')).toMatch(/consecutive failures/i);
  });

  // The reset is what this pins, so the failure run must be long enough to trip
  // the breaker if the reset were removed: fail, fail, SUCCEED, fail, fail with a
  // limit of 3 must fetch all five. Without the reset the counter reaches 3 on
  // the fourth URL and the fifth is never attempted.
  it('forgives a host that recovers', async () => {
    let n = 0;
    const h = harness({ fail: () => (++n === 3 ? null : network()) });
    const urls = ['a', 'b', 'c', 'd', 'e'].map((x) => `https://wp/${x}.jpg`);
    await run(pairOf('g', 'de-1', 'en-1', imgs(...urls)), h, { retries: 0, hostFailureLimit: 3 });
    expect(h.calls).toHaveLength(5);
  });

  /**
   * @ai-warning The breaker exists to notice "this host is refusing us", so only
   * a HOST-SHAPED failure may count toward it. A 404, an oversized response, an
   * unusable URL, a sharp decode failure or an ENOSPC on our own /data are facts
   * about one resource (or about us), not about the host.
   *
   * Counting them is not a cosmetic mistake: a trip whose photos were deleted
   * from the WordPress media library is a contiguous run of 404s, which abandons
   * a perfectly healthy host and leaves every later trip's photos un-fetched.
   * And because the run of 404s repeats identically on the next import, the
   * breaker trips at the same point every time — so re-running, the recovery
   * action this whole feature is built around, can never converge.
   */
  it('does not blame the host for individual photos that are simply gone', async () => {
    const dead = (u: string) => (u.includes('dead') ? new FetchError('x', 'http', { status: 404 }) : null);
    const h = harness({ fail: dead });
    const body = wxr([
      item('de', 'de-1', 'g1', imgs('https://wp/ok1.jpg')),
      item('en', 'en-1', 'g1', '<p>x</p>'),
      item('de', 'de-2', 'g2', imgs(...[1, 2, 3, 4, 5].map((n) => `https://wp/dead${n}.jpg`))),
      item('en', 'en-2', 'g2', '<p>x</p>'),
      item('de', 'de-3', 'g3', imgs('https://wp/ok2.jpg', 'https://wp/ok3.jpg')),
      item('en', 'en-3', 'g3', '<p>x</p>'),
    ].join('\n'));
    const s = await run(body, h, { retries: 0, hostFailureLimit: 3 });
    // The healthy photos of the LAST trip must still be fetched.
    expect(h.calls).toContain('https://wp/ok2.jpg');
    expect(h.calls).toContain('https://wp/ok3.jpg');
    expect(s.images).toEqual({ total: 8, hosted: 3, failed: 5 });
  });

  it('does not blame the host for a decode failure on our side', async () => {
    const h = harness({ fail: (u) => (u.includes('bad') ? new Error('unsupported image format') : null) });
    const urls = [...[1, 2, 3, 4].map((n) => `https://wp/bad${n}.jpg`), 'https://wp/good.jpg'];
    const h2 = await run(pairOf('g', 'de-1', 'en-1', imgs(...urls)), h, { retries: 0, hostFailureLimit: 3 });
    expect(h.calls).toContain('https://wp/good.jpg');
    expect(h2.images).toEqual({ total: 5, hosted: 1, failed: 4 });
  });

  // Both bounds truncate work, so both must be traceable in BOTH channels — the
  // response can drop them to the cap, the log cannot.
  it('logs the retry-budget notice, not only appends it to a capped list', async () => {
    const logged: string[] = [];
    const h = harness({ fail: () => network() });
    const urls = Array.from({ length: 6 }, (_, i) => `https://dead/p${i}.jpg`);
    // hostFailureLimit high enough that the breaker cannot fire first and mask it.
    await run(pairOf('g', 'de-1', 'en-1', imgs(...urls)), h,
      { retries: 3, retryBudget: 2, hostFailureLimit: 999, log: (m) => logged.push(m) });
    expect(logged.join('\n')).toMatch(/retry budget/i);
  });

  it('logs the host-breaker notice', async () => {
    const logged: string[] = [];
    const h = harness({ fail: () => network() });
    const urls = Array.from({ length: 6 }, (_, i) => `https://dead/p${i}.jpg`);
    await run(pairOf('g', 'de-1', 'en-1', imgs(...urls)), h,
      { retries: 0, hostFailureLimit: 3, log: (m) => logged.push(m) });
    expect(logged.join('\n')).toMatch(/stopped fetching dead after 3 consecutive failures/i);
  });

  it('keeps the truncation notices in the response even when the cap is reached', async () => {
    const h = harness({ fail: () => network() });
    const urls = Array.from({ length: 260 }, (_, i) => `https://dead/p${i}.jpg`);
    const s = await run(pairOf('g', 'de-1', 'en-1', imgs(...urls)), h,
      { retries: 0, hostFailureLimit: 3, log: () => {} });
    // "stopped fetching <host>" is the NOTICE. The per-image warnings happen to
    // share the phrase "consecutive failures", so matching that would pass even
    // with the notice dropped.
    expect(s.warnings.join(' ')).toMatch(/stopped fetching/i);
  });
});

describe('importWxr reporting', () => {
  it('counts distinct photos per pair, so hosted + failed === total', async () => {
    const h = harness({ fail: (u) => (u.includes('b.jpg') ? new FetchError('x', 'blocked') : null) });
    const s = await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg', 'https://wp/b.jpg'), imgs('https://wp/a.jpg')), h);
    expect(s.images).toEqual({ total: 2, hosted: 1, failed: 1 });
  });

  // Two trips sharing a photo each get their own copy under their own slug, so
  // the count is per (pair, url). This is wp-import.ts's pair-scoping warning.
  it('counts and fetches a shared photo once per trip', async () => {
    const h = harness();
    const body = wxr([
      item('de', 'de-1', 'g1', imgs('https://wp/shared.jpg')),
      item('en', 'en-1', 'g1', '<p>x</p>'),
      item('de', 'de-2', 'g2', imgs('https://wp/shared.jpg')),
      item('en', 'en-2', 'g2', '<p>x</p>'),
    ].join('\n'));
    const s = await run(body, h);
    expect(s.images).toEqual({ total: 2, hosted: 2, failed: 0 });
    expect(h.calls).toEqual(['https://wp/shared.jpg', 'https://wp/shared.jpg']);
    expect(h.keys).toEqual(['trips/de-1/shared', 'trips/de-2/shared']);
  });

  // CLAUDE.md: never return raw infrastructure errors. isBlockedHost does not
  // block RFC1918, so today's warnings hand a non-admin author a working
  // network-mapping oracle. The response gets a stable reason; detail goes to stdout.
  it('reports a stable reason to the author and the detail only to the log', async () => {
    const logged: string[] = [];
    const h = harness({
      fail: () => new FetchError('request failed for http://10.0.0.5:8080/x: connect ECONNREFUSED 10.0.0.5:8080', 'network', { code: 'ECONNREFUSED' }),
    });
    const s = await run(pairOf('g', 'de-1', 'en-1', imgs('http://10.0.0.5:8080/x.jpg')), h, { log: (m) => logged.push(m) });
    const joined = s.warnings.join(' ');
    expect(joined).not.toMatch(/ECONNREFUSED/);
    expect(joined).toMatch(/network error/);
    expect(logged.join(' ')).toMatch(/ECONNREFUSED/);
  });

  it('caps the warning list instead of returning one string per dead photo', async () => {
    const h = harness({ fail: () => new FetchError('x', 'blocked') });
    const urls = Array.from({ length: 240 }, (_, i) => `https://wp/p${i}.jpg`);
    const s = await run(pairOf('g', 'de-1', 'en-1', imgs(...urls)), h);
    expect(s.images.failed).toBe(240);
    expect(s.warnings.length).toBeLessThanOrEqual(201);
    expect(s.warnings[s.warnings.length - 1]).toMatch(/and \d+ more/);
  });

  // issue #100: one bucket per outcome. "Already published" is a success, a
  // rejected slug is the path-traversal defence firing, and a thrown upsert is
  // a failure — none may share a counter with the others. Every group lands in
  // exactly one bucket, so the buckets sum to the group count.
  it('gives each outcome its own bucket, so the buckets sum to the group count', async () => {
    const h = harness();
    const body = wxr([
      // g1: complete and new → imported.
      item('de', 'de-1', 'g1', '<p>a</p>'),
      item('en', 'en-1', 'g1', '<p>a</p>'),
      // g2: no en translation → rejected.
      item('de', 'de-2', 'g2', '<p>b</p>'),
      // g3: path-traversal slug → rejected.
      item('de', '../evil', 'g3', '<p>c</p>'),
      item('en', 'en-3', 'g3', '<p>c</p>'),
      // g4: new, but the store refuses the write → failed.
      item('de', 'de-4', 'g4', '<p>d</p>'),
      item('en', 'en-4', 'g4', '<p>d</p>'),
    ].join('\n'));
    const ok = memoryPostStore();
    const refusing: PostStore = {
      ...ok,
      upsertDraft: (pair, baseUpdatedAt) =>
        (pair.de.slug === 'de-4' ? Promise.reject(new Error('disk full')) : ok.upsertDraft(pair, baseUpdatedAt)),
    };
    const s = await run(body, h, {}, refusing);
    expect(s).toMatchObject({ imported: 1, updated: 0, skippedPublished: 0, rejected: 2, failed: 1 });
    expect(s.imported + s.updated + s.skippedPublished + s.rejected + s.failed).toBe(4);
    // the buckets are honest: the store holds only the imported group.
    expect((await refusing.list()).map((x) => x.slugDe)).toEqual(['de-1']);
  });

  it('logs the summary, because on a real export nobody receives the response', async () => {
    const logged: string[] = [];
    const h = harness();
    await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg')), h, { log: (m) => logged.push(m) });
    expect(logged.join('\n')).toMatch(/imported=1.*images=1\/1/s);
  });
});

describe('importWxr layering', () => {
  const network = () => new FetchError('boom', 'network');

  /**
   * @ai-warning The gate lives INSIDE the retry loop, so every network attempt is
   * paced and `nextAt` stays accurate. Moving it outside changes this order to
   * ['fetch:a','sleep:5000','fetch:a','fetch:b'] — the single gate entry for `a`
   * sets nextAt to t+1200, the 5 s backoff overshoots it, and `b` then fires with
   * no spacing at all. This assertion is the only thing distinguishing the two.
   */
  it('gates every attempt, not just the first of each image', async () => {
    const h = harness({ fail: (u, attempt) => (u.includes('a.jpg') && attempt < 1 ? network() : null) });
    await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg', 'https://wp/b.jpg')), h,
      { delayMs: 1200, retries: 1 });
    expect(h.order).toEqual([
      'fetch:https://wp/a.jpg', 'sleep:5000',
      'fetch:https://wp/a.jpg', 'sleep:1200',
      'fetch:https://wp/b.jpg',
    ]);
  });

  /**
   * Invariant: the SSRF guard runs on EVERY attempt. `assertFetchableUrl` is
   * called inside `safeFetch` and builds a fresh `URL`, which `safeFetch` passes
   * straight to `fetch` — so a distinct instance per call is exactly the
   * "not hoisted out of the retry loop" property. Uses the REAL safeFetch.
   */
  it('re-validates the URL through safeFetch on every retry attempt', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'wprevalidate-'));
    const baseUrl = 'https://img.example';
    const jpg = await sharp({ create: { width: 700, height: 500, channels: 3, background: '#345' } }).jpeg().toBuffer();
    const seen: unknown[] = [];
    let n = 0;
    const fetchImpl = (async (u: URL | string) => {
      seen.push(u);
      return ++n < 3 ? new Response('busy', { status: 503 }) : new Response(new Uint8Array(jpg));
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const s = await importWxr(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg')), {
      postStore: memoryPostStore(), storageDir, baseUrl,
      rehost: (url, key, alt) => rehostImage(url, key, alt, { storageDir, baseUrl, fetchImpl }),
      delayMs: 0, retries: 2, sleep: async (ms) => { sleeps.push(ms); }, log: () => {},
    });
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(sleeps).toEqual([5000, 15000]); // a real 503 is retryable
    expect(s.images).toEqual({ total: 1, hosted: 1, failed: 0 });
  });
});

describe('importWxr resumability', () => {
  it('skips a photo the resume index already has, without fetching or pacing', async () => {
    const h = harness();
    const resume = { lookup: async (key: string) => (key.endsWith('/a') ? { src: 'https://img/kept', width: 12, height: 34 } : null) };
    const s = await run(pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg', 'https://wp/b.jpg')), h, { resume, delayMs: 1200 });
    expect(h.calls).toEqual(['https://wp/b.jpg']);
    expect(h.order).toEqual(['fetch:https://wp/b.jpg']); // no sleep for the resumed one
    expect(s.images).toEqual({ total: 2, hosted: 2, failed: 0 });
  });

  /**
   * @ai-warning This is the ONLY thing tying `trips/<slug>/hero` (wp-import.ts)
   * to `HERO_KEY_RE` (wp-images.ts). The two modules must agree or the hero
   * silently becomes resumable, and changing a post's featured image in
   * WordPress would then keep the old photo forever.
   */
  it('always re-fetches the hero, whose key encodes no url identity', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'wphero-'));
    const baseUrl = 'https://img.example';
    const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#345' } }).jpeg().toBuffer();
    const calls: string[] = [];
    const fetchImpl = (async (u: URL | string) => {
      calls.push(String(u));
      return new Response(new Uint8Array(jpg));
    }) as unknown as typeof fetch;
    const store = memoryPostStore();
    const deps = async (): Promise<ImportDeps> => ({
      postStore: store, storageDir, baseUrl,
      rehost: (url, key, alt) => rehostImage(url, key, alt, { storageDir, baseUrl, fetchImpl }),
      resume: await createRehostResume({ storageDir, baseUrl }),
      delayMs: 0, retries: 0, log: () => {},
    });
    const body = pairWithHero('https://wp/hero.jpg', ['https://wp/a.jpg']);

    await importWxr(body, await deps());
    expect([...calls].sort()).toEqual(['https://wp/a.jpg', 'https://wp/hero.jpg']);

    calls.length = 0;
    await importWxr(body, await deps());
    // The body image resumes from disk; the hero does not.
    expect(calls).toEqual(['https://wp/hero.jpg']);
  });

  // The real thing: two runs against one storageDir, real rehostImage, real
  // createRehostResume, a stub fetchImpl serving a generated JPEG. This is the
  // kill-and-resume proof — everything else here uses a fake index.
  it('re-fetches only what failed when the whole import is re-run', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'wpresume-'));
    const baseUrl = 'https://img.example';
    const jpeg = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#345' } }).jpeg().toBuffer();
    const calls: string[] = [];
    let cFails = true;
    const fetchImpl = (async (u: URL | string) => {
      const url = String(u);
      calls.push(url);
      if (cFails && url.endsWith('c.jpg')) return new Response('gone', { status: 503 });
      return new Response(new Uint8Array(jpeg));
    }) as unknown as typeof fetch;

    const store = memoryPostStore();
    const deps = async (): Promise<ImportDeps> => ({
      postStore: store, storageDir, baseUrl,
      rehost: (url, key, alt) => rehostImage(url, key, alt, { storageDir, baseUrl, fetchImpl }),
      resume: await createRehostResume({ storageDir, baseUrl }),
      delayMs: 0, retries: 0, log: () => {},
    });
    const body = pairOf('g', 'de-1', 'en-1', imgs('https://wp/a.jpg', 'https://wp/b.jpg', 'https://wp/c.jpg'));

    const first = await importWxr(body, await deps());
    expect(first.images).toEqual({ total: 3, hosted: 2, failed: 1 });
    expect(calls).toHaveLength(3);

    calls.length = 0;
    cFails = false;
    const second = await importWxr(body, await deps());
    // The double-charging proof: call IDENTITY, not merely a count.
    expect(calls).toEqual(['https://wp/c.jpg']);
    expect(second).toMatchObject({ imported: 0, updated: 1 });
    expect(second.images).toEqual({ total: 3, hosted: 3, failed: 0 });

    const pair = (await store.get((await store.list())[0]!.translationKey))!;
    for (const name of ['a', 'b', 'c']) {
      expect(pair.de.images[`${baseUrl}/trips/de-1/${name}`], name).toMatchObject({ width: 900, height: 600 });
    }
    expect(pair.de.bodyMarkdown).not.toContain('https://wp/');
  });
});
