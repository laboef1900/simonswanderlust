import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ui } from '../../site/src/i18n/ui.js';
import { prepareTranslation, TranslationError, validateTranslation } from '../../site/src/lib/article-translation.js';
import { analyzeGallerySource } from '../../site/src/lib/gallery-source.js';
import { neutralIdentity } from '../../site/src/lib/site-identity.js';
import { auditAltText } from './alt-audit.js';
import { exportPost } from './export.js';
import { loadGalleryMetadata } from './gallery-metadata.js';
import { createGeocoder, GeocodingError } from './geocoding.js';
import { GpxError } from './gpx-errors.js';
import {
  PostError, assertNotStale, assertPublishTokens, validateDraft, validateForPublish,
  type PostPair, type PublishResult, type PublishTokens, type StopRoutePublishOutcome,
} from './posts.js';
import { renderPreviewHtml } from './preview.js';
import { CANONICAL_UUID_RE, isPlainObject, isStrictIsoUtc } from './request-guards.js';
import { projectBuildReport } from './build-state.js';
import { MAX_BULK_KEYS, PublicationImageError, type ServerContext } from './server-context.js';
import { renderStopRouteCopy } from './stop-route-copy.js';
import { createStopRouter, StopRoutingError } from './stop-routing.js';
import { fixedWindowLimiter } from './rate-limit.js';
import { STOP_ROUTE_LIMITS, StopRouteError, validateRouteStops } from '../public/stop-route.js';

export function saveReceiptFromRequest(req: FastifyRequest, reply: FastifyReply): { saveId: string; ownerUserId: string } | null {
  reply.header('Cache-Control', 'no-store');
  const body = req.body;
  if (!isPlainObject(body)) {
    reply.code(400).send({ code: 'invalid_save', error: 'A save object is required.' });
    return null;
  }
  for (const field of ['saveId', 'expectedOwnerId'] as const) {
    const val = body[field];
    if (typeof val !== 'string' || !CANONICAL_UUID_RE.test(val) || /[A-Z]/.test(val)) {
      reply.code(400).send({ code: `invalid_${field}`, error: `${field} must be a canonical UUID.` });
      return null;
    }
  }
  if (body.expectedOwnerId !== req.authUser!.id) {
    reply.code(403).send({ code: 'owner_changed', error: 'The authenticated account changed. Local work must stay with its original owner.' });
    return null;
  }
  return { saveId: String(body.saveId), ownerUserId: req.authUser!.id };
}

export function registerPostsRoutes(ctx: ServerContext): void {
  const {
    app, cfg, imageBase, previewPolicy, language, publication, routingInternalOrigins,
    requireAuth, requireAdmin, isWritable, readOnly, cleanupDeletedRoutes,
    foreignImagesMessage, foreignImagesReply, publicationBody, publicationReadiness,
  } = ctx;
  const { posts } = cfg;

  const geocode = createGeocoder({
    endpoint: () => cfg.settings.get().geocodingSearchUrl,
    canonicalOrigin: () => cfg.identityStore?.get().identity.canonicalOrigin ?? null,
  });

  app.post('/geocode', { preHandler: requireAuth, bodyLimit: 2048 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = isPlainObject(req.body) ? req.body.query : undefined;
    try {
      return reply.send({ results: await geocode(query) });
    } catch (error) {
      if (!(error instanceof GeocodingError)) throw error;
      if (error.status === 429) reply.header('Retry-After', '2');
      return reply.code(error.status).send({ code: error.code });
    }
  });

  const bundledRouting = cfg.bundledRouting;
  const stopRouter = cfg.stopRouter ?? createStopRouter({
    endpoints: () => {
      const s = cfg.settings.get();
      return { car: s.routingCarUrl, bike: s.routingBikeUrl, foot: s.routingFootUrl };
    },
    regionEndpoints: (countryCode) => bundledRouting?.endpoints(countryCode) ?? {},
    canonicalOrigin: () => cfg.identityStore?.get().identity.canonicalOrigin ?? null,
    internalOrigins: routingInternalOrigins,
  });
  const stopRouteLimiter = cfg.stopRouteLimiter ?? fixedWindowLimiter({ max: 20, windowMs: 600_000 });

  const routingContext = async (tk: string) => {
    const pair = await posts.get(tk);
    if (!pair) return null;
    const countryCode = pair.shared.countryCode;
    void bundledRouting?.sync();
    return { context: { countryCode }, bundled: bundledRouting ? { bundled: bundledRouting.view(countryCode) } : {} };
  };

  app.get<{ Params: { tk: string } }>('/posts/:tk/stop-route', { preHandler: requireAuth }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const story = await routingContext(req.params.tk);
      if (!story) return reply.code(404).send({ code: 'not_found' });
      return reply.send({ profiles: stopRouter.profiles(story.context), route: await posts.getStopRoute(req.params.tk), ...story.bundled });
    } catch (e) {
      if (e instanceof PostError && e.code === 'not_found') return reply.code(404).send({ code: 'not_found' });
      throw e;
    }
  });

  app.post<{ Params: { tk: string } }>('/posts/:tk/stop-route', { preHandler: requireAuth, bodyLimit: 16384 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const tk = req.params.tk;
    const input = isPlainObject(req.body) ? req.body.stops : undefined;
    let stops;
    try { stops = validateRouteStops(input); }
    catch (e) {
      if (e instanceof StopRouteError) return reply.code(400).send({ code: e.code, ...(e.index !== undefined ? { index: e.index } : {}) });
      throw e;
    }
    if (stops.length < 2) return reply.code(400).send({ code: 'stop_route_too_few' });
    if (stops.length > STOP_ROUTE_LIMITS.stops) return reply.code(400).send({ code: 'stop_route_too_many', max: STOP_ROUTE_LIMITS.stops });
    if (!isWritable()) return readOnly(reply);
    let story;
    try { story = await routingContext(tk); }
    catch (e) {
      if (e instanceof PostError && e.code === 'not_found') return reply.code(404).send({ code: 'not_found' });
      throw e;
    }
    if (!story) return reply.code(404).send({ code: 'not_found' });
    const { context, bundled } = story;
    const refuse = (e: StopRoutingError) => {
      if (e.status === 429) reply.header('Retry-After', '5');
      return reply.code(e.status).send({ code: e.code, ...(e.profiles ? { profiles: e.profiles } : {}), ...bundled });
    };
    const refused = stopRouter.refusal(stops, context);
    if (refused) return refuse(refused);
    if (!stopRouteLimiter.check(req.authUser!.id)) {
      return reply.code(429).header('Retry-After', '600').send({ code: 'stop_route_rate_limited' });
    }
    let route;
    try { route = await stopRouter.calculate(stops, context); }
    catch (e) {
      if (!(e instanceof StopRoutingError)) throw e;
      return refuse(e);
    }
    try { await posts.saveStopRoute(tk, route); }
    catch (e) {
      if (e instanceof PostError && e.code === 'not_found') return reply.code(404).send({ code: 'not_found' });
      if (e instanceof PostError && e.code === 'storage_read_only') return readOnly(reply);
      throw e;
    }
    return reply.send({ profiles: stopRouter.profiles(context), route, ...bundled });
  });

  app.post('/gallery/analyze', {
    onRequest: async (_req, reply) => { reply.header('Cache-Control', 'no-store'); },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const body = req.body;
    if (!isPlainObject(body) || typeof body.bodyMarkdown !== 'string') {
      return reply.code(400).send({ error: 'bodyMarkdown must be a string' });
    }
    try {
      return reply.send(await analyzeGallerySource(body.bodyMarkdown));
    } catch {
      throw new Error('Gallery source analysis failed');
    }
  });

  function translationFailure(error: unknown, reply: FastifyReply) {
    if (error instanceof TranslationError) {
      const code = error.code;
      const status = code === 'translation_input_limit' ? 413
        : code === 'translation_unsupported_source' || code === 'translation_structure_mismatch' ? 422 : 400;
      return reply.code(status).send({ code, error: code });
    }
    return reply.code(500).send({ code: 'translation_failed', error: 'Article translation analysis failed.' });
  }

  for (const action of ['prepare', 'validate'] as const) {
    app.post('/translation/' + action, {
      bodyLimit: 2 * 1024 * 1024,
      onRequest: async (_req, reply) => { reply.header('Cache-Control', 'no-store'); },
      preHandler: requireAuth,
      errorHandler(error, _req, reply) {
        const status = (error as FastifyError).statusCode;
        const code = status === 413 ? 'translation_input_limit' : 'translation_invalid_input';
        if (status === 400 || status === 413 || status === 415) return reply.code(status).send({ code, error: code });
        return translationFailure(error, reply);
      },
    }, async (req, reply) => {
      try {
        if (action === 'prepare') return reply.send(await prepareTranslation(req.body));
        if (!isPlainObject(req.body)) {
          return reply.code(400).send({ code: 'translation_invalid_input', error: 'translation_invalid_input' });
        }
        const { output, ...input } = req.body;
        return reply.send(await validateTranslation(input, output));
      } catch (error) {
        return translationFailure(error, reply);
      }
    });
  }

  app.get('/admin/waypoint-copy.js', async (_req, reply) => {
    const copy = Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
      locale, Object.fromEntries(Object.entries(strings)
        .filter(([key]) => key.startsWith('editor.waypoint.'))
        .map(([key, value]) => [key.slice('editor.waypoint.'.length), value])),
    ]));
    reply.header('Cache-Control', 'no-store');
    return reply.type('application/javascript').send(`window.WaypointCopy = ${JSON.stringify(copy)};`);
  });

  app.get('/admin/stop-route-copy.js', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.type('application/javascript').send(renderStopRouteCopy());
  });

  app.get('/admin/editor-image-copy.js', async (_req, reply) => {
    const copy = Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
      locale,
      Object.fromEntries(Object.entries(strings)
        .filter(([key]) => key.startsWith('editor.titleImage.'))
        .map(([key, value]) => [key.slice('editor.titleImage.'.length), value])),
    ]));
    const galleryCopy = Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
      locale, Object.fromEntries(Object.entries(strings)
        .filter(([key]) => key.startsWith('editor.gallery.'))
        .map(([key, value]) => [key.slice('editor.gallery.'.length), value])),
    ]));
    const editorCopy = Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
      locale, { siteTitleFallback: strings['site.titleFallback'], ...Object.fromEntries(Object.entries(strings)
        .filter(([key]) => key.startsWith('editor.chrome.'))
        .map(([key, value]) => [key.slice('editor.chrome.'.length), value])) },
    ]));
    const buildCopy = Object.fromEntries(Object.entries(ui).map(([locale, strings]) => [
      locale, Object.fromEntries(Object.entries(strings)
        .filter(([key]) => key.startsWith('admin.build.'))
        .map(([key, value]) => [key.slice('admin.build.'.length), value])),
    ]));
    const { siteName, studioDescriptor, canonicalOrigin } = cfg.identityStore?.get().identity ?? neutralIdentity();
    reply.header('Cache-Control', 'no-store');
    return reply.type('application/javascript').send(
      `window.EditorImageCopy = ${JSON.stringify(copy)};\n` +
      `window.EditorGalleryCopy = ${JSON.stringify(galleryCopy)};\n` +
      `window.EditorCopy = ${JSON.stringify(editorCopy)};\n` +
      `window.BuildCopy = ${JSON.stringify(buildCopy)};\n` +
      `window.SiteIdentity = ${JSON.stringify({ siteName, studioDescriptor, canonicalOrigin })};\n` +
      `window.EditorGalleryImageOrigin = ${JSON.stringify(new URL(cfg.baseUrl).origin)};`,
    );
  });

  app.get('/posts', { preHandler: requireAuth }, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const observation = await publication.read();
    const rows = await posts.list();
    return rows.map((row) => ({ ...row, publication: publication.from(observation, row.translationKey) }));
  });

  app.get<{ Params: { tk: string } }>('/posts/:tk', { preHandler: requireAuth }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const observation = await publication.read();
    const read = await posts.getForSave(req.params.tk, req.authUser!.id);
    if (!read) return reply.code(404).send({ error: 'post not found' });
    return reply.send({ ...read.content, publication: publication.from(observation, read.content.translationKey),
      ownerUserId: req.authUser!.id, lastSaveId: read.lastSaveId });
  });

  app.get<{ Params: { tk: string } }>('/posts/:tk/alt-audit', { preHandler: requireAuth }, async (req, reply) => {
    const pair = await posts.get(req.params.tk);
    if (!pair) return reply.code(404).send({ error: 'post not found' });
    const audit = await auditAltText(pair, await loadGalleryMetadata(pair, cfg.media, imageBase), (await language.get()).locales);
    return reply.send({ count: audit.count, images: audit.images });
  });

  app.get<{ Params: { tk: string }; Querystring: { locale?: unknown } }>('/posts/:tk/preview', { preHandler: requireAuth }, async (req, reply) => {
    const mode = await language.get();
    const rawLocale = req.query?.locale;
    const raw = rawLocale === undefined ? mode.primary : String(rawLocale);
    if ((raw !== 'de' && raw !== 'en') || !mode.locales.includes(raw)) {
      return reply.code(400).send({ error: "locale must be 'de' or 'en'" });
    }
    const locale: 'de' | 'en' = raw;
    const pair = await posts.get(req.params.tk);
    if (!pair) return reply.code(404).send({ error: 'post not found' });
    const galleryMetadata = await loadGalleryMetadata(pair, cfg.media, imageBase);
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-security-policy', previewPolicy)
      .send(await renderPreviewHtml(pair, locale, imageBase, galleryMetadata[locale]));
  });

  const upsert = async (req: FastifyRequest, reply: FastifyReply, tk: string) => {
    const receipt = saveReceiptFromRequest(req, reply);
    if (!receipt) return reply;
    try {
      const raw = req.body ?? {};
      const mode = await language.get();
      validateDraft(raw, mode);
      const { updatedAt, confirmSlugChange, saveId: _saveId, expectedOwnerId: _expectedOwnerId, ...body } = raw as PostPair & {
        updatedAt?: unknown; confirmSlugChange?: boolean; saveId: string; expectedOwnerId: string;
      };
      const createOnly = tk === '';
      if (createOnly && !Object.hasOwn(body, 'translationKey')) return reply.code(400).send({ code: 'translation_key_required', error: 'translationKey is required.' });
      if (createOnly && (typeof body.translationKey !== 'string' || !CANONICAL_UUID_RE.test(body.translationKey) || /[A-Z]/.test(body.translationKey))) {
        return reply.code(400).send({ code: 'invalid_translation_key', error: 'translationKey must be a canonical UUID.' });
      }
      const pair: PostPair = { ...body, translationKey: createOnly ? body.translationKey : tk };
      const existing = createOnly ? null : await posts.get(tk);
      if (!createOnly && !existing) return reply.code(404).send({ error: 'post not found' });
      let baseUpdatedAt: Date | undefined;
      if (updatedAt !== undefined && updatedAt !== null) {
        baseUpdatedAt = new Date(String(updatedAt));
        if (Number.isNaN(baseUpdatedAt.getTime())) return reply.code(400).send({ error: 'invalid updatedAt' });
      }
      if (existing) assertNotStale(existing.updatedAt, baseUpdatedAt);
      if (existing && !confirmSlugChange) {
        for (const locale of mode.locales) {
          if (existing[locale].publishedAt) continue;
          const from = existing[locale].slug;
          const to = pair[locale].slug ?? '';
          if (from !== '' && to !== from) {
            return reply.code(409).send({
              error: `changing the ${locale.toUpperCase()} slug from "${from}" to "${to}" changes the post's URL — confirm the change to save`,
              code: 'slug_change_unconfirmed',
            });
          }
        }
      }
      const saved = await posts.upsertDraft(pair, baseUpdatedAt ?? existing?.updatedAt, { createOnly, receipt, baseLanguageUpdatedAt: mode.updatedAt });
      void bundledRouting?.sync();
      return reply.send({ ...saved, publication: await publication.one(saved.translationKey),
        ownerUserId: receipt.ownerUserId, saveId: receipt.saveId });
    } catch (e) {
      if (e instanceof PostError) {
        if (e.code === 'storage_read_only') return readOnly(reply);
        const status = e.code === 'not_found' ? 404
          : ['already_exists', 'duplicate_slug', 'slug_locked', 'conflict', 'locale_published', 'reserved_slug'].includes(e.code ?? '') ? 409 : 400;
        return reply.code(status).send({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.owner ? { owner: e.owner } : {}) });
      }
      throw e;
    }
  };

  app.post('/posts', { preHandler: requireAuth }, (req, reply) => upsert(req, reply, ''));
  app.put<{ Params: { tk: string } }>('/posts/:tk', { preHandler: requireAuth }, (req, reply) => upsert(req, reply, req.params.tk));

  app.get<{ Params: { tk: string } }>('/posts/:tk/revisions', { preHandler: requireAuth }, async (req, reply) => {
    const tk = req.params.tk;
    if (!(await posts.get(tk))) return reply.code(404).send({ error: 'post not found' });
    return reply.send(await posts.listRevisions(tk));
  });

  app.get<{ Params: { tk: string; id: string } }>('/posts/:tk/revisions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { tk, id } = req.params;
    if (!(await posts.get(tk))) return reply.code(404).send({ error: 'post not found' });
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
    const postStats = posts.getCmsStats ? await posts.getCmsStats() : { totalPosts: 0, draftPosts: 0, publishedPosts: 0, totalCategories: 0, totalTags: 0 };
    const { total } = await cfg.media.list({ pageSize: 1 });
    return { ...postStats, mediaCount: total };
  });

  app.post<{ Params: { tk: string } }>('/posts/:tk/publish', { preHandler: requireAdmin, bodyLimit: 4096 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = req.body;
    if (!isPlainObject(body) || Object.keys(body).length !== 3
      || !('baseUpdatedAt' in body) || !('baseRouteVersion' in body) || !('baseLanguageUpdatedAt' in body)
      || !isStrictIsoUtc(body.baseLanguageUpdatedAt) || !isStrictIsoUtc(body.baseUpdatedAt)
      || !(body.baseRouteVersion === null || (typeof body.baseRouteVersion === 'string' && CANONICAL_UUID_RE.test(body.baseRouteVersion)))) {
      return reply.code(400).send({ error: 'invalid publish tokens', code: 'invalid_publish_tokens' });
    }
    const tokens: PublishTokens = {
      baseUpdatedAt: new Date(body.baseUpdatedAt),
      baseRouteVersion: body.baseRouteVersion,
      baseLanguageUpdatedAt: new Date(body.baseLanguageUpdatedAt),
    };
    const tk = req.params.tk;
    const state = await posts.getPublishState(tk);
    if (!state) return reply.code(404).send({ error: 'post not found' });
    const { pair } = state;
    let analysis: { foreign: string[]; keys: string[] };
    try {
      assertPublishTokens(state, tokens);
      validateForPublish(pair, state.language);
      analysis = await publicationBody(pair, state.language);
    } catch (e) {
      if (e instanceof PostError) return reply.code(e.code === 'conflict' ? 409 : 400).send({ error: e.message, code: e.code });
      throw e;
    }
    if (analysis.foreign.length > 0) return foreignImagesReply(reply, analysis.foreign);
    const galleryMetadata = await loadGalleryMetadata(pair, cfg.media, imageBase);
    const audit = await auditAltText(pair, galleryMetadata, state.language.locales);
    let committed: PublishResult;
    try { committed = await posts.publish(tk, tokens, publicationReadiness(analysis.keys)); }
    catch (e) {
      if (e instanceof PublicationImageError) return reply.code(409).send({
        error: e.message, code: e.code,
        ...(e.foreign.length ? { foreignImages: e.foreign.slice(0, 5), foreignImageCount: e.foreign.length } : { notReady: e.notReady }),
      });
      if (e instanceof GpxError) return reply.code(e.statusCode).send({ error: e.code, code: e.code, ...(e.counts ? { counts: e.counts } : {}) });
      if (e instanceof PostError) return reply.code(e.code === 'storage_read_only' ? 503 : e.code === 'not_found' ? 404 : 409).send({ error: e.message, code: e.code });
      throw e;
    }
    const build = projectBuildReport(await cfg.builder.build('publish'));
    await posts.getPublishedTrack(tk)
      .then((track) => exportPost(pair, cfg.backupDir, track))
      .catch((e) => console.error(`MDX backup for ${tk} failed:`, e));
    return reply.send({
      published: true,
      build,
      updatedAt: committed.updatedAt,
      stopRoute: committed.stopRoute,
      publication: await publication.one(tk),
      altAudit: { count: audit.count, images: audit.images },
    });
  });

  const BULK_ACTIONS = ['publish', 'unpublish', 'delete'] as const;
  type BulkAction = (typeof BULK_ACTIONS)[number];

  app.post('/posts/bulk', { preHandler: requireAdmin }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const b = (req.body ?? {}) as { action?: unknown; keys?: unknown; baseLanguageUpdatedAt?: unknown };
    const action = String(b.action ?? '') as BulkAction;
    if (!BULK_ACTIONS.includes(action)) {
      return reply.code(400).send({ error: `action must be one of ${BULK_ACTIONS.join(', ')}` });
    }
    if (action === 'publish' && !isStrictIsoUtc(b.baseLanguageUpdatedAt)) {
      return reply.code(400).send({ code: 'invalid_publish_tokens', error: 'invalid language token' });
    }
    if (!Array.isArray(b.keys)) return reply.code(400).send({ error: 'keys must be an array' });
    if (b.keys.length > MAX_BULK_KEYS) {
      return reply.code(400).send({ error: `at most ${MAX_BULK_KEYS} posts per request` });
    }
    const keys = [...new Set(b.keys.map((k) => String(k)))].filter((k) => k !== '');
    if (keys.length === 0) return reply.code(400).send({ error: 'keys must not be empty' });

    const results: { key: string; ok: boolean; updatedAt?: Date; previousUpdatedAt?: Date; stopRoute?: StopRoutePublishOutcome; error?: string; code?: string; counts?: GpxError['counts'] }[] = [];
    let liveChanged = false;
    let cleanupPending = false;
    for (const tk of keys) {
      try {
        const state = action === 'publish' ? await posts.getPublishState(tk) : null;
        const pair = action === 'publish' ? state?.pair : await posts.get(tk);
        if (!pair) throw new PostError('post not found');
        let committed: { updatedAt: Date; previousUpdatedAt?: Date; stopRoute?: StopRoutePublishOutcome } | undefined;
        if (action === 'publish') {
          validateForPublish(pair, state!.language);
          const analysis = await publicationBody(pair, state!.language);
          if (analysis.foreign.length > 0) throw new PostError(foreignImagesMessage(analysis.foreign.length));
          committed = await posts.publish(tk, { baseUpdatedAt: pair.updatedAt, baseRouteVersion: state!.routeVersion,
            baseLanguageUpdatedAt: new Date(String(b.baseLanguageUpdatedAt)) }, publicationReadiness(analysis.keys));
          liveChanged = true;
          await posts.getPublishedTrack(tk)
            .then((track) => exportPost(pair, cfg.backupDir, track))
            .catch((e) => console.error(`MDX backup for ${tk} failed:`, e));
        } else if (action === 'unpublish') {
          if (pair.status !== 'published') throw new PostError('post is not published');
          committed = await posts.unpublish(tk);
          liveChanged = true;
        } else {
          if (pair.status === 'published') liveChanged = true;
          await posts.remove(tk);
          cleanupPending = await cleanupDeletedRoutes() || cleanupPending;
        }
        results.push({ key: tk, ok: true, ...committed });
      } catch (e) {
        if (e instanceof GpxError) {
          results.push({ key: tk, ok: false, error: e.code, code: e.code, ...(e.counts ? { counts: e.counts } : {}) });
        } else if (e instanceof PostError) {
          results.push({ key: tk, ok: false, error: e.message });
        } else {
          console.error(`bulk ${action} failed for ${tk}:`, e);
          results.push({ key: tk, ok: false, error: 'internal error' });
        }
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    const build = liveChanged ? projectBuildReport(await cfg.builder.build('bulk')) : undefined;
    const observation = await publication.read();
    const projectedResults = results.map((result) => ({ ...result, publication: publication.from(observation, result.key) }));
    return reply.send({ action, succeeded, failed: results.length - succeeded, results: projectedResults, ...(build ? { build } : {}), ...(cleanupPending ? { cleanupPending: true } : {}) });
  });

  app.post<{ Params: { tk: string } }>('/posts/:tk/unpublish', { preHandler: requireAdmin }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const tk = req.params.tk;
    const pair = await posts.get(tk);
    if (!pair) return reply.code(404).send({ error: 'post not found' });
    if (pair.status !== 'published') return reply.code(409).send({ error: 'post is not published' });
    let committed: { previousUpdatedAt: Date; updatedAt: Date };
    try {
      committed = await posts.unpublish(tk);
    } catch (e) {
      if (e instanceof PostError) {
        if (e.code === 'storage_read_only') return readOnly(reply);
        return reply.code(404).send({ error: e.message });
      }
      throw e;
    }
    const build = projectBuildReport(await cfg.builder.build('unpublish'));
    return reply.send({
      unpublished: true, build,
      previousUpdatedAt: committed.previousUpdatedAt, updatedAt: committed.updatedAt,
      publication: await publication.one(tk),
    });
  });

  app.delete<{ Params: { tk: string } }>('/posts/:tk', { preHandler: requireAdmin }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const tk = req.params.tk;
    const pair = await posts.get(tk);
    if (!pair) return reply.code(404).send({ error: 'post not found' });
    const wasPublished = pair.status === 'published';
    try {
      await posts.remove(tk);
    } catch (e) {
      if (e instanceof PostError) return reply.code(e.code === 'storage_read_only' ? 503 : 404).send({ error: e.message });
      throw e;
    }
    const cleanupPending = await cleanupDeletedRoutes();
    if (wasPublished) {
      const build = projectBuildReport(await cfg.builder.build('delete'));
      return reply.send({ deleted: true, build, publication: await publication.one(tk), ...(cleanupPending ? { cleanupPending: true } : {}) });
    }
    return reply.send({ deleted: true, publication: await publication.one(tk), ...(cleanupPending ? { cleanupPending: true } : {}) });
  });
}
