import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer, type ServerConfig } from '../src/server.js';
import { defaultSettings, validate, type Settings, type SettingsStore } from '../src/settings.js';
import { memoryUserStore } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { memoryPostStore, type PostPair, type PostStore } from '../src/posts.js';
import { memoryPageStore } from '../src/pages.js';
import { memorySecretsStore } from '../src/secrets.js';
import { memoryMediaStore } from '../src/media-store.js';
import { createImportRunner, memoryImportJobStore } from '../src/import-jobs.js';
import { fixedWindowLimiter } from '../src/rate-limit.js';
import { createStopRouter, StopRoutingError, type StopRouter } from '../src/stop-routing.js';
import type { RouteStop, StoredStopRoute } from '../public/stop-route.js';
import type { UserStore } from '../src/users.js';
import type { SessionStore } from '../src/sessions.js';
import type { SiteBuilder } from '../src/build.js';
import type { DbBackup } from '../src/backup.js';
import type { EncodeQueue } from '../src/encode-queue.js';
import { idleBuildState } from './build-fixture.js';
import { TEST_TRUST } from './trusted-proxy-fixture.js';
import { ROUTE_STOPS, storedRouteFor } from './stop-route-fixture.js';

const ENDPOINTS = { routingCarUrl: 'https://car.example/routed-car', routingBikeUrl: 'https://bike.example', routingFootUrl: '' };

function settingsStore(init: Settings): SettingsStore {
  let current = { ...init };
  return { get: () => ({ ...current }), update: (partial) => { current = validate({ ...current, ...partial }); return { ...current }; } };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'stop-route-api-')); });

function build(extra: Partial<ServerConfig> = {}) {
  const users = memoryUserStore();
  const sessions = memorySessionStore();
  const posts = (extra.posts as PostStore | undefined) ?? memoryPostStore();
  const settings = extra.settings ?? settingsStore({ ...defaultSettings(), ...ENDPOINTS });
  const queue: EncodeQueue = {
    withAdmission: (_key, operation) => operation(), enqueue: () => {}, isActive: () => false, availableCapacity: () => 1,
    onCapacity: () => () => {}, recover: async () => 0, drain: async () => {}, quiesce: async () => {}, idle: async () => {},
    stats: () => ({ pending: 0, running: 0 }),
  };
  const builder: SiteBuilder = { ...idleBuildState, build: async () => ({ ok: true, attemptId: 'r1', release: 'r1' }), hasRelease: () => true, quiesce: async () => {} };
  const dbBackup: DbBackup = {
    dir, runNow: async () => ({}), running: () => false, sweepTempFiles: () => [], list: () => [], listImageArchives: () => [],
    listRouteArchives: () => [], quiesce: async () => {}, state: () => ({}),
  };
  const app = buildServer({
    trustProxy: TEST_TRUST, storageDir: dir, baseUrl: 'https://img.example', users, sessions, settings,
    secrets: memorySecretsStore(), posts, media: memoryMediaStore({ baseUrl: 'https://img.example' }), encodeQueue: queue,
    importJobs: createImportRunner({ store: memoryImportJobStore(), log: () => {} }), pages: memoryPageStore(posts.language),
    imgHost: 'img.example', siteDir: join(dir, 'site'), builder, backupDir: join(dir, 'backup'), dbBackup, dbCheck: async () => {},
    ...extra,
  });
  return { app, users, sessions, posts, settings };
}

async function login(b: { users: UserStore; sessions: SessionStore }, isAdmin = false, username = 'author') {
  const user = await b.users.create({ username, password: 'password123456', isAdmin });
  return { sid: await b.sessions.create(user.id, 60_000) };
}

async function story(posts: PostStore): Promise<string> {
  const loc = (locale: 'de' | 'en') => ({ locale, slug: `route-${locale}`, title: 'Route', excerpt: 'x', country: 'Greece',
    heroImage: { src: 'https://img.example/h', width: 768, height: 512, alt: 'a' }, bodyMarkdown: 'Text', images: {} });
  const pair: PostPair = { translationKey: '', status: 'draft',
    shared: { date: '2026-10-03', countryCode: 'GR', region: 'europe', coordinates: { lat: 38, lng: 23 }, stops: ROUTE_STOPS }, de: loc('de'), en: loc('en') };
  return (await posts.upsertDraft(pair)).translationKey;
}

/** A router double: records calls; returns a valid straight-only route for the given stops. */
function fakeRouter(behaviour: (stops: readonly RouteStop[]) => Promise<StoredStopRoute> = async (stops) => storedRouteFor([...stops])) {
  const calculate = vi.fn(behaviour);
  const router: StopRouter = { profiles: () => ({ car: true, bike: true, foot: false }), refusal: () => null, calculate };
  return { router, calculate };
}

describe('stop-route HTTP boundary (#513)', () => {
  let close: (() => Promise<unknown>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it('requires a session for both reads and calculations', async () => {
    const { router, calculate } = fakeRouter();
    const b = build({ stopRouter: router });
    close = () => b.app.close();
    const tk = await story(b.posts);
    expect((await b.app.inject({ url: `/posts/${tk}/stop-route` })).statusCode).toBe(401);
    expect((await b.app.inject({ method: 'POST', url: `/posts/${tk}/stop-route`, payload: { stops: ROUTE_STOPS } })).statusCode).toBe(401);
    expect(calculate).not.toHaveBeenCalled();
  });

  it('lets an author calculate and store a route; GET reports profile availability without URLs', async () => {
    const { router, calculate } = fakeRouter();
    const b = build({ stopRouter: router });
    close = () => b.app.close();
    const cookies = await login(b);
    const tk = await story(b.posts);
    const empty = await b.app.inject({ url: `/posts/${tk}/stop-route`, cookies });
    expect(empty.statusCode).toBe(200);
    expect(empty.headers['cache-control']).toBe('no-store');
    expect(empty.json()).toEqual({ profiles: { car: true, bike: true, foot: false }, route: null });
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/stop-route`, cookies, payload: { stops: ROUTE_STOPS } });
    expect(res.statusCode).toBe(200);
    expect(calculate).toHaveBeenCalledOnce();
    expect(res.json().route).toEqual(storedRouteFor(ROUTE_STOPS));
    expect(await b.posts.getStopRoute(tk)).toEqual(storedRouteFor(ROUTE_STOPS));
    const read = await b.app.inject({ url: `/posts/${tk}/stop-route`, cookies });
    expect(read.json().route).toEqual(storedRouteFor(ROUTE_STOPS));
    expect(read.body).not.toMatch(/car\.example|bike\.example/);
  });

  it.each([
    [{ stops: [ROUTE_STOPS[0]] }, 'stop_route_too_few'],
    [{ stops: Array.from({ length: 26 }, (_, i) => ({ name: `S${i}`, lat: i, lng: i })) }, 'stop_route_too_many'],
    [{ stops: [{ name: '', lat: 1, lng: 1 }, { name: 'B', lat: 2, lng: 2 }] }, 'stop_name_invalid'],
    [{ stops: [{ name: 'A', lat: 1, lng: 1, via: 'yes' }, { name: 'B', lat: 2, lng: 2 }] }, 'stop_via_invalid'],
    [{ stops: [{ name: 'A', lat: 1, lng: 1, profile: 'boat' }, { name: 'B', lat: 2, lng: 2 }] }, 'stop_profile_invalid'],
    [{}, 'stops_invalid'],
  ])('rejects %o with 400 %s and never calculates', async (payload, code) => {
    const { router, calculate } = fakeRouter();
    const b = build({ stopRouter: router });
    close = () => b.app.close();
    const tk = await story(b.posts);
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/stop-route`, cookies: await login(b), payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(code);
    expect(calculate).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown story without any outbound request', async () => {
    const { router, calculate } = fakeRouter();
    const b = build({ stopRouter: router });
    close = () => b.app.close();
    const res = await b.app.inject({ method: 'POST', url: '/posts/missing/stop-route', cookies: await login(b), payload: { stops: ROUTE_STOPS } });
    expect(res.statusCode).toBe(404);
    expect(calculate).not.toHaveBeenCalled();
  });

  it.each([
    [new StopRoutingError('stop_route_profile_unavailable', 409, ['foot']), 409, { code: 'stop_route_profile_unavailable', profiles: ['foot'] }],
    [new StopRoutingError('stop_route_busy', 429), 429, { code: 'stop_route_busy' }],
    [new StopRoutingError('stop_route_failed', 502), 502, { code: 'stop_route_failed' }],
    [new StopRoutingError('stop_route_empty', 422), 422, { code: 'stop_route_empty' }],
  ])('maps a failed calculation to its status and leaves the stored route unchanged', async (error, status, body) => {
    const { router } = fakeRouter(async () => { throw error; });
    const b = build({ stopRouter: router });
    close = () => b.app.close();
    const tk = await story(b.posts);
    const previous = storedRouteFor(ROUTE_STOPS, '2026-01-01T00:00:00.000Z');
    await b.posts.saveStopRoute(tk, previous);
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/stop-route`, cookies: await login(b), payload: { stops: ROUTE_STOPS } });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual(body);
    expect(await b.posts.getStopRoute(tk)).toEqual(previous);
  });

  it('rate-limits calculations per user', async () => {
    const { router, calculate } = fakeRouter();
    const b = build({ stopRouter: router, stopRouteLimiter: fixedWindowLimiter({ max: 2, windowMs: 60_000 }) });
    close = () => b.app.close();
    const tk = await story(b.posts);
    const cookies = await login(b);
    const post = () => b.app.inject({ method: 'POST', url: `/posts/${tk}/stop-route`, cookies, payload: { stops: ROUTE_STOPS } });
    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(200);
    const limited = await post();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ code: 'stop_route_rate_limited' });
    expect(limited.headers['retry-after']).toBeDefined();
    expect(calculate).toHaveBeenCalledTimes(2);
    const other = await login(b, false, 'other');
    expect((await b.app.inject({ method: 'POST', url: `/posts/${tk}/stop-route`, cookies: other, payload: { stops: ROUTE_STOPS } })).statusCode).toBe(200);
  });

  it('answers refusals that start nothing without spending a calculation', async () => {
    const { router, calculate } = fakeRouter();
    const refusals = [new StopRoutingError('stop_route_profile_unavailable', 409, ['foot']), new StopRoutingError('stop_route_busy', 429)];
    router.refusal = () => refusals.shift() ?? null;
    const b = build({ stopRouter: router, stopRouteLimiter: fixedWindowLimiter({ max: 1, windowMs: 60_000 }) });
    close = () => b.app.close();
    const tk = await story(b.posts);
    const cookies = await login(b);
    const post = () => b.app.inject({ method: 'POST', url: `/posts/${tk}/stop-route`, cookies, payload: { stops: ROUTE_STOPS } });
    expect((await post()).json()).toEqual({ code: 'stop_route_profile_unavailable', profiles: ['foot'] });
    const busy = await post();
    expect([busy.statusCode, busy.json(), busy.headers['retry-after']]).toEqual([429, { code: 'stop_route_busy' }, '5']);
    expect((await post()).statusCode).toBe(200);
    expect((await post()).json()).toEqual({ code: 'stop_route_rate_limited' });
    expect(calculate).toHaveBeenCalledOnce();
  });

  it('uses the Settings URLs live: clearing them disables routed legs before any request', async () => {
    const settings = settingsStore({ ...defaultSettings(), ...ENDPOINTS });
    const request = vi.fn();
    const b = build({ settings, stopRouter: createStopRouter({
      endpoints: () => ({ car: settings.get().routingCarUrl, bike: settings.get().routingBikeUrl, foot: settings.get().routingFootUrl }), request,
    }) });
    close = () => b.app.close();
    const admin = await login(b, true, 'admin');
    const cleared = await b.app.inject({ method: 'POST', url: '/settings', cookies: admin, payload: { routingCarUrl: '', routingBikeUrl: '' } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ routingCarUrl: '', routingBikeUrl: '', routingFootUrl: '' });
    const tk = await story(b.posts);
    const res = await b.app.inject({ method: 'POST', url: `/posts/${tk}/stop-route`, cookies: admin, payload: { stops: ROUTE_STOPS } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'stop_route_profile_unavailable', profiles: ['car', 'bike'] });
    expect(request).not.toHaveBeenCalled();
    expect(await b.posts.getStopRoute(tk)).toBeNull();
  });

  it.each([
    ['http://osrm.example', 400], ['https://user:pw@osrm.example', 400], ['https://osrm.example/?x=1', 400],
    ['https://osrm.example/routed-car', 200], ['', 200],
  ])('validates routing URL %s in Settings (admin only)', async (url, status) => {
    const b = build();
    close = () => b.app.close();
    expect((await b.app.inject({ method: 'POST', url: '/settings', cookies: await login(b), payload: { routingCarUrl: url } })).statusCode).toBe(403);
    const res = await b.app.inject({ method: 'POST', url: '/settings', cookies: await login(b, true, 'admin'), payload: { routingCarUrl: url } });
    expect(res.statusCode).toBe(status);
    if (status === 400) expect(res.body).not.toContain(url);
  });

  it.each([
    ['http://osrm-car:5000', 200], ['http://osrm-car:5000/', 200], ['http://osrm-car:5001', 400],
    ['http://osrm-bike:5000', 400], ['http://db:5432', 400],
  ])('accepts plain-HTTP routing URL %s only for a ROUTING_INTERNAL_ORIGINS origin', async (url, status) => {
    const b = build({ routingInternalOrigins: new Set(['http://osrm-car:5000']) });
    close = () => b.app.close();
    const res = await b.app.inject({ method: 'POST', url: '/settings', cookies: await login(b, true, 'admin'), payload: { routingCarUrl: url } });
    expect(res.statusCode).toBe(status);
    if (status === 400) expect(res.body).not.toContain(url);
    else expect(b.settings.get().routingCarUrl).toBe(url);
  });

  it('does not let a stale stored plain-HTTP routing URL block an unrelated settings save', async () => {
    const b = build({ settings: settingsStore({ ...defaultSettings(), ...ENDPOINTS, routingFootUrl: 'http://osrm-foot:5000' }) });
    close = () => b.app.close();
    const res = await b.app.inject({ method: 'POST', url: '/settings', cookies: await login(b, true, 'admin'), payload: { routingCarUrl: '' } });
    expect(res.statusCode).toBe(200);
  });

  it("answers with the story country's bundled region state and its per-story profiles, and asks for that region", async () => {
    const sync = vi.fn(async () => {});
    const b = build({
      settings: settingsStore({ ...defaultSettings(), routingCarUrl: '', routingBikeUrl: '', routingFootUrl: '' }),
      routingInternalOrigins: new Set(['http://osrm:5100', 'http://osrm:5101']),
      bundledRouting: {
        sync,
        endpoints: (code) => (code === 'GR' ? { car: 'http://osrm:5100', bike: 'http://osrm:5101' } : {}),
        view: (code) => (code === 'GR' ? { state: 'preparing', region: 'greece' } : { state: 'unsupported', region: null }),
      },
    });
    close = () => b.app.close();
    const tk = await story(b.posts); // countryCode GR
    const res = await b.app.inject({ method: 'GET', url: `/posts/${tk}/stop-route`, cookies: await login(b) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ profiles: { car: true, bike: true, foot: false }, route: null, bundled: { state: 'preparing', region: 'greece' } });
    expect(res.body).not.toContain('osrm:51');
    expect(sync).toHaveBeenCalled();
    const refused = await b.app.inject({ method: 'POST', url: `/posts/${tk}/stop-route`, cookies: await login(b, false, 'second'),
      payload: { stops: ROUTE_STOPS.map((stop, index) => (index === 0 ? { ...stop, profile: 'foot' } : stop)) } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ code: 'stop_route_profile_unavailable', profiles: ['foot'], bundled: { state: 'preparing', region: 'greece' } });
  });

  it('adds no bundled field when the install has no bundled routing', async () => {
    const b = build();
    close = () => b.app.close();
    const tk = await story(b.posts);
    const res = await b.app.inject({ method: 'GET', url: `/posts/${tk}/stop-route`, cookies: await login(b) });
    expect(Object.keys(res.json()).sort()).toEqual(['profiles', 'route']);
  });

  it('defaults every routing URL to empty: no routing service is shipped', () => {
    const defaults = defaultSettings();
    expect([defaults.routingCarUrl, defaults.routingBikeUrl, defaults.routingFootUrl]).toEqual(['', '', '']);
  });

  it('serves the editor copy from both dictionaries', async () => {
    const b = build();
    close = () => b.app.close();
    const res = await b.app.inject({ url: '/admin/stop-route-copy.js' });
    expect(res.statusCode).toBe(200);
    const sandbox: { window: { StopRouteCopy?: Record<string, Record<string, string>> } } = { window: {} };
    new Function('window', res.body)(sandbox.window);
    expect(Object.keys(sandbox.window.StopRouteCopy!)).toEqual(['de', 'en']);
    expect(Object.keys(sandbox.window.StopRouteCopy!.de!).sort()).toEqual(Object.keys(sandbox.window.StopRouteCopy!.en!).sort());
  });
});
