import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { processImage } from './pipeline.js';
import { storeVariants } from './storage.js';
import { isAuthorized } from './auth.js';

export interface ServerConfig {
  storageDir: string;
  baseUrl: string;
  authToken: string;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_-]*$/;

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

  return app;
}
