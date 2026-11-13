import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { LEGACY_REDIRECTS, legacyRedirectForRelease } from '../../../uploader/src/redirects.js';
// The fixture driver builds these independently specified published pairs in
// every mode. This is a continuous route contract, not a historical byte diff.
// Disabled rows retain private-<locale>-285 markers; they must never be emitted.
const root = process.env.BUILT_ROUTE_CONTRACT_ROOT;
if (!root) throw new Error('BUILT_ROUTE_CONTRACT_ROOT must contain de-bilingual, en-bilingual, de-only and en-only releases');
const windows: Window[] = [];
afterEach(async () => { await Promise.all(windows.splice(0).map((window) => window.happyDOM.close())); });
function documentOf(text: string, xml = false) {
  const window = new Window(); windows.push(window);
  return new window.DOMParser().parseFromString(text, xml ? 'application/xml' : 'text/html');
}
async function files(dir: string, prefix = '', htmlXmlOnly = true): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(join(dir, entry.name), `${path}/`, htmlXmlOnly));
    else if (!htmlXmlOnly || /\.(?:html|xml)$/.test(entry.name)) result.push(path);
  }
  return result.sort();
}
const common = ['404.html', 'sitemap-index.xml', 'sitemap-0.xml', 'legal/de.html', 'legal/en.html'];
const de = ['index.html', 'uber-mich/index.html', 'karte/index.html', 'reiseziele/index.html', 'reiseziele/europa/index.html', 'reiseziele/suedamerika/index.html', 'reise/index.html', 'zweite-reise/index.html', 'rss.xml'];
const en = ['index.html', 'about-me/index.html', 'travel-map/index.html', 'destinations/index.html', 'destinations/europe/index.html', 'destinations/south-america/index.html', 'journey/index.html', 'second-journey/index.html', 'rss.xml'];
const enSecondary = en.map((path) => `en/${path === 'travel-map/index.html' ? 'map/index.html' : path}`);
const deSecondary = de.map((path) => `de/${path}`);
const cases = [
  { name: 'de-bilingual', primary: 'de', locales: ['de', 'en'], expected: [...common, ...de, ...enSecondary] },
  { name: 'en-bilingual', primary: 'en', locales: ['en', 'de'], expected: [...common, ...en, ...deSecondary] },
  { name: 'de-only', primary: 'de', locales: ['de'], expected: [...common, ...de] },
  { name: 'en-only', primary: 'en', locales: ['en'], expected: [...common, ...en] },
];
function publicPath(file: string) { return '/' + file.replace(/index\.html$/, ''); }

describe('actual built four-mode route and SEO contract', () => {
  it.each(cases)('$name has exactly the approved files and no dangling locale links', async ({ name, primary, locales, expected }) => {
    const dir = join(root, name);
    expect(await files(dir)).toEqual([...expected].sort());
    if (locales.length === 1) {
      const marker = `private-${primary === 'de' ? 'en' : 'de'}-285`;
      const markerBytes = Buffer.from(marker);
      for (const file of await files(dir, '', false)) {
        expect(file, 'disabled slug in output filename').not.toContain(marker);
        expect((await readFile(join(dir, file))).includes(markerBytes), `${name}/${file} leaks retained inactive content`).toBe(false);
      }
    }
    const urls = new Set((await files(dir, '', false)).map(publicPath));
    // Packaged software notices are global static assets, not localized blog routes.
    for (const locale of ['de', 'en']) {
      const file = `legal/${locale}.html`;
      const notice = documentOf(await readFile(join(dir, file), 'utf8'));
      expect(notice.documentElement.lang).toBe(locale);
      for (const link of notice.querySelectorAll('a[href]')) {
        const target = new URL(link.getAttribute('href')!, 'https://simonswanderlust.com/' + file);
        if (target.origin === 'https://simonswanderlust.com') expect(urls.has(target.pathname), target.pathname).toBe(true);
      }
    }
    const sitemap = documentOf(await readFile(join(dir, 'sitemap-0.xml'), 'utf8'), true);
    const sitemapPaths = [...sitemap.querySelectorAll('url > loc')].map((node) => new URL(node.textContent!).pathname).sort();
    const htmlPaths = expected.filter((path) => path.endsWith('.html') && path !== '404.html' && !path.startsWith('legal/')).map(publicPath).sort();
    expect(sitemapPaths).toEqual(htmlPaths);
    for (const [from, target] of LEGACY_REDIRECTS) {
      const eligible = primary === 'de' && (!from.startsWith('/en/') || locales.includes('en'));
      expect(await legacyRedirectForRelease(from, dir)).toBe(eligible ? target : undefined);
    }
    for (const file of expected.filter((path) => path.endsWith('.html') && !path.startsWith('legal/'))) {
      const document = documentOf(await readFile(join(dir, file), 'utf8'));
      const locale = file.startsWith('de/') ? 'de' : file.startsWith('en/') ? 'en' : primary;
      expect(document.documentElement.lang).toBe(locale);
      const alternateLinks = [...document.querySelectorAll('link[hreflang]')];
      if (locales.length === 1 || file === '404.html') expect(alternateLinks).toHaveLength(0);
      else {
        expect(alternateLinks).toHaveLength(3);
        const primaryLink = document.querySelector(`link[hreflang="${primary}"]`)!;
        expect(document.querySelector('link[hreflang="x-default"]')?.getAttribute('href')).toBe(primaryLink.getAttribute('href'));
      }
      for (const link of [...alternateLinks, ...document.querySelectorAll('a[href], link[type="application/rss+xml"]')]) {
        const href = link.getAttribute('href')!;
        if (href.startsWith('#')) continue;
        const target = new URL(href, 'https://simonswanderlust.com' + publicPath(file));
        if (target.origin !== 'https://simonswanderlust.com') continue;
        expect(urls.has(target.pathname), `${name}/${file} links ${target.pathname}`).toBe(true);
      }
      if (locales.length === 1) {
        expect(document.querySelectorAll('a[hreflang], meta[property="og:locale:alternate"]')).toHaveLength(0);
      }
      const comments = document.querySelector('[data-comments-root]');
      if (comments) {
        expect(comments.getAttribute('data-locale')).toBe(locale);
        expect(comments.getAttribute('data-comments-url')).toBe('/comments');
      }
    }
    for (const file of expected.filter((path) => path.endsWith('rss.xml'))) {
      const locale = file.startsWith('de/') ? 'de' : file.startsWith('en/') ? 'en' : primary;
      const feed = documentOf(await readFile(join(dir, file), 'utf8'), true);
      expect(feed.querySelector('channel > language')?.textContent).toBe(locale);
      expect(feed.querySelectorAll('item')).toHaveLength(2);
      for (const item of feed.querySelectorAll('item > link')) expect(urls.has(new URL(item.textContent!).pathname)).toBe(true);
    }
  });
});
