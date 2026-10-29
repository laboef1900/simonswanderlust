import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

/** Existing feature suites submit the current authoring protocol. Boundary tests
 * use app.inject directly, including missing-ID and account-switch regressions. */
export async function injectAuthoring(app: FastifyInstance, request: InjectOptions): Promise<LightMyRequestResponse> {
  const url = typeof request.url === 'string' ? request.url : request.url?.pathname;
  const save = request.method === 'POST' && url === '/posts'
    || request.method === 'PUT' && /^\/(posts|pages)\/[^/]+$/.test(url ?? '');
  const upload = request.method === 'POST' && url === '/upload';
  if ((!save && !upload) || !request.cookies?.sid) return app.inject(request);
  const response = await app.inject({ method: 'GET', url: '/auth/me', cookies: request.cookies });
  if (response.statusCode !== 200) return app.inject(request);
  const auth = response.json<unknown>();
  if (!auth || typeof auth !== 'object' || !('userId' in auth) || typeof auth.userId !== 'string') throw new Error('Test author identity unavailable');
  const payload = request.payload;
  if (upload && payload && typeof payload === 'object' && 'append' in payload && typeof payload.append === 'function') {
    payload.append('uploadId', randomUUID());
    payload.append('expectedOwnerId', auth.userId);
    payload.append('retryGeneration', '0');
    return app.inject(request);
  }
  if (!save || !payload || typeof payload !== 'object' || Array.isArray(payload) || Buffer.isBuffer(payload)) return app.inject(request);
  const body = { saveId: randomUUID(), expectedOwnerId: auth.userId, ...payload };
  if (request.method === 'POST' && (!('translationKey' in body) || body.translationKey === '')) {
    return app.inject({ ...request, payload: { ...body, translationKey: randomUUID() } });
  }
  return app.inject({ ...request, payload: body });
}
