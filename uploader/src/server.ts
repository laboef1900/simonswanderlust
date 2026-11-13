import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import Fastify, { type FastifyError, type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import { IdentityError } from '../../site/src/lib/site-identity.js';
import { ui } from '../../site/src/i18n/ui.js';
import { createAuthn } from './authn.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerBackupAndImportRoutes } from './backup-import-routes.js';
import { validateCanonicalRoles } from './canonical-origin.js';
import { commentAuthorityOrigin, commentOrigin, registerPublicComments } from './comments-public.js';
import { compressionHook } from './compress.js';
import { diskSpace, formatBytes } from './disk.js';
import { registerGpxRoutes } from './gpx-routes.js';
import { renderGpxCopy } from './gpx-copy.js';
import { VARIANT_FILE_RE } from './media-files.js';
import { createImportRunner, memoryImportJobStore } from './import-jobs.js';
import { memoryJourneyStore } from './journeys.js';
import { registerJourneyAdmin } from './journeys-admin.js';
import { registerMediaRoutes } from './media-routes.js';
import { registerPagesAndModerationRoutes } from './pages-moderation-routes.js';
import { registerPostsRoutes } from './posts-routes.js';
import { previewCsp } from './preview.js';
import { createPublicationProjection } from './publication.js';
import { accountLockoutLimiter, commentLimiters, fixedWindowLimiter, rateLimitPreHandler } from './rate-limit.js';
import { legacyRedirectForRelease } from './redirects.js';
import { createReleaseManifestReader } from './release-manifest.js';
import { escapeRegExp } from './request-guards.js';
import { createPublishHelpers, type AppServer, type ServerConfig, type ServerContext } from './server-context.js';
import { registerSettingsRoutes } from './settings-routes.js';
import { StorageReadOnlyError } from './storage-owner.js';

export type { AppServer, ServerConfig } from './server-context.js';

/** IPv4 loopback block (127.0.0.0/8) — matched after WHATWG normalization. */
const LOOPBACK_IPV4_RE = /^127(?:\.\d{1,3}){3}$/;

function isLoopbackAuthority(authority: string): boolean {
  let hostname: string;
  try {
    ({ hostname } = new URL(`http://${authority}`));
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname === '[::1]' || LOOPBACK_IPV4_RE.test(hostname);
}

export function buildServer(cfg: ServerConfig): AppServer {
  const storageDir = resolve(cfg.storageDir);
  const app = Fastify({ logger: false, trustProxy: cfg.trustProxy, requestTimeout: 120_000 });
  if (cfg.onRoute) app.addHook('onRoute', cfg.onRoute);
  const { users, sessions } = cfg;
  const language = cfg.language ?? cfg.posts.language;
  const routingInternalOrigins = cfg.routingInternalOrigins ?? new Set<string>();
  const journeys = cfg.journeys ?? memoryJourneyStore(cfg.posts, cfg.posts.language, cfg.media, cfg.baseUrl.replace(/\/$/, ''));
  let mutationsClosed = false;
  const activeMutations = new Set<Promise<void>>();
  const isWritable = () => !mutationsClosed && cfg.isWritable?.() !== false;
  const isMutation = (method: string) => method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  const readOnly = (reply: FastifyReply) => reply.code(503).header('cache-control', 'no-store')
    .send({ error: 'storage_read_only', message: ui.en['gpx.storageReadOnly'] });
  const quiesceMutations = async () => {
    mutationsClosed = true;
    await Promise.allSettled(activeMutations);
  };

  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.some(isMutation)) return;
    const handler = route.handler;
    route.handler = async function (request, reply) {
      if (!isMutation(request.method) || route.url === '/media/lookup') return handler.call(this, request, reply);
      if (!isWritable()) return readOnly(reply);
      const completion = Promise.withResolvers<void>();
      activeMutations.add(completion.promise);
      try { return await handler.call(this, request, reply); }
      finally { activeMutations.delete(completion.promise); completion.resolve(); }
    };
  });

  app.addHook('onRequest', async (request, reply) => {
    if (isWritable()) return;
    if (request.routeOptions.url === '/health') {
      return reply.code(503).header('cache-control', 'no-store')
        .send({ ok: false, db: false, release: cfg.builder.hasRelease(), storageWritable: false });
    }
    if (isMutation(request.method) && request.routeOptions.url !== '/media/lookup') return readOnly(reply);
  });

  const cleanupDeletedRoutes = async (): Promise<boolean> => {
    if (!cfg.gpx) return false;
    try { const result = await cfg.gpx.reconcile(); return result.skipped || result.cleanupPending; }
    catch { return true; }
  };

  const PUBLIC_ROUTES: Record<string, true> = { '/*': true, '/map/*': true };
  const STATIC_ADMIN_ROUTES: Record<string, true> = { '/admin': true, '/admin/*': true, '/login': true };
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    const url = req.raw.url ?? '';
    const route = req.routeOptions.url;
    if (route !== undefined && !PUBLIC_ROUTES[route] && !STATIC_ADMIN_ROUTES[route] && !reply.hasHeader('cache-control')) {
      reply.header('Cache-Control', 'no-store');
    }
    if (route !== undefined && !PUBLIC_ROUTES[route]) {
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Referrer-Policy', 'no-referrer');
    }
    const path = url.split('?', 1)[0] ?? url;
    if (path.startsWith('/map/') && reply.statusCode < 400) {
      if (path.endsWith('.pmtiles')) reply.header('content-type', 'application/octet-stream');
      else if (path.endsWith('.pbf')) reply.header('content-type', 'application/x-protobuf');
    }
    if ((path.startsWith('/_astro/') || /^\/_identity\/(?:logo|favicon-32|favicon-192|apple-touch-180)-[a-f0-9]{16}\.png$/.test(path)) && reply.statusCode < 400) {
      reply.header('cache-control', 'public, max-age=31536000, immutable');
    }
  });

  app.addHook('onSend', compressionHook({ skipPrefixes: ['/map/'] }));
  const loginLimiter = cfg.loginLimiter ?? fixedWindowLimiter({ max: 10, windowMs: 900_000 });
  const accountLimiter = cfg.accountLimiter ?? accountLockoutLimiter({ max: 100 });
  const passwordLimiter = cfg.passwordLimiter ?? accountLockoutLimiter();
  const importJobs = cfg.importJobs ?? createImportRunner({ store: memoryImportJobStore(), signal: cfg.storageSignal, isWritable });
  const limitAuth = rateLimitPreHandler(loginLimiter);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof StorageReadOnlyError || !isWritable()) return readOnly(reply);
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      console.error(`unhandled error on ${req.method} ${req.url}:`, err);
      return reply.code(500).send({ error: 'internal server error' });
    }
    return reply.code(status).send({ error: err.message });
  });

  app.register(cookie);
  app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1, parts: 8 },
  });
  app.decorateRequest('authUser', null);
  const { optionalAuth, requireAuth, requireAdmin } = createAuthn(users, sessions);

  if (cfg.gpx) registerGpxRoutes(app, { gpx: cfg.gpx, requireAuth });
  registerJourneyAdmin(app, { store: journeys, posts: cfg.posts, language, imageBase: cfg.baseUrl.replace(/\/$/, ''), builder: cfg.builder, requireAuth, requireAdmin });
  app.get('/admin/gpx-copy.js', async (_req, reply) =>
    reply.type('application/javascript; charset=utf-8').header('cache-control', 'no-store').send(renderGpxCopy()));

  const here = dirname(fileURLToPath(import.meta.url));
  app.register(fastifyStatic, { root: join(here, '..', 'public'), prefix: '/admin', redirect: true });

  const imgHostPattern = new RegExp(`^${escapeRegExp(cfg.imgHost)}$`, 'i');
  app.register(fastifyStatic, {
    root: storageDir,
    prefix: '/',
    decorateReply: false,
    maxAge: '365d',
    immutable: true,
    constraints: { host: imgHostPattern },
    setHeaders: (reply) => { reply.header('Access-Control-Allow-Origin', '*'); },
    allowedPath: (pathName) => VARIANT_FILE_RE.test(pathName),
  });

  const currentDir = join(resolve(cfg.siteDir), 'current');
  app.register(fastifyStatic, {
    root: currentDir,
    prefix: '/',
    decorateReply: false,
    redirect: true,
    index: 'index.html',
  });

  if (cfg.mapDir) {
    app.register(fastifyStatic, {
      root: resolve(cfg.mapDir),
      prefix: '/map/',
      decorateReply: false,
    });
  }

  const imageBase = cfg.baseUrl.replace(/\/+$/, '');
  cfg.pages.configureImageOrigin(imageBase);
  const previewPolicy = previewCsp(imageBase);

  const releaseManifests = createReleaseManifestReader(cfg.siteDir);
  const publication = createPublicationProjection({
    posts: cfg.posts, readRelease: () => releaseManifests.read(), media: cfg.media, imageBase,
    onUnavailable: () => console.warn('Publication projection unavailable'),
  });

  const usageCorpus = async () => {
    const [postRows, pagePairs, journeyRows] = await Promise.all([
      cfg.posts.usageRows(),
      cfg.pages.getAll
        ? cfg.pages.getAll()
        : cfg.pages.keys().then((pageKeys) => Promise.all(pageKeys.map((k) => cfg.pages.get(k)))),
      journeys.list(),
    ]);
    return { posts: postRows, pages: pagePairs, journeys: journeyRows };
  };

  const publishHelpers = createPublishHelpers(cfg, imageBase);
  const ctx: ServerContext = {
    app,
    cfg,
    storageDir,
    imageBase,
    previewPolicy,
    language,
    journeys,
    publication,
    routingInternalOrigins,
    requireAuth,
    requireAdmin,
    optionalAuth,
    limitAuth,
    accountLimiter,
    passwordLimiter,
    importJobs,
    isWritable,
    readOnly,
    cleanupDeletedRoutes,
    usageCorpus,
    ...publishHelpers,
  };

  registerMediaRoutes(ctx);
  registerSettingsRoutes(ctx);
  registerAuthRoutes(ctx);
  registerPostsRoutes(ctx);
  registerPagesAndModerationRoutes(ctx);
  registerBackupAndImportRoutes(ctx);

  app.get('/health', { preHandler: optionalAuth }, async (req, reply) => {
    let disk: { free: number; total: number; freeLabel: string } | undefined;
    if (req.authUser?.isAdmin) {
      try {
        const space = await diskSpace(storageDir);
        disk = { ...space, freeLabel: formatBytes(space.free) };
      } catch { /* reported as absent */ }
    }
    const release = cfg.builder.hasRelease();
    try {
      await cfg.dbCheck();
      return { ok: true, db: true, release, ...(disk ? { disk } : {}) };
    } catch {
      return reply.code(503).send({ ok: false, db: false, release, ...(disk ? { disk } : {}) });
    }
  });

  const imgHostServesBlog = isLoopbackAuthority(cfg.imgHost);
  const imgHostLower = cfg.imgHost.toLowerCase();

  {
    const fresh = commentLimiters();
    const imageOrigin = new URL(cfg.baseUrl).origin;
    const imageAuthority = new URL(imageOrigin).host;
    const servingImageAuthorities = ['http', 'https'].map((protocol) => {
      const origin = commentAuthorityOrigin(protocol, cfg.imgHost);
      return origin === null ? null : new URL(origin).host;
    });
    registerPublicComments(app, {
      comments: cfg.comments,
      posts: cfg.posts,
      allowedOrigin: (req) => {
        if (cfg.commentsOrigin !== undefined) return commentOrigin(cfg.commentsOrigin);
        const canonical = cfg.identityStore?.get().identity.canonicalOrigin;
        if (canonical !== undefined && canonical !== null) {
          try { return validateCanonicalRoles(canonical, cfg); }
          catch (error) {
            if (error instanceof IdentityError) return null;
            throw error;
          }
        }
        const origin = commentAuthorityOrigin(req.protocol, req.headers.host);
        if (origin === null) return null;
        if (servingImageAuthorities.some((authority) => authority === null)) return null;
        const servesImages = servingImageAuthorities.some((authority) =>
          commentAuthorityOrigin(req.protocol, authority) === origin);
        if (commentAuthorityOrigin(req.protocol, imageAuthority) === origin || servesImages) {
          return imgHostServesBlog && servesImages && origin === imageOrigin ? origin : null;
        }
        return origin;
      },
      commentsEnabled: cfg.commentsEnabled ?? (() => cfg.settings.get().commentsEnabled === true),
      ipLimiter: cfg.commentIpLimiter ?? fresh.ip,
      globalLimiter: cfg.commentGlobalLimiter ?? fresh.global,
    });
  }

  app.setNotFoundHandler(async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(404).send({ error: 'not found' });
    if (host === imgHostLower) {
      if (!imgHostServesBlog) return reply.code(404).send('Not found');
      const rawUrl = req.raw.url ?? '';
      const qIndex = rawUrl.indexOf('?');
      const urlPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
      const relPath = (urlPath.endsWith('/') ? join(urlPath, 'index.html') : urlPath).replace(/^\//, '');
      const entryStat = relPath ? await stat(join(currentDir, relPath)).catch(() => undefined) : undefined;
      if (entryStat?.isFile()) {
        return reply.sendFile(relPath, currentDir);
      }
      if (entryStat?.isDirectory()) {
        const query = qIndex === -1 ? '' : rawUrl.slice(qIndex);
        return reply.code(301).header('location', `${urlPath}/${query}`).send();
      }
      return reply.code(404).send('Not found');
    }
    const target = await legacyRedirectForRelease(req.raw.url ?? '', currentDir);
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

  return Object.assign(app, { quiesceMutations });
}
