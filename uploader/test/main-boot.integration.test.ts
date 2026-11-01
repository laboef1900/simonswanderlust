import { publishTokens } from './publish-tokens.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, symlink, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgPostStore } from '../src/posts.js';
import { pgUserStore } from '../src/users.js';
import { pgSecretsStore } from '../src/secrets.js';
import { pgJourneyStore } from '../src/journeys.js';
import { pgMediaStore } from '../src/media-store.js';
import sharp from 'sharp';

import { seedSiteIdentity, type IdentityRecord } from '../src/site-identity.js';
const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const addr = srv.address();
    if (addr === null || typeof addr === 'string') return reject(new Error('no TCP address'));
    srv.close(() => resolve(addr.port));
  });
});

/** Node's fetch rewrites Host; use the wire transport to exercise proxy authority. */
function requestWithHost(url: string, options: { method: string; headers: Record<string, string>; body: string }): Promise<Response> {
  const { promise, resolve, reject } = Promise.withResolvers<Response>();
  const req = request(url, { method: options.method, headers: options.headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.once('error', reject);
    res.once('end', () => {
      const headers = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
      }
      resolve(new Response(Buffer.concat(chunks).toString(), { status: res.statusCode!, headers }));
    });
  });
  req.once('error', reject);
  // Bound a stalled real socket; this is not a sleep or a timing assertion.
  req.setTimeout(10_000, () => req.destroy(new Error('HTTP fixture request timed out')));
  req.end(options.body);
  return promise;
}

/** `{ comments: [...] }` from a comment route, narrowed at runtime. */
function commentsOf(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== 'object' || !('comments' in body) || !Array.isArray(body.comments)) {
    throw new Error(`not a comment list: ${JSON.stringify(body)}`);
  }
  return body.comments.filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object');
}

/**
 * Boots the real `src/main.ts` — the production composition root — rather than
 * `buildServer` with hand-picked stores. Every other comment suite injects its
 * stores directly, which is how a deployed container shipped with the comment
 * stores never passed in: all comment routes answered 503 while CI was green.
 */
maybe.each(['split', 'loopback'] as const)('production boot (src/main.ts, Postgres, %s origins)', (topology) => {
  let pool: DbPool;
  let owner: DbPool;
  let fixtureDatabaseUrl: string;
  const schema = `main_boot_${randomBytes(12).toString('hex')}`;
  let dir: string;
  let child: ChildProcess;
  let base: string;
  let blogOrigin: string;
  let blogHost: string;
  let imageOrigin: string;
  let commentHeaders: Record<string, string>;
  let tk: string;
  let username: string;
  const password = 'password123456';
  const encryptionKey = randomBytes(32);
  let settingsPath: string;
  let bootLog = '';
  const orphanJourneyId = randomUUID();
  let journeyId: string | undefined;
  let heroKey: string;
  const previousRelease = '1760000000000-1-0000';
  const interruptedAttempt = '1760000001000-1-0001';
  const interruptedStartedAt = new Date(1760000001000).toISOString();
  let initialBuildStatus: { status: number; cacheControl: string | null; body: unknown; disk: string };

  beforeAll(async () => {
    owner = createPool(url!);
    await owner.query(`CREATE SCHEMA ${schema}`);
    const fixtureUrl = new URL(url!);
    fixtureUrl.searchParams.set('options', `-c search_path=${schema}`);
    fixtureDatabaseUrl = fixtureUrl.href;
    pool = createPool(fixtureDatabaseUrl);
    await ensureSchema(pool);
    // This scenario exercises #319's request-origin fallback, not legacy upgrade
    // seeding. Seed the isolated fresh install before it gains fixture content.
    await seedSiteIdentity(pool);
    const stamp = Date.now();
    username = `boot${stamp}`;
    await pgUserStore(pool).create({ username, password, isAdmin: true });
    const posts = pgPostStore(pool);
    const loc = (locale: 'de' | 'en') => ({
      locale, slug: `boot-${locale}-${stamp}`, title: 'T', excerpt: 'e', country: 'X',
      heroImage: { src: 'https://i/h', width: 10, height: 10, alt: 'a' }, bodyMarkdown: '## b', images: {},
    });
    const created = await posts.upsertDraft({
      translationKey: '', status: 'draft',
      shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 1, lng: 2 } },
      de: loc('de'), en: loc('en'),
    });
    tk = created.translationKey;
    await posts.publish(tk, await publishTokens(posts, tk));

    dir = await mkdtemp(join(await realpath(tmpdir()), 'main-boot-'));
    settingsPath = join(dir, 'settings.json');
    // An existing release suppresses boot rebuilding; the newly acquired owner
    // must still initialize the durable record before accepting HTTP requests.
    await mkdir(join(dir, 'site', 'releases', previousRelease), { recursive: true });
    await writeFile(join(dir, 'site', 'releases', previousRelease, 'index.html'), 'Previous release');
    await symlink(join('releases', previousRelease), join(dir, 'site', 'current'));
    await writeFile(join(dir, 'site', 'build-state.json'), JSON.stringify({
      schema: 1, running: { attemptId: interruptedAttempt, startedAt: interruptedStartedAt, triggers: ['publish'] }, last: null,
    }));
    // A pre-registry install: review on OpenRouter, captions local, and the one
    // shared key in the legacy slot. Boot must migrate both before listen().
    await pool.query("DELETE FROM app_secrets WHERE key IN ('ai_api_key', 'ai_provider_key:openrouter')");
    await pgSecretsStore(pool, encryptionKey).set('ai_api_key', 'boot-legacy-fixture');
    await writeFile(settingsPath, JSON.stringify({
      commentsEnabled: true, lmBaseUrl: 'http://localhost:1234/v1', aiProvider: 'openrouter', aiCustomBaseUrl: '',
      captionProvider: 'lm-studio', captionCustomBaseUrl: '',
    }));
    const port = await freePort();
    base = `http://localhost:${port}`;
    blogOrigin = topology === 'split' ? 'https://blog.example' : base;
    blogHost = new URL(blogOrigin).host;
    imageOrigin = topology === 'split' ? 'https://images.example' : base;
    // The real builder runs the installed Astro binary against a minimal site;
    // no fake builder or fake executable can hide a missing production wire-up.
    const siteApp = join(dir, 'site-app');
    await mkdir(join(siteApp, 'src', 'pages'), { recursive: true });
    await symlink(fileURLToPath(new URL('../../site/node_modules', import.meta.url)), join(siteApp, 'node_modules'), 'dir');
    await writeFile(join(siteApp, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(siteApp, 'src', 'pages', 'index.astro'), '<!doctype html><html lang="en"><title>Boot fixture</title><body>Boot fixture</body></html>');
    heroKey = 'journey-boot-' + stamp;
    await mkdir(join(dir, 'images'), { recursive: true });
    const hero = sharp({ create: { width: 640, height: 400, channels: 3, background: '#416486' } });
    await Promise.all([
      hero.clone().jpeg().toFile(join(dir, 'images', heroKey + '-orig.jpg')),
      hero.clone().webp().toFile(join(dir, 'images', heroKey + '-640.webp')),
      hero.clone().avif().toFile(join(dir, 'images', heroKey + '-640.avif')),
    ]);
    await pgMediaStore(pool, { baseUrl: imageOrigin }).upsert({ key: heroKey, width: 640, height: 400, origBytes: 1, status: 'ready',
      exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null });
    // Both working and retained snapshot orphans must be repaired before admission.
    const snapshot = { version: 1, members: [tk, 'missing-journey-boot-story'], locales: {
      de: { slug: 'boot-journey-' + stamp, title: 'Boot journey', intro: 'Intro', heroImage: { src: imageOrigin + '/' + heroKey, width: 640, height: 400, alt: 'Landscape' } },
      en: { slug: 'boot-journey-' + stamp, title: 'Boot journey', intro: 'Intro', heroImage: { src: imageOrigin + '/' + heroKey, width: 640, height: 400, alt: 'Landscape' } },
    } };
    await pool.query("INSERT INTO journeys(id,status,published_snapshot,published_at,updated_at) VALUES ($1,'draft',$2,now(),'2020-01-01')", [orphanJourneyId, snapshot]);
    for (const locale of ['de', 'en'] as const) {
      const row = snapshot.locales[locale];
      await pool.query('INSERT INTO journey_locales(journey_id,locale,slug,title,intro,hero_image,omitted,published_at) VALUES($1,$2,$3,$4,$5,$6,false,now())', [orphanJourneyId, locale, row.slug, row.title, row.intro, row.heroImage]);
    }
    await pool.query('INSERT INTO journey_members(journey_id,translation_key,position) VALUES ($1,$2,0),($1,$3,1)', [orphanJourneyId, 'missing-journey-boot-story', tk]);
    commentHeaders = {
      'content-type': 'application/json', host: blogHost, origin: blogOrigin,
      'x-forwarded-proto': new URL(blogOrigin).protocol.slice(0, -1),
    };
    const { ENCRYPTION_KEY: _unused, TRUSTED_PROXY: _proxyUnused, ...env } = process.env;
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...env,
        ENCRYPTION_KEY: encryptionKey.toString('hex'),
        DATABASE_URL: fixtureDatabaseUrl,
        PORT: String(port),
        HOST: '127.0.0.1',
        PUBLIC_BASE_URL: imageOrigin,
        IMG_HOST: new URL(imageOrigin).host,
        STORAGE_DIR: join(dir, 'images'),
        SETTINGS_PATH: settingsPath,
        SITE_DIR: join(dir, 'site'),
        SITE_APP_DIR: siteApp,
        BACKUP_DIR: join(dir, 'backup'),
        MAP_DIR: join(dir, 'map'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const onData = (b: Buffer) => {
        bootLog += b.toString();
        if (bootLog.includes(`app listening on :${port}`)) resolve();
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', (b: Buffer) => { bootLog += b.toString(); });
      child.once('exit', (code) => reject(new Error(`main.ts exited ${code}:\n${bootLog}`)));
    });
    // Capture boot facts before any test can legitimately promote a new release.
    const login = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username, password }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const response = await fetch(`${base}/rebuild/status`, { headers: { cookie } });
    initialBuildStatus = { status: response.status, cacheControl: response.headers.get('cache-control'),
      body: await response.json(), disk: await readFile(join(dir, 'site', 'build-state.json'), 'utf8') };
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    if (journeyId) await pool.query('DELETE FROM journeys WHERE id=$1', [journeyId]);
    await pool?.query('DELETE FROM journeys WHERE id=$1', [orphanJourneyId]);
    if (heroKey) await pool.query('DELETE FROM media WHERE key=$1', [heroKey]);
    if (tk) await pgPostStore(pool).remove(tk);
    if (username) await pool.query('DELETE FROM users WHERE username = $1', [username]);
    await pool?.query("DELETE FROM app_secrets WHERE key IN ('ai_api_key', 'ai_provider_key:openrouter')");
    await pool?.end();
    if (owner) { await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await owner.end(); }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('repairs all orphan references before serving and wires journey publication through the real builder', async () => {
    // Journey heroes live on the image origin, which differs from the app origin in the split topology.
    const media = pgMediaStore(pool, { baseUrl: imageOrigin });
    const store = pgJourneyStore(pool, media, imageOrigin);
    const repaired = await store.get(orphanJourneyId);
    expect(repaired?.members).toEqual([tk]);
    expect(repaired?.publishedSnapshot?.members).toEqual([tk]);
    expect(repaired!.updatedAt.getTime()).toBeGreaterThan(Date.parse('2020-01-01'));
    const positions = await pool.query('SELECT position FROM journey_members WHERE journey_id=$1 ORDER BY position', [orphanJourneyId]);
    expect(positions.rows).toEqual([{ position: 0 }]);
    // Release the boot fixture's working claim, without touching its retained snapshot.
    const writable = (row: NonNullable<typeof repaired>['de']) => ({ slug: row.slug, title: row.title, intro: row.intro, heroImage: row.heroImage, omitted: row.omitted });
    await store.save(orphanJourneyId, { de: writable(repaired!.de), en: writable(repaired!.en), members: [] }, repaired!.updatedAt);
    const login = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const locale = { slug: heroKey, title: 'Journey', intro: 'A real boot publication', heroImage: { src: imageOrigin + '/' + heroKey, width: 640, height: 400, alt: 'Landscape', focus: { x: 30, y: 70 } }, omitted: false };
    const created = await fetch(base + '/journey-admin', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ de: locale, en: locale, members: [tk] }) });
    expect(created.status).toBe(201);
    const row = await created.json() as { id: string; updatedAt: string }; journeyId = row.id;
    const published = await fetch(`${base}/journey-admin/${row.id}/publish`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ baseUpdatedAt: row.updatedAt }) });
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ build: { ok: true }, saved: { status: 'published' } });
    expect((await store.get(row.id))?.publishedSnapshot?.locales.de?.heroImage.focus).toEqual({ x: 30, y: 70 });
    expect(await readFile(join(dir, 'site', 'current', 'index.html'), 'utf8')).toContain('Boot fixture');
  }, 60_000);

  it('refuses an unknown trust policy before acquiring storage ownership', async () => {
    const refused = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DATABASE_URL: url!, TRUSTED_PROXY: 'bogus' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    refused.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const [code, signal] = await once(refused, 'close', { signal: AbortSignal.timeout(10_000) });
      expect(signal).toBeNull();
      expect(code).not.toBe(0);
      expect(stderr.trim()).toBe('TRUSTED_PROXY must be loopback or docker-gateway when set.');
    } finally {
      if (refused.exitCode === null && refused.signalCode === null) {
        const exited = once(refused, 'close');
        refused.kill('SIGKILL');
        await exited;
      }
    }
  });

  it('preserves HTTPS from a real TCP loopback proxy when TRUSTED_PROXY is unset', async () => {
    const endpoint = new URL('/login', base);
    endpoint.hostname = '127.0.0.1';
    const login = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ username, password }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toMatch(/;\s*Secure(?:;|$)/i);
  });

  it('refuses foreign, credential-bearing and malformed origins without inserting a row', async () => {
    const before = await pool.query('SELECT id FROM comments WHERE translation_key = $1', [tk]);
    const cases: Record<string, string>[] = [
      { origin: 'https://third-party.example' },
      { origin: `${blogOrigin}.evil.example` },
      { origin: `${new URL(blogOrigin).protocol}//${blogHost}@evil.example` },
      { origin: `${new URL(blogOrigin).protocol}//evil.example@${blogHost}` },
      { origin: 'null', referer: `${blogOrigin}/trip/` },
      { origin: `${blogOrigin}/path`, referer: `${blogOrigin}/trip/` },
      { origin: '', referer: '' },
      { origin: 'https://spoof.example', 'x-forwarded-host': 'spoof.example' },
      { origin: blogOrigin, 'x-forwarded-proto': new URL(blogOrigin).protocol === 'https:' ? 'http' : 'https' },
      ...(topology === 'split' ? [
        { origin: imageOrigin },
        { origin: imageOrigin, host: new URL(imageOrigin).host },
        { origin: 'http://images.example', host: 'images.example', 'x-forwarded-proto': 'http' },
        { origin: blogOrigin, host: 'images.example', 'x-forwarded-host': blogHost },
        { origin: `${blogOrigin}:444` },
      ] : []),
    ];
    for (const [index, headers] of cases.entries()) {
      const response = await requestWithHost(`${base}/comments`, {
        method: 'POST',
        // Distinct proxy-accepted clients preserve the real five-per-window
        // limiter without allowing a 429 to mask any origin assertion.
        headers: { ...commentHeaders, 'x-forwarded-for': `198.51.100.${index + 1}`, ...headers },
        body: JSON.stringify({ translationKey: tk, postedLocale: 'de', authorName: 'Reader', body: 'Must not be stored' }),
      });
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expect(await response.json()).toEqual({ error: 'forbidden' });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect((await pool.query('SELECT id FROM comments WHERE translation_key = $1', [tk])).rows).toEqual(before.rows);
  });

  it('accepts Referer only when Origin is absent and ignores a spoofed forwarded Host', async () => {
    const { origin: _origin, ...headers } = commentHeaders;
    const response = await requestWithHost(`${base}/comments`, {
      method: 'POST',
      headers: {
        ...headers, referer: `${blogOrigin}/trip/?q=1#h`,
        'x-forwarded-host': 'spoof.example', 'x-forwarded-for': '203.0.113.10',
      },
      body: JSON.stringify({ translationKey: tk, postedLocale: 'de', authorName: 'Referer reader', body: 'Pending only' }),
    });
    expect(response.status).toBe(201);
    const rows = await pool.query('SELECT id, status FROM comments WHERE translation_key = $1', [tk]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe('pending');
    expect(commentsOf(await (await fetch(`${base}/comments?tk=${tk}`)).json())).toEqual([]);
    // Keep the subsequent moderation round-trip isolated from this fixture.
    await pool.query('DELETE FROM comments WHERE id = $1', [rows.rows[0]!.id]);
  });

  it('a reader comment lands in the admin moderation queue, and approving it makes it public', async () => {
    const posted = await requestWithHost(`${base}/comments`, {
      method: 'POST',
      headers: commentHeaders,
      body: JSON.stringify({ translationKey: tk, postedLocale: 'de', authorName: 'Leserin', body: 'Schöne Reise!' }),
    });
    expect(posted.status).toBe(201);

    const before = await fetch(`${base}/comments?tk=${tk}`);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ enabled: true, comments: [] });

    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username, password }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;

    const queue = await fetch(`${base}/moderation/comments?status=pending`, { headers: { cookie } });
    expect(queue.status).toBe(200);
    const pending = commentsOf(await queue.json()).filter((c) => c.translationKey === tk);
    expect(pending.map((c) => c.body)).toEqual(['Schöne Reise!']);
    const id = pending[0]?.id;
    expect(typeof id).toBe('string');

    const approve = await fetch(`${base}/moderation/comments/${String(id)}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(approve.status).toBe(200);

    const after = await fetch(`${base}/comments?tk=${tk}`);
    const listed = commentsOf(await after.json());
    expect(listed.map((c) => [c.authorName, c.body])).toEqual([['Leserin', 'Schöne Reise!']]);

    const identityResponse = await fetch(`${base}/settings/identity`, { headers: { cookie } });
    expect(identityResponse.status).toBe(200);
    const original = await identityResponse.json() as IdentityRecord;
    const editable = original.identity;
    let revision = original.revision;
    try {
      for (const authorName of ['Configured author', 'Renamed author', '']) {
        const saved = await fetch(`${base}/settings/identity`, {
          method: 'PUT', headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ revision, identity: { ...editable, authorName } }),
        });
        expect(saved.status).toBe(200);
        revision = (await saved.json() as { revision: number }).revision;
        const reply = await fetch(`${base}/moderation/comments/${String(id)}/reply`, {
          method: 'POST', headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ body: 'Thank you for reading.' }),
        });
        expect(reply.status).toBe(201);
      }
      const publicReplies = commentsOf(await (await fetch(`${base}/comments?tk=${tk}`)).json());
      expect(publicReplies.map((comment) => comment.authorName)).toEqual(['Leserin', 'Configured author', 'Renamed author', 'Author']);
      expect(JSON.stringify(publicReplies)).not.toContain(username);
    } finally {
      const restored = await fetch(`${base}/settings/identity`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ revision, identity: editable }),
      });
      expect(restored.status).toBe(200);
    }
  });

  it('initializes interrupted history after storage ownership even when a live release already exists', async () => {
    expect(initialBuildStatus.status).toBe(200);
    expect(initialBuildStatus.cacheControl).toBe('no-store');
    expect(initialBuildStatus.body).toMatchObject({
      live: { release: previousRelease }, running: null, record: 'ok',
      last: { attemptId: interruptedAttempt, startedAt: interruptedStartedAt, result: 'interrupted',
        finishedAt: null, release: null, failure: null, beforeBoot: true, triggers: ['publish'] },
    });
    // Boot observation is read-only; only a later build may supersede this record.
    expect(JSON.parse(initialBuildStatus.disk).running.attemptId).toBe(interruptedAttempt);
  });

  it('keeps author projection and paginated moderation aligned beyond 500 older comments', async () => {
    const olderKey = `${tk}-older`;
    const createdIds: string[] = [];
    const login = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    try {
      await pool.query(
        `INSERT INTO comments (id, translation_key, locale, name, body, status, created_at)
         SELECT gen_random_uuid(), $1, 'de', 'Older reader', 'Older comment', 'approved', '2020-01-01'::timestamptz
         FROM generate_series(1, 505)`, [olderKey],
      );
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO comments (id, translation_key, locale, name, body, status)
         VALUES (gen_random_uuid(), $1, 'de', 'Integration reader', 'Dedicated parent', 'approved') RETURNING id`, [tk],
      );
      const parentId = rows[0]!.id;
      createdIds.push(parentId);
      const reply = await fetch(`${base}/moderation/comments/${parentId}/reply`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ body: 'Integrated author reply beyond the old cap.' }),
      });
      expect(reply.status).toBe(201);
      const replyId = (await reply.json() as { id: string }).id;
      createdIds.push(replyId);
      const visible = commentsOf(await (await fetch(`${base}/comments?tk=${tk}`)).json());
      const author = visible.find((row) => row.id === replyId)!;
      expect(author.isAuthor).toBe(true);
      expect(Object.keys(author).sort()).toEqual(['authorName', 'body', 'createdAt', 'id', 'isAuthor', 'postedLocale']);
      const ids: unknown[] = [];
      for (let offset = 0; ; offset += 50) {
        const response = await fetch(`${base}/moderation/comments?status=approved&offset=${offset}`, { headers: { cookie } });
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const page = await response.json() as { comments: { id: string }[]; hasMore: boolean };
        expect(page.comments.length).toBeLessThanOrEqual(50);
        ids.push(...page.comments.map((row) => row.id));
        if (!page.hasMore) break;
        expect(offset).toBeLessThan(1000);
      }
      expect(ids.indexOf(replyId)).toBeGreaterThanOrEqual(505);
      expect(new Set(ids).size).toBe(ids.length);
      const removed = await fetch(`${base}/moderation/comments/${replyId}`, { method: 'DELETE', headers: { cookie } });
      expect(removed.status).toBe(200);
      expect(commentsOf(await (await fetch(`${base}/comments?tk=${tk}`)).json()).some((row) => row.id === replyId)).toBe(false);
    } finally {
      await pool.query('DELETE FROM comments WHERE translation_key = $1', [olderKey]);
      await pool.query('DELETE FROM comments WHERE id = ANY($1::uuid[])', [createdIds]);
    }
  });
  it('migrated a legacy settings file and the shared key to the provider registry before listening', async () => {
    expect(bootLog).toContain('settings: migrated AI settings to the provider registry (2 providers)');
    expect(bootLog).not.toContain('boot-legacy-fixture');
    const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(saved).toMatchObject({
      aiDefaultProviderId: 'openrouter', reviewProviderId: 'openrouter', captionProviderId: 'lm-studio', commentsEnabled: true,
    });
    expect(saved).not.toHaveProperty('aiProvider');
    expect(JSON.parse(await readFile(`${settingsPath}.pre-ai-registry`, 'utf8'))).toMatchObject({ aiProvider: 'openrouter' });
    expect((await pool.query("SELECT 1 FROM app_secrets WHERE key = 'ai_api_key'")).rows).toHaveLength(0);

    const login = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username, password }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const review = await fetch(`${base}/ai-config`, { headers: { cookie } });
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({
      aiProvider: 'openrouter', aiBaseUrl: 'https://openrouter.ai/api/v1', hasAiApiKey: true, aiApiKey: 'boot-legacy-fixture',
    });
    const caption = await fetch(`${base}/ai-config?purpose=caption`, { headers: { cookie } });
    expect(await caption.json()).toMatchObject({ captionProvider: 'lm-studio', captionApiKey: null });
  });
});
