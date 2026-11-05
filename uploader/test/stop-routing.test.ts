import { describe, expect, it, vi } from 'vitest';
import { createStopRouter, splitAntimeridian, StopRoutingError, ROUTING_SPACING_MS, ROUTING_BUDGET_MS, ROUTING_SNAP_RADIUS_METRES } from '../src/stop-routing.js';
import { FetchError, type SafeFetchOptions } from '../src/safe-fetch.js';
import { validatePublicStopRoute, validateRouteStops, type RouteStop } from '../public/stop-route.js';
import { stopRouteFingerprintSync } from '../src/stop-route-fingerprint.js';

const ENDPOINTS = { car: 'https://car.example/osrm/', bike: 'https://bike.example', foot: 'https://foot.example/routed-foot' };
const ok = (coordinates: [number, number][]) => JSON.stringify({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates } }] });
const respond = (body: string) => ({ buffer: Buffer.from(body), contentType: 'application/json' });
const line = (from: RouteStop, to: RouteStop): [number, number][] =>
  [[from.lng, from.lat], [(from.lng + to.lng) / 2, (from.lat + to.lat) / 2 + 0.05], [to.lng, to.lat]];

/** A clock that only advances when the router sleeps. */
function clock(start = 1_000_000) {
  let time = start;
  const waits: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => { waits.push(ms); time += ms; },
    advance: (ms: number) => { time += ms; },
    waits,
  };
}

function stops(...rows: Partial<RouteStop>[]): RouteStop[] {
  return validateRouteStops(rows.map((row, index) => ({ name: `Stop ${index}`, lat: 37 + index * 0.1, lng: 23 + index * 0.1, ...row })));
}

describe('createStopRouter (#513)', () => {
  it('dispatches each leg to its own profile endpoint in stop order; straight legs never fetch; via points shape the route', async () => {
    const route = stops({}, { via: true, profile: 'bike' }, { profile: 'foot' }, { profile: 'straight' }, {});
    const calls: string[] = [];
    const c = clock();
    const router = createStopRouter({
      endpoints: () => ENDPOINTS, now: c.now, sleep: c.sleep,
      request: async (url) => {
        calls.push(url);
        const index = calls.length - 1;
        return respond(ok(line(route[index]!, route[index + 1]!)));
      },
    });
    const stored = await router.calculate(route);
    expect(calls.map((url) => new URL(url).origin + new URL(url).pathname.replace(/\/[^/]+$/, ''))).toEqual([
      'https://car.example/osrm/route/v1/driving',
      'https://bike.example/route/v1/cycling',
      'https://foot.example/routed-foot/route/v1/walking',
    ]);
    expect(calls[1]).toContain(`${route[1]!.lng.toFixed(6)},${route[1]!.lat.toFixed(6)};${route[2]!.lng.toFixed(6)},${route[2]!.lat.toFixed(6)}`);
    expect(stored.legs).toEqual([
      { profile: 'car', kind: 'road' }, { profile: 'bike', kind: 'road' },
      { profile: 'foot', kind: 'road' }, { profile: 'straight', kind: 'straight' },
    ]);
    expect(stored.fingerprint).toBe(stopRouteFingerprintSync(route));
    // Road legs meeting at the same point merge into one run; the straight leg is its own run, last.
    expect(stored.route.runs.map((run) => run.kind)).toEqual(['road', 'straight']);
    expect(stored.route.runs[0]!.coordinates[0]).toEqual([23, 37]);
    expect(stored.route.runs[1]!.coordinates).toEqual([[23.3, 37.3], [23.4, 37.4]]);
    expect(validatePublicStopRoute(stored.route)).toBe(stored.route);
  });

  it('refuses a leg whose profile has no endpoint before any request, and reports the profiles', async () => {
    const request = vi.fn();
    const router = createStopRouter({ endpoints: () => ({ ...ENDPOINTS, bike: '', foot: '' }), request });
    expect(router.profiles()).toEqual({ car: true, bike: false, foot: false });
    const error = await router.calculate(stops({ profile: 'bike' }, { profile: 'foot' }, {})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StopRoutingError);
    expect(error).toMatchObject({ code: 'stop_route_profile_unavailable', status: 409, profiles: ['bike', 'foot'] });
    expect(request).not.toHaveBeenCalled();
  });

  it('calculates all-straight routes with every provider disabled and no network', async () => {
    const request = vi.fn();
    const router = createStopRouter({ endpoints: () => ({ car: '', bike: '', foot: '' }), request });
    const stored = await router.calculate(stops({ profile: 'straight' }, {}));
    expect(stored.legs).toEqual([{ profile: 'straight', kind: 'straight' }]);
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to a flagged straight leg for OSRM NoRoute (HTTP 400) through the real safeFetch, keeping routed legs', async () => {
    const route = stops({}, {}, {});
    const agents: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      agents.push(new Headers(init?.headers).get('user-agent') ?? '');
      return fetchImpl.mock.calls.length === 1
        ? new Response(ok(line(route[0]!, route[1]!)), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ code: 'NoRoute', message: 'Impossible route' }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
    const c = clock();
    const router = createStopRouter({
      endpoints: () => ENDPOINTS, now: c.now, sleep: c.sleep, fetchImpl,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    const stored = await router.calculate(route);
    expect(stored.legs).toEqual([{ profile: 'car', kind: 'road' }, { profile: 'car', kind: 'straight', fallback: 'no_route' }]);
    expect(stored.route.runs.map((run) => run.kind)).toEqual(['road', 'straight']);
    expect(agents.every((agent) => /SimonsWanderlust\/.+ \(editor stop routing\)/.test(agent))).toBe(true);
  });

  it('turns stops outside the extract into flagged straight legs instead of a fake road at its edge', async () => {
    // Behaves like osrm-routed on a Berlin-only graph: without a radius every
    // Yucatán stop snaps ~9,600 km to the same Berlin edge node (0 m "route");
    // with `radiuses` beyond the nearest road it answers NoSegment.
    const edge: [number, number] = [13.083971, 52.411755];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const radiuses = new URL(String(input)).searchParams.get('radiuses')?.split(';').map(Number) ?? [];
      return radiuses.length === 2 && radiuses.every((metres) => metres > 0 && metres <= ROUTING_SNAP_RADIUS_METRES)
        ? new Response(JSON.stringify({ code: 'NoSegment', message: 'Could not find a matching segment' }), { status: 400 })
        : new Response(ok([edge, edge]), { status: 200 });
    });
    const c = clock();
    const router = createStopRouter({
      endpoints: () => ({ car: 'http://osrm-car:5000', bike: '', foot: '' }), now: c.now, sleep: c.sleep, fetchImpl,
      lookup: async () => [{ address: '172.18.0.4', family: 4 }], internalOrigins: new Set(['http://osrm-car:5000']),
    });
    const yucatan = validateRouteStops([
      { name: 'Cancún', lat: 21.1527467, lng: -86.8425761 }, { name: 'Playa del Carmen', lat: 20.6462848, lng: -87.0807866 },
      { name: 'Tulum', lat: 20.429647, lng: -87.6529306 },
    ]);
    const stored = await router.calculate(yucatan);
    expect(stored.legs).toEqual([
      { profile: 'car', kind: 'straight', fallback: 'no_route' }, { profile: 'car', kind: 'straight', fallback: 'no_route' },
    ]);
    expect(stored.route.runs).toEqual([{ kind: 'straight', coordinates: [[-86.8426, 21.1527], [-87.0808, 20.6463], [-87.6529, 20.4296]] }]);
  });

  it.each([
    ['HTTP 500', () => { throw new FetchError('download failed (HTTP 500)', 'http', { status: 500 }); }],
    ['timeout', () => { throw new FetchError('timeout', 'timeout'); }],
    ['malformed JSON', () => respond('{nope')],
    ['out-of-range geometry', () => respond(ok([[200, 1], [1, 1]]))],
    ['non-Ok code', () => respond(JSON.stringify({ code: 'TooBig' }))],
  ])('flags %s on one leg as provider_error while another leg routes', async (_name, failure) => {
    const route = stops({}, {}, {});
    let call = 0;
    const c = clock();
    const router = createStopRouter({
      endpoints: () => ENDPOINTS, now: c.now, sleep: c.sleep,
      request: async () => (call++ === 0 ? respond(ok(line(route[0]!, route[1]!))) : failure()),
    });
    const stored = await router.calculate(route);
    expect(stored.legs[1]).toEqual({ profile: 'car', kind: 'straight', fallback: 'provider_error' });
  });

  it('treats a provider that answers no leg as unreachable: nothing is returned to store', async () => {
    const c = clock();
    const router = createStopRouter({
      endpoints: () => ENDPOINTS, now: c.now, sleep: c.sleep,
      request: async () => { throw new FetchError('network', 'network'); },
    });
    await expect(router.calculate(stops({}, { profile: 'straight' }, {}))).rejects.toMatchObject({ code: 'stop_route_failed', status: 502 });
  });

  it.each([
    ['a loopback literal', 'https://127.0.0.1/osrm', async () => [{ address: '127.0.0.1', family: 4 }]],
    ['a public name resolving to RFC1918', 'https://osrm.internal.example', async () => [{ address: '10.0.0.1', family: 4 }]],
  ])('refuses %s through safeFetch without contacting it', async (_name, base, lookup) => {
    const fetchImpl = vi.fn(async () => new Response(ok([[1, 1], [2, 2]])));
    const c = clock();
    const router = createStopRouter({ endpoints: () => ({ car: base, bike: '', foot: '' }), now: c.now, sleep: c.sleep, fetchImpl, lookup });
    await expect(router.calculate(stops({}, {}))).rejects.toMatchObject({ code: 'stop_route_failed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('routes through an operator-listed compose origin over plain HTTP via the real safeFetch', async () => {
    const fetched: string[] = [];
    const fetchImpl = vi.fn(async (input: URL | string) => { fetched.push(String(input)); return new Response(ok([[23, 37], [23.1, 37.1]])); }) as unknown as typeof fetch;
    const c = clock();
    const router = createStopRouter({
      endpoints: () => ({ car: 'http://osrm-car:5000', bike: '', foot: '' }), now: c.now, sleep: c.sleep, fetchImpl,
      lookup: async () => [{ address: '172.18.0.4', family: 4 }], internalOrigins: new Set(['http://osrm-car:5000']),
    });
    expect(router.profiles()).toEqual({ car: true, bike: false, foot: false });
    const stored = await router.calculate(stops({}, {}));
    expect(stored.legs).toEqual([{ profile: 'car', kind: 'road' }]);
    expect(new URL(fetched[0]!).origin).toBe('http://osrm-car:5000');
  });

  it('treats a plain-HTTP URL whose origin is not listed as unconfigured, before any request', () => {
    const request = vi.fn();
    const router = createStopRouter({
      endpoints: () => ({ car: 'http://osrm-car:5000', bike: 'http://osrm.example', foot: '' }), request,
      internalOrigins: new Set(['http://osrm-car:5001']),
    });
    expect(router.profiles()).toEqual({ car: false, bike: false, foot: false });
    expect(router.refusal(stops({}, {}))).toMatchObject({ code: 'stop_route_profile_unavailable', profiles: ['car'] });
    expect(request).not.toHaveBeenCalled();
  });

  it("routes each leg to the story country's bundled server when ready, else to the Settings URL", async () => {
    const calls: string[] = [];
    const c = clock();
    const router = createStopRouter({
      endpoints: () => ({ car: 'https://car.example', bike: 'https://bike.example', foot: '' }),
      // Costa Rica: car and foot built, bike still building. Unlisted origins never win.
      regionEndpoints: (code) => (code === 'CR' ? { car: 'http://osrm:5100', foot: 'http://osrm:5102' } : code === 'MX' ? { car: 'http://evil:5100' } : {}),
      internalOrigins: new Set(['http://osrm:5100', 'http://osrm:5101', 'http://osrm:5102']),
      now: c.now, sleep: c.sleep,
      request: async (url) => { calls.push(new URL(url).origin); return respond(ok([[23, 37], [23.1, 37.1]])); },
    });
    expect(router.profiles({ countryCode: 'CR' })).toEqual({ car: true, bike: true, foot: true });
    expect(router.profiles({ countryCode: 'GR' })).toEqual({ car: true, bike: true, foot: false });
    await router.calculate(stops({}, { profile: 'bike' }, { profile: 'foot' }, {}), { countryCode: 'CR' });
    await router.calculate(stops({}, {}), { countryCode: 'MX' });
    await router.calculate(stops({}, {}));
    expect(calls).toEqual(['http://osrm:5100', 'https://bike.example', 'http://osrm:5102', 'https://car.example', 'https://car.example']);
    expect(router.refusal(stops({ profile: 'foot' }, {}), { countryCode: 'GR' })).toMatchObject({ code: 'stop_route_profile_unavailable', profiles: ['foot'] });
  });

  it('spaces outbound requests at least 1.1 s apart, across calculations', async () => {
    const c = clock();
    const starts: number[] = [];
    const router = createStopRouter({
      endpoints: () => ENDPOINTS, now: c.now, sleep: c.sleep,
      request: async () => { starts.push(c.now()); c.advance(200); return respond(ok([[23, 37], [23.1, 37.1]])); },
    });
    await router.calculate(stops({}, {}, {}));
    await router.calculate(stops({}, {}));
    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(ROUTING_SPACING_MS);
  });

  it('does not pace an operator-listed internal origin, but keeps pacing public endpoints in the same route', async () => {
    const c = clock();
    const starts: Array<[string, number]> = [];
    const router = createStopRouter({
      endpoints: () => ({ car: 'http://osrm-car:5000', bike: 'https://bike.example', foot: '' }), now: c.now, sleep: c.sleep,
      internalOrigins: new Set(['http://osrm-car:5000']),
      request: async (url) => { starts.push([new URL(url).host, c.now()]); c.advance(200); return respond(ok([[23, 37], [23.1, 37.1]])); },
    });
    await router.calculate(stops({}, {}, { profile: 'bike' }, {}, { profile: 'bike' }, {}));
    const car = starts.filter(([host]) => host === 'osrm-car:5000').map(([, at]) => at);
    const bike = starts.filter(([host]) => host === 'bike.example').map(([, at]) => at);
    expect([car.length, bike.length]).toEqual([3, 2]);
    expect(car[1]! - car[0]!).toBe(200); // back to back: no sleep before the second internal leg
    expect(bike[1]! - bike[0]!).toBeGreaterThanOrEqual(ROUTING_SPACING_MS);
  });

  it('runs one calculation at a time app-wide', async () => {
    const { promise: held, resolve } = Promise.withResolvers<void>();
    const router = createStopRouter({
      endpoints: () => ENDPOINTS,
      request: async () => { await held; return respond(ok([[23, 37], [23.1, 37.1]])); },
    });
    const first = router.calculate(stops({}, {}));
    await expect(router.calculate(stops({}, {}))).rejects.toMatchObject({ code: 'stop_route_busy', status: 429 });
    resolve();
    await expect(first).resolves.toMatchObject({ version: 1 });
  });

  it('turns legs past the overall budget into provider_error without requesting them', async () => {
    const c = clock();
    const request = vi.fn(async () => { c.advance(ROUTING_BUDGET_MS); return respond(ok([[23, 37], [23.1, 37.1]])); });
    const router = createStopRouter({ endpoints: () => ENDPOINTS, now: c.now, sleep: c.sleep, request });
    const stored = await router.calculate(stops({}, {}, {}));
    expect(request).toHaveBeenCalledTimes(1);
    expect(stored.legs[1]).toEqual({ profile: 'car', kind: 'straight', fallback: 'provider_error' });
  });

  // 3 × 100,000 positions (the provider cap): heavy by design, so it gets its own budget under a loaded suite.
  it('simplifies huge provider geometry until every public limit holds', { timeout: 30_000 }, async () => {
    const route = stops({ lat: 40, lng: -10 }, { lat: 40, lng: 10 }, { lat: 50, lng: 10 }, { lat: 50, lng: 30 });
    const zigzag = (from: RouteStop, to: RouteStop): [number, number][] => Array.from({ length: 100_000 }, (_, i) => {
      const t = i / 99_999;
      return [from.lng + (to.lng - from.lng) * t + (i % 2 ? 0.01 : -0.01), from.lat + (to.lat - from.lat) * t + (i % 3 ? 0.01 : -0.01)];
    });
    let leg = 0;
    const c = clock();
    const router = createStopRouter({
      endpoints: () => ENDPOINTS, now: c.now, sleep: c.sleep,
      request: async () => { const index = leg++; return respond(ok(zigzag(route[index]!, route[index + 1]!))); },
    });
    const stored = await router.calculate(route);
    const vertices = stored.route.runs.reduce((count, run) => count + run.coordinates.length, 0);
    expect(vertices).toBeLessThanOrEqual(2000);
    expect(new TextEncoder().encode(JSON.stringify(stored.route)).byteLength).toBeLessThanOrEqual(65536);
    expect(validatePublicStopRoute(stored.route)).toBe(stored.route);
  });

  it('splits straight and road legs at the antimeridian with interpolated ±180 boundary vertices', async () => {
    const route = stops({ lat: -16, lng: 179.5, profile: 'straight' }, { lat: -17, lng: -179.5 }, { lat: -16.5, lng: 179.6 });
    const c = clock();
    const router = createStopRouter({
      endpoints: () => ENDPOINTS, now: c.now, sleep: c.sleep,
      request: async () => respond(ok([[-179.5, -17], [-179.9, -16.8], [179.9, -16.6], [179.6, -16.5]])),
    });
    const stored = await router.calculate(route);
    expect(stored.route.runs.map((run) => [run.kind, run.coordinates[0], run.coordinates.at(-1)])).toEqual([
      ['straight', [179.5, -16], [180, -16.5]],
      ['straight', [-180, -16.5], [-179.5, -17]],
      ['road', [-179.5, -17], [-180, -16.7]],
      ['road', [180, -16.7], [179.6, -16.5]],
    ]);
    expect(validatePublicStopRoute(stored.route)).toBe(stored.route);
  });

  it('splitAntimeridian keeps continuous lines whole', () => {
    expect(splitAntimeridian([[10, 1], [20, 2], [30, 3]])).toEqual([[[10, 1], [20, 2], [30, 3]]]);
  });

  it('passes the safeFetch hardening options on every request', async () => {
    const seen: SafeFetchOptions[] = [];
    const router = createStopRouter({
      endpoints: () => ENDPOINTS,
      request: async (_url, opts) => { seen.push(opts ?? {}); return respond(ok([[23, 37], [23.1, 37.1]])); },
    });
    await router.calculate(stops({}, {}));
    expect(seen[0]).toMatchObject({ maxRedirects: 0, maxBytes: 4 * 1024 * 1024 });
    expect(seen[0]!.timeoutMs).toBeLessThanOrEqual(10_000);
  });
});
