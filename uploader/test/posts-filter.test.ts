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
  hasEnBody: boolean; heroSrc: string; heroWidth: number;
  date: string; country: string; region: string;
}
interface Api {
  REGIONS: string[];
  apply(posts: Summary[], opts: Record<string, string>): Summary[];
  countries(posts: Summary[]): string[];
  thumbUrl(post: { heroSrc?: unknown; heroWidth?: unknown }): string | null;
}

function load(): Api {
  const windowStub: { PostsFilter?: Api } = {};
  vm.runInNewContext(src, { window: windowStub });
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

describe('posts.html wiring', () => {
  const page = readFileSync('public/posts.html', 'utf8');

  it('loads the extracted filter module rather than inlining the logic', () => {
    expect(page).toContain('<script src="/admin/posts-filter.js"></script>');
    expect(page).toContain('PostsFilter.apply(');
    expect(page).toContain('PostsFilter.thumbUrl(');
  });

  it('requires a typed confirmation for bulk delete only', () => {
    // Bulk delete is irreversible (revisions are per-save snapshots and
    // remove() hard-deletes both locale rows) — a plain confirm() is not enough.
    expect(page).toContain("Type DELETE to confirm:");
    expect(page).toContain("return typed === 'DELETE'");
  });

  it('posts bulk actions to the single admin-only endpoint', () => {
    expect(page).toContain("fetch('/posts/bulk'");
    expect(page).toContain("runBulk('publish')");
    expect(page).toContain("runBulk('unpublish')");
    expect(page).toContain("runBulk('delete')");
  });

  it('builds every cell with textContent — innerHTML only ever clears', () => {
    // Post titles, countries and slugs are author-supplied; the list must not
    // become an injection sink.
    for (const match of page.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)) {
      expect(match[1]?.trim()).toBe("''");
    }
  });
});
