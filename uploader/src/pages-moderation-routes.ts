import type { FastifyReply } from 'fastify';
import { isPageKind, PAGE_KINDS } from '../../site/src/lib/page-kinds.js';
import { projectBuildReport } from './build-state.js';
import {
  CommentError, UUID_RE as COMMENT_ID_RE, isCommentStatus, isModerationOffset, withPublicLocaleMetadata,
} from './comments-admin.js';
import { loadGalleryMetadata } from './gallery-metadata.js';
import { PageError, isSafePageKey, pagePaths, type ImageDims, type PageUpdate } from './pages.js';
import { saveReceiptFromRequest } from './posts-routes.js';
import { renderPagePreviewHtml } from './preview.js';
import { isPlainObject } from './request-guards.js';
import type { ServerContext } from './server-context.js';

export function registerPagesAndModerationRoutes(ctx: ServerContext): void {
  const { app, cfg, imageBase, previewPolicy, language, requireAuth, requireAdmin, validatePageImages } = ctx;
  const { posts } = cfg;
  const commentsAdmin = cfg.commentsAdmin;

  const commentId = (req: { params: unknown }, reply: FastifyReply): string | null => {
    const id = (req.params as { id?: string }).id ?? '';
    if (!COMMENT_ID_RE.test(id)) { void reply.code(400).send({ error: 'invalid comment id' }); return null; }
    return id;
  };
  const commentsUnavailable = (reply: FastifyReply) => { void reply.code(503).send({ error: 'comments are not available' }); };

  app.get('/moderation/comments', { preHandler: requireAdmin }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const query = req.query as { status?: unknown; offset?: unknown };
    const status = query.status ?? 'pending';
    if (!isCommentStatus(status)) return reply.code(400).send({ error: 'status must be pending or approved' });
    const rawOffset = query.offset ?? '0';
    if (typeof rawOffset !== 'string' || !/^[0-9]+$/.test(rawOffset) || !isModerationOffset(Number(rawOffset))) {
      return reply.code(400).send({ error: 'invalid pagination' });
    }
    if (!commentsAdmin) return commentsUnavailable(reply);
    const page = await commentsAdmin.list(status, Number(rawOffset));
    return reply.send({ ...page, comments: await withPublicLocaleMetadata(page.comments, posts) });
  });

  app.post('/moderation/comments/:id/status', { preHandler: requireAdmin }, async (req, reply) => {
    const id = commentId(req, reply);
    if (!id) return reply;
    const status = isPlainObject(req.body) ? req.body.status : undefined;
    if (!isCommentStatus(status)) return reply.code(400).send({ error: 'status must be pending or approved' });
    if (!commentsAdmin) return commentsUnavailable(reply);
    if (!(await commentsAdmin.setStatus(id, status))) return reply.code(404).send({ error: 'comment not found' });
    return reply.send({ id, status });
  });

  app.delete('/moderation/comments/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = commentId(req, reply);
    if (!id) return reply;
    if (!commentsAdmin) return commentsUnavailable(reply);
    if (!(await commentsAdmin.remove(id))) return reply.code(404).send({ error: 'comment not found' });
    return reply.send({ deleted: true });
  });

  app.post('/moderation/comments/:id/reply', { preHandler: requireAdmin }, async (req, reply) => {
    const id = commentId(req, reply);
    if (!id) return reply;
    if (!commentsAdmin) return commentsUnavailable(reply);
    const body = isPlainObject(req.body) ? req.body.body : undefined;
    try {
      const created = await commentsAdmin.replyAsAuthor(id, cfg.identityStore?.get().identity.authorName || 'Author', body);
      if (!created) return reply.code(404).send({ error: 'comment not found' });
      return reply.code(201).send(created);
    } catch (e) {
      if (e instanceof CommentError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  interface PageRoute { Params: { key: string } }
  interface PagePreviewRoute extends PageRoute { Querystring: { locale?: string } }
  interface PageRevisionRoute { Params: { key: string; id: string } }

  function pageFailure(error: unknown, reply: FastifyReply) {
    if (!(error instanceof PageError)) throw error;
    const status = error.code === 'not_found' ? 404 : error.code === 'unknown_page_kind' || error.code === 'invalid_page' ? 400 : 409;
    return reply.code(status).send({ error: error.message, code: error.code,
      ...(error.owner ? { owner: error.owner } : {}), ...(error.locale ? { locale: error.locale } : {}),
      ...(error.foreignImages ? { foreignImageCount: error.foreignImages.length, foreignImages: error.foreignImages.slice(0, 5) } : {}) });
  }

  function pageToken(value: unknown): Date | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !Number.isFinite(new Date(value).getTime())) throw new PageError('Invalid updatedAt.');
    return new Date(value);
  }

  function pageMutationToken(body: unknown): Date | undefined {
    if (body === undefined || body === null) return undefined;
    if (!isPlainObject(body) || Object.keys(body).some((key) => key !== 'updatedAt')) throw new PageError('Invalid page action payload.');
    return pageToken('updatedAt' in body ? body.updatedAt : undefined);
  }

  async function pageRebuild(reply: FastifyReply, saved: unknown, rebuild: boolean, extra: Record<string, unknown> = {}) {
    const build = rebuild ? projectBuildReport(await cfg.builder.build('page')) : null;
    return reply.send({ saved, build, ...extra });
  }

  app.get('/pages', { preHandler: requireAuth }, async (_req, reply) => {
    const mode = await language.get();
    const existingAll = cfg.pages.getAll ? await cfg.pages.getAll() : null;
    const byKey = new Map(existingAll?.map((pair) => [pair.key, pair]));
    const keys = [...new Set([...Object.keys(PAGE_KINDS), ...(existingAll ? existingAll.map((p) => p.key) : await cfg.pages.keys())])];
    const pages = await Promise.all(keys.map(async (key) => {
      const pair = byKey.get(key) ?? await cfg.pages.get(key);
      return { key, known: isPageKind(key), exists: pair.updatedAt !== null, status: pair.status, updatedAt: pair.updatedAt,
        deletable: key !== 'about', defaults: isPageKind(key) ? PAGE_KINDS[key].slugs : null,
        paths: pagePaths(pair, mode), locales: Object.fromEntries((['de', 'en'] as const).map((locale) =>
          [locale, { title: pair[locale].title, slug: pair[locale].slug ?? '', publishedAt: pair[locale].publishedAt ?? null }])) };
    }));
    return reply.header('cache-control', 'no-store').send({ pages, language: mode });
  });

  app.get<PageRoute>('/pages/:key', { preHandler: requireAuth }, async (req, reply) => {
    const key = req.params.key;
    if (!isSafePageKey(key)) return reply.code(400).send({ error: 'Invalid page key.' });
    const read = await cfg.pages.getForSave(key, req.authUser!.id);
    return reply.header('cache-control', 'no-store').send({ ...read.content, ownerUserId: read.ownerUserId, lastSaveId: read.lastSaveId });
  });

  app.put<PageRoute>('/pages/:key', { preHandler: requireAdmin }, async (req, reply) => {
    const receipt = saveReceiptFromRequest(req, reply);
    if (!receipt) return reply;
    try {
      const key = req.params.key;
      if (!isPlainObject(req.body)) throw new PageError('Invalid page payload.');
      const body = req.body;
      if (Object.keys(body).some((k) => !['de', 'en', 'updatedAt', 'prepareLocale', 'saveId', 'expectedOwnerId'].includes(k))) throw new PageError('Invalid page fields.');
      const pair: PageUpdate = { key };
      for (const locale of ['de', 'en'] as const) if (body[locale] !== undefined) {
        const value = body[locale];
        if (!isPlainObject(value)) throw new PageError(`Invalid ${locale} fields.`);
        if (typeof value.title !== 'string' || typeof value.bodyMarkdown !== 'string' || (value.slug !== undefined && typeof value.slug !== 'string')) throw new PageError(`Invalid ${locale} content.`);
        pair[locale] = { locale, title: value.title, bodyMarkdown: value.bodyMarkdown,
          ...(value.slug !== undefined ? { slug: value.slug } : {}), images: (value.images ?? {}) as Record<string, ImageDims> };
      }
      if (body.prepareLocale !== undefined && body.prepareLocale !== 'de' && body.prepareLocale !== 'en') throw new PageError('Invalid preparation locale.');
      if (body.prepareLocale !== undefined && !Object.hasOwn(body, 'updatedAt')) throw new PageError('Preparation requires the loaded updatedAt token.');
      const { galleryWarnings, ...saved } = await cfg.pages.save(pair, pageToken(body.updatedAt), {
        prepareLocale: body.prepareLocale, receipt, expectAbsent: body.updatedAt === null, validate: validatePageImages,
      });
      return pageRebuild(reply, saved, saved.status === 'published', {
        galleryWarnings, ownerUserId: receipt.ownerUserId, saveId: receipt.saveId,
      });
    } catch (error) { return pageFailure(error, reply); }
  });

  for (const action of ['publish', 'unpublish'] as const) {
    app.post<PageRoute>(`/pages/:key/${action}`, { preHandler: requireAdmin }, async (req, reply) => {
      try {
        const key = req.params.key;
        const token = pageMutationToken(req.body);
        const saved = action === 'publish'
          ? await cfg.pages.publish(key, token, { validate: validatePageImages })
          : await cfg.pages.unpublish(key, token);
        return pageRebuild(reply, saved, true);
      } catch (error) { return pageFailure(error, reply); }
    });
  }

  app.get<PageRoute>('/pages/:key/deletion', { preHandler: requireAdmin }, async (req, reply) => {
    try { return reply.send(await cfg.pages.removalInfo(req.params.key)); }
    catch (error) { return pageFailure(error, reply); }
  });

  app.delete<PageRoute>('/pages/:key', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const removed = await cfg.pages.remove(req.params.key, pageMutationToken(req.body));
      return pageRebuild(reply, removed, removed.published);
    } catch (error) { return pageFailure(error, reply); }
  });

  app.get<PagePreviewRoute>('/pages/:key/preview', { preHandler: requireAuth }, async (req, reply) => {
    const key = req.params.key;
    const locale = req.query.locale;
    if (locale !== 'de' && locale !== 'en') return reply.code(400).send({ error: 'Choose a preview locale.' });
    const pair = await cfg.pages.get(key);
    if (!pair.updatedAt || !isPageKind(key)) return reply.code(404).send({ error: 'Page not found.' });
    const metadata = await loadGalleryMetadata(pair, cfg.media, imageBase);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', previewPolicy)
      .send(await renderPagePreviewHtml(pair, locale, imageBase, metadata[locale]));
  });

  app.get<PageRoute>('/pages/:key/revisions', { preHandler: requireAuth }, async (req, reply) => {
    const key = req.params.key;
    if (!(await cfg.pages.get(key)).updatedAt) return reply.code(404).send({ error: 'Page not found.' });
    return reply.send(await cfg.pages.listRevisions(key));
  });

  app.get<PageRevisionRoute>('/pages/:key/revisions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { key, id } = req.params;
    const rev = await cfg.pages.getRevision(key, id);
    if (!rev) return reply.code(404).send({ error: 'revision not found' });
    return reply.send(rev);
  });
}
