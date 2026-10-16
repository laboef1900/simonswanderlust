import { describe, expect, it, vi } from 'vitest';
import { createGeocoder } from '../src/geocoding.js';
import type { safeFetch, SafeFetchResult } from '../src/safe-fetch.js';
import { defaultSettings, validate } from '../src/settings.js';

const place = { display_name: 'Cancún, Quintana Roo, México', lat: '21.1619', lon: '-86.8515' };
const result = { label: place.display_name, lat: 21.1619, lng: -86.8515 };
const body = (data: unknown) => ({ buffer: Buffer.from(JSON.stringify(data)), contentType: 'application/json' });
function fixture(request = vi.fn<typeof safeFetch>(async () => body([place]))) {
  let time = 0;
  let endpoint = 'https://nominatim.openstreetmap.org/search';
  return {
    request,
    lookup: createGeocoder({ endpoint: () => endpoint, now: () => time, request }),
    tick: (ms = 1100) => { time += ms; },
    endpoint: (value: string) => { endpoint = value; },
  };
}

describe('geocoding', () => {
  it('spaces requests across queries, observes startup cooldown and caches normalized queries', async () => {
    const f = fixture();
    await expect(f.lookup('Cancun')).rejects.toMatchObject({ code: 'lookup_busy' });
    f.tick();
    expect(await f.lookup(' Cancun ')).toEqual([result]);
    expect(await f.lookup('cancun')).toEqual([result]);
    await expect(f.lookup('London')).rejects.toMatchObject({ code: 'lookup_busy' });
    f.tick(1099);
    await expect(f.lookup('London')).rejects.toMatchObject({ code: 'lookup_busy' });
    f.tick(1);
    expect(await f.lookup('London')).toEqual([result]);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(new URL(f.request.mock.calls[0]![0]).searchParams.get('q')).toBe('Cancun');
  });
  it('permits only one pending upstream call and recovers after failure without caching it', async () => {
    const pending = Promise.withResolvers<SafeFetchResult>();
    const f = fixture(vi.fn<typeof safeFetch>().mockReturnValueOnce(pending.promise).mockResolvedValue(body([place])));
    f.tick();
    const first = f.lookup('Cancun');
    const failure = expect(first).rejects.toMatchObject({ code: 'lookup_failed', status: 502 });
    f.tick(30_000);
    await expect(f.lookup('London')).rejects.toMatchObject({ code: 'lookup_busy' });
    pending.reject(new Error('sensitive upstream failure'));
    await failure;
    expect(await f.lookup('Cancun')).toEqual([result]);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it('expires and bounds the cache, and never reuses results after changing the endpoint', async () => {
    const f = fixture();
    f.tick();
    await f.lookup('Cancun');
    f.tick(24 * 60 * 60 * 1000);
    await f.lookup('Cancun');
    expect(f.request).toHaveBeenCalledTimes(2);
    f.endpoint('https://geocode.example/search');
    f.tick();
    await f.lookup('Cancun');
    expect(f.request).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 100; i++) { f.tick(); await f.lookup('City ' + i); }
    f.tick();
    await f.lookup('Cancun');
    expect(f.request).toHaveBeenCalledTimes(104);
    f.endpoint('');
    await expect(f.lookup('Cancun')).rejects.toMatchObject({ code: 'lookup_disabled' });
  });

  it('caches empty searches and fails closed on internal destinations', async () => {
    const f = fixture(vi.fn<typeof safeFetch>(async () => body([])));
    f.tick();
    expect(await f.lookup('Not a place')).toEqual([]);
    expect(await f.lookup('Not a place')).toEqual([]);
    expect(f.request).toHaveBeenCalledTimes(1);
    let time = 0;
    const lookup = createGeocoder({ endpoint: () => 'https://127.0.0.1/search', now: () => time });
    time = 1100;
    await expect(lookup('Cancun')).rejects.toMatchObject({ code: 'lookup_failed' });
  });

  it.each([null, {}, '', 'x', 'x'.repeat(201), 'Can\u0000cun'])('refuses invalid input without contacting a provider: %j', async (input) => {
    const f = fixture();
    f.tick();
    await expect(f.lookup(input)).rejects.toMatchObject({ code: 'invalid_query', status: 400 });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([{}, [null], [{ ...place, lat: '' }], [{ ...place, lat: '91' }], [{ ...place, lon: '-181' }], [{ ...place, lat: 'NaN' }], [{ ...place, display_name: '' }]])('rejects malformed provider data: %j', async (data) => {
    const f = fixture(vi.fn<typeof safeFetch>(async () => body(data)));
    f.tick();
    await expect(f.lookup('Cancun')).rejects.toMatchObject({ code: 'lookup_failed' });
  });

  it.each(['http://example.com/search', 'https://user:secret@example.com/search', 'https://example.com/?key=x', 'https://example.com/#x', 'https://exa\nmple.com/'])('rejects unsafe configured endpoints: %s', (url) => {
    expect(() => validate({ ...defaultSettings(), geocodingSearchUrl: url })).toThrow();
  });
});
