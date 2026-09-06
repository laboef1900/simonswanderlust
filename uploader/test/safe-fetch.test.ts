import { describe, expect, it } from 'vitest';
import { assertFetchableUrl, safeFetch, FetchError, type LookupFn } from '../src/safe-fetch.js';

/** Every hostname resolves to one public address unless a test says otherwise. */
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

/** A `fetchImpl` that answers each request from `script` in order and records what it was asked for. */
function scripted(script: Array<() => Response>) {
  const calls: string[] = [];
  let n = 0;
  const fetchImpl = (async (u: URL | string) => {
    calls.push(String(u));
    const next = script[n++];
    if (!next) throw new Error(`unscripted fetch #${n} for ${String(u)}`);
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
const body = (bytes: number[]) => () => new Response(new Uint8Array(bytes));

const caught = async (fn: () => Promise<unknown>): Promise<FetchError> => {
  try {
    await fn();
  } catch (e) {
    if (e instanceof FetchError) return e;
    throw e;
  }
  throw new Error('expected a FetchError');
};

describe('assertFetchableUrl', () => {
  it('accepts public http(s) URLs', () => {
    expect(() => assertFetchableUrl('https://example.com/a.jpg')).not.toThrow();
    expect(() => assertFetchableUrl('http://example.com:8080/a.jpg')).not.toThrow();
    expect(() => assertFetchableUrl('http://93.184.216.34/a.jpg')).not.toThrow();
    expect(() => assertFetchableUrl('http://[2606:2800:220:1:248:1893:25c8:1946]/a.jpg')).not.toThrow();
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
  it('rejects RFC1918, CGNAT, unspecified and multicast literals', () => {
    for (const host of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
      expect(() => assertFetchableUrl(`http://${host}/x`), host).toThrow(/internal/i);
    }
  });
  it('rejects IPv6 unique-local, link-local, NAT64 and IPv4-mapped internal literals', () => {
    for (const host of ['[fd12::1]', '[fe80::1]', '[64:ff9b::7f00:1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::]']) {
      expect(() => assertFetchableUrl(`http://${host}/x`), host).toThrow(/internal/i);
    }
  });
  it('sees through the alternate IPv4 spellings the URL parser canonicalises', () => {
    expect(() => assertFetchableUrl('http://2130706433/x')).toThrow(/internal/i);     // decimal 127.0.0.1
    expect(() => assertFetchableUrl('http://0x7f.1/x')).toThrow(/internal/i);         // hex + short form
    expect(() => assertFetchableUrl('http://0251.0376.0251.0376/x')).toThrow(/internal/i); // octal 169.254.169.254
  });
});

describe('safeFetch', () => {
  it('returns the body buffer on success', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = (async () => new Response(payload)) as unknown as typeof fetch;
    const { buffer } = await safeFetch('https://example.com/a.jpg', { fetchImpl, lookup: publicLookup });
    expect([...buffer]).toEqual([1, 2, 3, 4]);
  });
  it('throws on a non-2xx response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(safeFetch('https://example.com/a.jpg', { fetchImpl, lookup: publicLookup })).rejects.toThrow(/404/);
  });
  it('enforces the byte cap by aborting mid-stream', async () => {
    const big = new Uint8Array(1000);
    const fetchImpl = (async () => new Response(big)) as unknown as typeof fetch;
    await expect(safeFetch('https://example.com/a.jpg', { fetchImpl, lookup: publicLookup, maxBytes: 100 })).rejects.toThrow(/exceeds|too large/i);
  });
  it('aborts when the timeout elapses', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    await expect(safeFetch('https://example.com/a.jpg', { fetchImpl: hang, lookup: publicLookup, timeoutMs: 10 })).rejects.toThrow(FetchError);
  });
  it('asks fetch for manual redirects, so no hop can slip past the guard', async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_u: URL | string, i?: RequestInit) => { init = i; return new Response(new Uint8Array(1)); }) as unknown as typeof fetch;
    await safeFetch('https://example.com/a.jpg', { fetchImpl, lookup: publicLookup });
    expect(init?.redirect).toBe('manual');
  });
});

/**
 * Redirect hops are re-validated one by one (issue #93). WordPress media URLs
 * legitimately redirect — CDN, HTTPS upgrade, resized-variant handlers — so the
 * legitimate shapes must keep working while every hop into internal space is refused.
 */
describe('safeFetch redirects', () => {
  it('follows a relative same-origin redirect and returns the final body', async () => {
    const { fetchImpl, calls } = scripted([redirect('/uploads/2024/b.jpg'), body([7, 8])]);
    const { buffer } = await safeFetch('https://wp.example.com/a.jpg', { fetchImpl, lookup: publicLookup });
    expect([...buffer]).toEqual([7, 8]);
    expect(calls).toEqual(['https://wp.example.com/a.jpg', 'https://wp.example.com/uploads/2024/b.jpg']);
  });

  it('follows a cross-origin public redirect (CDN, HTTPS upgrade), resolving each hop', async () => {
    const seen: string[] = [];
    const lookup: LookupFn = async (host) => { seen.push(host); return publicLookup(host); };
    const { fetchImpl, calls } = scripted([
      redirect('https://wp.example.com/a.jpg', 301),
      redirect('https://cdn.example.net/x/a.jpg', 307),
      body([9]),
    ]);
    const { buffer } = await safeFetch('http://wp.example.com/a.jpg', { fetchImpl, lookup });
    expect([...buffer]).toEqual([9]);
    expect(calls).toEqual(['http://wp.example.com/a.jpg', 'https://wp.example.com/a.jpg', 'https://cdn.example.net/x/a.jpg']);
    expect(seen).toEqual(['wp.example.com', 'wp.example.com', 'cdn.example.net']);
  });

  it('refuses a redirect to loopback, RFC1918, link-local or an IPv4-mapped literal, before fetching it', async () => {
    for (const target of [
      'http://127.0.0.1/admin',
      'http://10.0.0.5:8080/x',
      'http://192.168.1.1/x',
      'http://172.17.0.2:5432/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/x',
      'http://[::ffff:127.0.0.1]/x',
    ]) {
      const { fetchImpl, calls } = scripted([redirect(target)]);
      const err = await caught(() => safeFetch('https://wp.example.com/a.jpg', { fetchImpl, lookup: publicLookup }));
      expect(err.kind, target).toBe('blocked');
      expect(err.message, target).toMatch(/internal/i);
      expect(calls, target).toEqual(['https://wp.example.com/a.jpg']);
    }
  });

  it('refuses a redirect whose hostname resolves to an internal address, before fetching it', async () => {
    const lookup: LookupFn = async (host) =>
      host === 'internal.example' ? [{ address: '10.0.0.5', family: 4 }] : publicLookup(host);
    const { fetchImpl, calls } = scripted([redirect('http://internal.example/x')]);
    const err = await caught(() => safeFetch('https://wp.example.com/a.jpg', { fetchImpl, lookup }));
    expect(err.kind).toBe('blocked');
    expect(calls).toEqual(['https://wp.example.com/a.jpg']);
  });

  it('refuses a redirect to an unsupported scheme or a URL with credentials', async () => {
    for (const target of ['ftp://example.com/x', 'file:///etc/passwd', 'data:text/plain,hi', 'https://user:pw@example.com/x']) {
      const { fetchImpl, calls } = scripted([redirect(target)]);
      const err = await caught(() => safeFetch('https://wp.example.com/a.jpg', { fetchImpl, lookup: publicLookup }));
      expect(err.kind, target).toBe('invalid-url');
      expect(calls, target).toHaveLength(1);
    }
  });

  it('stops at the hop cap and reports it as a non-retryable http failure', async () => {
    const { fetchImpl, calls } = scripted(
      Array.from({ length: 10 }, (_, i) => redirect(`https://wp.example.com/hop${i + 1}`)),
    );
    const err = await caught(() => safeFetch('https://wp.example.com/hop0', { fetchImpl, lookup: publicLookup, maxRedirects: 3 }));
    expect(err.kind).toBe('http');
    expect(err.status).toBe(302);
    expect(err.message).toMatch(/too many redirects/);
    expect(calls).toHaveLength(4); // the original plus three hops, never the fourth
  });

  it('treats a 3xx without a Location as an ordinary non-2xx response', async () => {
    const { fetchImpl } = scripted([() => new Response(null, { status: 304 })]);
    const err = await caught(() => safeFetch('https://wp.example.com/a.jpg', { fetchImpl, lookup: publicLookup }));
    expect(err.kind).toBe('http');
    expect(err.status).toBe(304);
  });

  it('spans the whole chain with one timeout', async () => {
    let n = 0;
    const fetchImpl = ((_u: URL | string, init?: RequestInit) => {
      if (n++ === 0) return Promise.resolve(redirect('https://cdn.example.net/a.jpg')());
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as unknown as typeof fetch;
    const err = await caught(() => safeFetch('https://wp.example.com/a.jpg', { fetchImpl, lookup: publicLookup, timeoutMs: 20 }));
    expect(err.kind).toBe('timeout');
    expect(n).toBe(2);
  });

  it('applies the byte cap to the body behind the redirect', async () => {
    const { fetchImpl } = scripted([redirect('https://cdn.example.net/a.jpg'), () => new Response(new Uint8Array(1000))]);
    const err = await caught(() => safeFetch('https://wp.example.com/a.jpg', { fetchImpl, lookup: publicLookup, maxBytes: 100 }));
    expect(err.kind).toBe('too-large');
  });
});

/** The pre-connect DNS check: a hostname is judged by what it resolves to, not by its spelling. */
describe('safeFetch DNS check', () => {
  it('refuses a hostname that resolves to an internal address, without fetching', async () => {
    const lookup: LookupFn = async () => [{ address: '127.0.0.1', family: 4 }];
    const { fetchImpl, calls } = scripted([body([1])]);
    const err = await caught(() => safeFetch('http://localhost/x', { fetchImpl, lookup }));
    expect(err.kind).toBe('blocked');
    expect(calls).toEqual([]);
  });

  it('refuses when ANY resolved address is internal — the attacker does not pick the record', async () => {
    const lookup: LookupFn = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '::ffff:10.0.0.1', family: 6 },
    ];
    const { fetchImpl, calls } = scripted([body([1])]);
    const err = await caught(() => safeFetch('https://dual.example/x', { fetchImpl, lookup }));
    expect(err.kind).toBe('blocked');
    expect(calls).toEqual([]);
  });

  it('refuses an empty or unparseable resolution rather than trusting the connect', async () => {
    for (const addresses of [[], [{ address: 'garbage', family: 4 }]]) {
      const lookup: LookupFn = async () => addresses;
      const { fetchImpl } = scripted([body([1])]);
      const err = await caught(() => safeFetch('https://odd.example/x', { fetchImpl, lookup }));
      expect(err.kind).toBe('blocked');
    }
  });

  it('does not resolve a literal IP host — the string check already judged it', async () => {
    const lookup: LookupFn = async () => { throw new Error('lookup must not run'); };
    const { fetchImpl } = scripted([body([5])]);
    const { buffer } = await safeFetch('http://93.184.216.34/x', { fetchImpl, lookup });
    expect([...buffer]).toEqual([5]);
  });

  it('tags a resolution failure as network and carries the dns code, so ENOTFOUND stays non-retryable', async () => {
    const lookup: LookupFn = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND gone.example'), { code: 'ENOTFOUND' }); };
    const { fetchImpl, calls } = scripted([body([1])]);
    const err = await caught(() => safeFetch('https://gone.example/x', { fetchImpl, lookup }));
    expect(err.kind).toBe('network');
    expect(err.code).toBe('ENOTFOUND');
    expect(calls).toEqual([]);
  });

  it('counts a hanging resolver against the timeout', async () => {
    const lookup: LookupFn = () => new Promise(() => {});
    const { fetchImpl } = scripted([body([1])]);
    const err = await caught(() => safeFetch('https://slow.example/x', { fetchImpl, lookup, timeoutMs: 10 }));
    expect(err.kind).toBe('timeout');
  });
});

/**
 * The retry policy in wp-import.ts branches on `kind`/`status`/`code` rather than
 * on message text (issue #85). These assert the tagging exists and is stable —
 * without them the importer would have to regex human-readable messages, the
 * duplicated-parsing-rule mistake gallery-fence-parity.test.ts already guards.
 */
describe('FetchError classification', () => {
  it('tags an unusable URL as invalid-url, whatever makes it unusable', () => {
    for (const raw of ['not a url', 'ftp://example.com/a', 'http://user:pass@example.com/a']) {
      let err: unknown;
      try { assertFetchableUrl(raw); } catch (e) { err = e; }
      expect(err, raw).toBeInstanceOf(FetchError);
      expect((err as FetchError).kind, raw).toBe('invalid-url');
    }
  });

  it('tags an SSRF-guard refusal as blocked, distinctly from a malformed URL', () => {
    let err: unknown;
    try { assertFetchableUrl('http://169.254.169.254/latest/meta-data/'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).kind).toBe('blocked');
  });

  it('tags a non-2xx response as http and carries the status', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const err = await caught(() => safeFetch('https://example.com/a.jpg', { fetchImpl, lookup: publicLookup }));
    expect(err.kind).toBe('http');
    expect(err.status).toBe(503);
  });

  it('tags a byte-cap breach as too-large', async () => {
    const fetchImpl = (async () => new Response(new Uint8Array(1000))) as unknown as typeof fetch;
    const err = await caught(() => safeFetch('https://example.com/a.jpg', { fetchImpl, lookup: publicLookup, maxBytes: 100 }));
    expect(err.kind).toBe('too-large');
  });

  it('tags an abort as timeout', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const err = await caught(() => safeFetch('https://example.com/a.jpg', { fetchImpl: hang, lookup: publicLookup, timeoutMs: 10 }));
    expect(err.kind).toBe('timeout');
  });

  it('tags a transport failure as network and carries cause.code through', async () => {
    const boom = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }) as unknown as typeof fetch;
    const err = await caught(() => safeFetch('https://example.com/a.jpg', { fetchImpl: boom, lookup: publicLookup }));
    expect(err.kind).toBe('network');
    expect(err.code).toBe('ENOTFOUND');
  });
});
