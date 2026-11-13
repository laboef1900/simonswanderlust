import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import sharp from 'sharp';
import { initializeApplicationSchema } from '../src/onboarding-bootstrap.js';
import { pgUserStore } from '../src/users.js';
import { pgPostStore } from '../src/posts.js';
import { pgMediaStore } from '../src/media-store.js';
import { emptyMediaExif } from '../src/exif.js';
import { uploadFile } from '../src/cli.js';

export interface StudioFixture {
  base: string;
  imageBase: string;
  username: string;
  password: string;
  tk: string;
  pool: pg.Pool;
  close(): Promise<void>;
}

export async function startStudio(): Promise<StudioFixture> {
  const testUrl = process.env.TEST_DATABASE_URL;
  assert(testUrl, 'Browser tests require TEST_DATABASE_URL; never fall back to DATABASE_URL');
  const owner = new pg.Pool({ connectionString: testUrl });
  const database = 'browser_' + randomUUID().replaceAll('-', '');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'studio-e2e-'));
  let pool: pg.Pool | undefined;
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  let created = false;
  const close = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const force = setTimeout(() => child?.kill('SIGKILL'), 15_000);
      await exited?.finally(() => clearTimeout(force));
    }
    await pool?.end();
    if (created) await owner.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await owner.end();
    await rm(root, { recursive: true, force: true });
  };
  try {
    await owner.query(`CREATE DATABASE ${database}`);
    created = true;
    const connection = new URL(testUrl);
    connection.pathname = '/' + database;
    connection.search = '';
    pool = new pg.Pool({ connectionString: connection.href });
    await initializeApplicationSchema(pool, () => {});
    await pool.query("UPDATE site_language SET primary_locale='de', enabled_locales=ARRAY['de']");
    const portServer = createServer();
    const listening = Promise.withResolvers<void>();
    portServer.once('error', listening.reject);
    portServer.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const address = portServer.address();
    assert(address && typeof address !== 'string');
    const port = address.port;
    const closed = Promise.withResolvers<void>();
    portServer.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    const base = `http://127.0.0.1:${port}`;
    const imageBase = `http://localhost:${port}`;
    await pool.query('UPDATE site_identity SET canonical_origin=$1', [base]);
    const username = 'browser-admin';
    const password = randomUUID() + randomUUID();
    const admin = await pgUserStore(pool).create({ username, password, isAdmin: true });
    const photo = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#416486' } }).png().toBuffer();
    const stored = await uploadFile(photo, 'fixtures/mountain', 'Mountain', { storageDir: join(root, 'images'), baseUrl: imageBase });
    await pgMediaStore(pool, { baseUrl: imageBase }).upsert({ key: stored.src.slice(imageBase.length + 1), title: 'Mountain', width: stored.width, height: stored.height,
      origBytes: photo.length, status: 'ready', exif: emptyMediaExif(), uploadedBy: admin.id });
    const posts = pgPostStore(pool);
    const draft = await posts.upsertDraft({ translationKey: '', status: 'draft', shared: { date: '2026-01-01', countryCode: 'DE', region: 'europe', coordinates: { lat: 48, lng: 11 } },
      de: { locale: 'de', slug: 'browser-story', title: 'Browser fixture', excerpt: 'A browser smoke story.', country: 'Deutschland', bodyMarkdown: 'Original story body.', images: {}, heroImage: { src: stored.src, width: stored.width, height: stored.height, alt: 'Mountain' } },
      en: { locale: 'en', omitted: true, slug: '', title: '', excerpt: '', country: '', bodyMarkdown: '', images: {}, heroImage: { src: '', width: 0, height: 0, alt: '' } },
    });
    const uploader = fileURLToPath(new URL('../', import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DATABASE_URL|PGOPTIONS|SITE_|PUBLIC_|IMG_HOST|BLOG_HOST|TRUSTED_PROXY|ENCRYPTION_KEY|ROUTING_|STORAGE_DIR|SETTINGS_PATH|BACKUP_DIR|MAP_DIR|PORT|HOST)/.test(key)));
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: uploader, env: { ...env,
      DATABASE_URL: connection.href, HOST: '127.0.0.1', PORT: String(port), PUBLIC_BASE_URL: imageBase, IMG_HOST: `localhost:${port}`,
      STORAGE_DIR: join(root, 'images'), SETTINGS_PATH: join(root, 'settings.json'), BACKUP_DIR: join(root, 'backup'),
      SITE_DIR: join(root, 'site'), SITE_APP_DIR: fileURLToPath(new URL('../../site', import.meta.url)), MAP_DIR: join(root, 'map'), ASTRO_TELEMETRY_DISABLED: '1',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    // Logs stay local and bounded; never upload session/credential-bearing traces.
    let log = '';
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => { log = (log + String(bytes)).slice(-12_000); });
    const stopped = Promise.withResolvers<void>();
    child.once('error', stopped.reject);
    child.once('exit', () => stopped.resolve());
    exited = stopped.promise;
    void exited.catch(() => {});
    const deadline = Date.now() + 90_000;
    while (!log.includes(`app listening on :${port}`)) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) throw new Error('Browser fixture app failed to start: ' + log.replaceAll(password, '[REDACTED]'));
      await delay(50);
    }
    return { base, imageBase, username, password, tk: draft.translationKey, pool, close };
  } catch (error) {
    await close();
    throw error;
  }
}
