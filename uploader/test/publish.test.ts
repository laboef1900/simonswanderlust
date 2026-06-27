import { describe, expect, it } from 'vitest';
import { triggerBuild } from '../src/publish.js';

const fakeFetch = (status: number, body: unknown, capture?: (h: HeadersInit | undefined) => void) =>
  (async (_url: string, init?: RequestInit) => { capture?.(init?.headers); return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }; }) as unknown as typeof fetch;

describe('triggerBuild', () => {
  it('sends the x-build-secret header and returns the release on success', async () => {
    let headers: Record<string, string> = {};
    const r = await triggerBuild('http://b:4000', 's3cret', fakeFetch(200, { ok: true, release: 'r1' }, (h) => { headers = h as Record<string, string>; }));
    expect(r).toEqual({ ok: true, release: 'r1' });
    expect(headers['x-build-secret']).toBe('s3cret');
  });
  it('returns ok:false with the error on a non-2xx', async () => {
    const r = await triggerBuild('http://b:4000', 's', fakeFetch(500, { ok: false, error: 'boom' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('boom');
  });
  it('returns ok:false when fetch throws', async () => {
    const throwing = (async () => { throw new Error('econn'); }) as unknown as typeof fetch;
    const r = await triggerBuild('http://b:4000', 's', throwing);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('econn');
  });
  it('aborts and returns ok:false when the builder hangs past the timeout', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as unknown as typeof fetch;
    const r = await triggerBuild('http://b:4000', 's', hang, 10);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/tim(e|ed) ?out|abort/i);
  });
});
