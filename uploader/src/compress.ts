// Response compression for the public blog (and any other text payload this
// process serves). The measured defect: `GET /` answered 38 864 bytes and
// `GET /_astro/Base.CREtK3y4.css` 68 353 bytes, both with no
// `content-encoding` at all — nginx used to do this, and nothing took the job
// over when the stack collapsed into one Fastify process.
//
// @ai-note Hand-rolled on `node:zlib` instead of @fastify/compress (9.2.0),
// which adds 12 packages for what is `createGzip()` on a stream: itself,
// a second copy of fastify-plugin, and — via `readable-stream@4` — the browser
// polyfills `buffer`, `base64-js`, `ieee754`, `events`, `process`,
// `abort-controller`, `event-target-shim`, `safe-buffer` and `string_decoder`,
// every one of them native in Node since v15. CLAUDE.md's dependency-integrity
// rule ("prefer the platform over a package") decides it.
//
// @ai-warning Three rules here are load-bearing, all of them about the
// self-hosted basemap under /map/ (see server.ts):
//  1. Only status 200 is compressed. PMTiles is read with HTTP RANGE requests;
//     a 206 body is a byte range of the IDENTITY representation, so encoding it
//     hands the client bytes that do not match the `content-range` it asked
//     for. 304 (empty body) and 1xx/204 (no body allowed) fall out of the same
//     check.
//  2. Content types are an ALLOW-LIST, not mime-db's `compressible` flag:
//     `.pmtiles` (application/octet-stream) and `.pbf` (application/x-protobuf)
//     are already-compressed binaries, as are every image variant and font.
//  3. `skipPrefixes` keeps /map/ out even if a future mime mapping were to call
//     one of its payloads text-ish.
// The hook must therefore be registered AFTER the header hook in server.ts that
// assigns those two content types (onSend hooks run in registration order), or
// rule 2 would judge a basemap payload by a content type it does not have yet.

import { constants, createBrotliCompress, createGzip, brotliCompress, gzip } from 'node:zlib';
import { pipeline, type Readable, type Transform } from 'node:stream';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/** Encodings served, in descending preference: brotli beats gzip by ~15% on
 *  this site's HTML/CSS at the quality setting below, and every browser that
 *  reaches this process supports it. */
const ENCODINGS = ['br', 'gzip'] as const;
type Encoding = (typeof ENCODINGS)[number];

/**
 * Below this many bytes compression costs more than it saves: the gzip/brotli
 * frame overhead plus a `vary`-widened cache key against a payload that fits in
 * one TCP segment anyway. 1024 is the same threshold nginx and
 * @fastify/compress default to. The two payloads this exists for are 38 KB and
 * 68 KB, so the threshold never gets in their way.
 */
const DEFAULT_THRESHOLD = 1024;

/** @ai-note Brotli's default quality is 11 — a ~100x slower, archive-grade
 *  setting that must never sit on a request path. 5 costs about what gzip -6
 *  costs and still compresses text better than gzip does. */
const BROTLI_QUALITY = 5;

/** Content types worth compressing. Everything else — images, fonts, PMTiles,
 *  protobuf tiles, archives — is already compressed, so a second pass burns CPU
 *  to add bytes. `+json`/`+xml` suffixes cover `image/svg+xml`,
 *  `application/xhtml+xml`, `application/manifest+json` and the feed types. */
const TEXT_TYPES: Record<string, true> = {
  'application/json': true,
  'application/javascript': true,
  'application/x-javascript': true,
  'application/xml': true,
  'application/graphql': true,
};

/** True for a text-ish `content-type` header value (parameters tolerated). */
export function isTextish(contentType: string): boolean {
  const type = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
  if (type.startsWith('text/')) return true;
  return TEXT_TYPES[type] === true || type.endsWith('+json') || type.endsWith('+xml');
}

/**
 * Picks an encoding from an `Accept-Encoding` header, or null when the client
 * gets identity bytes.
 *
 * @ai-note An explicit `q=0` is a REFUSAL and outranks a `*` wildcard
 * (RFC 9110 §12.5.3), which is how a client opts out of an encoding it
 * cannot decode while still accepting others.
 */
export function negotiateEncoding(header: string | undefined): Encoding | null {
  if (!header) return null;
  const offered = new Map<string, number>();
  for (const part of header.split(',')) {
    const [token, ...params] = part.split(';');
    const name = (token ?? '').trim().toLowerCase();
    if (name === '') continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(param);
      if (match) {
        const parsed = Number(match[1]);
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    offered.set(name, q);
  }
  const wildcard = offered.get('*');
  for (const encoding of ENCODINGS) {
    const q = offered.get(encoding) ?? wildcard;
    if (q !== undefined && q > 0) return encoding;
  }
  return null;
}

/** Adds `Accept-Encoding` to `vary` without dropping or duplicating tokens. */
function addVary(reply: FastifyReply): void {
  const current = reply.getHeader('vary');
  const tokens = (Array.isArray(current) ? current : [current])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .flatMap((value) => value.split(','))
    .map((token) => token.trim())
    .filter((token) => token !== '');
  if (tokens.some((token) => token === '*' || token.toLowerCase() === 'accept-encoding')) return;
  reply.header('vary', [...tokens, 'Accept-Encoding'].join(', '));
}

function createEncoder(encoding: Encoding, sizeHint: number | undefined): Transform {
  if (encoding === 'gzip') return createGzip();
  return createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      ...(sizeHint !== undefined ? { [constants.BROTLI_PARAM_SIZE_HINT]: sizeHint } : {}),
    },
  });
}

function isStream(payload: unknown): payload is Readable {
  return typeof payload === 'object' && payload !== null
    && typeof (payload as { pipe?: unknown }).pipe === 'function';
}

/** Byte length of a buffered payload, or of a stream as announced by its
 *  `content-length` (which @fastify/static sets from `stat`), or undefined. */
function payloadSize(payload: string | Buffer | Readable, reply: FastifyReply): number | undefined {
  if (typeof payload === 'string') return Buffer.byteLength(payload);
  if (Buffer.isBuffer(payload)) return payload.length;
  const declared = reply.getHeader('content-length');
  const length = Number(Array.isArray(declared) ? declared[0] : declared);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

export interface CompressionOptions {
  /** Minimum uncompressed size. Defaults to 1024 bytes. */
  threshold?: number;
  /** URL path prefixes never compressed, whatever their content type. */
  skipPrefixes?: readonly string[];
}

/**
 * Builds the `onSend` hook that compresses text responses.
 *
 * Buffered payloads are compressed in one async call (Fastify recomputes
 * `content-length` from the returned buffer); streams are piped through an
 * encoder and lose their length, since it is no longer known up front.
 *
 * @ai-note Callback style, NOT `async`: every decision not to compress calls
 * `done` SYNCHRONOUSLY, so the overwhelming majority of responses — every
 * non-GET, every refusal, every image and basemap byte — pay no microtask for
 * a feature they do not use. An `async` first version of this hook also
 * exposed a real defect in authn.ts (its guards refused a request without
 * returning the reply, so one extra microtask hop let the route handler run on
 * top of a 401/403); that is fixed at the source now — see the @ai-warning on
 * `AuthGuard` — and pinned by `authn.test.ts`, so correctness here no longer
 * depends on the shape of this hook.
 */
export function compressionHook(options: CompressionOptions = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const skipPrefixes = options.skipPrefixes ?? [];

  return function compressResponse(
    req: FastifyRequest,
    reply: FastifyReply,
    payload: unknown,
    done: (err: Error | null, payload?: unknown) => void,
  ): void {
    if (req.method !== 'GET') return done(null, payload);
    // Rule 1: identity-only outside a plain 200 — see the @ai-warning above.
    if (reply.statusCode !== 200) return done(null, payload);
    if (reply.hasHeader('content-encoding') || reply.hasHeader('content-range')) return done(null, payload);
    if (payload === null || payload === undefined) return done(null, payload);

    const path = (req.raw.url ?? '').split('?', 1)[0] ?? '';
    if (skipPrefixes.some((prefix) => path.startsWith(prefix))) return done(null, payload);

    const contentType = reply.getHeader('content-type');
    if (typeof contentType !== 'string' || !isTextish(contentType)) return done(null, payload);

    const body = isStream(payload) ? payload
      : typeof payload === 'string' || Buffer.isBuffer(payload) ? payload
        : null;
    if (body === null) return done(null, payload);

    // Set on every compressible response, not only the compressed ones (what
    // nginx's `gzip_vary on` does): a shared cache must key the identity copy
    // on the same header, or the first non-gzip client's response is what every
    // later client gets.
    addVary(reply);

    const size = payloadSize(body, reply);
    if (size !== undefined && size < threshold) return done(null, payload);

    const encoding = negotiateEncoding(req.headers['accept-encoding']);
    if (encoding === null) return done(null, payload);

    reply.header('content-encoding', encoding);
    // A range of the encoded body is not a range of the resource, and this
    // process answers a later `Range` request with identity bytes (rule 1). So
    // withdraw the offer, exactly as nginx does when its gzip filter engages.
    reply.removeHeader('accept-ranges');

    if (isStream(body)) {
      reply.removeHeader('content-length');
      const encoder = createEncoder(encoding, size);
      // pipeline (not .pipe) so a read error on the file destroys the encoder
      // instead of leaving Fastify waiting on a stream that never ends.
      pipeline(body, encoder, () => {});
      return done(null, encoder);
    }

    const raw = typeof body === 'string' ? Buffer.from(body) : body;
    const compressed = encoding === 'gzip'
      ? gzipAsync(raw)
      : brotliAsync(raw, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
      });
    compressed.then(
      (buf) => { done(null, buf); },
      (err: unknown) => { done(err instanceof Error ? err : new Error('compression failed')); },
    );
  };
}
