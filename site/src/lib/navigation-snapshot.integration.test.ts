import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Loader } from 'astro/loaders';
import { ensureSchema } from '../../../uploader/src/db.js';
import { withBuildSnapshot } from '../../../uploader/src/build-snapshot.js';
import { createSiteBuilder } from '../../../uploader/src/build.js';
import { postgresPagesLoader } from './pages-loader.js';
import { postgresNavigationLoader } from './navigation-loader.js';
import { postgresTripsLoader } from './postgres-loader.js';
import { renderMarkdown } from './render-markdown.js';
import { publicRoutes } from './public-routes.js';
import { resolveNavigation } from './resolve-navigation.js';
import type { PublicPage } from './page-content.js';
import type { Trip } from './trips.js';

const url = process.env.TEST_DATABASE_URL;
afterEach(() => vi.unstubAllEnvs());
async function collect(loader: Loader) {
  const entries: { id: string; data: unknown; body?: string; rendered?: { html: string } }[] = [];
  await loader.load({ store: { clear() {}, set(entry: typeof entries[number]) { entries.push(entry); return true; } },
    parseData: async ({ data }: { data: unknown }) => data,
    renderMarkdown: async (body: string) => ({ html: await renderMarkdown(body) }), logger: { info() {} },
  } as unknown as Parameters<Loader['load']>[0]);
  return entries;
}

(url ? describe : describe.skip)('page/navigation captured build and failed successor', () => {
  it.each(['de', 'en'] as const)('does not expose prepared inactive content after an older %s-primary build captures', async (primary) => {
    const secondary = primary === 'de' ? 'en' : 'de';
    const schema = `nav_snapshot_${randomUUID().replaceAll('-', '')}`;
    const owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(url!); connection.searchParams.set('options', `-c search_path=${schema}`);
    connection.searchParams.set('application_name', schema);
    const pool = new pg.Pool({ connectionString: connection.href, max: 4 });
    const root = await mkdtemp(join(tmpdir(), 'nav-snapshot-'));
    let exported = '';
    const captured = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    try {
      await ensureSchema(pool);
      await pool.query("INSERT INTO site_identity(id,seed_source,site_name) VALUES(true,'neutral','CAPTURED IDENTITY')");
      await pool.query('UPDATE site_language SET primary_locale=$1,enabled_locales=$2,locked_at=NULL', [primary, [primary, secondary]]);
      for (const locale of ['de', 'en']) await pool.query(`INSERT INTO pages(key,locale,slug,status,title,body_markdown,images,published_at)
        VALUES('contact',$1,$2,'published','CAPTURED PAGE','CAPTURED BODY','{}',now())`, [locale, locale === 'de' ? 'kontakt' : 'contact']);
      const nav = { version: 1, header: [{ kind: 'page', target: 'contact', label: { de: 'CAPTURED NAV', en: 'CAPTURED NAV' } }], footer: [], legal: [] };
      await pool.query('UPDATE site_nav SET config=$1', [nav]);
      vi.stubEnv('DATABASE_URL', connection.href); vi.stubEnv('PUBLIC_BASE_URL', 'https://img.example');
      let runs = 0;
      const builder = createSiteBuilder({ siteAppDir: root, releasesRoot: join(root, 'site'), runBuild: async (outDir) => {
        if (++runs > 1) throw new Error('Queued rebuild fails');
        await withBuildSnapshot(pool, { timeoutMs: 10000 }, async (snapshot) => {
          exported = snapshot.databaseSnapshot;
          captured.resolve(); await resume.promise;
          vi.stubEnv('SITE_DATABASE_SNAPSHOT', snapshot.databaseSnapshot);
          vi.stubEnv('SITE_LANGUAGE_JSON', JSON.stringify(snapshot.language));
          const pages = await collect(postgresPagesLoader());
          const navigation = await collect(postgresNavigationLoader());
          const trips = await collect(postgresTripsLoader());
          const routes = publicRoutes(trips as Trip[], snapshot.language, pages as PublicPage[]);
          const resolved = resolveNavigation(navigation[0]!.data, routes, snapshot.language, secondary, '/');
          expect(resolved.header[0]?.label).toBe('CAPTURED NAV');
          expect(routes.some((route) => route.locale === secondary && route.kind === 'page')).toBe(true);
          const output = JSON.stringify({ identity: snapshot.identity, pages, navigation, routes });
          expect(output).not.toContain('PRIVATE');
          await mkdir(outDir, { recursive: true });
          await writeFile(join(outDir, 'index.html'), output);
        });
      } });
      const first = builder.build('rebuild');
      await captured.promise;
      // The real snapshot is captured; saves are allowed to commit while the build is paused.
      await pool.query('UPDATE site_language SET enabled_locales=$1', [[primary]]);
      await pool.query("UPDATE pages SET title='PRIVATE PAGE',body_markdown='PRIVATE BODY' WHERE locale=$1", [secondary]);
      await pool.query("UPDATE site_nav SET config=jsonb_set(config,ARRAY['header','0','label',$1],to_jsonb('PRIVATE NAV'::text))", [secondary]);
      await pool.query("UPDATE site_identity SET site_name='PRIVATE IDENTITY'");
      const queued = builder.build('rebuild');
      resume.resolve();
      expect((await first).ok).toBe(true);
      expect((await queued).ok).toBe(false);
      const serving = await readFile(join(root, 'site/current/index.html'), 'utf8');
      expect(serving).toContain('CAPTURED BODY'); expect(serving).toContain('CAPTURED NAV'); expect(serving).not.toContain('PRIVATE');
      // An expired supplied snapshot fails both loaders, never silently reading new private rows.
      vi.stubEnv('SITE_DATABASE_SNAPSHOT', exported);
      await expect(collect(postgresPagesLoader())).rejects.toThrow();
      await expect(collect(postgresNavigationLoader())).rejects.toThrow();
      expect(await readFile(join(root, 'site/current/index.html'), 'utf8')).toBe(serving);
      const sessions = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'", [schema]);
      expect(sessions.rows[0].count).toBe(0);
    } finally {
      resume.resolve(); await pool.end(); await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
