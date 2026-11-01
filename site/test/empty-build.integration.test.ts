import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { Window } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeApplicationSchema } from '../../uploader/src/onboarding-bootstrap.js';
import { ui } from '../src/i18n/ui.js';
import { unallowedBranding } from '../../uploader/test/branding-allowlist.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const siteRoot = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const modes = [
  { name: 'de-bilingual', primary: 'de', locales: ['de', 'en'] },
  { name: 'en-bilingual', primary: 'en', locales: ['en', 'de'] },
  { name: 'de-only', primary: 'de', locales: ['de'] },
  { name: 'en-only', primary: 'en', locales: ['en'] },
] as const;

async function documents(directory: string, prefix = '', all = false): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) paths.push(...await documents(join(directory, entry.name), relative + '/', all));
    else if (all || /\.(html|xml)$/.test(entry.name)) paths.push(relative);
  }
  return paths.sort();
}

// Unlike container tests, this migrates an empty real Postgres schema and runs
// the production Astro config/loaders. Both output and content cache are private;
// neither the developer's dist nor their database's public schema is modified.
// TEST_DATABASE_URL is required in CI, as for the uploader integration suites.
describe.skipIf(!databaseUrl)('real zero-content Astro builds', () => {
  const schema = 'empty_build_' + randomUUID().replaceAll('-', '');
  let admin: pg.Pool;
  let pool: pg.Pool;
  let directory: string;
  let isolatedUrl: string;
  beforeAll(async () => {
    // @ai-warning Not os.tmpdir(): with an outDir outside the site root Astro stages
    // prerender assets under <site>/.astro/.prerender and rename()s them into outDir,
    // which fails with EXDEV where /tmp is another device (GitHub runners) once the
    // shared CSS is large enough to be emitted as a file. Production avoids the same
    // trap by building into <site>/.build-tmp (uploader/src/build.ts); .astro/ is ignored.
    await mkdir(join(siteRoot, '.astro', 'test-builds'), { recursive: true });
    directory = await mkdtemp(join(siteRoot, '.astro', 'test-builds', 'empty-build-'));
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const target = new URL(databaseUrl!);
    target.searchParams.set('options', `-c search_path=${schema}`);
    isolatedUrl = target.href;
    pool = new pg.Pool({ connectionString: isolatedUrl });
    await initializeApplicationSchema(pool, () => {});
    expect((await pool.query('SELECT count(*)::int AS count FROM posts')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS count FROM media')).rows[0].count).toBe(0);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(modes)('builds $name without fabricated content, maps or region links', async ({ name, primary, locales }) => {
    await pool.query('UPDATE site_language SET primary_locale=$1, enabled_locales=$2', [primary, [...locales]]);
    const outDir = join(directory, name);
    const cacheDir = join(directory, name + '-cache');
    const config = { root: siteRoot, outDir, cacheDir, vite: { envDir: join(cacheDir, 'empty-env') } };
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: isolatedUrl, ASTRO_TELEMETRY_DISABLED: '1' };
    delete env.SITE_LANGUAGE_JSON;
    delete env.SITE_IDENTITY_JSON;
    delete env.SITE_DATABASE_SNAPSHOT;
    await run(process.execPath, ['--input-type=module', '--eval',
      `import { build } from 'astro'; await build(${JSON.stringify(config)});`], {
      cwd: siteRoot,
      env,
      timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    });
    const window = new Window();
    try {
      const parse = (text: string, xml = false) => new window.DOMParser().parseFromString(text, xml ? 'application/xml' : 'text/html');
      const expected = ['404.html', 'sitemap-0.xml', 'sitemap-index.xml'];
      const htmlPaths: string[] = [];
      for (const locale of locales) {
        const prefix = locale === primary ? '' : locale + '/';
        const about = locale === 'de' ? 'uber-mich' : 'about-me';
        const map = locale === 'de' ? 'karte' : locale === primary ? 'travel-map' : 'map';
        const destinations = locale === 'de' ? 'reiseziele' : 'destinations';
        const htmlFiles = ['index.html', about + '/index.html', map + '/index.html', destinations + '/index.html'];
        expected.push(...htmlFiles.map((file) => prefix + file), prefix + 'rss.xml');
        htmlPaths.push(...htmlFiles.map((file) => '/' + prefix + file.replace(/index\.html$/, '')));
        for (const [file, emptyKey] of [
          ['index.html', 'stories.emptyBody'], [map + '/index.html', 'map.emptyBody'],
          [destinations + '/index.html', 'stories.emptyBody'],
        ] as const) {
          const document = parse(await readFile(join(outDir, prefix + file), 'utf8'));
          const main = document.querySelector('main')!;
          expect(document.documentElement.lang).toBe(locale);
          expect(main.textContent).toContain(ui[locale][emptyKey]);
          expect(document.querySelectorAll('h1')).toHaveLength(1);
          expect(main.querySelectorAll('#map, [data-geojson], .story-grid, nav ul')).toHaveLength(0);
          expect(main.querySelectorAll('a[href]')).toHaveLength(0);
          expect(document.querySelectorAll('link[hreflang]')).toHaveLength(locales.length === 2 ? 3 : 0);
        }
        const feed = parse(await readFile(join(outDir, prefix + 'rss.xml'), 'utf8'), true);
        expect(feed.querySelector('channel > language')?.textContent).toBe(locale);
        expect(feed.querySelectorAll('item')).toHaveLength(0);
      }
      // Exact inventory proves liveRegions omits every empty region, not just
      // that a representative region happens to be missing from navigation.
      expect(await documents(outDir)).toEqual(expected.sort());
      const sitemap = parse(await readFile(join(outDir, 'sitemap-0.xml'), 'utf8'), true);
      expect([...sitemap.querySelectorAll('url > loc')].map((node) => new URL(node.textContent!).pathname).sort()).toEqual(htmlPaths.sort());
      // #272: no owner branding in any fresh-install release file (pages,
      // feeds, scripts, styles, fonts) beyond docs/site-identity-branding-allowlist.json.
      const branding = [];
      for (const file of await documents(outDir, '', true)) {
        branding.push(...unallowedBranding('site', file, await readFile(join(outDir, file), 'latin1')));
      }
      expect(branding).toEqual([]);
    } finally { await window.happyDOM.close(); }
  }, 150_000);
});
