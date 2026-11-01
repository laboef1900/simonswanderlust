import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import sharp from 'sharp';
import { extract } from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKUP_FILE_RE, DUMP_VERSION, IMAGES_ARCHIVE_RE, readDump } from '../src/backup.js';
import { uploadFile } from '../src/cli.js';
import { pgCommentStore } from '../src/comments.js';
import { ensureSchema, type DbPool } from '../src/db.js';
import { ROUTE_ARCHIVE_RE } from '../src/gpx-backup.js';
import { createGpxFiles, sourceDigest } from '../src/gpx-files.js';
import { pgMediaStore } from '../src/media-store.js';
import { pgPageStore } from '../src/pages.js';
import { pgPostStore, type PostLocale } from '../src/posts.js';
import { pgSecretsStore } from '../src/secrets.js';
import { APP_SESSION_PREFIX } from '../src/storage-owner.js';
import { pgUserStore } from '../src/users.js';
import type { PrivateGeometry } from '../public/gpx-geometry.js';
import { publishTokens } from './publish-tokens.js';
import { runCli } from './run-cli.js';

/**
 * Issue #295: the whole-blog recovery journey of the restore rehearsal runbook
 * (ARCHITECTURE.md), automated for the CURRENT dump version.
 *
 * backup.integration covers dump → restore on one live schema and
 * secrets.integration the CLI's secret handling; neither restores into a
 * FRESHLY BOOTSTRAPPED database and then boots the production composition
 * root on the result. This suite does exactly what the runbook does:
 *   1. a running app ("production", its own schema + /data) takes the backup
 *      through `POST /backups` — the recovery set an operator actually holds;
 *   2. a fresh stack (new schema, empty /data) boots once, so `ensureSchema`
 *      bootstraps it and `/setup` is open; the app is stopped and drained;
 *   3. the real restore CLI restores the copied set after the `yes` prompt, a
 *      second CLI run answered with EOF prints the live counts for comparison,
 *      the image archives are untarred oldest-first into an EMPTY images dir
 *      and settings.json is copied — all BEFORE the restored app starts;
 *   4. the real `src/main.ts` boots on the restored database with the escrowed
 *      key, and every user-visible surface named in the issue is checked.
 *
 * The static `astro build` is deliberately out of scope (SITE_APP_DIR points
 * at nothing, as in the other boot suites): it needs the site toolchain. The
 * draft preview renders the restored body through the same Markdown/gallery
 * renderer and library-metadata overlay the build uses, which is the in-suite
 * evidence that a story and its gallery render; the runbook covers the build.
 *
 * Isolation: two schemas with random names, both derived only from
 * TEST_DATABASE_URL and dropped afterwards, plus private temp dirs. The
 * storage-owner lease and the restore drain check are DATABASE-wide, so like
 * gpx-main-boot this suite relies on the serial integration project.
 */

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const uploaderDir = fileURLToPath(new URL('..', import.meta.url));

// The rehearsal keeps production's image origin: gallery URLs are allow-listed
// by origin equality, so a different PUBLIC_BASE_URL would silently drop them.
const IMAGE_BASE = 'https://img.rehearsal.test';
const IMG_HOST = 'img.rehearsal.test';
const ADMIN = { username: 'rehearsal-admin', password: 'synthetic-admin-password' };
const AUTHOR = { username: 'rehearsal-author', password: 'synthetic-author-password' };
const REVIEW_KEY = 'synthetic-review-key-fixture';
const LIBRARY = {
  alt: { de: 'Bergsee im Morgenlicht', en: 'Mountain lake at dawn' },
  caption: { de: 'Aus der Bibliothek wiederhergestellt', en: 'Restored from the library' },
};
const GEOMETRY: PrivateGeometry = { version: 1, segments: [{ points: [
  { lat: 46.512345678, lng: 8.123456789, elevation: 1820.5, time: '2026-08-14T06:00:00.000Z' },
  { lat: 46.513345678, lng: 8.124456789, elevation: 1835.25, time: '2026-08-14T06:20:00.000Z' },
] }] };
const GPX = Buffer.from('<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><trkseg><trkpt lat="46.512345678" lon="8.123456789"><ele>1820.5</ele><time>2026-08-14T06:00:00.000Z</time></trkpt><trkpt lat="46.513345678" lon="8.124456789"><ele>1835.25</ele><time>2026-08-14T06:20:00.000Z</time></trkpt></trkseg></trk></gpx>');

interface ProcessExit { code: number | null; signal: NodeJS.Signals | null }
interface RunningApp { child: ChildProcess; exited: Promise<ProcessExit>; log: () => string; base: string; port: number }

async function freePort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  const closed = Promise.withResolvers<void>();
  server.close((error) => (error ? closed.reject(error) : closed.resolve()));
  await closed.promise;
  if (!address || typeof address === 'string') throw new Error('No loopback TCP address');
  return address.port;
}

// Spawned processes and PostgreSQL cannot be driven by fake clocks: poll the
// observable state; the deadline only bounds a failure.
async function until(check: () => Promise<boolean>, detail: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Rehearsal fixture did not reach the expected state:\n${detail()}`);
    await delay(25);
  }
}

/** One GET to the image host by its configured Host header (node:http sets it verbatim). */
function fromImageHost(port: number, path: string): Promise<{ status: number; body: Buffer }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: Buffer }>();
  const req = request({ host: '127.0.0.1', port, path, headers: { host: IMG_HOST } }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    res.on('error', reject);
  });
  req.on('error', reject);
  req.end();
  return promise;
}

async function listOrEmpty(dir: string): Promise<string[]> {
  try { return await readdir(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function reportedCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of text.matchAll(/\b([a-z_]+)\s+(\d+)\b/g)) {
    counts[match[1]!] = Number(match[2]);
  }
  return counts;
}

maybe('restore rehearsal: app backup → fresh database → restore CLI → production boot (Postgres)', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const productionSchema = `rehearsal_prod_${suffix}`;
  const rehearsalSchema = `rehearsal_fresh_${suffix}`;
  const encryptionKey = randomBytes(32).toString('hex');
  const apps: RunningApp[] = [];
  let observer: DbPool;
  let productionPool: DbPool;
  let productionUrl: string;
  let rehearsalUrl: string;
  let productionRoot: string;
  let rehearsalRoot: string;
  let inputDir: string;
  let dumpName: string;
  let imageArchives: string[];
  let tk: string;
  let adminId: string;
  let photoKey: string;
  let storedFiles: string[];
  let restored: RunningApp;

  function scopedUrl(schema: string, label: string): string {
    const scoped = new URL(url!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    scoped.searchParams.set('application_name', `restore-rehearsal:${label}`);
    return scoped.toString();
  }

  /** The /data layout both the app and the restore CLI derive their paths from. */
  const dataEnv = (root: string): NodeJS.ProcessEnv => ({
    STORAGE_DIR: join(root, 'images'), SETTINGS_PATH: join(root, 'settings.json'), BACKUP_DIR: join(root, 'backup'),
  });

  function cliEnv(): NodeJS.ProcessEnv {
    // Restore needs no master key: prove it by never handing the CLI one.
    const { ENCRYPTION_KEY: _withheld, ...inherited } = process.env;
    return { ...inherited, ...dataEnv(rehearsalRoot), DATABASE_URL: rehearsalUrl, PGOPTIONS: '' };
  }

  async function bootApp(root: string, databaseUrl: string, key: string | undefined): Promise<RunningApp> {
    const port = await freePort();
    const { ENCRYPTION_KEY: _inherited, TRUSTED_PROXY: _proxyInherited, ...inherited } = process.env;
    const env: NodeJS.ProcessEnv = {
      ...inherited, ...dataEnv(root), DATABASE_URL: databaseUrl, HOST: '127.0.0.1', PORT: String(port),
      PUBLIC_BASE_URL: IMAGE_BASE, IMG_HOST, SITE_DIR: join(root, 'site'),
      SITE_APP_DIR: join(root, 'deliberately-unavailable-site-app'), MAP_DIR: join(root, 'map'), PGOPTIONS: '',
    };
    if (key !== undefined) env.ENCRYPTION_KEY = key;
    const child = spawn(process.execPath, ['--import', 'tsx', join(uploaderDir, 'src', 'main.ts')], {
      cwd: uploaderDir, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout!.on('data', (bytes: Buffer) => { log += bytes.toString(); });
    child.stderr!.on('data', (bytes: Buffer) => { log += bytes.toString(); });
    const exit = Promise.withResolvers<ProcessExit>();
    child.once('error', exit.reject);
    child.once('exit', (code, signal) => exit.resolve({ code, signal }));
    const exited = exit.promise;
    void exited.catch(() => {});
    const app: RunningApp = { child, exited, log: () => log, base: `http://127.0.0.1:${port}`, port };
    apps.push(app);
    await until(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`main.ts exited during boot:\n${log}`);
      return log.includes(`app listening on :${port}`);
    }, app.log);
    return app;
  }

  /** `docker compose stop app`: SIGTERM, a clean exit, then wait until its database sessions drained. */
  async function stopApp(app: RunningApp): Promise<void> {
    if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill('SIGTERM');
    const force = setTimeout(() => app.child.kill('SIGKILL'), 15_000);
    const result = await app.exited.finally(() => clearTimeout(force));
    expect(result, app.log()).toEqual({ code: 0, signal: null });
    await until(async () => {
      const { rows } = await observer.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND starts_with(application_name, $1)',
        [APP_SESSION_PREFIX],
      );
      return rows[0]!.n === 0;
    }, app.log);
  }

  async function login(app: RunningApp, who: { username: string; password: string }): Promise<string> {
    const response = await fetch(`${app.base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: app.base }, body: JSON.stringify(who),
    });
    expect(response.status, app.log()).toBe(200);
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(cookie).toMatch(/^sid=.+/);
    return cookie;
  }

  beforeAll(async () => {
    observer = new pg.Pool({ connectionString: url });
    await observer.query(`CREATE SCHEMA ${productionSchema}`);
    await observer.query(`CREATE SCHEMA ${rehearsalSchema}`);
    productionUrl = scopedUrl(productionSchema, 'production');
    rehearsalUrl = scopedUrl(rehearsalSchema, 'rehearsal');
    const tmp = await realpath(tmpdir());
    productionRoot = await mkdtemp(join(tmp, 'restore-rehearsal-production-'));
    rehearsalRoot = await mkdtemp(join(tmp, 'restore-rehearsal-data-'));
    inputDir = await mkdtemp(join(tmp, 'restore-rehearsal-input-'));

    // ── "Production": one story with everything a recovery must bring back ──
    productionPool = new pg.Pool({ connectionString: productionUrl });
    await ensureSchema(productionPool);
    const users = pgUserStore(productionPool);
    adminId = (await users.create({ ...ADMIN, isAdmin: true })).id;
    await users.create({ ...AUTHOR, isAdmin: false });

    const photo = await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 38, g: 104, b: 156 } } }).png().toBuffer();
    // The CLI uploader's real encode + content-hashed key + original retention.
    const stored = await uploadFile(photo, 'trips/bergsee/see', 'Bergsee', { storageDir: join(productionRoot, 'images'), baseUrl: IMAGE_BASE });
    photoKey = stored.src.slice(`${IMAGE_BASE}/`.length);
    storedFiles = stored.files;
    expect(storedFiles.filter((file) => file.includes('-orig.'))).toHaveLength(1);
    const media = pgMediaStore(productionPool, { baseUrl: IMAGE_BASE });
    await media.createFolder('reisen/bergsee');
    await media.upsert({
      key: photoKey, folder: 'reisen/bergsee', title: 'Bergsee', alt: LIBRARY.alt, caption: LIBRARY.caption, tags: ['see', 'morgen'],
      width: stored.width, height: stored.height, origBytes: photo.length, status: 'ready',
      exif: { takenAt: null, camera: null, lens: null, lat: 46.5123, lng: 8.1234 }, uploadedBy: adminId,
    });

    const posts = pgPostStore(productionPool);
    const photoSrc = `${IMAGE_BASE}/${photoKey}`;
    const locale = (l: 'de' | 'en'): PostLocale => ({
      locale: l,
      slug: l === 'de' ? 'probe-am-bergsee' : 'rehearsal-at-the-lake',
      title: l === 'de' ? 'Probe am Bergsee' : 'Rehearsal at the lake',
      excerpt: l === 'de' ? 'Eine Geschichte, die die Wiederherstellung überlebt.' : 'A story that survives the restore.',
      country: l === 'de' ? 'Schweiz' : 'Switzerland',
      heroImage: { src: photoSrc, width: stored.width, height: stored.height, alt: l === 'de' ? 'Bergsee' : 'Mountain lake' },
      bodyMarkdown: `${l === 'de' ? 'Der Morgen am See.' : 'Morning at the lake.'}\n\n\`\`\`gallery\n${photoSrc}\n\`\`\`\n`,
      // The post's own copy; the restored library rows must win in the gallery.
      images: { [photoSrc]: { width: stored.width, height: stored.height, alt: 'Kopierter Post-Alt', caption: 'Kopierte Unterschrift' } },
    });
    const pair = await posts.upsertDraft({
      translationKey: '', status: 'draft',
      shared: { date: '2026-08-14', countryCode: 'CH', region: 'europe', coordinates: { lat: 46.5, lng: 8.1 } },
      de: locale('de'), en: locale('en'),
    });
    tk = pair.translationKey;
    await posts.publish(tk, await publishTokens(posts, tk));

    const comments = pgCommentStore(productionPool);
    const reader = await comments.create({ translationKey: tk, locale: 'de', name: 'Leserin', body: 'Wunderschöner See!' });
    await comments.approve(reader.id);
    await comments.replyAsAuthor({ translationKey: tk, body: 'Danke fürs Lesen!', postedLocale: 'de' }, 'Rehearsal author');
    await comments.create({ translationKey: tk, locale: 'en', name: 'Waiting reader', body: 'Still in moderation' });

    await pgPageStore(productionPool).save({
      key: 'about',
      de: { locale: 'de', title: 'Über die Probe', bodyMarkdown: 'Diese Seite überlebt die Wiederherstellung.', images: {} },
      en: { locale: 'en', title: 'About the rehearsal', bodyMarkdown: 'This page survives the restore.', images: {} },
    });

    // A private route row + retained original, seeded the way gpx-backup.integration does.
    const files = createGpxFiles({ storageDir: join(productionRoot, 'images') });
    const source = { translationKey: tk, sourceId: randomUUID(), sha256: sourceDigest(GPX), bytes: GPX.length };
    await files.writeOriginal(source, GPX);
    await productionPool.query(
      `INSERT INTO post_routes (translation_key, version, geometry, source_id, source_sha256, source_bytes, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
      [tk, randomUUID(), JSON.stringify(GEOMETRY), source.sourceId, source.sha256, source.bytes, '2026-08-14T07:00:00.000Z'],
    );

    await pgSecretsStore(productionPool, Buffer.from(encryptionKey, 'hex')).set('ai_provider_key:openrouter', REVIEW_KEY);
    await writeFile(join(productionRoot, 'settings.json'), JSON.stringify({
      aiProviders: [
        { id: 'lm-studio', name: 'Local LM Studio', kind: 'lm-studio', baseUrl: 'http://localhost:1234/v1' },
        { id: 'openrouter', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
      ],
      aiDefaultProviderId: 'lm-studio', reviewProviderId: 'openrouter', captionProviderId: null,
      commentsEnabled: true, backupSchedule: 'off',
    }));

    // ── The recovery set: taken by the running app, exactly like "Back up now" ──
    const production = await bootApp(productionRoot, productionUrl, encryptionKey);
    const cookie = await login(production, ADMIN);
    const backup = await fetch(`${production.base}/backups`, { method: 'POST', headers: { cookie, origin: production.base } });
    expect(backup.status, production.log()).toBe(200);
    const state = await backup.json() as Record<string, unknown>;
    expect(state.lastError, production.log()).toBeUndefined();
    expect(state.routeRecovery).toEqual({ status: 'complete', present: 1, missing: 0, corrupt: 0, unreadable: 0, oversized: 0 });
    await stopApp(production);

    // The operator's copy of the set (offsite, or the production backup dir):
    // the dump, the routes archive its manifest names, and every image archive.
    const backupDir = join(productionRoot, 'backup', 'db');
    const names = await readdir(backupDir);
    const dumps = names.filter((name) => BACKUP_FILE_RE.test(name));
    expect(dumps).toHaveLength(1);
    dumpName = dumps[0]!;
    const dump = readDump(join(backupDir, dumpName));
    expect(dump.version).toBe(DUMP_VERSION);
    expect(dump.tables.post_routes).toHaveLength(1);
    const routeArchive = dump.routeArchive?.name;
    expect(routeArchive).toMatch(ROUTE_ARCHIVE_RE);
    imageArchives = names.filter((name) => IMAGES_ARCHIVE_RE.test(name)).sort();
    expect(imageArchives).toHaveLength(1);
    // Copies, never hard links: readDump refuses a dump with more than one link.
    for (const name of [dumpName, routeArchive!, ...imageArchives]) await copyFile(join(backupDir, name), join(inputDir, name));
  }, 120_000);

  afterAll(async () => {
    for (const app of apps.reverse()) {
      if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill('SIGTERM');
      const force = setTimeout(() => app.child.kill('SIGKILL'), 5_000);
      try { await app.exited; } finally { clearTimeout(force); }
    }
    await productionPool?.end();
    if (observer) {
      await observer.query(`DROP SCHEMA IF EXISTS ${productionSchema} CASCADE`);
      await observer.query(`DROP SCHEMA IF EXISTS ${rehearsalSchema} CASCADE`);
      await observer.end();
    }
    for (const dir of [productionRoot, rehearsalRoot, inputDir]) if (dir) await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('brings the whole blog back into a freshly bootstrapped database and the real app serves it', async () => {
    // ── Fresh stack: first boot bootstraps the schema; zero users opens /setup ──
    const fresh = await bootApp(rehearsalRoot, rehearsalUrl, encryptionKey);
    expect(await (await fetch(`${fresh.base}/auth/status`)).json()).toEqual({ authenticated: false, needsSetup: true });
    await stopApp(fresh);

    // ── Restore CLI, confirmed with a typed `yes` ──
    const dumpPath = join(inputDir, dumpName);
    const run = await runCli(['restore', dumpPath], cliEnv(), 'yes\n');
    expect(run.code, run.stdout + run.stderr).toBe(0);
    // The CLI names its target as host:port/dbname — never credentials, never the search_path.
    const target = new URL(url!);
    expect(run.stdout).toContain(`target database: ${target.hostname}${target.port ? `:${target.port}` : ''}${target.pathname}`);
    const dumpCounts = /^dump: .* \(v(\d+), created [^)]+\) — (.+)$/m.exec(run.stdout);
    expect(dumpCounts?.[1]).toBe(String(DUMP_VERSION));
    expect(reportedCounts(dumpCounts?.[2] ?? '')).toMatchObject({
      users: 2, posts: 2, pages: 2, media: 1, media_folders: 2, comments: 3, post_routes: 1,
    });
    // The bootstrapped database holds only the seeded About page before restore.
    expect(reportedCounts(run.stdout.split('\n').find((line) => line.includes('live rows')) ?? '')).toMatchObject({
      users: 0, posts: 0, pages: 2, media: 0, media_folders: 0, comments: 0, post_routes: 0,
    });
    for (const secret of [REVIEW_KEY, ADMIN.password, AUTHOR.password, encryptionKey]) {
      expect(run.stdout + run.stderr).not.toContain(secret);
    }
    // The undo set captured the bootstrapped state inside the disposable /data.
    const undoNames = (await readdir(join(rehearsalRoot, 'backup', 'db'))).filter((name) => BACKUP_FILE_RE.test(name));
    expect(undoNames).toHaveLength(1);
    const undoPath = join(rehearsalRoot, 'backup', 'db', undoNames[0]!);
    expect(run.stdout).toContain(undoPath);
    expect(readDump(undoPath).tables.users).toEqual([]);

    // ── Runbook count check: a second run answered with EOF prints the live counts, changes nothing ──
    const check = await runCli(['restore', dumpPath], cliEnv());
    expect(check.code).toBe(1);
    expect(reportedCounts(check.stdout.split('\n').find((line) => line.includes('live rows')) ?? ''))
      .toMatchObject(reportedCounts(dumpCounts![2]!));
    expect((await readdir(join(rehearsalRoot, 'backup', 'db'))).filter((name) => BACKUP_FILE_RE.test(name))).toEqual(undoNames);

    // ── Files, BEFORE the restored app boots: its boot reconcile would otherwise mark every photo missing ──
    const imagesDir = join(rehearsalRoot, 'images');
    expect(await listOrEmpty(imagesDir)).toEqual([]);
    await mkdir(imagesDir, { recursive: true });
    for (const name of imageArchives) await extract({ file: join(inputDir, name), cwd: imagesDir, strict: true });
    await copyFile(join(productionRoot, 'settings.json'), join(rehearsalRoot, 'settings.json'));

    // ── The restored stack, with the escrowed master key ──
    restored = await bootApp(rehearsalRoot, rehearsalUrl, encryptionKey);
    await until(async () => restored.log().includes('media-sync: scanned'), restored.log);

    // Accounts: setup is closed again and the original credentials work.
    expect(await (await fetch(`${restored.base}/auth/status`)).json()).toEqual({ authenticated: false, needsSetup: false });
    const setup = await fetch(`${restored.base}/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: restored.base },
      body: JSON.stringify({ username: 'intruder', password: 'intruder-password-123' }),
    });
    expect(setup.status).toBe(409);
    const admin = await login(restored, ADMIN);
    const author = await login(restored, AUTHOR);
    expect(await (await fetch(`${restored.base}/auth/status`, { headers: { cookie: author } })).json())
      .toMatchObject({ authenticated: true, username: AUTHOR.username, isAdmin: false });

    // Rescan: nothing missing, demoted, adopted or re-queued.
    const rescan = await fetch(`${restored.base}/media/rescan`, { method: 'POST', headers: { cookie: admin, origin: restored.base } });
    expect(rescan.status).toBe(200);
    expect(await rescan.json()).toEqual({ scanned: 1, inserted: 0, altHarvested: 0, markedMissing: 0, demoted: 0, recovered: 0 });

    // Media library: folder, descriptions, tags, attribution and GPS — still redacted for authors.
    const item = `${restored.base}/media/items/${photoKey}`;
    expect(await (await fetch(item, { headers: { cookie: admin } })).json()).toMatchObject({
      key: photoKey, folder: 'reisen/bergsee', alt: LIBRARY.alt, caption: LIBRARY.caption, tags: ['see', 'morgen'],
      status: 'ready', uploadedBy: adminId, exif: { lat: 46.5123, lng: 8.1234 },
    });
    expect(await (await fetch(item, { headers: { cookie: author } })).json()).toMatchObject({
      key: photoKey, uploadedBy: null, exif: { lat: null, lng: null },
    });

    // The image host serves the untarred variants byte-for-byte; the original stays private.
    for (const file of storedFiles) {
      const served = await fromImageHost(restored.port, `/${file}`);
      if (file.includes('-orig.')) { expect(served.status, file).toBe(404); continue; }
      expect(served.status, file).toBe(200);
      expect(served.body.equals(await readFile(join(productionRoot, 'images', file)))).toBe(true);
    }

    // The story renders, with its gallery described by the restored library rows.
    for (const [loc, title] of [['de', 'Probe am Bergsee'], ['en', 'Rehearsal at the lake']] as const) {
      const preview = await fetch(`${restored.base}/posts/${tk}/preview?locale=${loc}`, { headers: { cookie: author } });
      expect(preview.status).toBe(200);
      const html = await preview.text();
      expect(html).toContain(title);
      expect(html).toContain('class="jgal');
      expect(html).toContain(`alt="${LIBRARY.alt[loc]}"`);
      expect(html).toContain(LIBRARY.caption[loc]);
      expect(html).not.toContain('Kopierter Post-Alt');
    }
    const list = await fetch(`${restored.base}/posts`, { headers: { cookie: author } });
    expect((await list.json() as Record<string, unknown>[]).find((summary) => summary.translationKey === tk))
      .toMatchObject({ status: 'published', slugs: { de: 'probe-am-bergsee', en: 'rehearsal-at-the-lake' } });
    expect(await (await fetch(`${restored.base}/pages/about`, { headers: { cookie: author } })).json()).toMatchObject({
      de: { title: 'Über die Probe' }, en: { title: 'About the rehearsal' },
    });

    // Comments: approved thread public (settings.json's site switch came back too), pending still queued.
    expect(await (await fetch(`${restored.base}/comments?tk=${tk}`)).json()).toMatchObject({
      enabled: true,
      comments: [
        { authorName: 'Leserin', body: 'Wunderschöner See!', isAuthor: false },
        { authorName: 'Rehearsal author', body: 'Danke fürs Lesen!', isAuthor: true },
      ],
    });
    const queue = await (await fetch(`${restored.base}/moderation/comments?status=pending`, { headers: { cookie: admin } })).json() as Record<string, unknown>;
    expect(queue.comments).toEqual([expect.objectContaining({ translationKey: tk, body: 'Still in moderation' })]);

    // AI credentials decrypt with the escrowed key, bound to the restored provider registry.
    expect(await (await fetch(`${restored.base}/ai-config`, { headers: { cookie: author } })).json()).toMatchObject({
      aiProvider: 'openrouter', aiBaseUrl: 'https://openrouter.ai/api/v1', hasAiApiKey: true, aiApiKey: REVIEW_KEY,
    });

    // The private route: precise geometry and the original upload, still authenticated-only.
    expect(await (await fetch(`${restored.base}/posts/${tk}/route`, { headers: { cookie: author } })).json())
      .toMatchObject({ geometry: GEOMETRY, originalAvailable: true });
    const gpx = await fetch(`${restored.base}/posts/${tk}/route/original`, { headers: { cookie: author } });
    expect(gpx.status).toBe(200);
    expect(Buffer.from(await gpx.arrayBuffer()).equals(GPX)).toBe(true);
    expect((await fetch(`${restored.base}/posts/${tk}/route`)).status).toBe(401);

    for (const secret of [REVIEW_KEY, ADMIN.password, AUTHOR.password, encryptionKey]) {
      expect(restored.log()).not.toContain(secret);
    }
    await stopApp(restored);
    const cases = [
      { key: undefined, code: 'encryption_key_unconfigured' },
      { key: randomBytes(32).toString('hex'), code: 'ai_secret_unavailable' },
    ] as const;
    for (const { key, code } of cases) {
      const app = await bootApp(rehearsalRoot, rehearsalUrl, key);
      const cookie = await login(app, AUTHOR);
      const config = await fetch(`${app.base}/ai-config`, { headers: { cookie } });
      expect(config.status, code).toBe(503);
      expect(await config.json()).toMatchObject({ code });
      const preview = await fetch(`${app.base}/posts/${tk}/preview?locale=de`, { headers: { cookie } });
      expect(preview.status).toBe(200);
      expect(await preview.text()).toContain(`alt="${LIBRARY.alt.de}"`);
      expect(app.log()).not.toContain(REVIEW_KEY);
      await stopApp(app);
    }
  }, 180_000);
});
