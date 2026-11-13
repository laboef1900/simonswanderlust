import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { initializeApplicationSchema } from '../../uploader/src/onboarding-bootstrap.js';
import { pgSiteIdentityStore } from '../../uploader/src/site-identity.js';
import { toIdentitySnapshot, type IdentityLocale } from '../src/lib/site-identity.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
assert(databaseUrl, 'TEST_DATABASE_URL must name a disposable PostgreSQL fixture service');
const siteRoot = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const modes: { name: string; primary: IdentityLocale; locales: IdentityLocale[] }[] = [
  { name: 'de-bilingual', primary: 'de', locales: ['de', 'en'] },
  { name: 'en-bilingual', primary: 'en', locales: ['en', 'de'] },
  { name: 'de-only', primary: 'de', locales: ['de'] },
  { name: 'en-only', primary: 'en', locales: ['en'] },
];
const hero = { src: 'https://images.fixture.test/photos/journey', width: 1600, height: 1200, alt: 'A mountain', focus: { x: 23, y: 71 } };
const label = '<img src=x onerror=alert(289)> & source';
await mkdir(join(siteRoot, '.astro/test-builds'), { recursive: true });
const root = await mkdtemp(join(siteRoot, '.astro/test-builds/populated-'));
const owner = new pg.Pool({ connectionString: databaseUrl });
// Explicit test environment; never inherit build snapshots or a production .env.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DATABASE_URL|PGOPTIONS|SITE_|PUBLIC_|IMG_HOST|BLOG_HOST|TRUSTED_PROXY)/.test(key)));
try {
  const publicSource = join(siteRoot, 'public');
  await run(process.execPath, ['../uploader/scripts/copy-legal.mjs', 'site'], { cwd: siteRoot });
  await cp(publicSource, join(root, 'public'), { recursive: true });
  for (const mode of modes) {
    for (const scenario of ['routes', 'pages', 'journeys']) {
      const schema = 'built_' + randomUUID().replaceAll('-', '');
      await owner.query(`CREATE SCHEMA ${schema}`);
      const connection = new URL(databaseUrl);
      connection.searchParams.set('options', `-c search_path=${schema}`);
      const pool = new pg.Pool({ connectionString: connection.href });
      try {
        await initializeApplicationSchema(pool, () => {});
        await pool.query('UPDATE site_language SET primary_locale=$1, enabled_locales=$2', [mode.primary, mode.locales]);
        await pool.query('UPDATE site_identity SET canonical_origin=$1, social_links=$2', ['https://simonswanderlust.com', JSON.stringify([{ label: 'Author', url: 'https://social.example/author' }])]);
        const identity = toIdentitySnapshot((await pgSiteIdentityStore(pool)).get().identity, mode.locales);
        const build = async (state?: string) => {
          const output = join(root, scenario, mode.name, ...(state ? [state] : []));
          const cache = output + '-cache';
          const config = { root: siteRoot, publicDir: join(root, 'public'), outDir: output, cacheDir: cache, vite: { envDir: join(root, 'empty-env') } };
          await run(process.execPath, ['--input-type=module', '--eval', `import { build } from 'astro'; await build(${JSON.stringify(config)});`], {
            cwd: siteRoot, env: { ...env, DATABASE_URL: connection.href, SITE_IDENTITY_JSON: JSON.stringify(identity), PUBLIC_BASE_URL: 'https://images.fixture.test', ASTRO_TELEMETRY_DISABLED: '1' },
            timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
          });
          console.log(`Built ${scenario}/${mode.name}${state ? '/' + state : ''}`);
        };
        const story = async (key: string, slugs: Record<string, string>, region = 'europe', published = true, track?: unknown) => {
          for (const locale of ['de', 'en'] as const) {
            const enabled = mode.locales.includes(locale);
            const privateText = scenario === 'routes' ? `private-${locale}-285` : 'private-draft-310';
            const slug = enabled && published ? slugs[locale]! : privateText + '-' + key;
            const snapshot = {
              translation_key: key, locale, slug, title: `Story ${key} ${locale}`, date: '2024-01-01', country: 'Country', country_code: 'DE', region,
              excerpt: `Excerpt ${key}`, hero_image: hero, coordinates: { lat: 1, lng: 2 }, stops: null, route: null, key_facts: null,
              body_markdown: `Published story ${key}.`, images: {}, ...(track ? { track } : {}),
            };
            await pool.query(`INSERT INTO posts (id, translation_key, locale, slug, title, date, country, country_code, region, excerpt, hero_image, coordinates, body_markdown, images, status, omitted, published_snapshot, published_at)
              VALUES ($1,$2,$3,$4,$5,'2024-01-01','Country','DE',$6,$7,$8,$9,$10,'{}',$11,$12,$13,$14)`,
              [randomUUID(), key, locale, slug, enabled && published ? snapshot.title : privateText, region, snapshot.excerpt, hero, snapshot.coordinates,
                enabled && published ? snapshot.body_markdown : privateText, enabled && published ? 'published' : 'draft', !enabled,
                enabled && published ? snapshot : null, enabled && published ? new Date('2024-01-01') : null]);
          }
        };
        if (scenario === 'routes') {
          await story('language-europe', { de: 'reise', en: 'journey' });
          await story('language-south-america', { de: 'zweite-reise', en: 'second-journey' }, 'south-america');
          await build();
        } else if (scenario === 'pages') {
          await build('seed');
          for (const locale of ['de', 'en'] as const) {
            const active = mode.locales.includes(locale);
            for (const key of ['contact', 'legal', 'privacy']) {
              const slug = locale === 'de' ? ({ contact: 'kontakt', legal: 'impressum', privacy: 'datenschutz' } as Record<string, string>)[key]! : key;
              await pool.query(`INSERT INTO pages(key,locale,slug,status,title,body_markdown,images,published_at) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`,
                [key, locale, slug, active && key !== 'privacy' ? 'published' : 'draft', active && key !== 'privacy' ? key : 'PRIVATE289',
                  active && key !== 'privacy' ? 'Public page. <script data-attacker>bad()</script><form>Not a public form</form>' : 'PRIVATE289', active && key !== 'privacy' ? new Date('2024-01-01') : null]);
            }
          }
          await pool.query('UPDATE site_nav SET config=$1', [{ version: 1, header: [
            { kind: 'page', target: 'contact' }, { kind: 'builtin', target: 'map' },
            { kind: 'external', href: { de: 'https://example.org/source?lang=de', en: 'https://example.org/source?lang=en' }, label: { de: label, en: label } },
            { kind: 'path', href: { de: '/missing-289/', en: '/missing-289/' }, label: { de: 'Missing', en: 'Missing' } },
          ], footer: [{ kind: 'page', target: 'legal' }], legal: [] }]);
          await build('configured');
        } else {
          await story('a', { de: 'a', en: 'a' }, 'europe', true, { version: 1, type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] });
          await story('c', { de: 'c', en: 'c' }, 'europe', true, { version: 1, type: 'MultiLineString', coordinates: [[[90, 20], [91, 21]]] });
          await story('n', { de: 'n', en: 'n' });
          await story('b', { de: 'b', en: 'b' }, 'europe', false);
          await story('d', { de: 'd', en: 'd' }, 'europe', false);
          await build('before');
          for (const [slug, members] of [['expedition', ['a', 'b', 'c']], ['dormant', ['d']]] as const) {
            const id = randomUUID();
            const snapshot = { version: 1, members, locales: Object.fromEntries(mode.locales.map(locale => [locale, { slug, title: `Journey ${locale}`, intro: '<script>not markup</script>', heroImage: hero }])) };
            await pool.query("INSERT INTO journeys(id,status,published_snapshot,published_at) VALUES($1,'published',$2,'2024-01-01')", [id, snapshot]);
            for (const locale of ['de', 'en'] as const) await pool.query(`INSERT INTO journey_locales(journey_id,locale,slug,title,intro,hero_image,omitted)
              VALUES($1,$2,$3,$4,$4,$5,$6)`, [id, locale, `private-working-310-${slug}`, mode.locales.includes(locale) ? 'private-working-310' : 'private-inactive-310', hero, !mode.locales.includes(locale)]);
            for (const [position, key] of members.entries()) await pool.query('INSERT INTO journey_members(journey_id,translation_key,position) VALUES($1,$2,$3)', [id, key, position]);
          }
          await build('live');
          await pool.query(`UPDATE journeys SET published_snapshot=jsonb_set(published_snapshot,'{members}', CASE WHEN published_snapshot->'members' ? 'a' THEN '["b"]'::jsonb ELSE '["d"]'::jsonb END)`);
          await build('dormant');
        }
      } finally {
        await pool.end();
        await owner.query(`DROP SCHEMA ${schema} CASCADE`);
      }
    }
  }
  const result = await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.built.config.ts'], {
    cwd: siteRoot, env: { ...env, BUILT_ROUTE_CONTRACT_ROOT: join(root, 'routes'), BUILT_PAGE_CONTRACT_ROOT: join(root, 'pages'), BUILT_JOURNEY_CONTRACT_ROOT: join(root, 'journeys') },
    timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  console.log(result.stdout);
} finally {
  await owner.end();
  await rm(root, { recursive: true, force: true });
}
