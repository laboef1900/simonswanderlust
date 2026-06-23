import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import sharp from 'sharp';
import FormData from 'form-data';
import { buildServer, type ServerConfig } from '../src/server.js';
import type { Caption, CaptionConfig } from '../src/caption.js';
import { validate } from '../src/settings.js';
import type { Settings, SettingsStore } from '../src/settings.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgsrv-'));
});

const SETTINGS: Settings = {
  lmBaseUrl: 'http://lm:1234/v1', lmModel: 'qwen/qwen3-vl-4b',
  captionTimeoutMs: 60000, captionMaxEdge: 768, captionPrompt: 'P',
};
function fakeStore(init: Settings = SETTINGS): SettingsStore {
  let cur = { ...init };
  return { get: () => ({ ...cur }), update: (p) => { cur = validate({ ...cur, ...p }); return { ...cur }; } };
}
function build(extra: Partial<ServerConfig> = {}) {
  return buildServer({
    storageDir: dir, baseUrl: 'https://img.simonswanderlust.com', authToken: 'secret',
    settings: fakeStore(), ...extra,
  });
}
function app() { return build(); }

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
    const srv = buildServer({ storageDir: rel, baseUrl: 'https://img.simonswanderlust.com', authToken: 'secret', settings: fakeStore() });
    await expect(srv.ready()).resolves.toBeDefined();
    await srv.close();
  });
});

describe('POST /suggest', () => {
  const okCaption = async (): Promise<Caption> => ({ altEn: 'Old town', altDe: 'Altstadt', slug: 'old-town' });

  it('401 without auth', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await app().inject({ method: 'POST', url: '/suggest', headers: form.getHeaders(), payload: form });
    expect(res.statusCode).toBe(401);
  });

  it('returns suggestions + dimensions', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await build({ captionImpl: okCaption }).inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ filename: 'a.jpg', slug: 'old-town', altEn: 'Old town', altDe: 'Altstadt', width: 1000, height: 800 });
  });

  it('degrades a row when captioning throws, keeping dimensions', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'a.jpg', contentType: 'image/jpeg' });
    const res = await build({ captionImpl: async () => { throw new Error('down'); } }).inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ captionError: true, slug: '', width: 1000, height: 800 });
  });

  it('returns one row per file part even when a file is undecodable', async () => {
    const form = new FormData();
    form.append('file', await jpeg(), { filename: 'good.jpg', contentType: 'image/jpeg' });
    form.append('file', Buffer.from('not a real image'), { filename: 'bad.jpg', contentType: 'image/jpeg' });
    const res = await build({ captionImpl: okCaption }).inject({
      method: 'POST', url: '/suggest',
      headers: { ...form.getHeaders(), authorization: 'Bearer secret' }, payload: form,
    });
    const rows = res.json().results;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ filename: 'good.jpg', slug: 'old-town' });
    expect(rows[1]).toMatchObject({ filename: 'bad.jpg', captionError: true, width: 0, height: 0 });
  });
});

describe('settings endpoints', () => {
  const modelsFetch = (ids: string[]) =>
    (async () => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) })) as unknown as typeof fetch;

  it('GET /settings 401 without auth, returns current with auth', async () => {
    expect((await app().inject({ method: 'GET', url: '/settings' })).statusCode).toBe(401);
    const res = await app().inject({ method: 'GET', url: '/settings', headers: { authorization: 'Bearer secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lmModel: 'qwen/qwen3-vl-4b', captionMaxEdge: 768 });
  });

  it('POST /settings persists valid changes', async () => {
    const a = app();
    const res = await a.inject({
      method: 'POST', url: '/settings',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      payload: { lmModel: 'new-model', captionMaxEdge: 1024 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lmModel).toBe('new-model');
    const after = await a.inject({ method: 'GET', url: '/settings', headers: { authorization: 'Bearer secret' } });
    expect(after.json().captionMaxEdge).toBe(1024);
  });

  it('POST /settings 400 on invalid', async () => {
    const res = await app().inject({
      method: 'POST', url: '/settings',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      payload: { lmBaseUrl: 'ftp://nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it('GET /settings/models returns ids from LM Studio', async () => {
    const res = await build({ fetchImpl: modelsFetch(['a', 'b']) }).inject({
      method: 'GET', url: '/settings/models', headers: { authorization: 'Bearer secret' },
    });
    expect(res.json().models).toEqual(['a', 'b']);
  });

  it('GET /settings/models degrades to empty + error on failure', async () => {
    const failing = (async () => { throw new Error('econn'); }) as unknown as typeof fetch;
    const res = await build({ fetchImpl: failing }).inject({
      method: 'GET', url: '/settings/models', headers: { authorization: 'Bearer secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual([]);
    expect(res.json().error).toBeTruthy();
  });

  it('POST /settings/test reports reachable + modelPresent', async () => {
    const res = await build({ fetchImpl: modelsFetch(['qwen/qwen3-vl-4b']) }).inject({
      method: 'POST', url: '/settings/test',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      payload: { model: 'qwen/qwen3-vl-4b' },
    });
    expect(res.json()).toMatchObject({ ok: true, reachable: true, modelPresent: true });
  });
});
