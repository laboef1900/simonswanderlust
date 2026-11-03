import { describe, expect, it } from 'vitest';
import { memoryPostStore, PostError, validateDraft, freshStopRoute, type PostPair, type PostStore } from '../src/posts.js';
import { renderPostToMdx } from '../src/export.js';
import { stopRouteBasis, stopRouteFingerprint, type RouteStop } from '../public/stop-route.js';
import { stopRouteFingerprintSync } from '../src/stop-route-fingerprint.js';
import { publishTokens } from './publish-tokens.js';
import { ROUTE_STOPS, storedRouteFor } from './stop-route-fixture.js';

function pair(stops: RouteStop[] = ROUTE_STOPS): PostPair {
  const loc = (locale: 'de' | 'en') => ({
    locale, slug: `route-${locale}`, title: 'Route', excerpt: 'x', country: 'Greece',
    heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'a' }, bodyMarkdown: '## Hi', images: {},
  });
  return {
    translationKey: '', status: 'draft',
    shared: { date: '2026-10-03', countryCode: 'GR', region: 'europe', coordinates: { lat: 38, lng: 23 }, stops },
    de: loc('de'), en: loc('en'),
  };
}

async function publishedStopRoute(store: PostStore, tk: string) {
  return (await store.getPublishedTrack(tk)).stopRoute;
}

describe('stop routing fields (#513)', () => {
  it('canonicalizes via/profile on save: false/car/last-stop values become absent keys', async () => {
    const store = memoryPostStore();
    const saved = await store.upsertDraft(pair([
      { name: 'A', lat: 1, lng: 1, via: false, profile: 'car' },
      { name: 'B', lat: 2, lng: 2, via: true, profile: 'foot' },
      { name: 'C', lat: 3, lng: 3, profile: 'bike' },
    ] as RouteStop[]));
    expect(saved.shared.stops).toEqual([
      { name: 'A', lat: 1, lng: 1 },
      { name: 'B', lat: 2, lng: 2, via: true, profile: 'foot' },
      { name: 'C', lat: 3, lng: 3 },
    ]);
  });

  it.each([
    [{ via: 'yes' }, 'shared.stops[0].via must be a boolean'],
    [{ profile: 'boat' }, 'shared.stops[0].profile must be one of car, bike, foot, straight'],
  ])('refuses a malformed routing field %o at draft save', (field, message) => {
    const input = pair([{ name: 'A', lat: 1, lng: 1, ...field } as unknown as RouteStop, { name: 'B', lat: 2, lng: 2 }]);
    expect(() => validateDraft(input)).toThrow(message);
  });

  it('hashes the same basis in the browser (SubtleCrypto) and on the server, ignoring names', async () => {
    const renamed = ROUTE_STOPS.map((stop) => ({ ...stop, name: `${stop.name} (renamed)` }));
    expect(await stopRouteFingerprint(ROUTE_STOPS)).toBe(stopRouteFingerprintSync(ROUTE_STOPS));
    expect(stopRouteFingerprintSync(renamed)).toBe(stopRouteFingerprintSync(ROUTE_STOPS));
    expect(stopRouteBasis(ROUTE_STOPS)).not.toMatch(/Athens/);
  });
});

describe('stored stop route and Publish (memory store, #513)', () => {
  it('publishes a fresh route, omits it once any routing input changes, and republishes after recalculation', async () => {
    const store = memoryPostStore();
    const saved = await store.upsertDraft(pair());
    const tk = saved.translationKey;
    const before = (await store.get(tk))!.updatedAt;
    await store.saveStopRoute(tk, storedRouteFor(ROUTE_STOPS));
    expect((await store.get(tk))!.updatedAt).toEqual(before);
    const first = await store.publish(tk, await publishTokens(store, tk));
    expect(first.stopRoute).toBe('published');
    expect(await publishedStopRoute(store, tk)).toEqual(storedRouteFor(ROUTE_STOPS).route);

    const edits: [string, (stops: RouteStop[]) => RouteStop[]][] = [
      ['coordinate', (s) => s.map((stop, i) => i === 2 ? { ...stop, lat: stop.lat + 0.01 } : stop)],
      ['reorder', (s) => [s[0]!, s[2]!, s[1]!, s[3]!]],
      ['via toggle', (s) => s.map((stop, i) => i === 1 ? { name: stop.name, lat: stop.lat, lng: stop.lng } : stop)],
      ['profile', (s) => s.map((stop, i) => i === 0 ? { ...stop, profile: 'foot' as const } : stop)],
      ['remove', (s) => s.slice(0, 3)],
    ];
    for (const [, edit] of edits) {
      const current = (await store.get(tk))!;
      await store.upsertDraft({ ...current, shared: { ...current.shared, stops: edit(ROUTE_STOPS) } }, current.updatedAt);
      const result = await store.publish(tk, await publishTokens(store, tk));
      expect(result.stopRoute).toBe('stale');
      expect(await publishedStopRoute(store, tk)).toBeUndefined();
    }
    // A rename alone keeps the route fresh.
    const current = (await store.get(tk))!;
    const renamed = ROUTE_STOPS.map((stop) => ({ ...stop, name: `${stop.name}!` }));
    await store.upsertDraft({ ...current, shared: { ...current.shared, stops: renamed } }, current.updatedAt);
    expect((await store.publish(tk, await publishTokens(store, tk))).stopRoute).toBe('published');
    expect(await publishedStopRoute(store, tk)).toEqual(storedRouteFor(ROUTE_STOPS).route);
  });

  it('reports none without a stored route and never blocks Publish', async () => {
    const store = memoryPostStore();
    const { translationKey: tk } = await store.upsertDraft(pair());
    expect(await store.getStopRoute(tk)).toBeNull();
    expect((await store.publish(tk, await publishTokens(store, tk))).stopRoute).toBe('none');
  });

  it('flags draftDiffers when a recalculated route would change the published one, and clears it on Publish', async () => {
    const store = memoryPostStore();
    const { translationKey: tk } = await store.upsertDraft(pair());
    await store.publish(tk, await publishTokens(store, tk));
    expect((await store.get(tk))!.publication).toMatchObject({ draftDiffers: false });
    await store.saveStopRoute(tk, storedRouteFor(ROUTE_STOPS));
    expect((await store.get(tk))!.publication).toMatchObject({ draftDiffers: true });
    await store.publish(tk, await publishTokens(store, tk));
    expect((await store.get(tk))!.publication).toMatchObject({ draftDiffers: false });
  });

  it('rejects an invalid route or an unknown pair and keeps the previous value', async () => {
    const store = memoryPostStore();
    const { translationKey: tk } = await store.upsertDraft(pair());
    const valid = storedRouteFor(ROUTE_STOPS);
    await store.saveStopRoute(tk, valid);
    const invalid = { ...valid, route: { version: 1, runs: [] } } as unknown as typeof valid;
    await expect(store.saveStopRoute(tk, invalid)).rejects.toMatchObject({ code: 'invalid_stop_route' });
    await expect(store.saveStopRoute('missing', valid)).rejects.toBeInstanceOf(PostError);
    await expect(store.getStopRoute('missing')).rejects.toMatchObject({ code: 'not_found' });
    expect(await store.getStopRoute(tk)).toEqual(valid);
  });

  it('treats single-stop, leg-count-mismatched or corrupt stored values as not fresh', () => {
    const route = storedRouteFor(ROUTE_STOPS);
    expect(freshStopRoute(ROUTE_STOPS, route)).toEqual(route);
    expect(freshStopRoute(ROUTE_STOPS.slice(0, 1), route)).toBeNull();
    expect(freshStopRoute(ROUTE_STOPS, { ...route, legs: route.legs.slice(1) })).toBeNull();
    expect(freshStopRoute(ROUTE_STOPS, { ...route, fingerprint: 'x' })).toBeNull();
    expect(freshStopRoute(ROUTE_STOPS, null)).toBeNull();
  });

  it('exports via/profile in stops and the published stopRoute to MDX', async () => {
    const store = memoryPostStore();
    const { translationKey: tk } = await store.upsertDraft(pair());
    await store.saveStopRoute(tk, storedRouteFor(ROUTE_STOPS));
    await store.publish(tk, await publishTokens(store, tk));
    const stored = (await store.get(tk))!;
    const projection = await store.getPublishedTrack(tk);
    const mdx = await renderPostToMdx(stored, 'en', projection.track, projection.stopRoute);
    const frontmatter = Object.fromEntries(mdx.split('\n').filter((line) => /^(stops|stopRoute): /.test(line))
      .map((line) => [line.slice(0, line.indexOf(':')), JSON.parse(line.slice(line.indexOf(':') + 2))]));
    expect(frontmatter.stops).toEqual(ROUTE_STOPS);
    expect(frontmatter.stopRoute).toEqual(storedRouteFor(ROUTE_STOPS).route);
  });
});
