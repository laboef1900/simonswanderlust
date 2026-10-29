import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';

// Real Astro release fixtures, not container renders. Parent qualification prepares:
// BUILT_JOURNEY_CONTRACT_ROOT/{de-bilingual,en-bilingual,de-only,en-only}/{before,live,dormant}.
// `before`: actual #309/#289 prerequisite code, same published stories a,c,n in each enabled locale.
// Keep published generic pages and seeded navigation identical across all three releases;
// do not substitute the historical pre-#289 fixture or add automatic journey navigation.
// `live`: published journey expedition with members a,b,c; b is draft. A second
// published journey dormant has only b. `dormant`: both journeys have only b.
// Every unpublished field/slug uses private-draft-310; journey working fields use
// private-working-310; disabled locale content uses private-inactive-310.
// a public track = [[[1,2],[3,4]],[[5,6],[7,8]]]; c = [[[90,20],[91,21]]].
// Both active snapshot locales use canonical hero /photos/journey, 1600x1200,
// focus {x:23,y:71}, and plain intro containing <script>not markup</script>.
const root = process.env.BUILT_JOURNEY_CONTRACT_ROOT;
if (!root) throw new Error('BUILT_JOURNEY_CONTRACT_ROOT must contain real before/live/dormant four-mode journey releases');
const windows: Window[] = [];
afterEach(async () => { await Promise.all(windows.splice(0).map((window) => window.happyDOM.close())); });
function documentOf(html: string, xml = false) {
  const window = new Window(); windows.push(window);
  return new window.DOMParser().parseFromString(html, xml ? 'application/xml' : 'text/html');
}
async function files(dir: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await files(join(dir, entry.name), path + '/'));
    else result.push(path);
  }
  return result.sort();
}
function normalized(html: string) { return html.replace(/\/_astro\/[^"'\s<>]+/g, '/_astro/HASH'); }
const cases = [
  { name: 'de-bilingual', primary: 'de', locales: ['de', 'en'] },
  { name: 'en-bilingual', primary: 'en', locales: ['en', 'de'] },
  { name: 'de-only', primary: 'de', locales: ['de'] },
  { name: 'en-only', primary: 'en', locales: ['en'] },
];

describe('real built journey privacy and parity contract', () => {
  it.each(cases)('$name preserves old output and only adds live localized journeys', async ({ name, primary, locales }) => {
    const beforeDir = join(root, name, 'before'); const liveDir = join(root, name, 'live');
    const beforeFiles = await files(beforeDir); const liveFiles = await files(liveDir);
    const newFiles = locales.flatMap((locale) => {
      const base = `${locale === primary ? '' : locale + '/'}${locale === 'de' ? 'rundreisen' : 'journeys'}`;
      return [`${base}/index.html`, `${base}/expedition/index.html`];
    });
    expect(liveFiles.filter((file) => file.endsWith('.html'))).toEqual([...beforeFiles.filter((file) => file.endsWith('.html')), ...newFiles].sort());
    for (const file of liveFiles) {
      const bytes = await readFile(join(liveDir, file));
      for (const secret of ['private-draft-310', 'private-working-310', 'private-inactive-310']) {
        expect(file).not.toContain(secret); expect(bytes.includes(Buffer.from(secret)), `${name}/${file}`).toBe(false);
      }
    }
    const memberFiles = new Set(locales.flatMap((locale) => ['a', 'c'].map((slug) => `${locale === primary ? '' : locale + '/'}${slug}/index.html`)));
    for (const file of beforeFiles.filter((file) => /\.(html|xml)$/.test(file) && !file.startsWith('sitemap') && !memberFiles.has(file))) {
      expect(normalized(await readFile(join(liveDir, file), 'utf8')), `${name}/${file} changed`).toBe(normalized(await readFile(join(beforeDir, file), 'utf8')));
    }
    const sitemap = documentOf(await readFile(join(liveDir, 'sitemap-0.xml'), 'utf8'), true);
    const urls = [...sitemap.querySelectorAll('url > loc')].map((node) => new URL(node.textContent!).pathname);
    for (const file of newFiles) expect(urls).toContain('/' + file.replace(/index\.html$/, ''));
    expect(urls.some((url) => url.includes('/dormant/'))).toBe(false);
    for (const locale of locales) {
      const prefix = locale === primary ? '/' : `/${locale}/`;
      const base = prefix + (locale === 'de' ? 'rundreisen' : 'journeys') + '/';
      for (const [slug, number, previous, next] of [['a', '1', undefined, 'c'], ['c', '2', 'a', undefined]] as const) {
        const file = `${prefix.slice(1)}${slug}/index.html`;
        const current = documentOf(await readFile(join(liveDir, file), 'utf8'));
        const before = documentOf(await readFile(join(beforeDir, file), 'utf8'));
        expect(current.querySelectorAll('[data-journey-strip]')).toHaveLength(1);
        const strip = current.querySelector('[data-journey-strip]')!;
        expect(strip.querySelector('a')?.getAttribute('href')).toBe(base + 'expedition/');
        expect(strip.textContent).toContain(locale === 'de' ? `Geschichte ${number} von 2` : `Story ${number} of 2`);
        expect(strip.querySelector('[data-journey-previous]')?.getAttribute('href')).toBe(previous ? prefix + previous + '/' : undefined);
        expect(strip.querySelector('[data-journey-next]')?.getAttribute('href')).toBe(next ? prefix + next + '/' : undefined);
        const pager = `nav[aria-label="${locale === 'de' ? 'Weitere Geschichten' : 'More stories'}"]`;
        expect(normalized(current.querySelector(pager)!.outerHTML)).toBe(normalized(before.querySelector(pager)!.outerHTML));
        expect(current.body.textContent?.match(/N°\s*\d+/g)).toEqual(before.body.textContent?.match(/N°\s*\d+/g));
      }
      const page = documentOf(await readFile(join(liveDir, base.slice(1), 'expedition/index.html'), 'utf8'));
      expect(page.querySelectorAll('[data-journey-stories] > li')).toHaveLength(2);
      expect([...page.querySelectorAll('[data-journey-map-fallback] > li > a')].map((a) => a.getAttribute('href'))).toEqual([prefix + 'a/', prefix + 'c/']);
      expect(page.querySelectorAll('[data-comments-root]')).toHaveLength(0);
      expect(page.querySelectorAll('link[hreflang]')).toHaveLength(locales.length === 2 ? 3 : 0);
      const geometry = JSON.parse(page.querySelector('[data-journey-map]')!.getAttribute('data-geometry')!);
      expect(geometry.tracks.features.map((feature: { geometry: { coordinates: number[][] } }) => feature.geometry.coordinates)).toEqual([[[1, 2], [3, 4]], [[5, 6], [7, 8]], [[90, 20], [91, 21]]]);
      expect(page.querySelector('header img')?.getAttribute('style')).toContain('object-position:23% 71%');
      for (const source of page.querySelectorAll('header source')) for (const candidate of source.getAttribute('srcset')!.split(', ')) expect(new URL(candidate.split(' ')[0]!).pathname).toMatch(/^\/photos\/journey-(640|1280|1600)\.(avif|webp)$/);
      expect(new URL(page.querySelector('header img')!.getAttribute('src')!).pathname).toBe('/photos/journey-1280.webp');
      expect(page.querySelector('main')!.textContent).toContain('<script>not markup</script>');
      expect([...page.querySelectorAll('script')].some((script) => script.textContent === 'not markup')).toBe(false);
    }
  });
  it.each(cases)('$name removes all dormant pages, index, sitemap entries and strip links', async ({ name }) => {
    const dir = join(root, name, 'dormant');
    for (const file of await files(dir)) {
      expect(file).not.toMatch(/(?:^|\/)(?:rundreisen|journeys)\//);
      if (!/\.(html|xml)$/.test(file)) continue;
      const document = documentOf(await readFile(join(dir, file), 'utf8'), file.endsWith('.xml'));
      expect(document.querySelectorAll('[data-journey-strip]')).toHaveLength(0);
      for (const node of document.querySelectorAll('a[href], link[hreflang], url > loc')) {
        const target = node.getAttribute('href') ?? node.textContent!;
        expect(target).not.toMatch(/\/(?:rundreisen|journeys)\//);
      }
    }
  });
});
