import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { aboutPath, homePath, mapPath } from '../../src/lib/paths';
import type { SiteLanguage } from '../../src/lib/site-language';
// Actual Astro artifacts, not render mocks. The exact fixture is recorded in the
// #287/#289 specification's public-output evidence appendix.
const root = process.env.BUILT_PAGE_CONTRACT_ROOT;
if (!root) throw new Error('BUILT_PAGE_CONTRACT_ROOT must contain seed and configured releases for each of the four language modes');
const modes: { name: string; mode: SiteLanguage }[] = [
  { name: 'de-bilingual', mode: { primary: 'de', locales: ['de', 'en'] } },
  { name: 'en-bilingual', mode: { primary: 'en', locales: ['en', 'de'] } },
  { name: 'de-only', mode: { primary: 'de', locales: ['de'] } },
  { name: 'en-only', mode: { primary: 'en', locales: ['en'] } },
];
const windows: Window[] = [];
afterEach(async () => { await Promise.all(windows.splice(0).map((window) => window.happyDOM.close())); });
function doc(text: string, xml = false) {
  const window = new Window(); windows.push(window);
  return new window.DOMParser().parseFromString(text, xml ? 'application/xml' : 'text/html');
}
async function inventory(dir: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const file of await readdir(dir, { withFileTypes: true })) {
    if (file.isDirectory()) result.push(...await inventory(join(dir, file.name), prefix + file.name + '/'));
    else result.push(prefix + file.name);
  }
  return result.sort();
}
const label = '<img src=x onerror=alert(289)> & source';
describe('actual published page and configured navigation output', () => {
  it.each(modes)('$name preserves seed links and resolves configured pages without leaking private rows', async ({ name, mode }) => {
    const dir = join(root, name, 'configured'); const files = await inventory(dir);
    const emitted = new Set(files.map((file) => '/' + file.replace(/index\.html$/, '')));
    const sitemap = doc(await readFile(join(dir, 'sitemap-0.xml'), 'utf8'), true);
    const sitemapPaths = [...sitemap.querySelectorAll('url > loc')].map((node) => new URL(node.textContent!).pathname).sort();
    expect(sitemapPaths).toEqual([...emitted].filter((path) => path.endsWith('/') && path !== '/404.html').sort());
    for (const file of files) {
      expect(file).not.toContain('PRIVATE289');
      expect((await readFile(join(dir, file))).includes(Buffer.from('PRIVATE289')), file).toBe(false);
    }
    for (const locale of mode.locales) {
      const base = homePath(locale, mode); const contact = base + (locale === 'de' ? 'kontakt/' : 'contact/');
      const legal = base + (locale === 'de' ? 'impressum/' : 'legal/');
      const seed = doc(await readFile(join(root, name, 'seed', base.slice(1), 'index.html'), 'utf8'));
      expect([...seed.querySelectorAll('header nav > a')].map((node) => node.getAttribute('href'))).toEqual([base + '#stories', mapPath(locale, mode), aboutPath(locale, mode)]);
      expect(seed.querySelector('footer a[href="' + aboutPath(locale, mode) + '"]')).not.toBeNull();
      for (const path of [contact, legal, aboutPath(locale, mode)]) {
        expect(emitted.has(path)).toBe(true); expect(sitemapPaths).toContain(path);
        const page = doc(await readFile(join(dir, path.slice(1), 'index.html'), 'utf8'));
        expect(page.querySelector('html')?.getAttribute('lang')).toBe(locale);
        expect(page.querySelectorAll('h1')).toHaveLength(1);
        expect(page.querySelector('main form')).toBeNull(); expect(page.querySelector('script[data-attacker]')).toBeNull();
        expect(new URL(page.querySelector('link[rel="canonical"]')!.getAttribute('href')!).pathname).toBe(path);
        const alternatives = [...page.querySelectorAll('link[rel="alternate"][hreflang]')];
        expect(alternatives).toHaveLength(mode.locales.length === 2 ? 3 : 0);
        for (const alternate of alternatives) expect(emitted.has(new URL(alternate.getAttribute('href')!).pathname)).toBe(true);
        const header = page.querySelector('header nav')!;
        expect([...header.querySelectorAll(':scope > a')].map((node) => node.getAttribute('href'))).toEqual([contact, mapPath(locale, mode), 'https://example.org/source?lang=' + locale]);
        expect(header.querySelector('img')).toBeNull();
        const external = header.querySelector('a[target="_blank"]')!;
        expect(external.textContent).toContain(label); expect(external.textContent).toContain('↗');
        expect(external.getAttribute('rel')?.split(/\s+/).sort()).toEqual(['noopener', 'noreferrer']);
        expect(external.querySelector('.sr-only')?.textContent).toBeTruthy();
        const current = header.querySelector('a[aria-current="page"]');
        expect(current?.getAttribute('href') ?? null).toBe(path === contact ? contact : null);
        expect(page.querySelector('footer a[href="' + legal + '"]')).not.toBeNull();
        expect(page.querySelector('footer a[href="https://social.example/author"]')).not.toBeNull();
        expect(page.querySelector('a[href="/missing-289/"]')).toBeNull();
        for (const node of page.querySelectorAll('a[href^="/"]')) {
          const href = new URL(node.getAttribute('href')!, 'https://fixture.test');
          if (!href.pathname.startsWith('/images/')) expect(emitted.has(href.pathname), node.outerHTML).toBe(true);
        }
      }
      expect(emitted.has(base + (locale === 'de' ? 'datenschutz/' : 'privacy/'))).toBe(false);
    }
  });
});
