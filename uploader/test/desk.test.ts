import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('public/desk.js', 'utf8');

interface Post {
  status: 'draft' | 'published';
  updatedAt: string;
  hasUnpublishedChanges: boolean;
  translationKey: string;
}
interface Api {
  nextDraft(posts: Post[]): Post | null;
  unpublished(posts: Post[]): Post[];
  encodeCount(stats: { pending?: number; running?: number } | null): number;
}

function load(): Api {
  const windowStub: { Desk?: Api } = {};
  vm.runInNewContext(src, { window: windowStub });
  if (!windowStub.Desk) throw new Error('desk.js did not assign window.Desk');
  return windowStub.Desk;
}

const post = (o: Partial<Post>): Post => ({
  translationKey: 'tk', status: 'draft', updatedAt: '2025-01-01T00:00:00.000Z',
  hasUnpublishedChanges: false, ...o,
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
    const a = post({ translationKey: 'a', status: 'published', hasUnpublishedChanges: true, updatedAt: '2024-01-01T00:00:00.000Z' });
    const b = post({ translationKey: 'b', status: 'published', hasUnpublishedChanges: true, updatedAt: '2025-01-01T00:00:00.000Z' });
    const clean = post({ translationKey: 'c', status: 'published' });
    expect(api.unpublished([a, clean, b]).map((p) => p.translationKey)).toEqual(['b', 'a']);
  });
});

describe('Desk.encodeCount', () => {
  const api = load();

  it('sums pending and running', () => {
    expect(api.encodeCount({ pending: 2, running: 1 })).toBe(3);
    expect(api.encodeCount({ pending: 0, running: 0 })).toBe(0);
    expect(api.encodeCount(null)).toBe(0);
  });
});
