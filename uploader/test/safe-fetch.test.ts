import { describe, expect, it } from 'vitest';
import { assertFetchableUrl, safeFetch, FetchError } from '../src/safe-fetch.js';

describe('assertFetchableUrl', () => {
  it('accepts public http(s) URLs', () => {
    expect(() => assertFetchableUrl('https://example.com/a.jpg')).not.toThrow();
    expect(() => assertFetchableUrl('http://example.com:8080/a.jpg')).not.toThrow();
  });
  it('rejects non-http schemes', () => {
    expect(() => assertFetchableUrl('ftp://example.com/a')).toThrow(FetchError);
    expect(() => assertFetchableUrl('file:///etc/passwd')).toThrow(FetchError);
    expect(() => assertFetchableUrl('not a url')).toThrow(FetchError);
  });
  it('rejects embedded credentials', () => {
    expect(() => assertFetchableUrl('http://user:pass@example.com/a')).toThrow(/credential/i);
  });
  it('rejects literal loopback and link-local (cloud metadata) addresses', () => {
    expect(() => assertFetchableUrl('http://127.0.0.1/x')).toThrow(/internal/i);
    expect(() => assertFetchableUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/internal/i);
    expect(() => assertFetchableUrl('http://[::1]/x')).toThrow(/internal/i);
  });
});

describe('safeFetch', () => {
  it('returns the body buffer on success', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = (async () => new Response(payload)) as unknown as typeof fetch;
    const { buffer } = await safeFetch('https://example.com/a.jpg', { fetchImpl });
    expect([...buffer]).toEqual([1, 2, 3, 4]);
  });
  it('throws on a non-2xx response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(safeFetch('https://example.com/a.jpg', { fetchImpl })).rejects.toThrow(/404/);
  });
  it('enforces the byte cap by aborting mid-stream', async () => {
    const big = new Uint8Array(1000);
    const fetchImpl = (async () => new Response(big)) as unknown as typeof fetch;
    await expect(safeFetch('https://example.com/a.jpg', { fetchImpl, maxBytes: 100 })).rejects.toThrow(/exceeds|too large/i);
  });
  it('aborts when the timeout elapses', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    await expect(safeFetch('https://example.com/a.jpg', { fetchImpl: hang, timeoutMs: 10 })).rejects.toThrow(FetchError);
  });
});

/**
 * The retry policy in wp-import.ts branches on `kind`/`status`/`code` rather than
 * on message text (issue #85). These assert the tagging exists and is stable —
 * without them the importer would have to regex human-readable messages, the
 * duplicated-parsing-rule mistake gallery-fence-parity.test.ts already guards.
 */
describe('FetchError classification', () => {
  const caught = async (fn: () => Promise<unknown>): Promise<FetchError> => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof FetchError) return e;
      throw e;
    }
    throw new Error('expected a FetchError');
  };

  it('tags an unusable URL as invalid-url, whatever makes it unusable', () => {
    for (const raw of ['not a url', 'ftp://example.com/a', 'http://user:pass@example.com/a']) {
      let err: unknown;
      try { assertFetchableUrl(raw); } catch (e) { err = e; }
      expect((err as FetchError).kind, raw).toBe('invalid-url');
    }
  });

  it('tags an SSRF-guard refusal as blocked, distinctly from a malformed URL', () => {
    let err: unknown;
    try { assertFetchableUrl('http://169.254.169.254/latest/meta-data/'); } catch (e) { err = e; }
    expect((err as FetchError).kind).toBe('blocked');
  });

  it('tags a non-2xx response as http and carries the status', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const err = await caught(() => safeFetch('https://example.com/a.jpg', { fetchImpl }));
    expect(err.kind).toBe('http');
    expect(err.status).toBe(503);
  });

  it('tags a byte-cap breach as too-large', async () => {
    const fetchImpl = (async () => new Response(new Uint8Array(1000))) as unknown as typeof fetch;
    const err = await caught(() => safeFetch('https://example.com/a.jpg', { fetchImpl, maxBytes: 100 }));
    expect(err.kind).toBe('too-large');
  });

  it('tags an abort as timeout', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const err = await caught(() => safeFetch('https://example.com/a.jpg', { fetchImpl: hang, timeoutMs: 10 }));
    expect(err.kind).toBe('timeout');
  });

  it('tags a transport failure as network and carries cause.code through', async () => {
    const boom = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }) as unknown as typeof fetch;
    const err = await caught(() => safeFetch('https://example.com/a.jpg', { fetchImpl: boom }));
    expect(err.kind).toBe('network');
    expect(err.code).toBe('ENOTFOUND');
  });
});
