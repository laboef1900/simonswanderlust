import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// posts-filter.js is a plain browser IIFE (window.PostsFilter) holding the
// posts list's pure search/filter/sort and thumbnail-URL logic. Run it in a vm
// sandbox — same precedent as draft-guard.js in admin-pages.test.ts — so the
// behaviour is covered without a browser (Golden Rule 1: inline page script is
// untestable, so the logic does not live inline).
const src = readFileSync('public/posts-filter.js', 'utf8');

interface Summary {
  translationKey: string; titleDe: string; slugDe: string; slugEn: string;
  status: 'draft' | 'published'; updatedAt: string; hasUnpublishedChanges: boolean;
  hasEnBody: boolean; heroSrc: string; heroWidth: number; heroFormat?: 'jpeg';
  date: string; country: string; region: string;
}
interface Api {
  REGIONS: string[];
  apply(posts: Summary[], opts: Record<string, string>): Summary[];
  countries(posts: Summary[]): string[];
  extraFilterCount(opts: Record<string, string>): number;
  fromSearch(search: string, countries: string[]): Record<string, string>;
  thumbUrl(post: { heroSrc?: unknown; heroWidth?: unknown; heroFormat?: unknown }): string | null;
  toSearch(opts: Record<string, string>): string;
}

function load(): Api {
  const windowStub: { PostsFilter?: Api } = {};
  vm.runInNewContext(src, { window: windowStub, URLSearchParams });
  if (!windowStub.PostsFilter) throw new Error('posts-filter.js did not assign window.PostsFilter');
  return windowStub.PostsFilter;
}

const post = (o: Partial<Summary>): Summary => ({
  translationKey: 'tk', titleDe: 'Titel', slugDe: 'slug-de', slugEn: 'slug-en',
  status: 'draft', updatedAt: '2025-01-01T00:00:00.000Z', hasUnpublishedChanges: false,
  hasEnBody: true, heroSrc: 'https://img/h', heroWidth: 1600,
  date: '2024-05-01', country: 'Rumänien', region: 'europe', ...o,
});

describe('PostsFilter.thumbUrl', () => {
  const api = load();

  it('picks the 640 variant for a hero at or above 640px wide', () => {
    expect(api.thumbUrl(post({ heroSrc: 'https://img/h', heroWidth: 1600 }))).toBe('https://img/h-640.webp');
    expect(api.thumbUrl(post({ heroWidth: 640 }))).toBe('https://img/h-640.webp');
  });

  it('picks the intrinsic width below 640 — variantWidths never upscales, so -640 does not exist', () => {
    expect(api.thumbUrl(post({ heroWidth: 500 }))).toBe('https://img/h-500.webp');
    expect(api.thumbUrl(post({ heroWidth: 639 }))).toBe('https://img/h-639.webp');
  });

  it('uses the exact .jpeg suffix for a JPEG-only hero', () => {
    expect(api.thumbUrl(post({ heroFormat: 'jpeg' }))).toBe('https://img/h-640.jpeg');
  });

  it('fails closed on an unknown format hint', () => {
    expect(api.thumbUrl({ heroSrc: 'https://img/h', heroWidth: 1600, heroFormat: 'jpg' })).toBeNull();
  });

  it('returns null for the empty-src draft placeholder', () => {
    // Two independent sources of this: PLACEHOLDER_HERO in posts.ts and
    // another in wp-import.ts. Emitting `<img src="-640.webp">` would 404.
    expect(api.thumbUrl(post({ heroSrc: '', heroWidth: 0 }))).toBeNull();
  });

  it('returns null for a width that is not a positive integer (heroWidth is unverified jsonb)', () => {
    for (const heroWidth of [0, -1, 1.5, NaN, Infinity, '640', null, undefined]) {
      expect(api.thumbUrl(post({ heroWidth: heroWidth as unknown as number }))).toBeNull();
    }
  });
});

describe('PostsFilter.countries', () => {
  const api = load();

  it('derives a sorted, de-duplicated list from the loaded rows', () => {
    const list = api.countries([
      post({ country: 'Rumänien' }), post({ country: 'Island' }),
      post({ country: 'Rumänien' }), post({ country: '' }),
    ]);
    expect(list).toEqual(['Island', 'Rumänien']);
  });

  it('is not confused by a country literally named like an Object prototype key', () => {
    expect(api.countries([post({ country: 'constructor' }), post({ country: 'constructor' })]))
      .toEqual(['constructor']);
  });
});

describe('PostsFilter.apply — filtering', () => {
  const api = load();
  const posts = [
    post({ translationKey: 'a', titleDe: 'Bukarest', country: 'Rumänien', region: 'europe', status: 'published' }),
    post({ translationKey: 'b', titleDe: 'Reykjavík', slugDe: 'island-2023', country: 'Island', region: 'europe', status: 'draft' }),
    post({ translationKey: 'c', titleDe: 'Patagonien', country: 'Chile', region: 'south-america', status: 'draft' }),
  ];
  const keys = (r: Summary[]) => r.map((p) => p.translationKey);

  it('returns everything for empty options', () => {
    expect(api.apply(posts, {})).toHaveLength(3);
  });

  it('searches title, both slugs and country, case-insensitively', () => {
    expect(keys(api.apply(posts, { q: 'buka' }))).toEqual(['a']);
    expect(keys(api.apply(posts, { q: 'ISLAND-2023' }))).toEqual(['b']);
    expect(keys(api.apply(posts, { q: 'chile' }))).toEqual(['c']);
    expect(keys(api.apply(posts, { q: '  buka  ' }))).toEqual(['a']);
  });

  it('filters by status, region and country', () => {
    expect(keys(api.apply(posts, { status: 'draft' }))).toEqual(['b', 'c']);
    expect(keys(api.apply(posts, { region: 'south-america' }))).toEqual(['c']);
    expect(keys(api.apply(posts, { country: 'Island' }))).toEqual(['b']);
  });

  it('combines filters (AND, not OR)', () => {
    expect(keys(api.apply(posts, { status: 'draft', region: 'europe' }))).toEqual(['b']);
    expect(api.apply(posts, { status: 'published', region: 'south-america' })).toEqual([]);
  });

  it('exposes the closed region set — country is free text and must come from the rows', () => {
    expect(api.REGIONS).toEqual(['europe', 'north-america', 'south-america']);
  });

  it('filters the two editorial readiness states without changing draft/published semantics', () => {
    const readiness = [
      post({ translationKey: 'changed', status: 'published', hasUnpublishedChanges: true, hasEnBody: true }),
      post({ translationKey: 'missing-live', status: 'published', hasUnpublishedChanges: false, hasEnBody: false }),
      post({ translationKey: 'missing-draft', status: 'draft', hasUnpublishedChanges: false, hasEnBody: false }),
    ];
    expect(keys(api.apply(readiness, { status: 'unpublished' }))).toEqual(['changed']);
    expect(keys(api.apply(readiness, { status: 'missing-en' }))).toEqual(['missing-live', 'missing-draft']);
    expect(keys(api.apply(readiness, { status: 'draft' }))).toEqual(['missing-draft']);
    expect(keys(api.apply(readiness, { status: 'published' }))).toEqual(['changed', 'missing-live']);
  });

  it('does not mutate the input array', () => {
    const input = [...posts];
    api.apply(input, { sort: 'title', order: 'asc' });
    expect(keys(input)).toEqual(['a', 'b', 'c']);
  });
});

describe('PostsFilter.apply — sorting', () => {
  const api = load();
  const posts = [
    post({ translationKey: 'a', titleDe: 'Bukarest', date: '2024-05-01', updatedAt: '2025-01-02T00:00:00.000Z' }),
    post({ translationKey: 'b', titleDe: 'Ålesund', date: '2023-01-01', updatedAt: '2025-01-03T00:00:00.000Z' }),
    post({ translationKey: 'c', titleDe: 'Chile', date: '2025-09-09', updatedAt: '2025-01-01T00:00:00.000Z' }),
  ];
  const keys = (r: Summary[]) => r.map((p) => p.translationKey);

  it('defaults to newest-updated first', () => {
    expect(keys(api.apply(posts, {}))).toEqual(['b', 'a', 'c']);
  });

  it('sorts by trip date and by title, both directions', () => {
    expect(keys(api.apply(posts, { sort: 'date', order: 'asc' }))).toEqual(['b', 'a', 'c']);
    expect(keys(api.apply(posts, { sort: 'date', order: 'desc' }))).toEqual(['c', 'a', 'b']);
    expect(keys(api.apply(posts, { sort: 'title', order: 'asc' }))).toEqual(['b', 'a', 'c']); // Å collates before B
  });

  it('falls back to the default sort/order for unknown values', () => {
    // A stale bookmark or a hand-edited control must not produce a broken list.
    expect(keys(api.apply(posts, { sort: 'toString' }))).toEqual(['b', 'a', 'c']);
    expect(keys(api.apply(posts, { sort: 'nonsense', order: 'sideways' }))).toEqual(['b', 'a', 'c']);
  });
});

describe('PostsFilter URL state', () => {
  const api = load();

  it('round-trips non-default filters and omits inventory defaults', () => {
    const query = api.toSearch({
      q: 'Rhodes & sun',
      status: 'missing-en',
      region: 'europe',
      country: 'Griechenland',
      sort: 'title',
      order: 'asc',
    });
    expect(api.fromSearch('?' + query, ['Griechenland'])).toEqual({
      q: 'Rhodes & sun',
      status: 'missing-en',
      region: 'europe',
      country: 'Griechenland',
      sort: 'title',
      order: 'asc',
    });
    expect(api.toSearch({ sort: 'updated', order: 'desc' })).toBe('');
  });

  it('rejects stale enum and inventory values and bounds free text', () => {
    const state = api.fromSearch(
      '?q=' + 'x'.repeat(250) + '&status=deleted&region=moon&country=Atlantis&sort=toString&order=sideways',
      ['Island'],
    );
    expect(state).toEqual({
      q: 'x'.repeat(200),
      status: '',
      region: '',
      country: '',
      sort: 'updated',
      order: 'desc',
    });
  });

  it('counts only controls hidden inside the collapsed filter group', () => {
    expect(api.extraFilterCount({ q: 'trip', status: 'draft', sort: 'updated', order: 'desc' })).toBe(0);
    expect(api.extraFilterCount({ region: 'europe', country: 'Island', sort: 'title', order: 'asc' })).toBe(4);
  });
});


