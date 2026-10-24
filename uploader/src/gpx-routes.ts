import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthGuard } from './authn.js';
import { GPX_LIMITS, type TrimSelection } from '../public/gpx-geometry.js';
import { GpxError } from './gpx-errors.js';
import type { AttachRouteInput, GpxService } from './gpx-service.js';
import type { RouteTokens } from './gpx-store.js';
import { SOURCE_ID_RE } from './gpx-files.js';
import { readGpxUpload } from './gpx-upload.js';

function closedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GpxError('gpx_invalid_request', 400);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) throw new GpxError('gpx_invalid_request', 400);
  return object;
}
function tokens(body: Record<string, unknown>): RouteTokens {
  if (body.baseVersion !== null && (typeof body.baseVersion !== 'string' || !SOURCE_ID_RE.test(body.baseVersion))) throw new GpxError('gpx_invalid_request', 400);
  if (typeof body.baseUpdatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.baseUpdatedAt) || !Number.isFinite(Date.parse(body.baseUpdatedAt))) throw new GpxError('gpx_invalid_request', 400);
  if (new Date(body.baseUpdatedAt).toISOString() !== body.baseUpdatedAt) throw new GpxError('gpx_invalid_request', 400);
  return { baseVersion: body.baseVersion, baseUpdatedAt: body.baseUpdatedAt };
}
function selection(value: unknown): TrimSelection {
  const input = closedObject(value, ['startPoints', 'endPoints', 'removedSegments']);
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= GPX_LIMITS.points;
  if (!count(input.startPoints) || !count(input.endPoints) || !Array.isArray(input.removedSegments) || input.removedSegments.length > GPX_LIMITS.segments || !input.removedSegments.every(count) || new Set(input.removedSegments).size !== input.removedSegments.length) throw new GpxError('gpx_invalid_selection', 400);
  return { startPoints: input.startPoints, endPoints: input.endPoints, removedSegments: input.removedSegments as number[] };
}
function attachInput(value: unknown): AttachRouteInput {
  const body = closedObject(value, ['importId', 'baseVersion', 'baseUpdatedAt', 'selection', 'confirmReplace']);
  if (typeof body.importId !== 'string' || !/^[0-9a-f]{64}$/.test(body.importId) || typeof body.confirmReplace !== 'boolean') throw new GpxError('gpx_invalid_request', 400);
  return { ...tokens(body), importId: body.importId, selection: selection(body.selection), confirmReplace: body.confirmReplace };
}
function params(request: FastifyRequest): { tk: string; id: string } {
  const value = request.params as Record<string, string>;
  if (value.tk !== undefined && (!value.tk || value.tk.length > 512 || /[\u0000-\u001f\u007f]/.test(value.tk))) throw new GpxError('gpx_invalid_request', 400);
  return { tk: value.tk ?? '', id: value.id ?? '' };
}

export function registerGpxRoutes(app: FastifyInstance, { gpx, requireAuth, baseUrl }: { gpx: GpxService; requireAuth: AuthGuard; baseUrl: string }): void {
  const origin = new URL(baseUrl).origin;
  app.register(async (routes) => {
    routes.setErrorHandler((error: unknown, _request, reply) => {
      if (error instanceof GpxError) {
        const payload: { error: string; invalidPoints?: number } = { error: error.code };
        if (error.invalidPoints !== undefined) payload.invalidPoints = error.invalidPoints;
        return reply.code(error.statusCode).header('cache-control', 'no-store').send(payload);
      }
      const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      const code = status === 413 ? 'gpx_too_large' : status >= 400 && status < 500 ? 'gpx_invalid_request' : 'gpx_unavailable';
      return reply.code(status >= 400 && status < 500 ? status : 503).header('cache-control', 'no-store').send({ error: code });
    });
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      await requireAuth(request, reply);
      if (reply.sent) return reply;
      if (!request.authUser) return reply.code(401).send({ error: 'unauthorized' });
      if (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== undefined) {
        let supplied: string;
        try { supplied = new URL(request.headers.origin).origin; } catch { throw new GpxError('gpx_forbidden_origin', 403); }
        if (supplied !== origin || request.headers.origin !== supplied) throw new GpxError('gpx_forbidden_origin', 403);
      }
    });
    // Body/parser errors are contained by this plugin, never the application's logging boundary.
    routes.post('/gpx/imports', { bodyLimit: GPX_LIMITS.fileBytes + 16 * 1024, logLevel: 'silent' }, async (request, reply) => {
      const controller = new AbortController();
      const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
      request.raw.once('aborted', abort); reply.raw.once('close', abort);
      try {
        const result = await gpx.importUpload(request.authUser!.id, (signal) => readGpxUpload(request, reply, signal), controller.signal);
        return reply.code(201).send(result);
      } finally { request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort); }
    });
    routes.delete('/gpx/imports/:id', { logLevel: 'silent' }, async (request, reply) => {
      await gpx.cancel(request.authUser!.id, params(request).id);
      return reply.code(204).send();
    });
    routes.get('/posts/:tk/route', { logLevel: 'silent' }, async (request) => gpx.get(params(request).tk));
    routes.get('/posts/:tk/route/original', { logLevel: 'silent' }, async (request, reply) => {
      const bytes = await gpx.original(params(request).tk);
      return reply.type('application/octet-stream').header('content-disposition', 'attachment; filename="route.gpx"').header('x-content-type-options', 'nosniff').send(bytes);
    });
    routes.post('/posts/:tk/route/import', { bodyLimit: 4096, logLevel: 'silent' }, async (request, reply) => {
      if (request.body !== undefined && request.body !== null) throw new GpxError('gpx_invalid_request', 400);
      const controller = new AbortController();
      const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
      request.raw.once('aborted', abort); reply.raw.once('close', abort);
      try { return reply.code(201).send(await gpx.reimport(request.authUser!.id, params(request).tk, controller.signal)); }
      finally { request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort); }
    });
    routes.put('/posts/:tk/route', { bodyLimit: 64 * 1024, logLevel: 'silent' }, async (request, reply) => {
      const input = attachInput(request.body);
      const controller = new AbortController();
      const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
      request.raw.once('aborted', abort); reply.raw.once('close', abort);
      try { return await gpx.attach(request.authUser!.id, params(request).tk, input, controller.signal); }
      finally { request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort); }
    });
    routes.delete('/posts/:tk/route', { bodyLimit: 4096, logLevel: 'silent' }, async (request) => {
      const body = closedObject(request.body, ['baseVersion', 'baseUpdatedAt', 'confirmDetach']);
      if (body.confirmDetach !== true) throw new GpxError('gpx_detach_unconfirmed', 400);
      return gpx.detach(params(request).tk, tokens(body));
    });
  });
}
