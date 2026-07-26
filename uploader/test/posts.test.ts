import { describe, expect, it, vi } from 'vitest';
import { memoryPostStore, normalizeBodyImages, PostError, REVISION_CAP, validateDraft, validateForPublish, type PostPair } from '../src/posts.js';
import { renderPostToMdx } from '../src/export.js';

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

  it('round-trips stops through upsertDraft and get', async () => {
    const s = memoryPostStore();
    const stops = [{ name: 'Athen', lat: 37.98, lng: 23.73 }, { name: 'Rhodos', lat: 36.43, lng: 28.22 }];
    const created = await s.upsertDraft(pair({ shared: { ...pair().shared, stops } }));
    expect((await s.get(created.translationKey))?.shared.stops).toEqual(stops);
  });

  it('a subsequent upsertDraft without stops removes them (full-replace contract)', async () => {
    // @ai-warning The store replaces shared wholesale — a client that loads a post
    // but omits stops on save wipes them (issue #25). The editor must round-trip stops.
    const s = memoryPostStore();
    const stops = [{ name: 'Athen', lat: 37.98, lng: 23.73 }];
    const created = await s.upsertDraft(pair({ shared: { ...pair().shared, stops } }));
    await s.upsertDraft({ ...created, shared: { ...pair().shared } });
    expect((await s.get(created.translationKey))?.shared.stops).toBeUndefined();
  });

  it('unpublish flips a published pair back to draft', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.publish(c.translationKey);
    await s.unpublish(c.translationKey);
    expect((await s.get(c.translationKey))?.status).toBe('draft');
  });

  it('unpublish unlocks the slugs again (publish → unpublish → rename allowed)', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.publish(c.translationKey);
    await s.unpublish(c.translationKey);
    const renamed = await s.upsertDraft({ ...c, de: { ...c.de, slug: 'renamed' } });
    expect(renamed.de.slug).toBe('renamed');
  });

  it('remove deletes the pair and frees its slugs for reuse', async () => {
    const s = memoryPostStore();
    const c = await s.upsertDraft(pair());
    await s.remove(c.translationKey);
    expect(await s.get(c.translationKey)).toBeNull();
    expect(await s.list()).toHaveLength(0);
    // the slug-squatting fix: a fresh draft may take the freed slugs
    const reused = await s.upsertDraft(pair());
    expect(reused.de.slug).toBe('bukarest');
    expect(reused.translationKey).not.toBe(c.translationKey);
  });

  it('remove and unpublish reject an unknown key with PostError', async () => {
    const s = memoryPostStore();
    await expect(s.remove('nope')).rejects.toBeInstanceOf(PostError);
    await expect(s.unpublish('nope')).rejects.toBeInstanceOf(PostError);
  });

  it('list reports hasEnBody (blank EN body → false)', async () => {
    const s = memoryPostStore();
    const withEn = await s.upsertDraft(pair());
    const withoutEn = await s.upsertDraft(pair({
      de: { ...pair().de, slug: 'other-de' },
      en: { ...pair().en, slug: 'other-en', bodyMarkdown: '   ' },
    }));
    const list = await s.list();
    expect(list.find((p) => p.translationKey === withEn.translationKey)?.hasEnBody).toBe(true);
    expect(list.find((p) => p.translationKey === withoutEn.translationKey)?.hasEnBody).toBe(false);
  });

  it('usageRows returns one row per stored locale with the referencing fields', async () => {
    const s = memoryPostStore();
    const created = await s.upsertDraft(pair());
    const rows = await s.usageRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.translationKey)).toEqual([created.translationKey, created.translationKey]);
    expect(rows[0]).toMatchObject({
      title: 'Bukarest',
      heroImage: { src: 'https://img/h' },
      bodyMarkdown: '## Hi',
      images: {},
    });
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
    // The check runs BEFORE the snapshot: a rejected save must record no revision.
    expect(await s.listRevisions(created.translationKey)).toHaveLength(0);
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
  it('publish accepts valid stops and posts without stops', () => {
    const stops = [{ name: 'Athen', lat: 37.98, lng: 23.73 }, { name: 'Rhodos', lat: 36.43, lng: 28.22 }];
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, stops } }))).not.toThrow();
    // boundary coordinates are valid
    expect(() => validateForPublish(pair({ shared: { ...pair().shared, stops: [{ name: 'Pole', lat: -90, lng: 180 }] } }))).not.toThrow();
    // no stops at all is fine (backward compat)
    expect(() => validateForPublish(pair())).not.toThrow();
  });

  it('publish rejects malformed stops with an index-bearing message', () => {
    const withStops = (stops: unknown) =>
      pair({ shared: { ...pair().shared, stops: stops as never } });
    expect(() => validateForPublish(withStops('nope'))).toThrow(/stops must be an array/);
    expect(() => validateForPublish(withStops([null]))).toThrow(/stops\[0\] must be an object/);
    expect(() => validateForPublish(withStops([{ name: '', lat: 0, lng: 0 }]))).toThrow(/stops\[0\]\.name/);
    expect(() => validateForPublish(withStops([{ name: 'A', lat: 0, lng: 0 }, { name: 'B', lat: 91, lng: 0 }]))).toThrow(/stops\[1\]\.lat/);
    expect(() => validateForPublish(withStops([{ name: 'A', lat: -91, lng: 0 }]))).toThrow(/stops\[0\]\.lat/);
    expect(() => validateForPublish(withStops([{ name: 'A', lat: 0, lng: 181 }]))).toThrow(/stops\[0\]\.lng/);
    expect(() => validateForPublish(withStops([{ name: 'A', lat: 0, lng: -181 }]))).toThrow(/stops\[0\]\.lng/);
    expect(() => validateForPublish(withStops([{ name: 'A', lat: NaN, lng: 0 }]))).toThrow(PostError);
    expect(() => validateForPublish(withStops([{ name: 'A', lat: '37.98', lng: 0 }]))).toThrow(/stops\[0\]\.lat/);
  });

  it('publish throws PostError (not TypeError) when heroImage is missing', () => {
    const noHero = pair({ de: { ...pair().de, heroImage: undefined as never } });
    expect(() => validateForPublish(noHero)).toThrow(PostError);
    expect(() => validateForPublish(noHero)).not.toThrow(TypeError);
  });
});

describe('images-map validation at the store chokepoint', () => {
  // @ai-warning: this MUST be enforced in upsertDraft (draftWithDefaults), not
  // in validateDraft — the WXR importer calls upsertDraft directly and never
  // runs validateDraft, so validation placed there alone leaves every imported
  // post's images map unchecked.
  it('rejects a node-shaped alt (the hastscript markup-injection vector)', async () => {
    const s = memoryPostStore();
    const p = pair();
    p.de.images = {
      'https://img/x/y': { width: 8, height: 6, alt: { type: 'raw', value: '<script>alert(1)</script>' } },
    } as unknown as PostPair['de']['images'];
    await expect(s.upsertDraft(p)).rejects.toThrow(PostError);
    await expect(s.upsertDraft(p)).rejects.toThrow(/de: images.*alt must be a string/);
  });

  it('rejects non-positive-integer dimensions', async () => {
    const s = memoryPostStore();
    const p = pair();
    p.en.images = { 'https://img/x/y': { width: '1;} html{}', height: 6 } } as unknown as PostPair['en']['images'];
    await expect(s.upsertDraft(p)).rejects.toThrow(/en: images.*positive integer/);
  });

  it('validateDraft itself stays untouched — the gate is the store', () => {
    const p = pair();
    p.de.images = { 'https://img/x/y': { width: 0, height: 0 } };
    expect(() => validateDraft(p)).not.toThrow();
  });

  it('accepts alt/caption strings and keeps them', async () => {
    const s = memoryPostStore();
    const p = pair();
    p.de.images = { 'https://img/x/y': { width: 8, height: 6, alt: 'a', caption: 'c' } };
    const saved = await s.upsertDraft(p);
    expect(saved.de.images['https://img/x/y']).toEqual({ width: 8, height: 6, alt: 'a', caption: 'c' });
  });
});

describe('gallery fences at the store chokepoint', () => {
  const a = 'https://img/g/a-1a2b3c4d';

  it('lifts per-line metadata into images and bares the fence line', async () => {
    const s = memoryPostStore();
    const p = pair();
    p.de.bodyMarkdown = `Intro\n\n\`\`\`gallery\n${a} | 3000x2000 | alt="Sonnenaufgang" | caption="Tag 3"\n\`\`\``;
    const saved = await s.upsertDraft(p);
    expect(saved.de.bodyMarkdown).toBe(`Intro\n\n\`\`\`gallery\n${a}\n\`\`\``);
    expect(saved.de.images[a]).toEqual({ width: 3000, height: 2000, alt: 'Sonnenaufgang', caption: 'Tag 3' });
  });

  it('is idempotent across a re-save', async () => {
    const s = memoryPostStore();
    const p = pair();
    p.de.bodyMarkdown = `\`\`\`gallery\n${a} | 800x600 | alt="x"\n\`\`\``;
    const first = await s.upsertDraft(p);
    const second = await s.upsertDraft(first);
    expect(second.de.bodyMarkdown).toBe(first.de.bodyMarkdown);
    expect(second.de.images).toEqual(first.de.images);
  });
});

describe('normalizeBodyImages', () => {
  it('converts a JSX-attr <BodyImage> tag to a markdown image and records its dims', () => {
    const body = 'Intro\n\n<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Gasse" />\n\nMore';
    const out = normalizeBodyImages(body, {});
    expect(out.bodyMarkdown).toBe('Intro\n\n![Gasse](https://img/x/y)\n\nMore');
    expect(out.images).toEqual({ 'https://img/x/y': { width: 1600, height: 1067 } });
  });

  it('accepts quoted numeric attrs and decodes &quot; in alt (inverse of export escaping)', () => {
    const body = '<BodyImage src="https://img/a/b" width="1600" height="1067" alt="Die &quot;Gasse&quot;" />';
    const out = normalizeBodyImages(body, {});
    expect(out.bodyMarkdown).toBe('![Die "Gasse"](https://img/a/b)');
    expect(out.images).toEqual({ 'https://img/a/b': { width: 1600, height: 1067 } });
  });

  it('converts a tag without parsable dims but records no images entry', () => {
    const out = normalizeBodyImages('<BodyImage src="https://img/no/dims" alt="x" />', {});
    expect(out.bodyMarkdown).toBe('![x](https://img/no/dims)');
    expect(out.images).toEqual({});
  });

  it('leaves a src-less tag untouched', () => {
    const body = 'a <BodyImage alt="broken" /> b';
    const out = normalizeBodyImages(body, {});
    expect(out.bodyMarkdown).toBe(body);
    expect(out.images).toEqual({});
  });

  it('is idempotent: plain/already-normalized markdown passes through byte-identical, existing dims preserved', () => {
    const existing = { 'https://img/x/y': { width: 800, height: 600 } };
    const body = '## Hi\n\n![Gasse](https://img/x/y)\n';
    const once = normalizeBodyImages(body, existing);
    expect(once.bodyMarkdown).toBe(body);
    expect(once.images).toEqual(existing);
    const twice = normalizeBodyImages(once.bodyMarkdown, once.images);
    expect(twice).toEqual(once);
  });

  it('normalizes on upsertDraft (store chokepoint) and merges into existing images', async () => {
    const s = memoryPostStore();
    const p = pair();
    p.de.images = { 'https://img/pre/existing': { width: 100, height: 50 } };
    p.de.bodyMarkdown = 'Vorher\n\n<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Gasse" />';
    const saved = await s.upsertDraft(p);
    expect(saved.de.bodyMarkdown).not.toContain('<BodyImage');
    expect(saved.de.bodyMarkdown).toContain('![Gasse](https://img/x/y)');
    expect(saved.de.images).toEqual({
      'https://img/pre/existing': { width: 100, height: 50 },
      'https://img/x/y': { width: 1600, height: 1067 },
    });
    // en body had no tags — untouched
    expect(saved.en.bodyMarkdown).toBe('## Hi');
  });

  it('round-trips: MDX export reconstructs the <BodyImage> tag from the normalized pair', async () => {
    const s = memoryPostStore();
    const p = pair();
    p.de.bodyMarkdown = '<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Gasse" />';
    const saved = await s.upsertDraft(p);
    const mdx = renderPostToMdx(saved, 'de');
    expect(mdx).toContain('<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Gasse" />');
  });

  it('converts a tag whose quoted alt contains ">" (legacy exports escaped only quotes)', () => {
    const body = '<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Blick > Westen" />';
    const out = normalizeBodyImages(body, {});
    expect(out.bodyMarkdown).toBe('![Blick > Westen](https://img/x/y)');
    expect(out.images).toEqual({ 'https://img/x/y': { width: 1600, height: 1067 } });
  });

  it('does not truncate the tag on "/>" inside a quoted alt', () => {
    const body = 'a <BodyImage src="https://img/x/y" width={16} height={10} alt="x/>y" /> b';
    const out = normalizeBodyImages(body, {});
    expect(out.bodyMarkdown).toBe('a ![x/>y](https://img/x/y) b');
    expect(out.images).toEqual({ 'https://img/x/y': { width: 16, height: 10 } });
  });

  it('decodes &lt; &gt; &amp; in alt and round-trips through the MDX export escaping', async () => {
    const s = memoryPostStore();
    const p = pair();
    const alt = 'Blick <über> das "Tor" & zurück';
    p.de.bodyMarkdown = `![${alt}](https://img/x/y)`;
    p.de.images = { 'https://img/x/y': { width: 1600, height: 1067 } };
    const saved = await s.upsertDraft(p);
    const mdx = renderPostToMdx(saved, 'de');
    expect(mdx).toContain('alt="Blick &lt;über&gt; das &quot;Tor&quot; &amp; zurück"');
    const tag = mdx.match(/<BodyImage[^\n]*\/>/)?.[0] ?? '';
    const back = normalizeBodyImages(tag, {});
    expect(back.bodyMarkdown).toBe(`![${alt}](https://img/x/y)`);
    expect(back.images).toEqual({ 'https://img/x/y': { width: 1600, height: 1067 } });
  });

  it('accepts a multiline tag and the braced src={…} attribute form', () => {
    const multi = normalizeBodyImages('<BodyImage\n  src="https://img/m/l"\n  width={10}\n  height={20}\n  alt="ml"\n/>', {});
    expect(multi.bodyMarkdown).toBe('![ml](https://img/m/l)');
    expect(multi.images).toEqual({ 'https://img/m/l': { width: 10, height: 20 } });
    const braced = normalizeBodyImages('<BodyImage src={https://img/b/r} width={10} height={20} alt="b" />', {});
    expect(braced.bodyMarkdown).toBe('![b](https://img/b/r)');
    expect(braced.images).toEqual({ 'https://img/b/r': { width: 10, height: 20 } });
  });

  it('leaves malformed tags untouched rather than truncating (pinned rejected shapes)', () => {
    const nonSelfClosing = 'a <BodyImage src="https://img/x/y"></BodyImage> b';
    expect(normalizeBodyImages(nonSelfClosing, {}).bodyMarkdown).toBe(nonSelfClosing);
    const unclosedQuote = 'a <BodyImage src="https://img/x/y" alt="oops /> b';
    expect(normalizeBodyImages(unclosedQuote, {}).bodyMarkdown).toBe(unclosedQuote);
  });

  it('normalizes the EN locale through the store chokepoint too', async () => {
    const s = memoryPostStore();
    const p = pair();
    p.en.bodyMarkdown = 'Before\n\n<BodyImage src="https://img/e/n" width={10} height={20} alt="en alt" />';
    const saved = await s.upsertDraft(p);
    expect(saved.en.bodyMarkdown).toBe('Before\n\n![en alt](https://img/e/n)');
    expect(saved.en.images).toEqual({ 'https://img/e/n': { width: 10, height: 20 } });
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
