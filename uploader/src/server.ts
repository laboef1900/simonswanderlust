import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import { processImage } from './pipeline.js';
import { contentHashKey, storeVariants, isOriginalFile, assertSafeKey } from './storage.js';
import { listMedia, deleteMedia, imageUsage } from './media.js';
import { verifyPassword, type UserStore, UserExistsError } from './users.js';
import type { SessionStore } from './sessions.js';
import {
  SESSION_TTL_MS, loadUser, requireAuth, requireAdmin,
  setSessionCookie, clearSessionCookie, isSecureRequest, SESSION_COOKIE,
} from './authn.js';
import { SettingsError, type SettingsStore } from './settings.js';
import { validateDraft, validateForPublish, PostError, type PostStore, type PostPair, type StoredPostPair, type PostUsageRow } from './posts.js';
import { renderPreviewHtml } from './preview.js';
import { type PageStore, type PagePair, type PageContent, PageError } from './pages.js';
import { exportPost, exportAll } from './export.js';
import type { SiteBuilder } from './build.js';
import { importWxr } from './wp-import.js';
import { fixedWindowLimiter, rateLimitPreHandler, type RateLimiter } from './rate-limit.js';
import { BACKUP_FILE_RE, IMAGES_ARCHIVE_RE, type DbBackup } from './backup.js';
import { legacyRedirect } from './redirects.js';

export interface ServerConfig {
  storageDir: string;
  baseUrl: string;
  users: UserStore;
  sessions: SessionStore;
  settings: SettingsStore;
  posts: PostStore;
  pages: PageStore;
  imgHost: string;   // Host header that serves image variants (img subdomain)
  siteDir: string;   // release root; the blog is served from `${siteDir}/current`
  mapDir?: string;   // PMTiles/glyph assets; omit to disable /map/
  builder: SiteBuilder;
  backupDir: string;
  dbBackup: DbBackup;
  dbCheck: () => Promise<void>; // resolves iff the DB answers — probed by GET /health
  loginLimiter?: RateLimiter;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_-]*$/;

export function buildServer(cfg: ServerConfig): FastifyInstance {
  // @fastify/static requires an absolute root; tolerate a relative STORAGE_DIR
  // (e.g. ./data/images from env) by resolving against the process cwd.
  const storageDir = resolve(cfg.storageDir);
  // @ai-warning: trustProxy makes Fastify read X-Forwarded-* (so req.ip and the
  // cookie `secure` flag reflect the real client). This is correct ONLY behind a
  // trusted reverse proxy that sets X-Forwarded-Proto; if the container is ever
  // exposed directly, clients could spoof those headers.
  const app = Fastify({ logger: false, trustProxy: true });
  const { users, sessions } = cfg;

  // nosniff everywhere; clickjacking/referrer policies only on the admin/API
  // surface (blog pages keep parity with the old nginx: no admin headers).
  const ADMIN_PREFIXES = [
    '/admin', '/login', '/logout', '/auth', '/setup', '/settings', '/users',
    '/posts', '/upload', '/import', '/export', '/backups', '/rebuild', '/health', '/pages', '/images',
    '/ai-config',
  ];
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    const url = req.raw.url ?? '';
    const admin = ADMIN_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`));
    if (admin) {
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Referrer-Policy', 'no-referrer');
    }
    // Override MIME types for /map/ assets; setHeaders hooks don't fire for 206
    // responses. Match on the path only (ignore query strings) and skip error
    // responses so e.g. a 404 body keeps its own Content-Type.
    const path = url.split('?', 1)[0] ?? url;
    if (path.startsWith('/map/') && reply.statusCode < 400) {
      if (path.endsWith('.pmtiles')) reply.header('content-type', 'application/octet-stream');
      else if (path.endsWith('.pbf')) reply.header('content-type', 'application/x-protobuf');
    }
  });

  // Per-IP throttle for the unauthenticated auth endpoints (brute-force defense).
  const loginLimiter = cfg.loginLimiter ?? fixedWindowLimiter({ max: 10, windowMs: 900_000 });
  const limitAuth = rateLimitPreHandler(loginLimiter);

  // Unexpected errors (DB failures, bugs) must not leak internals to clients:
  // log the detail server-side, return a generic 500. Intentional 4xx framework
  // errors (body-limit 413, malformed JSON 400, …) keep their message — those
  // are Fastify's own sanitized responses, not internal state.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      console.error(`unhandled error on ${req.method} ${req.url}:`, err);
      return reply.code(500).send({ error: 'internal server error' });
    }
    return reply.code(status).send({ error: err.message });
  });

  app.register(cookie);
  app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  app.decorateRequest('authUser', null);
  app.addHook('onRequest', async (req) => { req.authUser = await loadUser(req, users, sessions); });

  const here = dirname(fileURLToPath(import.meta.url));
  app.register(fastifyStatic, { root: join(here, '..', 'public'), prefix: '/admin/' });
  // /upload and the CLI append a content hash to every key (contentHashKey),
  // so a given variant URL's bytes never change: replacing a photo mints a new
  // URL and previously published URLs keep serving — which is what makes a
  // one-year immutable cache correct. Exception: WP-import rehost keys
  // (wp-images.ts) stay deterministic so re-imports are idempotent, so
  // re-importing a remote image that changed since the first import is the one
  // residual path that can rewrite bytes under an immutable-cached URL —
  // accepted trade-off. (A custom setHeaders is overwritten by
  // @fastify/static's own cacheControl, so use the native maxAge + immutable
  // options instead.)
  app.register(fastifyStatic, {
    root: storageDir,
    prefix: '/',
    decorateReply: false,
    maxAge: '365d',
    immutable: true,
    constraints: { host: cfg.imgHost },
    // Untouched full-resolution originals (`<key>-orig.<ext>`) live in
    // storageDir so the incremental backup tar captures them, but they are a
    // private DR archive — never a web asset. Keep them off the public image
    // host (404) so a visitor can't guess `.../hero-orig.jpg` next to the
    // published `.../hero-640.avif`.
    allowedPath: (pathName) => !isOriginalFile(pathName),
  });

  // The public blog: static output of the last release. `current` is a symlink
  // flipped atomically by the builder; paths are joined per request, so a flip
  // takes effect immediately without re-registering.
  const currentDir = join(resolve(cfg.siteDir), 'current');
  app.register(fastifyStatic, {
    root: currentDir,
    prefix: '/',
    decorateReply: false,
    redirect: true,          // /foo -> 301 /foo/ (trailingSlash: 'always' contract)
    index: 'index.html',
  });

  // Self-hosted basemap + glyphs (was nginx's /map/ block). PMTiles needs HTTP
  // range reads; @fastify/send provides them. MIME types are set via onSend hook
  // (setHeaders doesn't fire for 206 responses). The mime db knows neither .pmtiles nor .pbf.
  if (cfg.mapDir) {
    app.register(fastifyStatic, {
      root: resolve(cfg.mapDir),
      prefix: '/map/',
      decorateReply: false,
    });
  }

  app.post('/upload', { preHandler: requireAuth }, async (req, reply) => {
    let key = '';
    let alt = '';
    let buf: Buffer | undefined;
    let mimetype = '';
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        mimetype = part.mimetype;
        buf = await part.toBuffer();
      } else if (part.fieldname === 'key') {
        key = String(part.value).trim();
      } else if (part.fieldname === 'alt') {
        alt = String(part.value).trim();
      }
    }
    if (!buf || !mimetype.startsWith('image/')) {
      return reply.code(400).send({ error: 'expected an image file' });
    }
    if (!KEY_RE.test(key)) {
      return reply.code(400).send({ error: 'invalid key (use lowercase a-z, 0-9, / _ -)' });
    }
    // Version the key by content hash (issue #26): a re-upload mints a fresh
    // URL instead of overwriting variants cached as immutable; old URLs keep
    // serving because nothing on disk is touched. Clients use the returned
    // src/snippet, never the key they sent.
    const versionedKey = contentHashKey(key, buf);
    const result = await processImage(buf);
    const stored = await storeVariants(versionedKey, alt, result, { storageDir, baseUrl: cfg.baseUrl });
    return reply.send(stored);
  });

  // ---- media library ----
  const imageBase = cfg.baseUrl.replace(/\/+$/, '');

  // Everything (posts + pages) that could reference an image URL. Usage is
  // computed store-agnostically in TS so the memory and pg stores behave alike.
  // @ai-note: posts come from usageRows() — flat per-locale rows — NOT from
  // list()+get(): pgPostStore.get() returns null for a stranded single-locale
  // row (crash between upsertDraft's two locale INSERTs), and that row's image
  // references must still block deletion. Do not cache across requests (state
  // lives in backing services).
  const usageCorpus = async (): Promise<{ posts: PostUsageRow[]; pages: PagePair[] }> => {
    const [postRows, pageKeys] = await Promise.all([cfg.posts.usageRows(), cfg.pages.keys()]);
    const pagePairs = await Promise.all(pageKeys.map((k) => cfg.pages.get(k)));
    return { posts: postRows, pages: pagePairs };
  };

  // Browse everything under storageDir. Admin-only: it exposes the full
  // inventory of uploaded files, same trust boundary as /settings.
  app.get('/images', { preHandler: requireAdmin }, async (_req, reply) => {
    const [items, corpus] = await Promise.all([listMedia(storageDir), usageCorpus()]);
    return reply.send(items.map((m) => {
      const src = `${imageBase}/${m.key}`;
      return {
        key: m.key,
        src,
        width: m.width,
        height: m.height,
        thumbUrl: m.thumbFile ? `${imageBase}/${m.thumbFile}` : null,
        files: m.files,
        usedIn: imageUsage(src, corpus.posts, corpus.pages),
      };
    }));
  });

  // Wildcard because keys contain slashes (trips/x/hero). Admin-only inside the
  // handler chain; refuses to delete anything still referenced by content.
  // @ai-note: usage only sees Postgres content — the last built release may
  // still reference a deleted image until the next rebuild.
  app.delete('/images/*', { preHandler: requireAdmin }, async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    try {
      assertSafeKey(key);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const corpus = await usageCorpus();
    const usedIn = imageUsage(`${imageBase}/${key}`, corpus.posts, corpus.pages);
    if (usedIn.length > 0) {
      return reply.code(409).send({ error: 'image is referenced by existing content — remove those references first', usedIn });
    }
    const deleted = await deleteMedia(storageDir, key);
    if (deleted === 0) return reply.code(404).send({ error: 'image not found' });
    return reply.send({ ok: true, deleted });
  });

  // Settings govern backups (what gets written to disk and retained) — same
  // trust boundary as /rebuild and /backups, so the whole surface is admin-only.
  app.get('/settings', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.send(cfg.settings.get());
  });

  app.post('/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const partial: Record<string, unknown> = {};
    if (b.lmBaseUrl !== undefined) partial.lmBaseUrl = String(b.lmBaseUrl).trim();
    if (b.lmModel !== undefined) partial.lmModel = String(b.lmModel).trim();
    if (b.captionTimeoutMs !== undefined) partial.captionTimeoutMs = Number(b.captionTimeoutMs);
    if (b.captionMaxEdge !== undefined) partial.captionMaxEdge = Number(b.captionMaxEdge);
    if (b.captionPrompt !== undefined) partial.captionPrompt = String(b.captionPrompt);
    if (b.backupSchedule !== undefined) partial.backupSchedule = String(b.backupSchedule);
    if (b.backupRetention !== undefined) partial.backupRetention = Number(b.backupRetention);
    try {
      return reply.send(cfg.settings.update(partial));
    } catch (e) {
      if (e instanceof SettingsError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  // Read-only LM config for the browser-direct alt-text suggester. Any signed-in
  // author may READ it (to run a suggestion); CHANGING it stays admin-only via
  // POST /settings. Deliberately excludes backup settings.
  app.get('/ai-config', { preHandler: requireAuth }, async (_req, reply) => {
    const s = cfg.settings.get();
    return reply.send({
      lmBaseUrl: s.lmBaseUrl,
      lmModel: s.lmModel,
      captionPrompt: s.captionPrompt,
      captionTimeoutMs: s.captionTimeoutMs,
      captionMaxEdge: s.captionMaxEdge,
    });
  });

  app.get('/login', (_req, reply) => reply.sendFile('login.html'));

  app.get('/auth/status', async (req) => {
    if (req.authUser) {
      return { authenticated: true, username: req.authUser.username, isAdmin: req.authUser.isAdmin, needsSetup: false };
    }
    return { authenticated: false, needsSetup: (await users.count()) === 0 };
  });

  // Serialize setup so the count()-then-create() check is atomic across
  // concurrent requests (closes the first-admin TOCTOU). Per-app instance.
  let setupChain: Promise<unknown> = Promise.resolve();
  const withSetupLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = setupChain.then(fn, fn);
    setupChain = run.then(() => undefined, () => undefined);
    return run;
  };

  app.post('/setup', { preHandler: limitAuth }, async (req, reply) => withSetupLock(async () => {
    if ((await users.count()) > 0) return reply.code(409).send({ error: 'setup already complete' });
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = String(b.username ?? '').trim();
    const password = String(b.password ?? '');
    if (!username || !password) return reply.code(400).send({ error: 'username and password are required' });
    const user = await users.create({ username, password, isAdmin: true });
    const token = await sessions.create(user.id, SESSION_TTL_MS);
    setSessionCookie(reply, token, isSecureRequest(req));
    return reply.send({ username: user.username, isAdmin: user.isAdmin });
  }));

  app.post('/login', { preHandler: limitAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = String(b.username ?? '').trim();
    const password = String(b.password ?? '');
    const user = await users.findByUsername(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return reply.code(401).send({ error: 'invalid username or password' });
    }
    const token = await sessions.create(user.id, SESSION_TTL_MS);
    setSessionCookie(reply, token, isSecureRequest(req));
    return reply.send({ username: user.username, isAdmin: user.isAdmin });
  });

  app.post('/logout', { preHandler: requireAuth }, async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await sessions.destroy(token);
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/users', { preHandler: requireAdmin }, async () => {
    const list = await users.list();
    return list.map((u) => ({ id: u.id, username: u.username, isAdmin: u.isAdmin, createdAt: u.createdAt }));
  });

  app.post('/users', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown; isAdmin?: unknown };
    const username = String(b.username ?? '').trim();
    const password = String(b.password ?? '');
    const isAdmin = Boolean(b.isAdmin);
    if (!username || !password) return reply.code(400).send({ error: 'username and password are required' });
    try {
      const user = await users.create({ username, password, isAdmin });
      return reply.send({ id: user.id, username: user.username, isAdmin: user.isAdmin, createdAt: user.createdAt });
    } catch (e) {
      if (e instanceof UserExistsError) return reply.code(409).send({ error: 'username already exists' });
      throw e;
    }
  });

  app.delete('/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (req.authUser && req.authUser.id === id) return reply.code(409).send({ error: 'you cannot delete your own account' });
    const target = await users.findById(id);
    if (!target) return reply.code(404).send({ error: 'user not found' });
    if (target.isAdmin && (await users.countAdmins()) <= 1) {
      return reply.code(409).send({ error: 'cannot remove the last admin' });
    }
    await users.remove(id);
    return reply.send({ ok: true });
  });

  // Self-service password change (any authenticated user, own account only).
  // Rate-limited like the other password-verifying endpoints: a hijacked
  // session must not be able to brute-force the current password.
  app.post('/users/me/password', { preHandler: [limitAuth, requireAuth] }, async (req, reply) => {
    const b = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = String(b.currentPassword ?? '');
    const newPassword = String(b.newPassword ?? '');
    if (!currentPassword || !newPassword) {
      return reply.code(400).send({ error: 'current and new password are required' });
    }
    const user = req.authUser ? await users.findById(req.authUser.id) : null;
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    // @ai-note: a wrong current password is a 400, NOT a 401 — the admin-page
    // fetch handlers redirect to /login on 401, which would boot the user mid-form.
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      return reply.code(400).send({ error: 'current password is incorrect' });
    }
    await users.setPassword(user.id, newPassword);
    await sessions.destroyAllForUser(user.id);
    // destroyAllForUser also killed the caller's own session — mint a fresh one
    // (mirrors /login) so changing the password doesn't log its author out.
    const token = await sessions.create(user.id, SESSION_TTL_MS);
    setSessionCookie(reply, token, isSecureRequest(req));
    return reply.send({ ok: true });
  });

  const { posts } = cfg;

  app.get('/posts', { preHandler: requireAuth }, async () => posts.list());

  app.get('/posts/:tk', { preHandler: requireAuth }, async (req, reply) => {
    const pair = await posts.get((req.params as { tk: string }).tk);
    if (!pair) return reply.code(404).send({ error: 'post not found' });
    return reply.send(pair);
  });

  // Server-side preview of a draft (or published) post, rendered through the
  // same markdown pipeline the site build uses (see src/preview.ts). Drafts
  // are author territory, so requireAuth — publishing stays admin-only.
  app.get('/posts/:tk/preview', { preHandler: requireAuth }, async (req, reply) => {
    const q = (req.query ?? {}) as { locale?: unknown };
    const locale = q.locale === undefined ? 'de' : String(q.locale);
    if (locale !== 'de' && locale !== 'en') {
      return reply.code(400).send({ error: "locale must be 'de' or 'en'" });
    }
    const pair = await posts.get((req.params as { tk: string }).tk);
    if (!pair) return reply.code(404).send({ error: 'post not found' });
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(await renderPreviewHtml(pair, locale));
  });

  const upsert = async (req: { body: unknown }, reply: import('fastify').FastifyReply, tk: string) => {
    // `updatedAt` is the optimistic-concurrency echo (the value the editor
    // loaded), not part of the pair itself — strip it before storing. It is
    // optional: callers without it (new posts, WP importer) skip the check.
    const { updatedAt, ...body } = (req.body ?? {}) as PostPair & { updatedAt?: unknown };
    const pair: PostPair = { ...body, translationKey: tk };
    let baseUpdatedAt: Date | undefined;
    if (updatedAt !== undefined && updatedAt !== null) {
      baseUpdatedAt = new Date(String(updatedAt));
      if (Number.isNaN(baseUpdatedAt.getTime())) return reply.code(400).send({ error: 'invalid updatedAt' });
    }
    try {
      validateDraft(pair);
      return reply.send(await posts.upsertDraft(pair, baseUpdatedAt));
    } catch (e) {
      if (e instanceof PostError) {
        // `code` lets the editor tell a stale-tab 409 ('conflict' → offer a
        // reload) apart from duplicate_slug/slug_locked 409s.
        const status = e.code === 'duplicate_slug' || e.code === 'slug_locked' || e.code === 'conflict' ? 409 : 400;
        return reply.code(status).send({ error: e.message, ...(e.code ? { code: e.code } : {}) });
      }
      throw e;
    }
  };
  app.post('/posts', { preHandler: requireAuth }, (req, reply) => upsert(req, reply, ''));
  app.put('/posts/:tk', { preHandler: requireAuth }, (req, reply) => upsert(req, reply, (req.params as { tk: string }).tk));

  // Revision history — read-only for any authed user (same trust boundary as
  // GET /posts/:tk); restoring goes through the normal PUT save, so slug-lock
  // and validation still apply and the clobbered state is itself snapshotted.
  app.get('/posts/:tk/revisions', { preHandler: requireAuth }, async (req, reply) => {
    const tk = (req.params as { tk: string }).tk;
    if (!(await posts.get(tk))) return reply.code(404).send({ error: 'post not found' });
    return reply.send(await posts.listRevisions(tk));
  });

  app.get('/posts/:tk/revisions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { tk, id } = req.params as { tk: string; id: string };
    const rev = await posts.getRevision(tk, id);
    if (!rev) return reply.code(404).send({ error: 'revision not found' });
    return reply.send(rev);
  });

  // @ai-warning: publishing pushes content to the PUBLIC static site, so it is
  // admin-only. Authors may create/edit drafts (requireAuth) but not publish.
  app.post('/posts/:tk/publish', { preHandler: requireAdmin }, async (req, reply) => {
    const tk = (req.params as { tk: string }).tk;
    const pair = await posts.get(tk);
    if (!pair) return reply.code(404).send({ error: 'post not found' });
    try { validateForPublish(pair); } catch (e) {
      if (e instanceof PostError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    await posts.publish(tk);
    const published = await posts.get(tk);
    const build = await cfg.builder.build();
    if (published) await exportPost(published, cfg.backupDir).catch(() => { /* best-effort backup */ });
    // updatedAt: publish bumps the stored timestamp, so the editor must re-sync
    // its concurrency echo or its very next Save would falsely 409.
    return reply.send({ published: true, build, updatedAt: published?.updatedAt });
  });

  // @ai-warning: the emergency brake — flips a published pair back to draft and
  // rebuilds so the live site drops it. Same trust boundary as publish: admin-only.
  app.post('/posts/:tk/unpublish', { preHandler: requireAdmin }, async (req, reply) => {
    const tk = (req.params as { tk: string }).tk;
    const pair = await posts.get(tk);
    if (!pair) return reply.code(404).send({ error: 'post not found' });
    if (pair.status !== 'published') return reply.code(409).send({ error: 'post is not published' });
    try {
      await posts.unpublish(tk);
    } catch (e) {
      if (e instanceof PostError) return reply.code(404).send({ error: e.message });
      throw e;
    }
    const build = await cfg.builder.build();
    return reply.send({ unpublished: true, build });
  });

  // Hard delete (both locale rows), freeing the slugs for reuse. MDX backups in
  // /data/backup and uploaded images are intentionally left in place (recovery
  // path). Rebuild only when the post is currently published.
  // @ai-warning: "draft" does not guarantee the post is absent from the live
  // site — if a prior unpublish's rebuild failed (e.g. "a build is already
  // running"), the deployed release may still contain it until the next
  // successful build. The unpublish response surfaces that failure to the
  // admin; build queueing (issue #36) is the proper fix.
  app.delete('/posts/:tk', { preHandler: requireAdmin }, async (req, reply) => {
    const tk = (req.params as { tk: string }).tk;
    const pair = await posts.get(tk);
    if (!pair) return reply.code(404).send({ error: 'post not found' });
    const wasPublished = pair.status === 'published';
    try {
      await posts.remove(tk);
    } catch (e) {
      if (e instanceof PostError) return reply.code(404).send({ error: e.message });
      throw e;
    }
    if (wasPublished) {
      const build = await cfg.builder.build();
      return reply.send({ deleted: true, build });
    }
    return reply.send({ deleted: true });
  });

  // Liveness + DB probe: the compose healthcheck polls this every 10s, so no
  // per-poll logging. Blog serving stays DB-independent (static files from the
  // current release), so a down Postgres flips the container unhealthy without
  // taking the blog offline.
  app.get('/health', async (_req, reply) => {
    try {
      await cfg.dbCheck();
      return { ok: true, db: true };
    } catch {
      return reply.code(503).send({ ok: false, db: false });
    }
  });

  // Replaces the old secret-gated POST /build on the builder container.
  app.post('/rebuild', { preHandler: requireAdmin }, async () => cfg.builder.build());

  app.get('/pages/:key', { preHandler: requireAuth }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    return reply.send(await cfg.pages.get(key));
  });

  // Admin-only: writing a page rebuilds the public site (like publishing a post).
  app.put('/pages/:key', { preHandler: requireAdmin }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const b = (req.body ?? {}) as Partial<Record<'de' | 'en', Partial<PageContent>>>;
    const mkLocale = (loc: 'de' | 'en'): PageContent => {
      const src = b[loc] ?? {};
      return {
        locale: loc,
        title: String(src.title ?? ''),
        bodyMarkdown: String(src.bodyMarkdown ?? ''),
        images: (src.images ?? {}) as Record<string, { width: number; height: number }>,
      };
    };
    const pair: PagePair = { key, de: mkLocale('de'), en: mkLocale('en') };
    try {
      const saved = await cfg.pages.save(pair);
      const build = await cfg.builder.build();
      return reply.send({ saved, build });
    } catch (e) {
      if (e instanceof PageError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.get('/backups', { preHandler: requireAdmin }, async () => ({
    state: cfg.dbBackup.state(),
    files: cfg.dbBackup.list(),
    imageArchives: cfg.dbBackup.listImageArchives(),
  }));

  app.post('/backups', { preHandler: requireAdmin }, async () => cfg.dbBackup.runNow());

  // Filename is validated against the strict backup patterns (db dump OR images
  // archive) — nothing else in the directory (state.json!) and no traversal can
  // be fetched.
  app.get('/backups/:name', { preHandler: requireAdmin }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const isDump = BACKUP_FILE_RE.test(name);
    if (!isDump && !IMAGES_ARCHIVE_RE.test(name)) {
      return reply.code(400).send({ error: 'invalid backup filename' });
    }
    const file = join(cfg.dbBackup.dir, name);
    if (!existsSync(file)) return reply.code(404).send({ error: 'backup not found' });
    reply.header('content-type', isDump ? 'application/gzip' : 'application/x-tar');
    reply.header('content-disposition', `attachment; filename="${name}"`);
    return reply.send(createReadStream(file));
  });

  app.post('/export', { preHandler: requireAuth }, async (_req, reply) => {
    const list = await posts.list();
    const pairs = (await Promise.all(list.map((s) => posts.get(s.translationKey)))).filter((p): p is StoredPostPair => p !== null);
    const files = await exportAll(pairs, cfg.backupDir);
    return reply.send({ ok: true, count: files.length });
  });

  app.post('/import', { preHandler: requireAuth }, async (req, reply) => {
    let xml = '';
    for await (const part of req.parts()) {
      if (part.type === 'file') xml = (await part.toBuffer()).toString('utf8');
    }
    if (!xml.includes('<rss') || !xml.includes('wordpress.org/export')) {
      return reply.code(400).send({ error: 'not a WordPress export (.xml) file' });
    }
    const summary = await importWxr(xml, { postStore: cfg.posts, storageDir: cfg.storageDir, baseUrl: cfg.baseUrl });
    if (summary.imported === 0 && summary.updated === 0 && summary.skipped === 0) {
      return reply.code(400).send({ error: 'no importable posts found in export' });
    }
    return reply.send(summary);
  });

  // 404/503 for the blog; plain 404 for the img host and non-GET methods.
  app.setNotFoundHandler(async (req, reply) => {
    const host = req.headers.host ?? '';
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(404).send({ error: 'not found' });
    if (host === cfg.imgHost) {
      const urlPath = (req.raw.url ?? '').split('?', 1)[0] ?? '';
      const relPath = (urlPath.endsWith('/') ? join(urlPath, 'index.html') : urlPath).replace(/^\//, '');
      const fullPath = join(currentDir, relPath);
      if (relPath && existsSync(fullPath)) {
        const body = await readFile(fullPath);
        const mime = relPath.endsWith('.html') ? 'text/html; charset=utf-8'
          : relPath.endsWith('.css') ? 'text/css; charset=utf-8'
          : relPath.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : relPath.endsWith('.svg') ? 'image/svg+xml'
          : 'application/octet-stream';
        return reply.type(mime).send(body);
      }
      return reply.code(404).send('Not found');
    }
    // Legacy WordPress URLs (feeds, category archives) 301 to their new homes
    // before any 404/503 — see redirects.ts (issue #35). Static files always
    // win: this handler only runs after @fastify/static misses. Explicit
    // code+header instead of reply.redirect() (its signature changed in v5).
    const target = legacyRedirect(req.raw.url ?? '');
    if (target) return reply.code(301).header('location', target).send();
    if (!cfg.builder.hasRelease()) {
      return reply
        .code(503)
        .header('retry-after', '30')
        .type('text/html')
        .send('<!doctype html><meta charset="utf-8"><title>Building…</title><h1>Site is building</h1><p>The first build is in progress — try again in a moment.</p>');
    }
    try {
      const html = await readFile(join(currentDir, '404.html'), 'utf8');
      return reply.code(404).type('text/html').send(html);
    } catch {
      return reply.code(404).send('Not found');
    }
  });

  return app;
}
