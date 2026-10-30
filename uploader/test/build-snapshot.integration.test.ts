import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureSchema } from '../src/db.js';
import { withBuildSnapshot, writeBuildAssets } from '../src/build-snapshot.js';
import { createSiteBuilder, runChildBuild } from '../src/build.js';
import { withLoaderSnapshot } from '../../site/src/lib/loader-pool.js';
import { postgresTripsLoader } from '../../site/src/lib/postgres-loader.js';
import { postgresPagesLoader } from '../../site/src/lib/pages-loader.js';
import { createWorkLock } from '../src/work-lock.js';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('one PostgreSQL view for the complete build', () => {
  const schema = `build_identity_${randomUUID().replaceAll('-', '')}`;
  let owner: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: url });
    await owner.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, connectionTimeoutMillis: 1000, query_timeout: 2000 });
    await ensureSchema(pool);
    await pool.query("INSERT INTO site_identity(id,seed_source,site_name) VALUES(true,'neutral','Before capture')");
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await pool?.end();
    if (owner) { await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); }
  });

  it('keeps identity, page and media content frozen while ordinary writes commit', async () => {
    await pool.query("UPDATE pages SET body_markdown = 'public-before' WHERE key='about'");
    await pool.query("INSERT INTO media(key, caption_en) VALUES ('snapshot/photo','caption-before')");
    let expired = '';
    await withBuildSnapshot(pool, { timeoutMs: 5000 }, async (snapshot) => {
      expired = snapshot.databaseSnapshot;
      expect(snapshot.identity.siteName).toBe('Before capture');
      // These writes deliberately do NOT acquire the work-lock or exporter client.
      await pool.query("UPDATE site_identity SET site_name='Private after capture'");
      await pool.query("UPDATE pages SET body_markdown='private-after' WHERE key='about'");
      await pool.query("UPDATE media SET caption_en='caption-after' WHERE key='snapshot/photo'");
      const seen = await withLoaderSnapshot(pool, async (client) => {
        const pages = await client.query("SELECT body_markdown FROM pages WHERE key='about'");
        const media = await client.query("SELECT caption_en FROM media WHERE key='snapshot/photo'");
        return { pages: pages.rows, media: media.rows };
      }, snapshot.databaseSnapshot);
      expect(seen.pages.length).toBeGreaterThan(0);
      expect(seen.pages.every(row => row.body_markdown === 'public-before')).toBe(true);
      expect(seen.media).toEqual([{ caption_en: 'caption-before' }]);
    });
    await expect(withLoaderSnapshot(pool, client => client.query('SELECT 1'), expired)).rejects.toThrow();
    expect((await pool.query('SELECT site_name FROM site_identity')).rows[0].site_name).toBe('Private after capture');
  });

  it('the actual trip and page loaders cannot see post-capture private edits', async () => {
    const stored = {
      translation_key: 'snapshot-story', locale: 'en', slug: 'snapshot-story', title: 'Captured story',
      date: '2026-01-01', country: 'Test', country_code: 'DE', region: 'europe',
      excerpt: 'Captured excerpt', hero_image: { src: 'https://img.example/snapshot/photo', width: 640, height: 480, alt: '' },
      coordinates: { lat: 1, lng: 2 }, body_markdown: 'Captured public story', images: {},
    };
    await pool.query(`INSERT INTO posts(id,translation_key,locale,slug,title,date,country,country_code,region,
      excerpt,hero_image,coordinates,body_markdown,status,published_snapshot)
      VALUES($1,'snapshot-story','en','snapshot-story','Captured story','2026-01-01','Test','DE','europe',
      'Captured excerpt',$2,$3,'Captured public story','published',$4)`,
    [randomUUID(), stored.hero_image, stored.coordinates, stored]);
    await pool.query("UPDATE pages SET body_markdown='Captured public page' WHERE key='about'");
    const connection = new URL(url!);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    vi.stubEnv('DATABASE_URL', connection.href);
    vi.stubEnv('PUBLIC_BASE_URL', 'https://img.example');
    await withBuildSnapshot(pool, { timeoutMs: 5000 }, async (snapshot) => {
      vi.stubEnv('SITE_DATABASE_SNAPSHOT', snapshot.databaseSnapshot);
      await pool.query("UPDATE posts SET published_snapshot=jsonb_set(published_snapshot,'{body_markdown}','\"PRIVATE NEW STORY\"') WHERE translation_key='snapshot-story'");
      await pool.query("UPDATE pages SET body_markdown='PRIVATE NEW PAGE' WHERE key='about'");
      for (const [loader, expected] of [[postgresTripsLoader(), 'Captured public story'], [postgresPagesLoader(), 'Captured public page']] as const) {
        const bodies: string[] = [];
        const context = {
          store: { clear() {}, set(entry: { body: string }) { bodies.push(entry.body); return true; } },
          parseData: async ({ data }: { data: Record<string, unknown> }) => data,
          renderMarkdown: async (body: string) => ({ html: body }),
          logger: { info() {} },
        } as unknown as Parameters<typeof loader.load>[0];
        await loader.load(context);
        expect(bodies.length).toBeGreaterThan(0);
        expect(bodies.every(body => body === expected)).toBe(true);
        expect(bodies.join('')).not.toContain('PRIVATE NEW');
      }
    });
  });

  it('writes captured asset bytes rather than fetching a replacement after child completion', async () => {
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#123456' } }).png().toBuffer();
    const sha = createHash('sha256').update(bytes).digest('hex');
    await pool.query("INSERT INTO site_identity_assets(role,sha256,width,height,bytes) VALUES('logo',$1,32,32,$2)", [sha, bytes]);
    const root = await mkdtemp(join(tmpdir(), 'identity-build-assets-'));
    try {
      await withBuildSnapshot(pool, { timeoutMs: 5000 }, async (snapshot) => {
        await pool.query("DELETE FROM site_identity_assets WHERE role='logo'");
        await writeBuildAssets(root, snapshot);
        expect(await readFile(join(root, '_identity', `logo-${sha.slice(0, 16)}.png`))).toEqual(bytes);
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('a failed capture leaves the prior release live and never invokes the child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'identity-release-'));
    const siteAppDir = join(root, 'app');
    await mkdir(siteAppDir);
    let calls = 0;
    const builder = createSiteBuilder({
      pool, siteAppDir, releasesRoot: join(root, 'site'),
      runBuild: async (outDir) => {
        calls++;
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, 'index.html'), 'previous release');
      },
    });
    try {
      expect((await builder.build()).ok).toBe(true);
      await pool.query(`UPDATE site_identity SET localized='{"tagline":{"xx":"invalid"}}'`);
      expect((await builder.build()).ok).toBe(false);
      expect(calls).toBe(1);
      expect(await readFile(join(root, 'site', 'current', 'index.html'), 'utf8')).toBe('previous release');
    } finally {
      await pool.query("UPDATE site_identity SET localized='{}'");
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lease cancellation never detaches in-flight deployment from quiescence', async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let settled = false;
    let exported = '';
    const operation = withBuildSnapshot(pool, { timeoutMs: 5000, signal: controller.signal }, async (snapshot) => {
      exported = snapshot.databaseSnapshot;
      entered.resolve();
      await finish.promise;
    });
    const outcome = operation.then(() => { settled = true; }, error => { settled = true; return error; });
    await entered.promise;
    controller.abort(new Error('lease lost'));
    await nextTurn();
    expect(settled).toBe(false);
    // The exporter must remain available until the child/deployment settles.
    await expect(withLoaderSnapshot(pool, client => client.query('SELECT 1'), exported)).resolves.toBeDefined();
    finish.resolve();
    expect(await outcome).toMatchObject({ message: 'lease lost' });
    await expect(withLoaderSnapshot(pool, client => client.query('SELECT 1'), exported)).rejects.toThrow();
  });

  it.each(['lease', 'deadline'] as const)('settles the actual killed build child before releasing the exporter on %s', async (cause) => {
    // Real clocks intentionally exercise OS child termination and pg exporter
    // lifetime together; the spawn barrier, not a sleep, triggers lease loss.
    const controller = new AbortController();
    const spawned = Promise.withResolvers<number>();
    let exported = '';
    const operation = withBuildSnapshot(pool, { timeoutMs: cause === 'deadline' ? 1000 : 5000, signal: controller.signal }, snapshot => {
      exported = snapshot.databaseSnapshot;
      return runChildBuild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], tmpdir(), 10000,
        child => {
          if (child.pid === undefined) spawned.reject(new Error('Child did not spawn'));
          else spawned.resolve(child.pid);
        }, { snapshot, signal: snapshot.signal });
    });
    const result = operation.then(() => null, error => error);
    const pid = await spawned.promise;
    if (cause === 'lease') controller.abort(new Error('lease lost'));
    expect(await result).toBeInstanceOf(Error);
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(withLoaderSnapshot(pool, client => client.query('SELECT 1'), exported)).rejects.toThrow();
  });

  it('intentional exporter release does not abort a successful build signal', async () => {
    const signal = await withBuildSnapshot(pool, { timeoutMs: 5000 }, async snapshot => snapshot.signal);
    await nextTurn();
    expect(signal.aborted).toBe(false);
  });

  it('exporter termination aborts the real child and retains the work lock until deployment settles', async () => {
    const applicationName = `snapshot-loss-${randomUUID()}`;
    const exporterPool = new pg.Pool({
      connectionString: url, application_name: applicationName, max: 1,
      options: `-c search_path=${schema}`, connectionTimeoutMillis: 1000, query_timeout: 2000,
    });
    const controller = new AbortController();
    const spawned = Promise.withResolvers<number>();
    const childStopped = Promise.withResolvers<void>();
    const finishDeployment = Promise.withResolvers<void>();
    const lock = createWorkLock();
    const capturedSignal = Promise.withResolvers<AbortSignal>();
    let operationSettled = false;
    let successorEntered = false;
    const operation = lock.runExclusive(() => withBuildSnapshot(exporterPool, { timeoutMs: 10000, signal: controller.signal }, async snapshot => {
      capturedSignal.resolve(snapshot.signal);
      try {
        // Real OS child: its close event, not a timing guess, proves termination.
        await runChildBuild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], tmpdir(), 15000,
          child => {
            if (child.pid === undefined) spawned.reject(new Error('Child did not spawn'));
            else spawned.resolve(child.pid);
          }, { snapshot, signal: snapshot.signal });
      } finally {
        childStopped.resolve();
        await finishDeployment.promise;
      }
    }));
    const result = operation.then(
      () => { operationSettled = true; return null; },
      error => { operationSettled = true; return error; },
    );
    try {
      const pid = await Promise.race([spawned.promise, result.then(() => { throw new Error('Capture ended before child spawn'); })]);
      const effectiveSignal = await capturedSignal.promise;
      // The unique application name belongs ONLY to this test's one exporter.
      const candidates = await owner.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
        WHERE application_name=$1 AND datname=current_database() AND usename=current_user
          AND state='idle in transaction' AND pid<>pg_backend_pid()`, [applicationName]);
      expect(candidates.rows).toHaveLength(1);
      const terminated = await owner.query<{ terminated: boolean }>(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
        WHERE pid=$1 AND application_name=$2 AND datname=current_database() AND usename=current_user`,
      [candidates.rows[0]!.pid, applicationName]);
      expect(terminated.rows).toEqual([{ terminated: true }]);
      await childStopped.promise;
      expect(effectiveSignal.aborted).toBe(true);
      expect(effectiveSignal.reason).toMatchObject({ message: 'Build snapshot connection lost' });
      expect(() => process.kill(pid, 0)).toThrow();
      const successor = lock.runExclusive(async () => { successorEntered = true; });
      await nextTurn();
      expect(operationSettled).toBe(false);
      expect(successorEntered).toBe(false);
      finishDeployment.resolve();
      expect(await result).toMatchObject({ message: 'Build snapshot connection lost' });
      await successor;
      expect(successorEntered).toBe(true);
    } finally {
      controller.abort(new Error('Test cleanup'));
      finishDeployment.resolve();
      await result;
      await exporterPool.end();
    }
  });

  it('releases the exporter after failure, cancellation and deadline', async () => {
    let exported = '';
    await expect(withBuildSnapshot(pool, { timeoutMs: 5000 }, async (snapshot) => {
      exported = snapshot.databaseSnapshot;
      throw new Error('child failed');
    })).rejects.toThrow('child failed');
    await expect(withLoaderSnapshot(pool, c => c.query('SELECT 1'), exported)).rejects.toThrow();
    const controller = new AbortController();
    await expect(withBuildSnapshot(pool, { timeoutMs: 5000, signal: controller.signal }, async (snapshot) => {
      exported = snapshot.databaseSnapshot;
      controller.abort(new Error('ownership lost'));
      snapshot.signal.throwIfAborted();
    })).rejects.toThrow('ownership lost');
    await expect(withLoaderSnapshot(pool, c => c.query('SELECT 1'), exported)).rejects.toThrow();
    await expect(withBuildSnapshot(pool, { timeoutMs: 1000 }, async (snapshot) => {
      exported = snapshot.databaseSnapshot;
      const stopped = Promise.withResolvers<void>();
      snapshot.signal.addEventListener('abort', () => stopped.resolve(), { once: true });
      await stopped.promise;
      snapshot.signal.throwIfAborted();
    })).rejects.toThrow('deadline');
    await expect(withLoaderSnapshot(pool, c => c.query('SELECT 1'), exported)).rejects.toThrow();
    expect(pool.waitingCount).toBe(0);
  });
});
