import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import cookie from '@fastify/cookie';
import { probeImage } from './pipeline.js';
import { contentHashKey, storeOriginal, heroSnippet, isOriginalFile, assertSafeKey } from './storage.js';
import { deleteMedia, imageUsage } from './media-files.js';
import {
  libraryKey, redactForNonAdmin, MediaStoreError,
  type MediaItem, type MediaQuery, type MediaStatus, type MediaStore,
} from './media-store.js';
import { BacklogFullError, type EncodeQueue } from './encode-queue.js';
import { parseExif } from './exif.js';
import { diskSpace, insufficientSpace, formatBytes } from './disk.js';
import type { SyncReport } from './media-sync.js';
import { verifyPassword, type UserStore, UserExistsError, DUMMY_STORED_HASH, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './users.js';
import type { SessionStore } from './sessions.js';
import {
  SESSION_TTL_MS, loadUser, requireAuth, requireAdmin,
  setSessionCookie, clearSessionCookie, isSecureRequest, SESSION_COOKIE,
} from './authn.js';
import { SettingsError, type SettingsStore } from './settings.js';
import { validateDraft, validateForPublish, PostError, type PostStore, type PostPair, type StoredPostPair, type PostUsageRow } from './posts.js';
import { renderPreviewHtml } from './preview.js';
import { type PageStore, type PagePair, type PageContent, type ImageDims, PageError } from './pages.js';
import { exportPost, exportAll } from './export.js';
import type { SiteBuilder } from './build.js';
import { importWxr, ImportTooLargeError, type ImportDeps, type ImportSummary } from './wp-import.js';
import { createRehostResume } from './wp-images.js';
import { fixedWindowLimiter, rateLimitPreHandler, accountLockoutLimiter, type RateLimiter, type AccountLimiter } from './rate-limit.js';
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
  accountLimiter?: AccountLimiter;
  media: MediaStore;
  encodeQueue: EncodeQueue;
  /** Disk↔database reconciliation, triggered by POST /media/rescan. */
  mediaSync?: { run: () => Promise<SyncReport> };
  /**
   * The WXR importer. Injectable for the same reason as `loginLimiter` and
   * `mediaSync`: the real one's pacing and retry behaviour cannot be observed
   * from a route test, because every failure mode reachable without a network
   * (the SSRF guard, an unresolvable host) is classified NON-retryable by
   * design, and the retryable ones cost 15 s each.
   */
  importRunner?: (xml: string, deps: ImportDeps) => Promise<ImportSummary>;
}

/**
 * Whether a WordPress import is running right now (issue #85).
 *
 * @ai-note Module-scoped, so it is per PROCESS, which is the right granularity:
 * the app runs as a single container and the resource it protects (the source
 * host's patience, plus `${storageDir}` variant writes) is per process too.
 */
let importInFlight = false;

const KEY_RE = /^[a-z0-9][a-z0-9/_-]*$/;

/** IPv4 loopback block (127.0.0.0/8) — matched after WHATWG normalization, which
 *  canonicalizes shorthands (`127.1` → `127.0.0.1`) and rejects out-of-range octets. */
const LOOPBACK_IPV4_RE = /^127(?:\.\d{1,3}){3}$/;

/**
 * True iff a host *authority* — `localhost:3000`, `127.0.0.1:3000`, `[::1]:3000`,
 * `img.simonswanderlust.com` — names the loopback interface. Parsed with the WHATWG
 * URL parser rather than string matching, so an optional port and bracketed IPv6 are
 * handled correctly; an unparseable authority counts as non-local.
 *
 * Only the exact loopback names qualify. `evil.localhost` does not, even though some
 * resolvers map every `*.localhost` name to 127.0.0.1: this predicate exists solely to
 * detect the one-hostname local-dev setup that makes the image mount shadow the blog
 * mount (see setNotFoundHandler), and giving images their own hostname is precisely the
 * setup that has no such collision.
 */
function isLoopbackAuthority(authority: string): boolean {
  let hostname: string;
  try {
    ({ hostname } = new URL(`http://${authority}`));
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname === '[::1]' || LOOPBACK_IPV4_RE.test(hostname);
}

export function buildServer(cfg: ServerConfig): FastifyInstance {
  // @fastify/static requires an absolute root; tolerate a relative STORAGE_DIR
  // (e.g. ./data/images from env) by resolving against the process cwd.
  const storageDir = resolve(cfg.storageDir);
  // @ai-warning: trustProxy makes Fastify read X-Forwarded-* (so req.ip and the
  // cookie `secure` flag reflect the real client). This is correct ONLY behind a
  // trusted reverse proxy that sets X-Forwarded-Proto; if the container is ever
  // exposed directly, clients could spoof those headers.
  // @ai-note: http.Server#requestTimeout bounds how long the server waits to
  // fully RECEIVE a request (headers + body) — it does not bound how long a
  // handler then takes to process it (e.g. encoding an upload). Fastify sets
  // this to 0 (disabled) by default, itself overriding Node's own 300s
  // default, so without an explicit value a stalled request would never time
  // out at this layer. 120s is generous for even a large multipart upload
  // over a slow connection while still bounding one that stalls outright.
  const app = Fastify({ logger: false, trustProxy: true, requestTimeout: 120_000 });
  const { users, sessions } = cfg;

  // nosniff everywhere; clickjacking/referrer policies only on the admin/API
  // surface (blog pages keep parity with the old nginx: no admin headers).
  const ADMIN_PREFIXES = [
    '/admin', '/login', '/logout', '/auth', '/setup', '/settings', '/users',
    '/posts', '/upload', '/import', '/export', '/backups', '/rebuild', '/health', '/pages', '/images',
    // Without '/media' here the whole media API would lose X-Frame-Options and
    // Referrer-Policy — it is admin surface, not public.
    '/media', '/ai-config',
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
  const accountLimiter = cfg.accountLimiter ?? accountLockoutLimiter();
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
  // @ai-warning: `files: 1` is a data-integrity guard, not a convenience limit.
  // POST /upload reads one file into a single `buf`, so a multi-file request
  // used to buffer every file and silently keep only the last. Bulk upload is
  // N single-file requests by design.
  // `parts` also matters: @fastify/multipart's parser never consumes the body,
  // so Fastify's 1 MiB bodyLimit does NOT apply to multipart — without a cap,
  // one authenticated request could stream ~25 GB.
  app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1, parts: 8 },
  });
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

  // Declared before the upload route, which builds `src` from it.
  const imageBase = cfg.baseUrl.replace(/\/+$/, '');

  /** Cap on any `keys[]` batch: an unbounded array is an authenticated
   *  N-round-trip amplifier against the process that also serves the blog. */
  const MAX_BULK_KEYS = 100;

  /**
   * Single-file upload. The request returns as soon as the untouched ORIGINAL
   * is on disk; the AVIF/WebP variants encode in the background queue.
   *
   * @ai-warning This used to encode inline, which held the connection for
   * 40–90 s per frame at concurrency 2 on a VPS — against a reverse proxy
   * whose default read timeout is 60 s. The response is still complete
   * immediately because the storage key is a pure function of the content hash
   * and a metadata-only probe reads orientation-corrected dimensions in
   * ~0.0002 s (vs ~0.467 s for the re-encode probe it replaced). What callers
   * lose is that `${src}-640.webp` 404s until the encode lands — the media
   * library shows a processing badge, and `POST /posts/:tk/publish` refuses to
   * publish a post referencing a photo that is not `ready`.
   */
  app.post('/upload', { preHandler: requireAuth }, async (req, reply) => {
    let key = '';
    let alt = '';
    let title = '';
    let folder = '';
    let filename = '';
    let buf: Buffer | undefined;
    let mimetype = '';
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        mimetype = part.mimetype;
        filename = String(part.filename ?? '');
        buf = await part.toBuffer();
      } else if (part.fieldname === 'key') {
        key = String(part.value).trim();
      } else if (part.fieldname === 'alt') {
        alt = String(part.value).trim();
      } else if (part.fieldname === 'title') {
        title = String(part.value).trim();
      } else if (part.fieldname === 'folder') {
        folder = String(part.value).trim();
      }
    }
    if (!buf || !mimetype.startsWith('image/')) {
      return reply.code(400).send({ error: 'expected an image file' });
    }
    // Bulk library uploads have no post slug to derive a key from, and KEY_RE
    // is lowercase-only — a Leica's `L1002345.JPG` would be a 400. So the
    // server derives one when the client sends none. Editor uploads keep
    // sending their `trips/<slug>/…` keys and are unaffected.
    if (key === '') key = libraryKey(filename, new Date());
    if (!KEY_RE.test(key)) {
      return reply.code(400).send({ error: 'invalid key (use lowercase a-z, 0-9, / _ -)' });
    }

    // #73: refuse before writing rather than failing mid-pipeline. A full
    // /data takes out uploads, publishing AND backups at once, and a partial
    // variant set with no complete record is worse than a rejected upload.
    try {
      const space = await diskSpace(storageDir);
      const problem = insufficientSpace(space, buf.length);
      if (problem) {
        console.error(`upload refused: ${formatBytes(space.free)} free on ${storageDir}`);
        return reply.code(507).send({ error: problem });
      }
    } catch (e) {
      // An unreadable statfs must not block uploads — log and continue.
      console.error('could not read free disk space; accepting the upload anyway:', e);
    }

    // Version the key by content hash (issue #26): a re-upload mints a fresh
    // URL instead of overwriting variants cached as immutable; old URLs keep
    // serving because nothing on disk is touched. Clients use the returned
    // src/snippet, never the key they sent.
    const versionedKey = contentHashKey(key, buf);
    const src = `${imageBase}/${versionedKey}`;

    let probe;
    try {
      probe = await probeImage(buf);
    } catch (e) {
      console.error(`could not probe uploaded image for ${versionedKey}:`, e);
      return reply.code(400).send({ error: 'could not read that image' });
    }
    if (!probe.width || !probe.height) {
      return reply.code(400).send({ error: 'could not read that image' });
    }

    // Re-uploading identical bytes is the NORMAL case when a folder is dropped
    // twice, so all three states of an existing row are handled explicitly.
    const existing = await cfg.media.get(versionedKey);
    if (existing && existing.status === 'ready') {
      // Metadata the caller supplied still applies — it is not silently
      // discarded — but the STORED values win for the returned snippet.
      if (alt || title || folder) {
        await cfg.media.patch(versionedKey, {
          ...(title ? { title } : {}), ...(folder ? { folder } : {}),
          ...(alt ? { alt: { de: existing.alt.de || alt, en: existing.alt.en || alt } } : {}),
        }).catch(() => { /* metadata update is best-effort on a duplicate */ });
      }
      return reply.send({
        src, key: versionedKey, width: existing.width, height: existing.height,
        status: existing.status, duplicate: true,
        snippet: heroSnippet(src, existing.width, existing.height, existing.alt.de || alt),
      });
    }
    if (existing && existing.status === 'processing') {
      // Do NOT re-enqueue: the job is already in the queue.
      return reply.send({
        src, key: versionedKey, width: existing.width, height: existing.height,
        status: 'processing', duplicate: true,
        snippet: heroSnippet(src, existing.width, existing.height, alt),
      });
    }

    const exif = parseExif(probe.exif);
    try {
      await storeOriginal(versionedKey, buf, probe.ext, { storageDir });
    } catch (e) {
      console.error(`could not store the original for ${versionedKey}:`, e);
      return reply.code(500).send({ error: 'internal server error' });
    }
    await cfg.media.upsert({
      key: versionedKey, folder, title,
      alt: { de: alt, en: alt },
      width: probe.width, height: probe.height, origBytes: buf.length,
      status: 'processing', exif, uploadedBy: req.authUser?.id ?? null,
    });
    try {
      cfg.encodeQueue.enqueue(versionedKey);
    } catch (e) {
      if (e instanceof BacklogFullError) return reply.code(429).send({ error: e.message });
      throw e;
    }
    return reply.send({
      src, key: versionedKey, width: probe.width, height: probe.height,
      status: 'processing',
      snippet: heroSnippet(src, probe.width, probe.height, alt),
    });
  });

  // ---- media library ----

  // Everything (posts + pages) that could reference an image URL. Usage is
  // computed store-agnostically in TS so the memory and pg stores behave alike.
  // @ai-note: posts come from usageRows() — flat per-locale rows — NOT from
  // list()+get(): pgPostStore.get() returns null for a stranded single-locale
  // row (crash between upsertDraft's two locale INSERTs), and that row's image
  // references must still block deletion. Do not cache across requests (state
  // lives in backing services).
  //
  // @ai-note This loads EVERY post body (both locales) plus every page on each
  // call, and `imageUsage()` then scans that corpus once per item — so a page
  // of GET /media costs O(pageSize × corpus). Acceptable at this size and
  // deliberately not cached, but it is the same cost that made `list()` drop
  // body_markdown from its SELECT (see PostListRow in posts.ts): once the
  // corpus is large enough to notice, usage belongs in SQL (an index over the
  // referenced URLs) rather than a full-corpus scan per request. The delete
  // routes need it whatever happens; the listing route is the one to move.
  const usageCorpus = async (): Promise<{ posts: PostUsageRow[]; pages: PagePair[] }> => {
    const [postRows, pageKeys] = await Promise.all([cfg.posts.usageRows(), cfg.pages.keys()]);
    const pagePairs = await Promise.all(pageKeys.map((k) => cfg.pages.get(k)));
    return { posts: postRows, pages: pagePairs };
  };

  /**
   * Serialize a media row for the wire, redacting what a non-admin must not see.
   *
   * @ai-warning `GET /media` is SESSION-level where the `GET /images` it
   * replaces was admin-only — the gallery picker needs authors to browse. That
   * privilege drop is only safe because `exif.lat`/`exif.lng` and `uploadedBy`
   * are redacted here: handing every author the GPS coordinates of every photo
   * through a lower gate would undo the Phase 0 privacy fix. Tests assert the
   * redaction itself, not merely the status code.
   */
  const serializeMedia = (item: MediaItem, isAdmin: boolean) => (isAdmin ? item : redactForNonAdmin(item));

  const mediaError = (e: unknown, reply: import('fastify').FastifyReply) => {
    if (e instanceof MediaStoreError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'exists' || e.code === 'not_empty' ? 409 : 400;
      return reply.code(status).send({ error: e.message });
    }
    throw e;
  };

  // Paginated, filtered listing plus usage refs for the visible page only.
  app.get('/media', { preHandler: requireAuth }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const query: MediaQuery = {
      ...(q.folder !== undefined ? { folder: q.folder } : {}),
      recursive: q.recursive === '1' || q.recursive === 'true',
      ...(q.q !== undefined ? { q: q.q } : {}),
      ...(q.tag ? { tag: q.tag } : {}),
      ...(q.status ? { status: q.status as MediaStatus } : {}),
      ...(q.sort ? { sort: q.sort as MediaQuery['sort'] } : {}),
      ...(q.order ? { order: q.order as MediaQuery['order'] } : {}),
      ...(q.page ? { page: Number(q.page) } : {}),
      ...(q.pageSize ? { pageSize: Number(q.pageSize) } : {}),
    };
    let result;
    try {
      result = await cfg.media.list(query);
    } catch (e) {
      return mediaError(e, reply);
    }
    const corpus = await usageCorpus();
    const isAdmin = Boolean(req.authUser?.isAdmin);
    return reply.send({
      total: result.total,
      items: result.items.map((m) => ({
        ...serializeMedia(m, isAdmin),
        usedIn: imageUsage(m.src, corpus.posts, corpus.pages),
      })),
    });
  });

  app.get('/media/folders', { preHandler: requireAuth }, async (_req, reply) =>
    reply.send(await cfg.media.folders()));

  app.post('/media/folders', { preHandler: requireAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as { path?: unknown };
    try {
      await cfg.media.createFolder(String(b.path ?? ''));
    } catch (e) {
      return mediaError(e, reply);
    }
    return reply.send({ ok: true, folders: await cfg.media.folders() });
  });

  // Rename and delete are ADMIN-only: both are bulk-irreversible, and media
  // has no revision history the way posts do.
  app.patch('/media/folders', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { from?: unknown; to?: unknown };
    try {
      const moved = await cfg.media.renameFolder(String(b.from ?? ''), String(b.to ?? ''));
      return reply.send({ ok: true, moved, folders: await cfg.media.folders() });
    } catch (e) {
      return mediaError(e, reply);
    }
  });

  app.delete('/media/folders', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { path?: unknown };
    try {
      await cfg.media.deleteFolder(String(b.path ?? ''));
      return reply.send({ ok: true, folders: await cfg.media.folders() });
    } catch (e) {
      return mediaError(e, reply);
    }
  });

  app.post('/media/move', { preHandler: requireAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as { keys?: unknown; folder?: unknown };
    if (!Array.isArray(b.keys)) return reply.code(400).send({ error: 'keys must be an array' });
    if (b.keys.length > MAX_BULK_KEYS) return reply.code(400).send({ error: `at most ${MAX_BULK_KEYS} photos per request` });
    try {
      const moved = await cfg.media.move(b.keys.map(String), String(b.folder ?? ''));
      return reply.send({ ok: true, moved });
    } catch (e) {
      return mediaError(e, reply);
    }
  });

  // Re-queue failed encodes. The original is still on disk, so this is just a
  // status flip plus an enqueue — re-encoding overwrites the same filenames.
  //
  // @ai-warning A failed enqueue MUST roll the status back. Flipping to
  // `processing` and then hitting a full backlog strands the key: the row says
  // `processing` with nothing queued, and nothing recovers it — this route
  // skips `processing` (below), the UI only offers Retry for `failed`, and the
  // publish gate blocks every post referencing it until the next restart runs
  // encodeQueue.recover().
  // The flip has to come FIRST despite that, not after a successful enqueue:
  // the queue can start the job immediately, and a fast encode would then
  // write `ready` before our write landed, leaving the row stuck at
  // `processing` after a perfectly successful encode.
  app.post('/media/retry', { preHandler: requireAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as { keys?: unknown };
    const keys = Array.isArray(b.keys) ? b.keys.map(String).slice(0, MAX_BULK_KEYS) : [];
    let queued = 0;
    for (const key of keys) {
      const item = await cfg.media.get(key);
      // `missing` is retryable too: media-sync marks a row missing when its
      // files vanish, and the retained original may well still be there.
      if (!item || item.status === 'ready' || item.status === 'processing') continue;
      await cfg.media.setStatus(key, 'processing');
      try {
        cfg.encodeQueue.enqueue(key);
      } catch (e) {
        await cfg.media.setStatus(key, item.status, item.error ?? undefined)
          .catch((err) => console.error(`could not restore status for ${key}:`, err));
        if (e instanceof BacklogFullError) return reply.code(429).send({ error: e.message, queued });
        throw e;
      }
      queued++;
    }
    return reply.send({ ok: true, queued });
  });

  app.post('/media/rescan', { preHandler: requireAdmin }, async (_req, reply) => {
    if (!cfg.mediaSync) return reply.code(503).send({ error: 'reconciliation is not configured' });
    return reply.send(await cfg.mediaSync.run());
  });

  app.get('/media/queue', { preHandler: requireAuth }, async (_req, reply) =>
    reply.send(cfg.encodeQueue.stats()));

  // Item routes nest under /media/items/* so a wildcard key (keys contain
  // slashes: trips/x/hero) can never collide with the static /media/folders.
  app.get('/media/items/*', { preHandler: requireAuth }, async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    const item = await cfg.media.get(key);
    if (!item) return reply.code(404).send({ error: 'image not found' });
    const corpus = await usageCorpus();
    return reply.send({
      ...serializeMedia(item, Boolean(req.authUser?.isAdmin)),
      usedIn: imageUsage(item.src, corpus.posts, corpus.pages),
    });
  });

  app.patch('/media/items/*', { preHandler: requireAuth }, async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<MediaStore['patch']>[1] = {};
    if (b.folder !== undefined) patch.folder = String(b.folder);
    if (b.title !== undefined) patch.title = String(b.title);
    if (b.alt && typeof b.alt === 'object') {
      const alt = b.alt as Record<string, unknown>;
      patch.alt = {
        ...(alt.de !== undefined ? { de: String(alt.de) } : {}),
        ...(alt.en !== undefined ? { en: String(alt.en) } : {}),
      };
    }
    if (b.caption && typeof b.caption === 'object') {
      const cap = b.caption as Record<string, unknown>;
      patch.caption = {
        ...(cap.de !== undefined ? { de: String(cap.de) } : {}),
        ...(cap.en !== undefined ? { en: String(cap.en) } : {}),
      };
    }
    if (Array.isArray(b.tags)) patch.tags = b.tags.map(String);
    try {
      const saved = await cfg.media.patch(key, patch);
      return reply.send(serializeMedia(saved, Boolean(req.authUser?.isAdmin)));
    } catch (e) {
      return mediaError(e, reply);
    }
  });

  // Deletion stays ADMIN-only and still refuses when a post or page references
  // the photo.
  // @ai-note: usage only sees Postgres content — the last built release may
  // still reference a deleted image until the next rebuild.
  app.delete('/media/items/*', { preHandler: requireAdmin }, async (req, reply) => {
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
    const hadRow = (await cfg.media.get(key)) !== null;
    await cfg.media.remove(key);
    if (deleted === 0 && !hadRow) return reply.code(404).send({ error: 'image not found' });
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
    if (b.importDelayMs !== undefined) partial.importDelayMs = Number(b.importDelayMs);
    if (b.importRetries !== undefined) partial.importRetries = Number(b.importRetries);
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
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return reply.code(400).send({ error: `password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters` });
    }
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
    // Constant-time execution: when username is missing, execute verifyPassword with DUMMY_STORED_HASH
    // so response timing does not leak whether a username exists (CWE-208 mitigation).
    const storedHash = user ? user.passwordHash : DUMMY_STORED_HASH;
    const isValid = verifyPassword(password, storedHash);

    if (accountLimiter.isLocked(username)) {
      return reply.code(429).send({ error: 'account is temporarily locked due to excessive failed login attempts' });
    }

    if (!user || !isValid) {
      if (username) accountLimiter.recordFailure(username);
      return reply.code(401).send({ error: 'invalid username or password' });
    }

    accountLimiter.recordSuccess(username);
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
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return reply.code(400).send({ error: `password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters` });
    }
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
    if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH || currentPassword.length > MAX_PASSWORD_LENGTH) {
      return reply.code(400).send({ error: `new password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters` });
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

  /**
   * Turn an image URL from a post back into its storage key, or null when the
   * URL is not one of ours. Strips the image base and any hand-pasted variant
   * suffix (`-1280.webp` from the browser's "Copy image address").
   */
  function srcToKey(src: string, baseUrl: string): string | null {
    if (typeof src !== 'string' || src === '') return null;
    const prefix = `${baseUrl}/`;
    let u: URL;
    let base: URL;
    try { u = new URL(src); base = new URL(baseUrl); } catch { return null; }
    // Origin equality, never a prefix match — same rule as the gallery
    // allow-list (see site/src/lib/body-images.ts).
    if (u.origin !== base.origin || !src.startsWith(prefix)) return null;
    return src.slice(prefix.length).replace(/-\d+\.(?:avif|webp)$/, '');
  }

  /**
   * Every image URL a post references: both heroes and every `images` key
   * (gallery URLs are already `images` keys — body-images.ts skips any that
   * are not).
   */
  function referencedSrcs(pair: StoredPostPair): string[] {
    const out = new Set<string>();
    for (const locale of ['de', 'en'] as const) {
      const l = pair[locale];
      if (l?.heroImage?.src) out.add(l.heroImage.src);
      for (const key of Object.keys(l?.images ?? {})) out.add(key);
    }
    return [...out];
  }

  /**
   * The publish gate: refuse to publish a post whose photos are still encoding.
   *
   * @ai-warning Deliberately NOT in `validateForPublish`, which is a
   * synchronous, pure `(pair) => void` with no store access and no knowledge of
   * `cfg.baseUrl`; making it async would ripple through every posts.test.ts
   * case for no benefit. This is also the ONLY real check on the encode
   * queue's `status` invariant — without it a post publishes, `astro build`
   * succeeds, and the live site shows broken <img> elements, because the URL is
   * already in the body and the original is already on disk.
   *
   * URLs with NO media row do not block: WordPress-imported and legacy files
   * predate the library and exist on disk perfectly well.
   */
  async function notReadyPhotos(pair: StoredPostPair): Promise<string[]> {
    const keys = referencedSrcs(pair)
      .map((src) => srcToKey(src, imageBase))
      .filter((k): k is string => k !== null);
    if (keys.length === 0) return [];
    const notReady = await cfg.media.notReadyKeys(keys);
    return [...notReady];
  }

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
      .send(await renderPreviewHtml(pair, locale, imageBase));
  });

  const upsert = async (req: { body: unknown }, reply: import('fastify').FastifyReply, tk: string) => {
    // `updatedAt` is the optimistic-concurrency echo (the value the editor
    // loaded), not part of the pair itself — strip it before storing. It is
    // optional: callers without it (new posts, WP importer) skip the check.
    const { updatedAt, ...body } = (req.body ?? {}) as PostPair & { updatedAt?: unknown };
    const pair: PostPair = { ...body, translationKey: tk };
    // PUT must never create: a stale tab saving a post an admin deleted must get
    // a 404, not resurrect it (issue #106). POST passes tk='' and skips this.
    if (tk && !(await posts.get(tk))) return reply.code(404).send({ error: 'post not found' });
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

  app.get('/api/categories', { preHandler: requireAuth }, async () => {
    if (posts.listCategories) return posts.listCategories();
    return [];
  });

  app.get('/api/tags', { preHandler: requireAuth }, async () => {
    if (posts.listTags) return posts.listTags();
    return [];
  });

  app.get('/api/cms/stats', { preHandler: requireAuth }, async () => {
    const postStats = posts.getCmsStats ? await posts.getCmsStats() : { totalPosts: 0, draftPosts: 0, publishedPosts: 0, scheduledPosts: 0, archivedPosts: 0, totalCategories: 0, totalTags: 0 };
    const mediaRes = await cfg.media.list({});
    return {
      ...postStats,
      mediaCount: mediaRes.items.length,
    };
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
    const notReady = await notReadyPhotos(pair);
    if (notReady.length > 0) {
      return reply.code(409).send({
        error: `${notReady.length} photo(s) are still processing or failed to encode — wait for them to finish, then publish again`,
        notReady,
      });
    }
    await posts.publish(tk);
    const published = await posts.get(tk);
    const build = await cfg.builder.build();
    if (published) await exportPost(published, cfg.backupDir).catch(() => { /* best-effort backup */ });
    // updatedAt: publish bumps the stored timestamp, so the editor must re-sync
    // its concurrency echo or its very next Save would falsely 409.
    return reply.send({ published: true, build, updatedAt: published?.updatedAt });
  });

  // Bulk publish / unpublish / delete from the posts list. Admin-only for the
  // same reason the single-post routes are: every action here changes what the
  // public site serves.
  //
  // Three things this deliberately does NOT do:
  //  • It does not abort on the first failure. `posts.get()` returns null for a
  //    stranded single-locale pair that `list()` still shows, so a perfectly
  //    ordinary selection can contain a key that cannot be acted on — report it
  //    per post and carry on.
  //  • It does not rebuild per post. `createSiteBuilder` already coalesces
  //    concurrent builds one-deep, so N calls would be correct but would
  //    serialise N full Astro builds; mutate first, then build once.
  //  • It does not skip the MDX backup. The single-post publish route runs
  //    `exportPost` best-effort afterwards; omitting it here would silently
  //    leave bulk-published posts without a backup.
  //
  // @ai-warning This request is UNBOUNDED IN WALL-CLOCK TIME, and nothing in
  // this process bounds it: Fastify's `requestTimeout` only caps how long the
  // server waits to RECEIVE a request, not how long a handler may run. A
  // 100-key publish is 100 × (validate + publish + get + exportPost) plus one
  // full Astro build, all before the first byte of the response. The only real
  // ceiling is the reverse proxy's read timeout — which is exactly what issue
  // #72 is about, and the reason MAX_BULK_KEYS exists at all. If that ever
  // starts timing out in practice, the fix is to return the per-post results
  // before triggering the build (the client already polls nothing, so it would
  // need a follow-up call), NOT to raise the proxy timeout.
  const BULK_ACTIONS = ['publish', 'unpublish', 'delete'] as const;
  type BulkAction = (typeof BULK_ACTIONS)[number];

  app.post('/posts/bulk', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { action?: unknown; keys?: unknown };
    const action = String(b.action ?? '') as BulkAction;
    if (!BULK_ACTIONS.includes(action)) {
      return reply.code(400).send({ error: `action must be one of ${BULK_ACTIONS.join(', ')}` });
    }
    if (!Array.isArray(b.keys)) return reply.code(400).send({ error: 'keys must be an array' });
    if (b.keys.length > MAX_BULK_KEYS) {
      return reply.code(400).send({ error: `at most ${MAX_BULK_KEYS} posts per request` });
    }
    // Dedupe: a repeated key would otherwise be processed (and reported) twice.
    const keys = [...new Set(b.keys.map((k) => String(k)))].filter((k) => k !== '');
    if (keys.length === 0) return reply.code(400).send({ error: 'keys must not be empty' });

    const results: { key: string; ok: boolean; error?: string }[] = [];
    // Whether anything that was actually LIVE changed — a bulk delete of drafts
    // only needs no rebuild, mirroring DELETE /posts/:tk's `wasPublished` rule.
    let liveChanged = false;
    for (const tk of keys) {
      try {
        const pair = await posts.get(tk);
        if (!pair) throw new PostError('post not found');
        if (action === 'publish') {
          validateForPublish(pair);
          const notReady = await notReadyPhotos(pair);
          if (notReady.length > 0) {
            throw new PostError(`${notReady.length} photo(s) are still processing or failed to encode`);
          }
          await posts.publish(tk);
          const published = await posts.get(tk);
          if (published) await exportPost(published, cfg.backupDir).catch(() => { /* best-effort backup */ });
          liveChanged = true;
        } else if (action === 'unpublish') {
          if (pair.status !== 'published') throw new PostError('post is not published');
          await posts.unpublish(tk);
          liveChanged = true;
        } else {
          if (pair.status === 'published') liveChanged = true;
          await posts.remove(tk);
        }
        results.push({ key: tk, ok: true });
      } catch (e) {
        // Never leak an internal error to the client (global-handler contract):
        // PostError messages are ours and safe; anything else is logged and
        // reported generically.
        if (e instanceof PostError) {
          results.push({ key: tk, ok: false, error: e.message });
        } else {
          console.error(`bulk ${action} failed for ${tk}:`, e);
          results.push({ key: tk, ok: false, error: 'internal error' });
        }
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    const build = liveChanged ? await cfg.builder.build() : undefined;
    return reply.send({ action, succeeded, failed: results.length - succeeded, results, ...(build ? { build } : {}) });
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
    // @ai-warning: free space is REPORTED, never a health verdict (#73). A low
    // -space warning that flipped the container unhealthy would trigger a
    // restart loop, which makes a full disk strictly worse. The probe is
    // best-effort for the same reason: an unreadable statfs must not 503.
    let disk: { free: number; total: number; freeLabel: string } | undefined;
    try {
      const space = await diskSpace(storageDir);
      disk = { ...space, freeLabel: formatBytes(space.free) };
    } catch { /* reported as absent */ }
    try {
      await cfg.dbCheck();
      return { ok: true, db: true, ...(disk ? { disk } : {}) };
    } catch {
      return reply.code(503).send({ ok: false, db: false, ...(disk ? { disk } : {}) });
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
        // @ai-warning: this cast is the reason `validatePagePair` runs
        // `imagesMapError` — the map is whatever JSON the client sent, and it
        // ends up at the render boundary in site/src/lib/body-images.ts.
        // Never "simplify" the validation away on the strength of this type.
        images: (src.images ?? {}) as Record<string, ImageDims>,
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
    // @ai-warning ONE import at a time. Resumability (issue #85) makes "run the
    // import again" the documented recovery path when the browser or the reverse
    // proxy gives up on a multi-minute request, so concurrent runs stopped being
    // hypothetical. Two of them would each see a mostly-empty resume index and
    // re-fetch everything (the very double-charging resumability exists to
    // prevent), hit the source host at twice the configured rate — the pacing
    // gate is per-run state and gives no aggregate guarantee — race
    // storeVariantFiles' non-atomic writes into a variant set mixing two source
    // images, and run two sharp pipelines inside one mem_limit'd container.
    // Deliberately NOT work-lock: no lock is taken and no queue is involved.
    if (importInFlight) {
      return reply.code(409).send({ error: 'an import is already running; wait for it to finish' });
    }
    importInFlight = true;
    try {
      let xml = '';
      for await (const part of req.parts()) {
        if (part.type === 'file') xml = (await part.toBuffer()).toString('utf8');
      }
      if (!xml.includes('<rss') || !xml.includes('wordpress.org/export')) {
        return reply.code(400).send({ error: 'not a WordPress export (.xml) file' });
      }
      const { importDelayMs, importRetries } = cfg.settings.get();
      let summary: ImportSummary;
      try {
        summary = await (cfg.importRunner ?? importWxr)(xml, {
          postStore: cfg.posts, storageDir: cfg.storageDir, baseUrl: cfg.baseUrl,
          delayMs: importDelayMs,
          retries: importRetries,
          // A FRESH disk walk per import, which is why this is built here rather
          // than injected once at boot like `settings` or `dbBackup`.
          resume: await createRehostResume({ storageDir: cfg.storageDir, baseUrl: cfg.baseUrl }),
          log: (msg) => console.log(msg),
        });
      } catch (e) {
        // issue #96: an export whose distinct-image count exceeds the cap is
        // rejected BEFORE any fetch — a 400 naming the count, not a 500.
        if (e instanceof ImportTooLargeError) return reply.code(400).send({ error: e.message });
        throw e;
      }
      // 400 only when the export yielded no groups at all. Every group lands in exactly
      // one bucket (issue #100), so an all-published or all-rejected export is a 200
      // with an honest summary — the old check 400'd a re-run of an already-published
      // export, and a 400 cannot say WHICH groups were rejected and why.
      if (summary.imported + summary.updated + summary.skippedPublished + summary.rejected + summary.failed === 0) {
        return reply.code(400).send({ error: 'no importable posts found in export' });
      }
      return reply.send(summary);
    } finally {
      // finally, not after send: a throw here would otherwise wedge the endpoint
      // until the process restarts.
      importInFlight = false;
    }
  });

  // @ai-note: the image host doubles as a blog host so that LOCAL DEV works, and
  // ONLY for local dev. uploader/.env.example tells you to set IMG_HOST=localhost:3000
  // for a bare local run; the image mount's host constraint then matches every request
  // on the only host that exists, shadowing the blog mount. Measured with that config:
  // without the arm below `/` and `/rumaenien/` 404 (`/admin/` and image variants serve
  // either way); with it they serve.
  // @ai-warning: this must never engage in production. With IMG_HOST=img.simonswanderlust.com
  // an ungated arm publishes a second, fully crawlable copy of the blog on the image
  // subdomain (duplicate content, split SEO). The gate is computed once here from the
  // *configured* imgHost and never from the request's Host header, so a spoofed Host
  // cannot talk a production deployment into the local branch; when it is off, the image
  // host plain-404s non-image paths exactly as it did before the arm existed (513bf5f).
  const imgHostServesBlog = isLoopbackAuthority(cfg.imgHost);

  // 404/503 for the blog; plain 404 for the img host and non-GET methods.
  app.setNotFoundHandler(async (req, reply) => {
    const host = req.headers.host ?? '';
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(404).send({ error: 'not found' });
    if (host === cfg.imgHost) {
      if (!imgHostServesBlog) return reply.code(404).send('Not found');
      // Delegated to @fastify/static's reply.sendFile (decorated by the /admin/
      // mount, which does not set decorateReply:false) instead of a hand-rolled
      // readFile: that buys the full mime database, ETag/Last-Modified, range
      // requests and @fastify/send's own root-containment check. No options are
      // passed, so the bytes are served with exactly the same headers as the
      // blog mount above serves them on the main host — in particular NOT the
      // image mount's immutable 365d, which would be wrong here: release HTML
      // changes under a stable URL on every publish.
      const rawUrl = req.raw.url ?? '';
      const qIndex = rawUrl.indexOf('?');
      const urlPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
      const relPath = (urlPath.endsWith('/') ? join(urlPath, 'index.html') : urlPath).replace(/^\//, '');
      const stat = relPath ? statSync(join(currentDir, relPath), { throwIfNoEntry: false }) : undefined;
      if (stat?.isFile()) return reply.sendFile(relPath, currentDir);
      // A directory without its trailing slash: mirror the blog mount's
      // `redirect: true` (301) rather than reading the directory and blowing up.
      if (stat?.isDirectory()) {
        const query = qIndex === -1 ? '' : rawUrl.slice(qIndex);
        return reply.code(301).header('location', `${urlPath}/${query}`).send();
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
