import { describe, expect, it, vi } from 'vitest';
import { memoryPostStore, PostError, REVISION_CAP, validateDraft, validateForPublish, type PostPair } from '../src/posts.js';

function pair(overrides: Partial<PostPair> = {}): PostPair {
  const loc = (locale: 'de' | 'en', slug: string, title: string) => ({
    locale, slug, title, excerpt: 'x',
    heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'a' },
    bodyMarkdown: '## Hi', images: {},
  });
  return {
    translationKey: '', status: 'draft',
    shared: { date: '2024-10-03', country: 'Rumänien', countryCode: 'RO', region: 'europe', coordinates: { lat: 44.4, lng: 26.1 } },
    de: loc('de', 'bukarest', 'Bukarest'), en: loc('en', 'bucharest', 'Bucharest'),
    ...overrides,
  };
}

describe('memoryPostStore', () => {
  it('creates a pair with a generated translationKey and lists it', async () => {
    const s = memoryPostStore();
    const created = await s.upsertDraft(pair());
    expect(created.translationKey).toMatch(/.+/);
    const list = await s.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ titleDe: 'Bukarest', slugDe: 'bukarest', slugEn: 'bucharest', status: 'draft' });
  });

  it('get returns the full pair; update preserves the key', async () => {
    const s = memoryPostStore();
    const created = await s.upsertDraft(pair());
    const updated = await s.upsertDraft({ ...created, de: { ...created.de, title: 'Bukarest 2' } });
    expect(updated.translationKey).toBe(created.translationKey);
    expect((await s.get(created.translationKey))?.de.title).toBe('Bukarest 2');
  });

  it('publish flips both rows to published', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.publish(c.translationKey);
    expect((await s.get(c.translationKey))?.status).toBe('published');
  });

  it('a new draft and a fresh publish report no unpublished changes', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    expect(c.hasUnpublishedChanges).toBe(false);
    expect((await s.list())[0]?.hasUnpublishedChanges).toBe(false);
    await s.publish(c.translationKey);
    expect((await s.get(c.translationKey))?.hasUnpublishedChanges).toBe(false);
    expect((await s.list())[0]?.hasUnpublishedChanges).toBe(false);
  });

  it('a draft save over a published post keeps it published but flags unpublished changes', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.publish(c.translationKey);
    const saved = await s.upsertDraft({ ...c, de: { ...c.de, bodyMarkdown: '## edited' } });
    expect(saved.status).toBe('published');
    expect(saved.hasUnpublishedChanges).toBe(true);
    const got = await s.get(c.translationKey);
    expect(got?.de.bodyMarkdown).toBe('## edited'); // editor sees the working copy
    expect(got?.hasUnpublishedChanges).toBe(true);
    expect((await s.list())[0]?.hasUnpublishedChanges).toBe(true);
  });

  it('re-publish picks up the newest working copy and clears the flag', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.publish(c.translationKey);
    await s.upsertDraft({ ...c, de: { ...c.de, bodyMarkdown: '## edited' } });
    await s.publish(c.translationKey);
    const got = await s.get(c.translationKey);
    expect(got?.de.bodyMarkdown).toBe('## edited');
    expect(got?.hasUnpublishedChanges).toBe(false);
    expect((await s.list())[0]?.hasUnpublishedChanges).toBe(false);
  });

  it('rejects changing a slug once published', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.publish(c.translationKey);
    await expect(s.upsertDraft({ ...c, status: 'published', de: { ...c.de, slug: 'renamed' } }))
      .rejects.toBeInstanceOf(PostError);
  });

  it('rejects a duplicate (locale, slug) across posts', async () => {
    const s = memoryPostStore();
    await s.upsertDraft(pair());
    await expect(s.upsertDraft(pair({ de: { ...pair().de, slug: 'bukarest' }, en: { ...pair().en, slug: 'other' } })))
      .rejects.toBeInstanceOf(PostError);
  });
});

describe('memoryPostStore optimistic concurrency', () => {
  it('get() and upsertDraft() return the stored updatedAt', async () => {
    const s = memoryPostStore();
    const created = await s.upsertDraft(pair());
    expect(created.updatedAt).toBeInstanceOf(Date);
    expect((await s.get(created.translationKey))?.updatedAt.getTime()).toBe(created.updatedAt.getTime());
  });

  it('accepts a save echoing the current updatedAt, and one without any', async () => {
    const s = memoryPostStore();
    const created = await s.upsertDraft(pair());
    const fresh = await s.get(created.translationKey);
    await expect(s.upsertDraft({ ...created, de: { ...created.de, title: 'A' } }, fresh!.updatedAt)).resolves.toBeTruthy();
    // No baseUpdatedAt → check skipped (POST-create and WP-importer back-compat).
    await expect(s.upsertDraft({ ...created, de: { ...created.de, title: 'B' } })).resolves.toBeTruthy();
  });

  it('rejects a stale save with PostError code "conflict" and stores nothing', async () => {
    const s = memoryPostStore();
    const created = await s.upsertDraft(pair());
    const stale = new Date(created.updatedAt.getTime() - 60_000);
    const attempt = () => s.upsertDraft({ ...created, de: { ...created.de, title: 'stale tab' } }, stale);
    await expect(attempt()).rejects.toBeInstanceOf(PostError);
    await expect(attempt()).rejects.toMatchObject({ code: 'conflict' });
    expect((await s.get(created.translationKey))?.de.title).toBe('Bukarest');
  });

  it('detects the two-tab scenario: B saves first, then stale A is rejected', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-05T10:00:00Z'));
      const s = memoryPostStore();
      const created = await s.upsertDraft(pair());
      const tabA = (await s.get(created.translationKey))!;
      vi.setSystemTime(new Date('2026-07-05T10:01:00Z'));
      // Tab B saves against a fresh copy — fine.
      await s.upsertDraft({ ...created, de: { ...created.de, title: 'Tab B' } }, tabA.updatedAt);
      // Tab A still holds the old updatedAt — its save must not clobber B's.
      await expect(s.upsertDraft({ ...created, de: { ...created.de, title: 'Tab A' } }, tabA.updatedAt))
        .rejects.toMatchObject({ code: 'conflict' });
      expect((await s.get(created.translationKey))?.de.title).toBe('Tab B');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the check for a brand-new post (nothing to conflict with)', async () => {
    const s = memoryPostStore();
    await expect(s.upsertDraft(pair(), new Date(0))).resolves.toBeTruthy();
  });
});

describe('memoryPostStore revisions', () => {
  it('first create records no revision; an overwrite snapshots the pre-save state', async () => {
    const s = memoryPostStore();
    const created = await s.upsertDraft(pair());
    expect(await s.listRevisions(created.translationKey)).toHaveLength(0);
    await s.upsertDraft({ ...created, de: { ...created.de, title: 'Bukarest 2' } });
    const revs = await s.listRevisions(created.translationKey);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ titleDe: 'Bukarest', status: 'draft' });
    expect(revs[0]!.savedAt).toBeInstanceOf(Date);
    const rev = await s.getRevision(created.translationKey, revs[0]!.id);
    expect(rev?.snapshot.de.title).toBe('Bukarest');
    expect(rev?.snapshot.en.slug).toBe('bucharest');
    expect(rev?.snapshot.shared.date).toBe('2024-10-03');
  });

  it('lists newest first and caps the history per post', async () => {
    const s = memoryPostStore();
    let cur = await s.upsertDraft({ ...pair(), de: { ...pair().de, title: 'v1' } });
    for (let i = 2; i <= REVISION_CAP + 6; i++) {
      cur = await s.upsertDraft({ ...cur, de: { ...cur.de, title: `v${i}` } });
    }
    const revs = await s.listRevisions(cur.translationKey);
    expect(revs).toHaveLength(REVISION_CAP);
    expect(revs[0]!.titleDe).toBe(`v${REVISION_CAP + 5}`); // state before the last save
    expect(revs[REVISION_CAP - 1]!.titleDe).toBe('v6');    // v1–v5 pruned
  });

  it('getRevision returns null for an unknown id', async () => {
    const s = memoryPostStore();
    const created = await s.upsertDraft(pair());
    expect(await s.getRevision(created.translationKey, 'nope')).toBeNull();
  });
});

describe('post validation', () => {
  it('draft requires only a DE title and valid slugs', () => {
    expect(() => validateDraft(pair({ de: { ...pair().de, title: '' } }))).toThrow(PostError);
    expect(() => validateDraft(pair({ de: { ...pair().de, slug: 'Bad Slug' } }))).toThrow(PostError);
    expect(() => validateDraft(pair())).not.toThrow();
  });
  it('publish requires both locales complete and schema-valid', () => {
    expect(() => validateForPublish(pair())).not.toThrow();
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, countryCode: 'ROU' } }))).toThrow(PostError);
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, region: 'mars' as never } }))).toThrow(PostError);
    expect(() => validateForPublish(pair({ en: { ...pair().en, excerpt: '' } }))).toThrow(PostError);
    expect(() => validateForPublish(pair({ de: { ...pair().de, heroImage: { ...pair().de.heroImage, alt: '' } } }))).toThrow(PostError);
  });
  it('publish rejects out-of-range coordinates', () => {
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, coordinates: { lat: 91, lng: 0 } } }))).toThrow(/lat/);
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, coordinates: { lat: -91, lng: 0 } } }))).toThrow(/lat/);
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, coordinates: { lat: 0, lng: 181 } } }))).toThrow(/lng/);
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, coordinates: { lat: 0, lng: -181 } } }))).toThrow(/lng/);
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, coordinates: { lat: NaN, lng: 0 } } }))).toThrow(PostError);
    // boundary values are valid
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, coordinates: { lat: -90, lng: 180 } } }))).not.toThrow();
  });
  it('publish throws PostError (not TypeError) when heroImage is missing', () => {
    const noHero = pair({ de: { ...pair().de, heroImage: undefined as never } });
    expect(() => validateForPublish(noHero)).toThrow(PostError);
    expect(() => validateForPublish(noHero)).not.toThrow(TypeError);
  });
});

describe('upsertDraft fills NOT-NULL defaults on a partial draft', () => {
  it('defaults missing coordinates and heroImage so a partial save cannot NULL a column', async () => {
    const store = memoryPostStore();
    // A payload the editor can produce for an imported draft (coords blanked):
    // coordinates and heroImage omitted entirely.
    const partial = {
      translationKey: '',
      status: 'draft',
      shared: { date: '2024-09-29', country: '', countryCode: 'XX', region: 'europe' },
      de: { locale: 'de', slug: 'partial-de', title: 'X', excerpt: '', bodyMarkdown: '', images: {} },
      en: { locale: 'en', slug: 'partial-en', title: 'Y', excerpt: '', bodyMarkdown: '', images: {} },
    } as unknown as PostPair;
    const saved = await store.upsertDraft(partial);
    expect(saved.shared.coordinates).toEqual({ lat: 0, lng: 0 });
    expect(saved.de.heroImage).toEqual({ src: '', width: 0, height: 0, alt: '' });
    expect(saved.en.heroImage).toEqual({ src: '', width: 0, height: 0, alt: '' });
  });
});
