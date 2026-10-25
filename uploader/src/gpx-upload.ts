import { Busboy, type BusboyFileStream, type BusboyInstance } from '@fastify/busboy';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { GPX_LIMITS } from '../public/gpx-geometry.js';
import { GpxError } from './gpx-errors.js';

const HEADER_BYTES = 16 * 1024;
const REQUEST_BYTES = GPX_LIMITS.fileBytes + HEADER_BYTES;
const HEADER_END = [13, 10, 13, 10];

/** Consume the real request only after the service has admitted this upload. */
export function readGpxUpload(request: FastifyRequest, reply: FastifyReply, signal: AbortSignal): Promise<Buffer> {
    const raw = request.raw;
    const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
    let parser: BusboyInstance | undefined;
    let file: BusboyFileStream | undefined;
    let settled = false;
    let ended = false;
    let finished = false;
    let total = 0;
    let length = 0;
    let prefixBytes = 0;
    let headerMatch = 0;
    let probingHeaderEnd = false;
    const chunks: Buffer[] = [];

    function cleanup(): void {
      signal.removeEventListener('abort', abort);
      raw.removeListener('data', data);
      raw.removeListener('end', end);
      raw.removeListener('aborted', abort);
      raw.removeListener('error', invalid);
      parser?.removeListener('drain', drain);
    }
    function fail(error: GpxError): void {
      if (settled) return;
      settled = true;
      cleanup();
      raw.pause();
      file?.destroy();
      parser?.destroy();
      chunks.length = 0;
      // Do not drain an unbounded hostile body, or destroy its socket before the
      // structured error is flushed. This connection cannot safely be reused.
      if (!raw.destroyed) {
        reply.header('connection', 'close');
        if (reply.raw.writableFinished) raw.destroy();
        else reply.raw.once('finish', () => raw.destroy());
      }
      reject(error);
    }
    function invalid(): void { fail(new GpxError('gpx_invalid_request', 400)); }
    function tooLarge(): void { fail(new GpxError('gpx_too_large', 413)); }
    function abort(): void { fail(new GpxError('gpx_aborted', 499)); }
    function complete(): void {
      if (settled || !ended || !finished) return;
      if (!file || !length) return invalid();
      if (file.truncated) return tooLarge();
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, length));
    }
    function drain(): void { if (!settled) raw.resume(); }
    function feed(chunk: Buffer): void {
      try {
        if (!settled && !finished && !parser!.write(chunk)) raw.pause();
      } catch { invalid(); }
    }
    function data(chunk: Buffer): void {
      if (settled) return;
      total += chunk.length;
      if (total > REQUEST_BYTES) return tooLarge();
      let start = 0;
      // Busboy silently truncates oversized part headers. Bound the entire
      // prefix (including any preamble) BEFORE its first file event instead.
      // Feed through each header terminator separately so the file event marks
      // the exact transition, even when headers and body share a TCP chunk.
      for (let i = 0; !file && !settled && i < chunk.length; i++) {
        ++prefixBytes;
        if (probingHeaderEnd) {
          // Dicer's boundary search may retain the terminator's trailing CRLF
          // until the next byte. Release that lookbehind before counting any
          // body bytes as header bytes.
          feed(chunk.subarray(start, i + 1));
          start = i + 1;
        } else {
          headerMatch = chunk[i] === HEADER_END[headerMatch] ? headerMatch + 1 : chunk[i] === 13 ? 1 : 0;
          if (headerMatch === HEADER_END.length) {
            headerMatch = 0;
            probingHeaderEnd = true;
            feed(chunk.subarray(start, i + 1));
            start = i + 1;
          }
        }
        if (!file && prefixBytes > HEADER_BYTES) return tooLarge();
      }
      if (start < chunk.length) feed(chunk.subarray(start));
    }
    function end(): void {
      ended = true;
      try { if (!settled && !finished) parser!.end(); }
      catch { invalid(); }
      complete();
    }

    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted || raw.aborted || raw.destroyed) { abort(); return promise; }
    const contentType = request.headers['content-type'];
    if (!contentType || !/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) { invalid(); return promise; }
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > REQUEST_BYTES)) { tooLarge(); return promise; }
    try {
      parser = new Busboy({
        headers: { ...request.headers, 'content-type': contentType },
        limits: { fileSize: GPX_LIMITS.fileBytes, files: 1, fields: 0, parts: 1,
          // Every header pair needs at least three bytes; these parser limits
          // cannot silently truncate anything admitted by the prefix bound.
          headerSize: HEADER_BYTES + 1, headerPairs: HEADER_BYTES, fieldSize: 0 },
      });
    } catch { invalid(); return promise; }
    parser.on('error', invalid);
    parser.on('partsLimit', invalid);
    parser.on('filesLimit', invalid);
    parser.on('fieldsLimit', invalid);
    parser.on('field', invalid);
    parser.on('drain', drain);
    parser.on('file', (_name, stream, filename) => {
      stream.on('error', invalid);
      if (settled) { stream.destroy(); return; }
      if (file || typeof filename !== 'string' || !/\.gpx$/i.test(filename)) {
        stream.destroy();
        invalid();
        return;
      }
      file = stream;
      stream.on('limit', tooLarge);
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        length += chunk.length;
        if (length > GPX_LIMITS.fileBytes) return tooLarge();
        chunks.push(chunk);
      });
    });
    parser.on('finish', () => { finished = true; complete(); });
    raw.on('error', invalid);
    raw.once('aborted', abort);
    raw.once('end', end);
    raw.on('data', data);
    return promise;
}
