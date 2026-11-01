import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'astro';
import pg from 'pg';
import { Window } from 'happy-dom';

// Run from site/: CANONICAL_MATRIX_DATABASE_URL=<isolated synthetic fixture DB>
// node scripts/canonical-build-matrix.mjs
// This is a real build contract, not a mocked renderer. The fixture must contain
// published stories for every enabled locale. It never writes database rows and
// never reads DATABASE_URL, SITE_* or PUBLIC_BASE_URL from the parent environment.
// Repeat against each of the four #285 language-mode fixtures; mode stays DB-owned.
const script = fileURLToPath(import.meta.url);
const siteRoot = dirname(dirname(script));
const imageOrigin = 'https://images.canonical-matrix.example';
const origins = ['https://simonswanderlust.com', 'https://journal.example:8443', null];

if (process.argv[2] === '--build-child') {
  const [, , , output, cache] = process.argv;
  assert(output && cache, 'Internal build child requires isolated output and cache directories');
  await build({
    root: siteRoot, outDir: output, cacheDir: cache,
    // Do not let Vite/Astro load this checkout's operator .env files.
    vite: { envDir: join(cache, 'empty-env') },
  });
} else {
  const databaseUrl = process.env.CANONICAL_MATRIX_DATABASE_URL;
  assert(databaseUrl, 'Supply CANONICAL_MATRIX_DATABASE_URL for an isolated synthetic Postgres fixture; inherited DATABASE_URL is never used');
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
  let language;
  try {
    const { rows } = await pool.query('SELECT primary_locale, enabled_locales FROM site_language WHERE id = true');
    assert.equal(rows.length, 1, 'Fixture must initialize site_language');
    language = { primary: rows[0].primary_locale, locales: rows[0].enabled_locales };
    const published = await pool.query("SELECT published_snapshot->>'locale' AS locale, count(*)::integer AS count FROM posts WHERE status = 'published' AND published_snapshot IS NOT NULL GROUP BY 1");
    for (const locale of language.locales) {
      assert(published.rows.some((row) => row.locale === locale && row.count > 0), `Fixture needs published ${locale} stories; empty builds cannot prove RSS/JSON-LD`);
    }
  } finally {
    await pool.end();
  }
  const root = await mkdtemp(join(tmpdir(), 'canonical-build-matrix-'));
  const reports = [];
  for (const [index, canonicalOrigin] of origins.entries()) {
    const name = ['legacy', 'changed', 'unconfigured'][index];
    const output = join(root, name);
    const snapshot = {
      v: 1, locales: language.locales, canonicalOrigin,
      siteName: 'Canonical matrix journal', authorName: 'Fixture author',
      tagline: {}, aboutRole: {}, aboutGear: {}, socialLinks: [],
      assets: { logo: null, favicon: null },
    };
    await runBuild(output, join(root, `cache-${name}`), {
      PATH: process.env.PATH ?? '', NODE_ENV: 'production', TZ: 'UTC', ASTRO_TELEMETRY_DISABLED: '1',
      DATABASE_URL: databaseUrl, PUBLIC_BASE_URL: imageOrigin,
      SITE_LANGUAGE_JSON: JSON.stringify(language), SITE_IDENTITY_JSON: JSON.stringify(snapshot),
    });
    const report = await inspect(output, canonicalOrigin, language);
    if (reports.length) {
      assert.deepEqual(report.files, reports[0].files, 'Changing/unsetting canonical origin must preserve every output filename');
      assert.deepEqual(report.images, reports[0].images, 'Changing/unsetting canonical origin must not change image URLs');
      assert.deepEqual(report.paths, reports[0].paths, 'Changing/unsetting canonical origin must preserve canonical paths');
      assert.deepEqual(report.alternates, reports[0].alternates, 'Changing/unsetting canonical origin must preserve locale routing');
    }
    reports.push({ name, canonicalOrigin, ...report });
  }
  await writeFile(join(root, 'matrix.json'), JSON.stringify({ language, reports }, null, 2) + '\n');
  console.log(`Canonical build matrix passed (${language.primary}: ${language.locales.join(', ')}); evidence: ${root}`);
}

async function runBuild(output, cache, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--build-child', output, cache], {
      cwd: siteRoot, env, stdio: 'inherit', shell: false,
    });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 15 * 60 * 1000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Astro build failed (${signal ?? code}); matrix did not pass`));
    });
  });
}

async function filesUnder(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(join(dir, entry.name), path + '/'));
    else files.push(path);
  }
  return files.sort();
}

async function inspect(dir, canonicalOrigin, language) {
  const origin = canonicalOrigin ?? 'https://unconfigured.invalid';
  const files = await filesUnder(dir);
  const htmlFiles = files.filter((file) => file.endsWith('.html'));
  const feeds = files.filter((file) => file.endsWith('rss.xml'));
  const sitemaps = files.filter((file) => /^sitemap.*\.xml$/.test(file));
  assert(htmlFiles.includes('index.html'));
  assert.equal(feeds.length, language.locales.length);
  assert(sitemaps.includes('sitemap-index.xml') && sitemaps.includes('sitemap-0.xml'));
  const window = new Window();
  const parse = (text, xml = false) => new window.DOMParser().parseFromString(text, xml ? 'application/xml' : 'text/html');
  const paths = {};
  const images = {};
  const alternates = {};
  let stories = 0;
  const publicPaths = new Set(htmlFiles.filter((file) => file !== '404.html').map((file) => '/' + file.replace(/index\.html$/, '')));
  try {
    for (const file of htmlFiles) {
      const document = parse(await readFile(join(dir, file), 'utf8'));
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
      assert(canonical, `${file} needs a canonical link`);
      assert.equal(new URL(canonical).origin, origin, `${file} canonical origin`);
      paths[file] = new URL(canonical).pathname;
      if (file !== '404.html') assert.equal(paths[file], '/' + file.replace(/index\.html$/, ''), `${file} route changed`);
      assert.equal(document.querySelector('meta[property="og:url"]')?.getAttribute('content'), canonical);
      assert.equal(document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null, canonicalOrigin === null ? 'noindex' : null);
      assert(language.locales.includes(document.documentElement.lang), `${file} disabled language leaked`);
      const locale = document.documentElement.lang;
      const feedLink = document.querySelector('link[type="application/rss+xml"]')?.getAttribute('href');
      assert.equal(feedLink, locale === language.primary ? '/rss.xml' : `/${locale}/rss.xml`);
      const links = [...document.querySelectorAll('link[hreflang]')];
      alternates[file] = links.map((link) => {
        const url = new URL(link.getAttribute('href'));
        assert.equal(url.origin, origin, `${file} hreflang origin`);
        assert(publicPaths.has(url.pathname), `${file} dangling hreflang ${url.pathname}`);
        return [link.getAttribute('hreflang'), url.pathname];
      });
      if (language.locales.length === 1) assert.equal(links.length, 0);
      if (links.length) {
        assert.equal(links.length, 3);
        assert.equal(document.querySelector('link[hreflang="x-default"]')?.getAttribute('href'), document.querySelector(`link[hreflang="${language.primary}"]`)?.getAttribute('href'));
      }
      images[file] = [...document.querySelectorAll('img[src], source[srcset], meta[property="og:image"]')].map((node) => node.getAttribute('src') ?? node.getAttribute('srcset') ?? node.getAttribute('content'));
      for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
        const value = JSON.parse(node.textContent);
        if (value.url) assert.equal(new URL(value.url).origin, origin);
        if (value['@type'] !== 'BlogPosting') continue;
        stories++;
        assert.equal(value.mainEntityOfPage, canonical);
        assert.equal(new URL(value.image.url).origin, imageOrigin);
        assert.equal(document.querySelector('meta[property="og:image"]')?.getAttribute('content'), value.image.url);
      }
    }
    assert(stories >= language.locales.length, 'Real published story rendering must be exercised');
    for (const file of feeds) {
      const document = parse(await readFile(join(dir, file), 'utf8'), true);
      const locale = document.querySelector('channel > language')?.textContent;
      assert(language.locales.includes(locale));
      assert.equal(document.querySelector('channel > link')?.textContent, origin + (locale === language.primary ? '/' : `/${locale}/`));
      const items = [...document.querySelectorAll('item > link')];
      assert(items.length > 0, `${file} needs real feed items`);
      for (const node of items) {
        const url = new URL(node.textContent);
        assert.equal(url.origin, origin, `${file} item origin`);
        assert(publicPaths.has(url.pathname), `${file} dangling item ${url.pathname}`);
        if (locale !== language.primary) assert(url.pathname.startsWith(`/${locale}/`));
      }
    }
    const listed = [];
    for (const file of sitemaps) {
      const document = parse(await readFile(join(dir, file), 'utf8'), true);
      const locations = [...document.querySelectorAll('loc')];
      assert(locations.length > 0, `${file} cannot be empty`);
      for (const node of locations) {
        const url = new URL(node.textContent);
        assert.equal(url.origin, origin, `${file} sitemap origin`);
        if (file === 'sitemap-index.xml') assert(files.includes(url.pathname.slice(1)));
        else listed.push(url.pathname);
      }
    }
    assert.deepEqual(listed.sort(), [...publicPaths].sort(), 'Sitemap must list exactly the emitted public HTML routes');
    const expectedRobots = canonicalOrigin === null
      ? 'User-agent: *\nDisallow: /\n'
      : `User-agent: *\nAllow: /\n\nSitemap: ${canonicalOrigin}/sitemap-index.xml\n`;
    assert.deepEqual(await readFile(join(dir, 'robots.txt')), Buffer.from(expectedRobots), 'robots.txt byte contract');
    return { files, paths, alternates, images, stories };
  } finally {
    await window.happyDOM.close();
  }
}
