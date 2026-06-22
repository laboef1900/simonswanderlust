import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import sharp from 'sharp';
import { processImage } from './pipeline.js';
import { storeVariants } from './storage.js';
import { isAuthorized } from './auth.js';
import { captionImage, type Caption } from './caption.js';

export type Captioner = (jpeg: Buffer) => Promise<Caption>;

export interface ServerConfig {
  storageDir: string;
  baseUrl: string;
  authToken: string;
  captioner?: Captioner;
  captionMaxEdge?: number;
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

  const captioner = cfg.captioner;
  const maxEdge = cfg.captionMaxEdge ?? 768;

  app.post('/suggest', async (req, reply) => {
    if (!isAuthorized(req.headers.authorization, cfg.authToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const results: Array<{
      filename: string; slug: string; altEn: string; altDe: string;
      width: number; height: number; captionError?: boolean;
    }> = [];

    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const buf = await part.toBuffer();
      if (!part.mimetype.startsWith('image/')) continue;

      let width = 0;
      let height = 0;
      try {
        const probe = await sharp(buf, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
        width = probe.info.width;
        height = probe.info.height;
      } catch {
        continue; // not a decodable image
      }

      const row = { filename: part.filename, slug: '', altEn: '', altDe: '', width, height } as {
        filename: string; slug: string; altEn: string; altDe: string; width: number; height: number; captionError?: boolean;
      };

      if (!captioner) {
        row.captionError = true;
      } else {
        try {
          const small = await sharp(buf, { failOn: 'none' })
            .rotate()
            .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
          const c = await captioner(small);
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

  return app;
}
