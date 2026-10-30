import { publishTokens } from './publish-tokens.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgPostStore } from '../src/posts.js';
import { pgUserStore } from '../src/users.js';
import { pgSecretsStore } from '../src/secrets.js';

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

  beforeAll(async () => {
    pool = createPool(url!);
    await ensureSchema(pool);
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
        DATABASE_URL: url!,
        PORT: String(port),
        HOST: '127.0.0.1',
        PUBLIC_BASE_URL: imageOrigin,
        IMG_HOST: new URL(imageOrigin).host,
        STORAGE_DIR: join(dir, 'images'),
        SETTINGS_PATH: settingsPath,
        SITE_DIR: join(dir, 'site'),
        SITE_APP_DIR: join(dir, 'no-site-app'),
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
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    if (tk) await pgPostStore(pool).remove(tk);
    if (username) await pool.query('DELETE FROM users WHERE username = $1', [username]);
    await pool?.query("DELETE FROM app_secrets WHERE key IN ('ai_api_key', 'ai_provider_key:openrouter')");
    await pool?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

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
