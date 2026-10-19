import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// gallery-library.js is the editor's read-only view of current Media rows for
// gallery photos (docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md).
// Run the real browser IIFEs (media-api.js's client included) in a vm sandbox.
const scripts = ['media-api', 'gallery-library'].map((name) => readFileSync('public/' + name + '.js', 'utf8'));

interface Row { key: string; src: string; title: string; alt: { de: string; en: string }; caption: { de: string; en: string } }
type Entry = { row?: Row; missing?: true; error?: unknown };
interface Library {
  lookup(srcs: string[], options?: { fresh?: boolean }): Promise<Map<string, Entry>>;
  peek(src: string): Entry | undefined;
  forget(): void;
}
interface Api {
  create(options: { client: unknown; imageOrigin: string; concurrency?: number }): Library;
  describe(row: Row, locale: 'de' | 'en'): { alt: string; caption: string; title: string; key: string };
}

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

function setup(options: { base?: string; rows?: Row[]; respond?: (url: string) => Promise<Response> | undefined; concurrency?: number } = {}) {
  const base = options.base ?? 'https://img.example';
  const rows = options.rows ?? [];
  const requests: { url: string; method: string }[] = [];
  const fetch = (url: string, init: RequestInit = {}) => {
    requests.push({ url, method: init.method ?? 'GET' });
    const custom = options.respond?.(url);
    if (custom) return custom;
    if (url.startsWith('/media?')) return Promise.resolve(response({ total: rows.length, items: rows.slice(0, 1) }));
    const row = rows.find((candidate) => url === '/media/items/' + candidate.key);
    return Promise.resolve(row ? response(row) : response({ error: 'image not found' }, 404));
  };
  const ctx: Record<string, unknown> = { fetch, URL };
  ctx.window = ctx;
  vm.createContext(ctx);
  scripts.forEach((script) => vm.runInContext(script, ctx));
  // vm globals are untyped: these are the browser IIFEs evaluated just above.
  const mediaApi = ctx.MediaApi as { makeClient(options: object): unknown };
  const api = ctx.GalleryLibrary as Api;
  const library = api.create({ client: mediaApi.makeClient({}), imageOrigin: new URL(base).origin, concurrency: options.concurrency });
  return { api, library, requests, base };
}

const row = (base: string, key: string, alt = { de: 'Berg', en: 'Mountain' }, caption = { de: '', en: 'Morning' }): Row =>
  ({ key, src: base + '/' + key, title: 'Ridge', alt, caption });

describe('GalleryLibrary', () => {
  it('finds rows under an image base with a path, by exact URL, and reports others as missing', async () => {
    const base = 'https://img.example/images';
    const rows = [row(base, 'trips/a'), row(base, 'trips/b')];
    const { library, requests } = setup({ base, rows });
    const entries = await library.lookup([base + '/trips/a', base + '/trips/none', 'https://img.example/trips/a']);
    expect(entries.get(base + '/trips/a')?.row?.alt).toEqual({ de: 'Berg', en: 'Mountain' });
    expect(entries.get(base + '/trips/none')).toEqual({ missing: true });
    // Same origin, outside the base: no row can have this URL, so nothing is asked.
    expect(entries.get('https://img.example/trips/a')).toEqual({ missing: true });
    expect(requests.map((request) => request.url)).toEqual(['/media?page=1&pageSize=1', '/media/items/trips/a', '/media/items/trips/none']);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('never turns a foreign, credentialed, query-bearing or traversing URL into a request', async () => {
    const { library, requests, base } = setup({ rows: [row('https://img.example', 'a')] });
    const hostile = [
      'https://evil.example/a', 'https://user:pw@img.example/a', base + '/a?x=1', base + '/a#frag',
      base + '/trips/../settings', base + '/trips//a', base + '/Upper', base + '/a b', 'not a url',
    ];
    const entries = await library.lookup(hostile);
    expect([...entries.values()]).toEqual(hostile.map(() => ({ missing: true })));
    expect(requests.map((request) => request.url)).toEqual(['/media?page=1&pageSize=1']);
  });

  it('treats an empty library as "no rows" without further requests', async () => {
    const { library, requests, base } = setup();
    expect((await library.lookup([base + '/a'])).get(base + '/a')).toEqual({ missing: true });
    expect(requests).toHaveLength(1);
  });

  it('asks once per URL, however many galleries ask at the same time, and caches settled answers', async () => {
    const base = 'https://img.example';
    const { library, requests } = setup({ rows: [row(base, 'a')] });
    const [first, second] = await Promise.all([library.lookup([base + '/a', base + '/a']), library.lookup([base + '/a'])]);
    expect(first.get(base + '/a')).toEqual(second.get(base + '/a'));
    expect(library.peek(base + '/a')?.row?.key).toBe('a');
    await library.lookup([base + '/a']);
    expect(requests.filter((request) => request.url === '/media/items/a')).toHaveLength(1);
    await library.lookup([base + '/a'], { fresh: true });
    expect(requests.filter((request) => request.url === '/media/items/a')).toHaveLength(2);
  });

  it('reports a failure without caching it, so the next lookup retries', async () => {
    const base = 'https://img.example';
    let failing = true;
    const { library } = setup({ rows: [row(base, 'a')],
      respond: (url) => failing && url.startsWith('/media/items/') ? Promise.resolve(response({ error: 'boom' }, 500)) : undefined });
    expect((await library.lookup([base + '/a'])).get(base + '/a')?.error).toBeDefined();
    expect(library.peek(base + '/a')).toBeUndefined();
    failing = false;
    expect((await library.lookup([base + '/a'])).get(base + '/a')?.row?.key).toBe('a');
  });

  it('drops a late answer from before forget(), so a reload cannot show stale descriptions', async () => {
    const base = 'https://img.example';
    const late = Promise.withResolvers<Response>();
    let calls = 0;
    const { library } = setup({ rows: [row(base, 'a')],
      respond: (url) => url.startsWith('/media/items/') && ++calls === 1 ? late.promise : undefined });
    const stale = library.lookup([base + '/a']);
    await settle();
    library.forget();
    const fresh = await library.lookup([base + '/a']);
    late.resolve(response(row(base, 'a', { de: 'Veraltet', en: 'Stale' })));
    await stale;
    expect(fresh.get(base + '/a')?.row?.alt.de).toBe('Berg');
    expect(library.peek(base + '/a')?.row?.alt.de).toBe('Berg');
  });

  it('bounds concurrent item requests', async () => {
    const base = 'https://img.example';
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const pending: PromiseWithResolvers<Response>[] = [];
    const { library } = setup({ rows: keys.map((key) => row(base, key)), concurrency: 2,
      respond: (url) => {
        if (!url.startsWith('/media/items/')) return undefined;
        const deferred = Promise.withResolvers<Response>();
        pending.push(deferred);
        return deferred.promise;
      } });
    const result = library.lookup(keys.map((key) => base + '/' + key));
    await settle();
    expect(pending).toHaveLength(2);
    for (let answered = 0; answered < keys.length; answered++) {
      // Never more than two in flight: answered + 2 started, capped at the total.
      expect(pending).toHaveLength(Math.min(keys.length, answered + 2));
      pending[answered]!.resolve(response({ error: 'image not found' }, 404));
      await settle();
    }
    expect([...(await result).values()]).toEqual(keys.map(() => ({ missing: true })));
  });

  it('describes one locale only, with the title as a label and never as alt', () => {
    const { api } = setup();
    expect(api.describe(row('https://img.example', 'trips/a', { de: '', en: 'Mountain' }), 'de'))
      .toEqual({ alt: '', caption: '', title: 'Ridge', key: 'trips/a' });
  });
});
