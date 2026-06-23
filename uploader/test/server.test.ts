import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import FormData from 'form-data';
import { buildServer } from '../src/server.js';
import type { Caption } from '../src/caption.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgsrv-'));
});

function app() {
  return buildServer({ storageDir: dir, baseUrl: 'https://img.simonswanderlust.com', authToken: 'secret' });
}

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 1000, height: 800, channels: 3, background: '#444' } }).jpeg().toBuffer();
}

describe('POST /upload', () => {
  it('401 without auth', async () => {
    const form = new FormData();
    form.append('key', 'trips/t/hero');
    form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
    const res = await app().inject({ method: 'POST', url: '/upload', headers: form.getHeaders(), payload: form });
    expect(res.statusCode).toBe(401);
  });

  it('400 for a non-image', async () => {
    const form = new FormData();
    form.append('key', 'trips/t/hero');
    form.append('file', Buffer.from('not an image'), { filename: 't.txt', contentType: 'text/plain' });
    const res = await app().inject({
      method: 'POST', url: '/upload',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(400);
  });

  it('200 + snippet for a valid upload', async () => {
    const form = new FormData();
    form.append('key', 'trips/bucharest-2024/hero');
    form.append('alt', 'Old town');
    form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
    const res = await app().inject({
      method: 'POST', url: '/upload',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.src).toBe('https://img.simonswanderlust.com/trips/bucharest-2024/hero');
    expect(body.snippet).toContain("alt: 'Old town'");
  });

  it('serves stored variants with a long immutable cache header', async () => {
    const a = app();
    const form = new FormData();
    form.append('key', 'trips/cache/hero');
    form.append('alt', 'c');
    form.append('file', await jpeg(), { filename: 't.jpg', contentType: 'image/jpeg' });
    const up = await a.inject({
      method: 'POST', url: '/upload',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(up.statusCode).toBe(200);
    const file = (up.json().files as string[]).find((f) => f.endsWith('.webp'))!;
    const res = await a.inject({ method: 'GET', url: '/' + file });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=31536000');
    expect(res.headers['cache-control']).toContain('immutable');
  });
});

describe('buildServer config', () => {
  it('boots with a relative storageDir (resolves it to absolute)', async () => {
    const rel = relative(process.cwd(), dir); // @fastify/static rejects relative roots
    const srv = buildServer({ storageDir: rel, baseUrl: 'https://img.simonswanderlust.com', authToken: 'secret' });
    await expect(srv.ready()).resolves.toBeDefined();
    await srv.close();
  });
});

function appWith(captioner?: (jpeg: Buffer) => Promise<Caption>) {
  return buildServer({ storageDir: dir, baseUrl: 'https://img.simonswanderlust.com', authToken: 'secret', captioner });
}

describe('POST /suggest', () => {
  it('401 without auth', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await appWith().inject({ method: 'POST', url: '/suggest', headers: form.getHeaders(), payload: form });
    expect(res.statusCode).toBe(401);
  });

  it('returns suggestions + dimensions from the captioner', async () => {
    const captioner = async (): Promise<Caption> => ({ altEn: 'Old town', altDe: 'Altstadt', slug: 'old-town' });
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await appWith(captioner).inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filename: 'a.jpg', slug: 'old-town', altEn: 'Old town', altDe: 'Altstadt', width: 1000, height: 800 });
  });

  it('degrades a row (captionError) when the captioner throws, keeping dimensions', async () => {
    const captioner = async (): Promise<Caption> => { throw new Error('lmstudio down'); };
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await appWith(captioner).inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().results[0];
    expect(row).toMatchObject({ captionError: true, slug: '', altEn: '', altDe: '', width: 1000, height: 800 });
  });

  it('marks rows captionError when no captioner is configured', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await appWith().inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.json().results[0].captionError).toBe(true);
  });

  it('returns one row per file part even when a file is undecodable (preserves index alignment)', async () => {
    const captioner = async (): Promise<Caption> => ({ altEn: 'A', altDe: 'B', slug: 'a-b' });
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'good.jpg', contentType: 'image/jpeg' });
    form.append('file', Buffer.from('not a real image'), { filename: 'bad.jpg', contentType: 'image/jpeg' });
    const res = await appWith(captioner).inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().results;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ filename: 'good.jpg', slug: 'a-b', width: 1000, height: 800 });
    expect(rows[1]).toMatchObject({ filename: 'bad.jpg', captionError: true, width: 0, height: 0 });
  });
});

describe('POST /convert', () => {
  it('401 without auth', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await app().inject({ method: 'POST', url: '/convert', headers: form.getHeaders(), payload: form });
    expect(res.statusCode).toBe(401);
  });

  it('converts each jpg to a downloadable .webp', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'photo.jpg', contentType: 'image/jpeg' });
    const res = await app().inject({
      method: 'POST', url: '/convert',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('photo.webp');
    const meta = await sharp(Buffer.from(results[0].base64, 'base64')).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1000);
  });
});
