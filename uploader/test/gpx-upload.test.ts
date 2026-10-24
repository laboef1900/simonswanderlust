import { request as httpRequest } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { afterEach, describe, expect, it } from 'vitest';
import { GPX_LIMITS } from '../public/gpx-geometry.js';
import { GpxError } from '../src/gpx-errors.js';
import { readGpxUpload } from '../src/gpx-upload.js';
import { createGpxWorker, type GpxWorker } from '../src/gpx-worker.js';

const xml = Buffer.from('<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1"><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.001" lon="2.001"/></trkseg></trk></gpx>');
const boundary = 'synthetic-upload-boundary';
const headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="PRIVATE_FILENAME.gpx"\r\nContent-Type: application/octet-stream\r\n\r\n`);
const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
const body = (bytes = xml) => Buffer.concat([prefix, bytes, suffix]);
const fixtures: { app: FastifyInstance; worker: GpxWorker }[] = [];
afterEach(async () => {
  for (const { app, worker } of fixtures.splice(0)) { await app.close(); await worker.close(); }
});

async function fixture(admission: Promise<void> = Promise.resolve()) {
  const logs: string[] = [];
  const app = Fastify({ logger: { stream: { write: (line: string) => { logs.push(line); } } } });
  const worker = createGpxWorker();
  fixtures.push({ app, worker });
  await app.register(multipart);
  const entered = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const controller = new AbortController();
  let received: Buffer | undefined;
  app.setErrorHandler((error, _request, reply) => {
    const safe = error instanceof GpxError ? error : new GpxError('gpx_unavailable', 503);
    return reply.code(safe.statusCode).send({ error: safe.code });
  });
  app.post('/upload', { logLevel: 'silent' }, async (request, reply) => {
    entered.resolve();
    await admission;
    const disconnected = () => controller.abort();
    request.raw.once('aborted', disconnected);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
      const pending = readGpxUpload(request, reply, signal);
      reading.resolve();
      received = await pending;
      return reply.code(201).send(await worker.parse(received));
    } finally {
      request.raw.removeListener('aborted', disconnected);
      settled.resolve();
    }
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { address, entered: entered.promise, reading: reading.promise, settled: settled.promise, controller, logs, received: () => received };
}

function start(address: string, extra: Record<string, string> = {}) {
  const result = Promise.withResolvers<{ status: number; text: string; connection: string | undefined }>();
  const sent = Promise.withResolvers<void>();
  let responding = false;
  const client = httpRequest(address + '/upload', { method: 'POST', headers: { ...headers, ...extra } }, (response) => {
    responding = true;
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => result.resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString(), connection: response.headers.connection }));
    response.on('error', result.reject);
  });
  client.on('error', (error) => { if (!responding) result.reject(error); });
  client.once('finish', () => sent.resolve());
  return { client, response: result.promise, sent: sent.promise };
}
async function send(address: string, bytes: Buffer, extra: Record<string, string> = {}) {
  const exchange = start(address, extra);
  exchange.client.end(bytes);
  return exchange.response;
}
function refusal(response: { status: number; text: string }, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(JSON.parse(response.text)).toEqual({ error: code });
  expect(response.text).not.toMatch(/PRIVATE|boundary|filename|stack/i);
}

describe('admitted GPX multipart ingestion over real HTTP', () => {
  it('keeps an already-sent small body readable across asynchronous admission', async () => {
    const admission = Promise.withResolvers<void>();
    const f = await fixture(admission.promise);
    const exchange = start(f.address);
    exchange.client.end(body());
    await Promise.all([exchange.sent, f.entered]);
    await setImmediate();
    admission.resolve();
    const response = await exchange.response;
    expect(response.status).toBe(201);
    expect(JSON.parse(response.text).geometry.segments[0].points).toHaveLength(2);
    expect(f.received()).toEqual(xml);
    expect(f.logs.join('')).not.toMatch(/PRIVATE_FILENAME|trkpt|lat=|lon=/);
  });

  it('accepts exact file and encoded request ceilings, including trailing epilogue', async () => {
    const f = await fixture();
    const exact = Buffer.concat([xml, Buffer.alloc(GPX_LIMITS.fileBytes - xml.length, 32)]);
    const envelope = body(exact);
    const padded = Buffer.concat([envelope, Buffer.alloc(GPX_LIMITS.fileBytes + 16 * 1024 - envelope.length, 32)]);
    const response = await send(f.address, padded, { 'transfer-encoding': 'chunked' });
    expect(response.status).toBe(201);
    expect(f.received()).toEqual(exact);
  // The real ingress budget is 15s, followed by the worker's bounded parse.
  // A 5s test deadline incorrectly rejects an admitted transfer under suite load.
  }, 20_000);

  it('rejects one byte above the file ceiling even below the encoded ceiling', async () => {
    const f = await fixture();
    refusal(await send(f.address, body(Buffer.alloc(GPX_LIMITS.fileBytes + 1, 32))), 413, 'gpx_too_large');
    expect(f.received()).toBeUndefined();
  });

  it('counts chunked epilogue bytes after the parser finishes the file', async () => {
    const f = await fixture();
    const exchange = start(f.address, { 'transfer-encoding': 'chunked' });
    exchange.client.write(body());
    await f.reading;
    await setImmediate();
    exchange.client.end(Buffer.alloc(GPX_LIMITS.fileBytes + 16 * 1024 + 1 - body().length, 32));
    const response = await exchange.response;
    refusal(response, 413, 'gpx_too_large');
    expect(response.connection).toBe('close');
    expect(f.received()).toBeUndefined();
  });

  it('rejects an excessive declared body without waiting for its bytes', async () => {
    const f = await fixture();
    const exchange = start(f.address, { 'content-length': String(GPX_LIMITS.fileBytes + 16 * 1024 + 1) });
    exchange.client.flushHeaders();
    refusal(await exchange.response, 413, 'gpx_too_large');
    exchange.client.destroy();
    await f.settled;
  });

  it('bounds headers before Busboy can silently truncate them', async () => {
    const f = await fixture();
    const hostile = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="PRIVATE_FILENAME.gpx"\r\nX-Private: ${'x'.repeat(16 * 1024)}\r\n\r\n`);
    refusal(await send(f.address, Buffer.concat([hostile, xml, suffix])), 413, 'gpx_too_large');
    expect(f.received()).toBeUndefined();
  });

  it('handles a header terminator split across TCP writes without counting file bytes as headers', async () => {
    const f = await fixture();
    const exchange = start(f.address, { 'transfer-encoding': 'chunked' });
    exchange.client.write(prefix.subarray(0, prefix.length - 3));
    await f.reading;
    await setImmediate();
    exchange.client.write(prefix.subarray(prefix.length - 3, prefix.length - 1));
    await setImmediate();
    exchange.client.end(Buffer.concat([prefix.subarray(-1), xml, Buffer.alloc(20 * 1024, 32), suffix]));
    expect((await exchange.response).status).toBe(201);
  });

  it.each(['field', 'file', 'malformed'])('rejects an extra %s part instead of silently ignoring it', async (kind) => {
    const f = await fixture();
    const disposition = kind === 'malformed' ? 'X-Private: PRIVATE_METADATA' : `Content-Disposition: form-data; name="PRIVATE_FIELD"${kind === 'file' ? '; filename="extra.gpx"' : ''}`;
    const extra = Buffer.from(`\r\n--${boundary}\r\n${disposition}\r\n\r\nPRIVATE_VALUE`);
    refusal(await send(f.address, Buffer.concat([prefix, xml, extra, suffix])), 400, 'gpx_invalid_request');
    expect(f.received()).toBeUndefined();
  });

  it.each([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="PRIVATE_FIELD"\r\n\r\nPRIVATE_VALUE\r\n--${boundary}--\r\n`),
    Buffer.concat([prefix, xml]),
    body(Buffer.alloc(0)),
  ])('rejects field-only, truncated and empty multipart bodies safely', async (bytes) => {
    const f = await fixture();
    refusal(await send(f.address, bytes), 400, 'gpx_invalid_request');
  });

  it('does not treat the filename or MIME type as GPX validation', async () => {
    const f = await fixture();
    const response = await send(f.address, body(Buffer.from('PRIVATE_VALUE not XML')));
    expect(response.status).toBe(422);
    expect(response.text).not.toMatch(/PRIVATE|filename|stack/i);
  });

  it('settles active parsing on cancellation without requiring another incoming byte', async () => {
    const f = await fixture();
    const exchange = start(f.address, { 'transfer-encoding': 'chunked' });
    exchange.client.write(prefix);
    await f.reading;
    f.controller.abort();
    await f.settled;
    refusal(await exchange.response, 499, 'gpx_aborted');
    exchange.client.destroy();
    expect(f.received()).toBeUndefined();
  });

  it('settles an admission cancelled before raw consumption begins', async () => {
    const admission = Promise.withResolvers<void>();
    const f = await fixture(admission.promise);
    const exchange = start(f.address);
    exchange.client.end(body());
    await f.entered;
    f.controller.abort();
    admission.resolve();
    refusal(await exchange.response, 499, 'gpx_aborted');
    await f.settled;
    expect(f.received()).toBeUndefined();
  });

  it('settles parsing after the client disconnects mid-file', async () => {
    const f = await fixture();
    const exchange = start(f.address, { 'transfer-encoding': 'chunked' });
    const disconnected = exchange.response.catch(() => undefined);
    exchange.client.write(Buffer.concat([prefix, xml.subarray(0, 30)]));
    await f.reading;
    exchange.client.destroy();
    await Promise.all([f.settled, disconnected]);
    expect(f.received()).toBeUndefined();
  });
});
