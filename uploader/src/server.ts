import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import sharp from 'sharp';
import { processImage } from './pipeline.js';
import { storeVariants } from './storage.js';
import { isAuthorized } from './auth.js';
import { captionImage, type Caption, type CaptionConfig } from './caption.js';
import { SettingsError, type SettingsStore } from './settings.js';

export interface ServerConfig {
  storageDir: string;
  baseUrl: string;
  authToken: string;
  settings: SettingsStore;
  captionImpl?: (jpeg: Buffer, cfg: CaptionConfig) => Promise<Caption>;
  fetchImpl?: typeof fetch;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_-]*$/;

async function fetchModelIds(baseUrl: string, doFetch: typeof fetch): Promise<string[]> {
  const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/models`, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}

export function buildServer(cfg: ServerConfig): FastifyInstance {
  // @fastify/static requires an absolute root; tolerate a relative STORAGE_DIR
  // (e.g. ./data/images from env) by resolving against the process cwd.
  const storageDir = resolve(cfg.storageDir);
  const app = Fastify({ logger: false });
  app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  const here = dirname(fileURLToPath(import.meta.url));
  app.register(fastifyStatic, { root: join(here, '..', 'public'), prefix: '/admin/' });
  // Variants are content-addressed by {key}-{width}.{fmt}, so they never change
  // under a given URL — serve them with a one-year immutable cache. (A custom
  // setHeaders is overwritten by @fastify/static's own cacheControl, so use the
  // native maxAge + immutable options instead.)
  app.register(fastifyStatic, {
    root: storageDir,
    prefix: '/',
    decorateReply: false,
    maxAge: '365d',
    immutable: true,
  });

  app.get('/', (_req, reply) => reply.redirect('/admin/'));

  app.post('/upload', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
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
    const result = await processImage(buf);
    const stored = await storeVariants(key, alt, result, { storageDir, baseUrl: cfg.baseUrl });
    return reply.send(stored);
  });

  const captionImpl = cfg.captionImpl ?? captionImage;
  const doFetch = cfg.fetchImpl ?? fetch;

  app.post('/suggest', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const s = cfg.settings.get();
    const maxEdge = s.captionMaxEdge;
    const results: Array<{
      filename: string; slug: string; altEn: string; altDe: string;
      width: number; height: number; captionError?: boolean;
    }> = [];

    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const buf = await part.toBuffer();
      const row = { filename: part.filename, slug: '', altEn: '', altDe: '', width: 0, height: 0 } as {
        filename: string; slug: string; altEn: string; altDe: string; width: number; height: number; captionError?: boolean;
      };

      let decodable = part.mimetype.startsWith('image/');
      if (decodable) {
        try {
          const probe = await sharp(buf, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
          row.width = probe.info.width;
          row.height = probe.info.height;
        } catch {
          decodable = false;
        }
      }

      if (!decodable) {
        row.captionError = true;
      } else {
        try {
          const small = await sharp(buf, { failOn: 'none' })
            .rotate()
            .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
          const c = await captionImpl(small, {
            baseUrl: s.lmBaseUrl, model: s.lmModel, timeoutMs: s.captionTimeoutMs, prompt: s.captionPrompt,
          });
          row.slug = c.slug;
          row.altEn = c.altEn;
          row.altDe = c.altDe;
        } catch {
          row.captionError = true;
        }
      }
      results.push(row);
    }

    return reply.send({ results });
  });

  app.get('/settings', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send(cfg.settings.get());
  });

  app.post('/settings', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) return reply.code(401).send({ error: 'unauthorized' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const partial: Record<string, unknown> = {};
    if (b.lmBaseUrl !== undefined) partial.lmBaseUrl = String(b.lmBaseUrl).trim();
    if (b.lmModel !== undefined) partial.lmModel = String(b.lmModel).trim();
    if (b.captionTimeoutMs !== undefined) partial.captionTimeoutMs = Number(b.captionTimeoutMs);
    if (b.captionMaxEdge !== undefined) partial.captionMaxEdge = Number(b.captionMaxEdge);
    if (b.captionPrompt !== undefined) partial.captionPrompt = String(b.captionPrompt);
    try {
      return reply.send(cfg.settings.update(partial));
    } catch (e) {
      if (e instanceof SettingsError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.get('/settings/models', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) return reply.code(401).send({ error: 'unauthorized' });
    const q = (req.query ?? {}) as { baseUrl?: string };
    const baseUrl = q.baseUrl?.trim() || cfg.settings.get().lmBaseUrl;
    try {
      return reply.send({ models: await fetchModelIds(baseUrl, doFetch) });
    } catch (e) {
      return reply.send({ models: [], error: (e as Error).message });
    }
  });

  app.post('/settings/test', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) return reply.code(401).send({ error: 'unauthorized' });
    const b = (req.body ?? {}) as { baseUrl?: string; model?: string };
    const s = cfg.settings.get();
    const baseUrl = b.baseUrl?.trim() || s.lmBaseUrl;
    const model = b.model?.trim() || s.lmModel;
    try {
      const ids = await fetchModelIds(baseUrl, doFetch);
      const modelPresent = ids.includes(model);
      return reply.send({ ok: modelPresent, reachable: true, modelPresent });
    } catch (e) {
      return reply.send({ ok: false, reachable: false, modelPresent: false, error: (e as Error).message });
    }
  });

  return app;
}
