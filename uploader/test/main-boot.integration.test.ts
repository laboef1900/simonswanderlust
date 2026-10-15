import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, ensureSchema, type DbPool } from '../src/db.js';
import { pgPostStore } from '../src/posts.js';
import { pgUserStore } from '../src/users.js';

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
    await posts.publish(tk);

    dir = await mkdtemp(join(tmpdir(), 'main-boot-'));
    const settingsPath = join(dir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ commentsEnabled: true }));
    const port = await freePort();
    base = `http://localhost:${port}`;
    const { ENCRYPTION_KEY: _unused, ...env } = process.env;
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...env,
        DATABASE_URL: url!,
        PORT: String(port),
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
      let out = '';
      const onData = (b: Buffer) => {
        out += b.toString();
        if (out.includes(`app listening on :${port}`)) resolve();
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', (b: Buffer) => { out += b.toString(); });
      child.once('exit', (code) => reject(new Error(`main.ts exited ${code}:\n${out}`)));
    });
  }, 30_000);

  afterAll(async () => {
    child?.kill('SIGKILL');
    if (tk) await pgPostStore(pool).remove(tk);
    if (username) await pool.query('DELETE FROM users WHERE username = $1', [username]);
    await pool?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
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
});
