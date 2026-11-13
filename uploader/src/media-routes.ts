import type { FastifyReply } from 'fastify';
import { diskSpace, insufficientSpace } from './disk.js';
import { BacklogFullError } from './encode-queue.js';
import { deleteMedia, imageUsage, imageUsageBatch, listVariantFiles, type MediaVersions, type UsageRef } from './media-files.js';
import { mediaImpact, type MediaImpact } from './media-impact.js';
import {
  MediaChangedError, MediaStoreError, redactForNonAdmin,
  type MediaError, type MediaItem, type MediaQuery, type MediaStatus,
} from './media-store.js';
import { galleryPending, type DescriptionPending } from './publication.js';
import { assertSafeKey } from './storage.js';
import { UPLOAD_UUID_RE } from './upload-receipts.js';
import { canonicalizeConditional } from '../public/media-conditional.js';
import { isPlainObject } from './request-guards.js';
import { MAX_BULK_KEYS, type ServerContext } from './server-context.js';

export function registerMediaRoutes(ctx: ServerContext): void {
  const { app, cfg, storageDir, imageBase, publication, requireAuth, requireAdmin, usageCorpus } = ctx;

  const releaseUnqueued = async (key: string, s: MediaStatus, e?: MediaError): Promise<boolean> => {
    if (cfg.encodeQueue.isActive(key)) return false;
    return cfg.media.setStatusIfProcessing(key, s, e).catch((err: unknown) => {
      console.error(`could not roll back status for ${key}:`, err);
      return false;
    });
  };

  const serializeMedia = (item: MediaItem, isAdmin: boolean) => (isAdmin ? item : redactForNonAdmin(item));

  async function mediaDetailProjection(item: MediaItem, isAdmin: boolean) {
    let impact: MediaImpact = { availability: 'unavailable' };
    let usedIn: UsageRef[] | undefined;
    try {
      const [corpus, impactCorpus] = await Promise.all([usageCorpus(), cfg.posts.mediaImpactCorpus()]);
      usedIn = imageUsage(item.src, corpus.posts, corpus.pages, corpus.journeys);
      impact = await mediaImpact(impactCorpus, item.key, imageBase);
    } catch { console.warn('Media impact unavailable'); }
    let livePending: DescriptionPending | null = null;
    if (isAdmin) {
      try {
        const observation = await publication.read();
        const pending = observation ? await galleryPending(observation, cfg.media, imageBase) : null;
        if (pending) livePending = pending.byKey.get(item.key)
          ?? { de: { alt: false, caption: false }, en: { alt: false, caption: false } };
      } catch { console.warn('Media pending projection unavailable'); }
    }
    return { impact, ...(usedIn ? { usedIn } : {}), ...(isAdmin ? { livePending } : {}) };
  }

  async function mediaVersions(item: MediaItem): Promise<MediaVersions> {
    if (item.status === 'processing') return { availability: 'processing' };
    try {
      const files = await listVariantFiles(storageDir, item.key);
      return {
        availability: 'available',
        items: files.map((file) => ({ ...file, src: `${item.src}-${file.width}.${file.format}` })),
      };
    } catch {
      console.warn('Media versions unavailable');
      return { availability: 'unavailable' };
    }
  }

  const mediaError = (e: unknown, reply: FastifyReply) => {
    if (e instanceof MediaStoreError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'exists' || e.code === 'not_empty' ? 409 : 400;
      return reply.code(status).send({ error: e.message });
    }
    throw e;
  };

  app.post('/upload', { preHandler: requireAuth }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!cfg.uploads) return reply.code(503).send({ error: 'upload receipts are unavailable' });
    const fields: Record<string, string> = {};
    let filename = '';
    let buf: Buffer | undefined;
    let mimetype = '';
    let invalidFileType = false;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        mimetype = part.mimetype;
        filename = String(part.filename ?? '');
        if (!mimetype.startsWith('image/')) {
          part.file.resume();
          invalidFileType = true;
          continue;
        }
        buf = await part.toBuffer();
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    const uploadId = fields.uploadId ?? '';
    const expectedOwnerId = fields.expectedOwnerId ?? '';
    const generation = fields.retryGeneration ?? '0';
    if (!UPLOAD_UUID_RE.test(uploadId) || !UPLOAD_UUID_RE.test(expectedOwnerId) || !/^(0|[1-9][0-9]*)$/.test(generation) || !Number.isSafeInteger(Number(generation))) {
      return reply.code(400).send({ code: 'invalid_upload_identity', error: 'Valid uploadId, expectedOwnerId and retryGeneration are required.' });
    }
    if (expectedOwnerId !== req.authUser!.id) return reply.code(403).send({ code: 'owner_changed', error: 'The authenticated account changed.' });
    if (invalidFileType || !buf || !mimetype.startsWith('image/')) return reply.code(400).send({ error: 'expected an image file' });
    try {
      const space = await diskSpace(storageDir);
      const problem = insufficientSpace(space, buf.length);
      if (problem) return reply.code(507).send({ error: problem });
    } catch (error) {
      console.error('could not read free disk space; accepting the upload anyway:', error);
    }
    const result = await cfg.uploads.upload({
      userId: req.authUser!.id, uploadId, retryGeneration: Number(generation), bytes: buf,
      key: fields.key ?? '', title: fields.title ?? '', alt: fields.alt ?? '', folder: fields.folder ?? '', filename,
    });
    return reply.code(result.statusCode).send(result.body);
  });

  app.get<{ Params: { uploadId: string } }>('/upload/receipts/:uploadId', { preHandler: requireAuth }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!UPLOAD_UUID_RE.test(req.params.uploadId)) return reply.code(404).send({ error: 'receipt not found' });
    if (!cfg.uploads) return reply.code(503).send({ error: 'upload receipts are unavailable' });
    const receipt = await cfg.uploads.get(req.authUser!.id, req.params.uploadId);
    if (!receipt) return reply.code(404).send({ error: 'receipt not found' });
    return reply.send(receipt);
  });

  app.post('/media/lookup', { preHandler: requireAuth, bodyLimit: 32 * 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = req.body;
    if (!isPlainObject(body) || !('keys' in body)
      || !Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 100
      || new Set(body.keys).size !== body.keys.length) return reply.code(400).send({ error: 'expected 1–100 distinct media keys' });
    const keys: string[] = [];
    for (const key of body.keys) {
      if (typeof key !== 'string') return reply.code(400).send({ error: 'invalid media key' });
      try { assertSafeKey(key); } catch { return reply.code(400).send({ error: 'invalid media key' }); }
      keys.push(key);
    }
    return reply.send({ items: await cfg.media.lookup(keys) });
  });

  app.get('/media', { preHandler: requireAuth }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const query: MediaQuery = {
      ...(q.folder !== undefined ? { folder: q.folder } : {}),
      recursive: q.recursive === '1' || q.recursive === 'true',
      ...(q.q !== undefined ? { q: q.q } : {}),
      ...(q.tag ? { tag: q.tag } : {}),
      ...(q.status ? { status: q.status as MediaStatus } : {}),
      ...(q.alt === 'missing' ? { alt: 'missing' as const } : {}),
      ...(q.sort ? { sort: q.sort as MediaQuery['sort'] } : {}),
      ...(q.order ? { order: q.order as MediaQuery['order'] } : {}),
      ...(q.page ? { page: Number(q.page) } : {}),
      ...(q.pageSize ? { pageSize: Number(q.pageSize) } : {}),
    };
    let result;
    let altMissing = 0;
    const countAltMissing = async () => {
      if (query.status && query.status !== 'ready') return 0;
      const altQuery: MediaQuery = { ...query, status: 'ready', alt: 'missing' };
      return cfg.media.count ? cfg.media.count(altQuery) : (await cfg.media.list({ ...altQuery, page: 1, pageSize: 1 })).total;
    };
    try {
      [result, altMissing] = await Promise.all([cfg.media.list(query), countAltMissing()]);
    } catch (e) {
      return mediaError(e, reply);
    }
    const corpus = await usageCorpus();
    const usageBySrc = imageUsageBatch(
      result.items.map((m) => m.src), corpus.posts, corpus.pages, corpus.journeys,
    );
    const isAdmin = Boolean(req.authUser?.isAdmin);
    return reply.send({
      total: result.total,
      altMissing,
      items: result.items.map((m) => ({
        ...serializeMedia(m, isAdmin),
        usedIn: usageBySrc.get(m.src) ?? [],
      })),
    });
  });

  app.get('/media/folders', { preHandler: requireAuth }, async (_req, reply) =>
    reply.header('Cache-Control', 'no-store').send(await cfg.media.folders()));

  app.post('/media/folders', { preHandler: requireAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as { path?: unknown };
    try {
      await cfg.media.createFolder(String(b.path ?? ''));
    } catch (e) {
      return mediaError(e, reply);
    }
    return reply.send({ ok: true, folders: await cfg.media.folders() });
  });

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

  app.post('/media/retry', { preHandler: requireAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as { keys?: unknown };
    if (!Array.isArray(b.keys)) return reply.code(400).send({ error: 'keys must be an array' });
    if (b.keys.length > MAX_BULK_KEYS) return reply.code(400).send({ error: `at most ${MAX_BULK_KEYS} photos per request` });
    const keys = [...new Set(b.keys.map(String))].filter((k) => k !== '');
    let queued = 0;
    for (const key of keys) {
      try {
        const admitted = await cfg.encodeQueue.withAdmission(key, async () => {
          const item = await cfg.media.get(key);
          if (!item || item.status === 'ready' || item.status === 'processing') return false;
          await cfg.media.setStatus(key, 'processing');
          try {
            cfg.encodeQueue.enqueue(key);
          } catch (e) {
            await releaseUnqueued(key, item.status, item.error ?? undefined);
            throw e;
          }
          return true;
        });
        if (admitted) queued++;
      } catch (e) {
        if (e instanceof BacklogFullError) return reply.code(429).send({ error: e.message, queued });
        throw e;
      }
    }
    return reply.send({ ok: true, queued });
  });

  app.post('/media/rescan', { preHandler: requireAdmin }, async (_req, reply) => {
    if (!cfg.reconciler) return reply.code(503).send({ error: 'reconciliation is not configured' });
    const report = await cfg.reconciler.run();
    const receipts = cfg.uploads ? await cfg.uploads.recover() : undefined;
    return reply.send({ ...report, ...(receipts ? { receipts } : {}) });
  });

  app.get('/media/queue', { preHandler: requireAuth }, async (_req, reply) =>
    reply.send(cfg.encodeQueue.stats()));

  app.get('/media/items/*', { preHandler: requireAuth }, async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    const item = await cfg.media.get(key);
    if (!item) return reply.code(404).send({ error: 'image not found' });
    reply.header('Cache-Control', 'no-store');
    const isAdmin = Boolean(req.authUser?.isAdmin);
    const wantsVersions = (req.query as { versions?: unknown } | undefined)?.versions === '1';
    return reply.send({
      ...serializeMedia(item, isAdmin),
      ...await mediaDetailProjection(item, isAdmin),
      ...(wantsVersions ? { versions: await mediaVersions(item) } : {}),
    });
  });

  app.patch('/media/items/*', { preHandler: requireAuth }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const key = (req.params as { '*': string })['*'];
    let conditional;
    try { conditional = canonicalizeConditional(req.body); }
    catch { return reply.code(400).send({ error: 'invalid_media_conditional' }); }
    try {
      const saved = await cfg.media.patchConditional(key, conditional);
      const isAdmin = Boolean(req.authUser?.isAdmin);
      return reply.send({ ...serializeMedia(saved, isAdmin), conditionalVersion: 1,
        changedDescriptions: saved.changedDescriptions, ...await mediaDetailProjection(saved, isAdmin) });
    } catch (e) {
      if (e instanceof MediaChangedError) {
        return reply.code(409).send({
          error: 'media_changed',
          current: serializeMedia(e.current, Boolean(req.authUser?.isAdmin)),
        });
      }
      return mediaError(e, reply);
    }
  });

  app.delete('/media/items/*', { preHandler: requireAdmin }, async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    try {
      assertSafeKey(key);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    if (!cfg.uploads) return reply.code(503).send({ error: 'upload receipts are unavailable' });
    return cfg.encodeQueue.withAdmission(key, async () => {
      const corpus = await usageCorpus();
      const usedIn = imageUsage(`${imageBase}/${key}`, corpus.posts, corpus.pages, corpus.journeys);
      if (usedIn.length > 0) {
        const error = usedIn.some((u) => u.published && !u.working)
          ? 'image is still part of a published version — republish (or unpublish) that post first'
          : 'image is referenced by existing content — remove those references first';
        return reply.code(409).send({ error, usedIn });
      }
      const item = await cfg.media.get(key);
      if (item?.status === 'processing' || cfg.encodeQueue.isActive(key)) {
        return reply.code(409).send({ error: 'photo is still being encoded — wait for it to finish (or fail), then delete it' });
      }
      const deleted = await deleteMedia(storageDir, key, { signal: cfg.storageSignal, isWritable: ctx.isWritable });
      await cfg.uploads!.removeMedia(key, (client) => cfg.media.remove(key, client));
      if (deleted === 0 && item === null) return reply.code(404).send({ error: 'image not found' });
      return reply.send({ ok: true, deleted });
    });
  });
}
