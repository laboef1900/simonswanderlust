import { publishTokens } from './publish-tokens.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
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
maybe('production boot (src/main.ts, Postgres)', () => {
  let pool: DbPool;
  let dir: string;
  let child: ChildProcess;
  let base: string;
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
    const { ENCRYPTION_KEY: _unused, TRUSTED_PROXY: _proxyUnused, ...env } = process.env;
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...env,
        ENCRYPTION_KEY: encryptionKey.toString('hex'),
        DATABASE_URL: url!,
        PORT: String(port),
        HOST: '127.0.0.1',
        PUBLIC_BASE_URL: base,
        IMG_HOST: `localhost:${port}`,
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

  it('a reader comment lands in the admin moderation queue, and approving it makes it public', async () => {
    const posted = await fetch(`${base}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
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
