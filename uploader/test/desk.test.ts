import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ui } from '../../site/src/i18n/ui.js';
import { publication, loadPublicationState, type AvailablePublication } from './publication-client-fixture.js';

const src = readFileSync('public/desk.js', 'utf8');
interface Post {
  status: 'draft' | 'published';
  updatedAt: string;
  publication: AvailablePublication;
  translationKey: string;
}
interface SectionView<T> {
  loading(): void;
  ready(value: T): void;
  unavailable(): void;
}
interface Api {
  nextDraft(posts: Post[]): Post | null;
  unpublished(posts: Post[]): Post[];
  publicationOverview(value: unknown): { state: 'clear' | 'attention' | 'unavailable'; message: string; items: string[] };
  encodeCount(stats: { pending?: number; running?: number } | null): number | null;
  releaseState(health: unknown): boolean | null;
  releaseFromResponse(response: { status: number; ok: boolean; json(): Promise<unknown> }): Promise<boolean>;
  resilientLoader<T>(load: () => Promise<T>, view: SectionView<T>): () => Promise<void>;
}

function load(locale: 'de' | 'en' = 'en'): Api {
  const ctx: Record<string, unknown> = {
    EditorCopy: { en: Object.fromEntries(Object.entries(ui.en).filter(([key]) => key.startsWith('editor.chrome.')).map(([key, value]) => [key.slice('editor.chrome.'.length), value])) },
    PublicationState: loadPublicationState({ document: { documentElement: { lang: locale } } }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  // VM exports lose their static browser type.
  const api = ctx.Desk as Api;
  return api;
}

const post = (o: Partial<Post>): Post => ({
  translationKey: 'tk', status: 'draft', updatedAt: '2025-01-01T00:00:00.000Z',
  publication: publication(o.status || 'draft'), ...o,
});

describe('Desk.nextDraft', () => {
  const api = load();

  it('returns the most recently updated draft', () => {
    const older = post({ translationKey: 'old', updatedAt: '2024-01-01T00:00:00.000Z' });
    const newer = post({ translationKey: 'new', updatedAt: '2025-06-01T00:00:00.000Z' });
    const live = post({ translationKey: 'live', status: 'published', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(api.nextDraft([older, live, newer])?.translationKey).toBe('new');
  });

  it('returns null when there are no drafts', () => {
    expect(api.nextDraft([post({ status: 'published' })])).toBeNull();
    expect(api.nextDraft([])).toBeNull();
  });
});

describe('Desk.unpublished', () => {
  const api = load();

  it('lists published pairs with unpublished edits, newest first', () => {
    const a = post({ translationKey: 'a', status: 'published', publication: publication('published', true), updatedAt: '2024-01-01T00:00:00.000Z' });
    const b = post({ translationKey: 'b', status: 'published', publication: publication('published', true), updatedAt: '2025-01-01T00:00:00.000Z' });
    const clean = post({ translationKey: 'c', status: 'published' });
    expect(api.unpublished([a, clean, b]).map((p) => p.translationKey)).toEqual(['b', 'a']);
  });
});

describe('Desk publication overview', () => {
  const known = () => ({
    availability: 'available', release: 'known',
    posts: { notLive: 0, olderVersionLive: 0, unexpectedLocaleLive: 0, unpublishedStillLive: 0, deletedStillLive: 0 },
    galleryDescriptions: { photos: 0, stories: 0 },
  });

  it('only reports no differences for a complete, known zero-count observation', () => {
    expect(load().publicationOverview(known())).toMatchObject({ state: 'clear', items: [] });
    for (const value of [null, {}, { ...known(), availability: 'unavailable' },
      { ...known(), release: 'none' }, { ...known(), release: 'unknown' },
      { ...known(), posts: null }, { ...known(), galleryDescriptions: { photos: 0 } }]) {
      expect(load().publicationOverview(value)).toMatchObject({ state: 'unavailable', items: [] });
    }
  });

  it.each(['notLive', 'olderVersionLive', 'unexpectedLocaleLive', 'unpublishedStillLive', 'deletedStillLive'] as const)(
    'keeps the nonzero %s category visible without reporting unrelated zero counts', (key) => {
      const value = known();
      value.posts[key] = 3;
      const result = load().publicationOverview(value);
      expect(result.state).toBe('attention');
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toContain('3');
      expect(result.items[0]).not.toContain(': 0');
    },
  );

  it('does not add overlapping story categories and retains media-only differences', () => {
    const value = known();
    value.posts.notLive = 2;
    value.posts.deletedStillLive = 2;
    value.galleryDescriptions = { photos: 5, stories: 1 };
    const result = load().publicationOverview(value);
    expect(result.state).toBe('attention');
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatch(/not yet live: 2/);
    expect(result.items[1]).toMatch(/Deleted.*: 2/);
    expect(result.items[2]).toMatch(/photos: 5; stories: 1/);
    value.posts.notLive = value.posts.deletedStillLive = 0;
    expect(load().publicationOverview(value)).toMatchObject({ state: 'attention', items: [result.items[2]] });
  });

  it.each([undefined, -1, 0.5, NaN, Infinity, '0'])('never turns an invalid count (%s) into an all-clear', (count) => {
    const value = known();
    expect(load().publicationOverview({ ...value, posts: { ...value.posts, notLive: count } }).state).toBe('unavailable');
    expect(load().publicationOverview({ ...value, galleryDescriptions: { photos: count, stories: 0 } }).state).toBe('unavailable');
  });
});

describe('Desk status interpretation', () => {
  const api = load();

  it('counts pending and running photos without turning unknown data into idle', () => {
    expect(api.encodeCount({ pending: 2, running: 1 })).toBe(3);
    expect(api.encodeCount({ pending: 0, running: 0 })).toBe(0);
    expect(api.encodeCount(null)).toBeNull();
    expect(api.encodeCount({ pending: 0 })).toBeNull();
    expect(api.encodeCount({ pending: -1, running: 0 })).toBeNull();
  });

  it('uses the release verdict carried by health even when its DB probe is 503', async () => {
    expect(api.releaseState({ release: true })).toBe(true);
    expect(api.releaseState({ release: false })).toBe(false);
    expect(api.releaseState({})).toBeNull();
    expect(api.releaseState(null)).toBeNull();
    await expect(api.releaseFromResponse({
      status: 503,
      ok: false,
      json: async () => ({ release: true }),
    })).resolves.toBe(true);
    await expect(api.releaseFromResponse({
      status: 500,
      ok: false,
      json: async () => ({ error: 'internal server error' }),
    })).rejects.toThrow();
  });
});

describe('Desk.resilientLoader', () => {
  const api = load();

  it('lets successful sections render when an independent section fails', async () => {
    const outcomes: string[] = [];
    const section = <T>(name: string, task: () => Promise<T>) => api.resilientLoader(task, {
      loading: () => outcomes.push(`${name}:loading`),
      ready: () => outcomes.push(`${name}:ready`),
      unavailable: () => outcomes.push(`${name}:unavailable`),
    });
    const posts = section('posts', async () => []);
    const queue = section('queue', async () => { throw new Error('offline'); });
    const release = section('release', async () => true);

    await Promise.all([posts(), queue(), release()]);

    expect(outcomes).toContain('posts:ready');
    expect(outcomes).toContain('release:ready');
    expect(outcomes).toContain('queue:unavailable');
    expect(outcomes).not.toContain('posts:unavailable');
  });

  it('recovers locally on retry without exposing the exception to the view', async () => {
    let attempts = 0;
    const states: string[] = [];
    const run = api.resilientLoader(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('sensitive internal detail');
        return 4;
      },
      {
        loading: () => states.push('loading'),
        ready: (value) => states.push(`ready:${value}`),
        unavailable: function () {
          expect(arguments).toHaveLength(0);
          states.push('unavailable');
        },
      },
    );

    await run();
    await run();

    expect(states).toEqual(['loading', 'unavailable', 'loading', 'ready:4']);
  });

  it('coalesces a double retry so a stale request cannot race a newer one', async () => {
    let requests = 0;
    let finish!: (value: number) => void;
    const pending = new Promise<number>((resolve) => { finish = resolve; });
    const states: string[] = [];
    const run = api.resilientLoader(
      async () => {
        requests += 1;
        return pending;
      },
      {
        loading: () => states.push('loading'),
        ready: (value) => states.push(`ready:${value}`),
        unavailable: () => states.push('unavailable'),
      },
    );

    const first = run();
    const second = run();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(requests).toBe(1);
    finish(7);
    await first;

    expect(requests).toBe(1);
    expect(states).toEqual(['loading', 'ready:7']);
  });
});
