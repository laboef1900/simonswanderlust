import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import FormData from 'form-data';
import { buildServer } from '../src/server.js';

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
