import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { memoryPostStore, validateDraft, type PostPair } from '../src/posts.js';

// posts-duplicate.js is a plain browser IIFE (window.PostsDuplicate) holding
// the copy semantics. Those are pure logic and belong in a unit test rather
// than only in the UI — which is why they live outside the inline page script.
const src = readFileSync('public/posts-duplicate.js', 'utf8');

interface Api {
  duplicatePayload(pair: PostPair, slugs: { de: string; en: string }, today?: Date): PostPair;
  slugError(slugs: { de: string; en: string } | null): string | null;
}
function load(): Api {
  const windowStub: Record<string, unknown> = {};
  vm.runInNewContext(src, { window: windowStub });
  return windowStub.PostsDuplicate as Api;
}

const source: PostPair = {
  translationKey: 'source-key', status: 'published',
  shared: {
    date: '2024-10-03', countryCode: 'NO', region: 'europe',
    coordinates: { lat: 63.43, lng: 10.39 },
    stops: [{ name: 'Trondheim', lat: 63.43, lng: 10.39 }],
    route: 'Oslo → Trondheim',
  },
  de: {
    locale: 'de', slug: 'norwegen-2024', title: 'Norwegen im Herbst', excerpt: 'Ein Roadtrip.',
    country: 'Norwegen',
    heroImage: { src: 'https://img/h', width: 1600, height: 900, alt: 'Fjord' },
    bodyMarkdown: '## Anreise\n\n![Fjord](https://img/x/y)',
    images: { 'https://img/x/y': { width: 1600, height: 1067, alt: 'Fjord', caption: 'Tag 1' } },
    keyFacts: { Währung: 'NOK', Sprache: 'Norwegisch' },
  },
  en: {
    locale: 'en', slug: 'norway-2024', title: 'Norway in autumn', excerpt: 'A road trip.',
    country: 'Norway',
    heroImage: { src: 'https://img/h', width: 1600, height: 900, alt: 'Fjord' },
    bodyMarkdown: '## Arrival',
    images: {},
    keyFacts: { Currency: 'NOK', Language: 'Norwegian' },
  },
};

const TODAY = new Date('2026-07-27T09:00:00Z');
const slugs = { de: 'schweden-2026', en: 'sweden-2026' };

describe('PostsDuplicate.duplicatePayload — structure copies', () => {
  const api = load();
  const copy = api.duplicatePayload(source, slugs, TODAY);

  it('carries the repeating structure this feature exists for', () => {
    expect(copy.de.country).toBe('Norwegen');
    expect(copy.en.country).toBe('Norway');
    expect(copy.shared.countryCode).toBe('NO');
    expect(copy.shared.region).toBe('europe');
    expect(copy.shared.route).toBe('Oslo → Trondheim');
    expect(copy.shared.stops).toEqual(source.shared.stops);
    expect(copy.de.keyFacts).toEqual(source.de.keyFacts);
    expect(copy.en.keyFacts).toEqual(source.en.keyFacts);
  });

  it('carries titles, excerpts, bodies and heroes', () => {
    expect(copy.de.title).toBe('Norwegen im Herbst');
    expect(copy.en.excerpt).toBe('A road trip.');
    expect(copy.de.bodyMarkdown).toBe(source.de.bodyMarkdown);
    expect(copy.de.heroImage).toEqual(source.de.heroImage);
  });

  // @ai-warning: correctness, not preference. body-images.ts skips any image
  // absent from the map, so copying a body without it silently breaks every
  // photo in the post.
  it('carries the images map — mandatory, not editorial', () => {
    expect(copy.de.images).toEqual(source.de.images);
    expect(copy.de.images['https://img/x/y']).toMatchObject({ width: 1600, alt: 'Fjord', caption: 'Tag 1' });
  });

  it('omits optional shared fields the source never had', () => {
    const bare: PostPair = { ...source, shared: { ...source.shared }, de: { ...source.de }, en: { ...source.en } };
    delete bare.shared.route;
    delete bare.shared.stops;
    delete bare.de.keyFacts;
    delete bare.en.keyFacts;
    const out = api.duplicatePayload(bare, slugs, TODAY);
    expect(out.shared).not.toHaveProperty('route');
    expect(out.shared).not.toHaveProperty('stops');
    expect(out.de).not.toHaveProperty('keyFacts');
    expect(out.en).not.toHaveProperty('keyFacts');
  });
});

describe('PostsDuplicate.duplicatePayload — identity resets', () => {
  const api = load();
  const copy = api.duplicatePayload(source, slugs, TODAY);

  // @ai-warning: correctness, not preference. A copy of a Norway trip must not
  // silently claim Norway's coordinates.
  it('resets coordinates to the incomplete-draft placeholder', () => {
    expect(copy.shared.coordinates).toEqual({ lat: 0, lng: 0 });
  });

  it('resets the date to today, NOT to empty', () => {
    // `posts.date` is `date NOT NULL` and Postgres rejects '' outright, so a
    // blank date cannot be saved at all — verified against the real database.
    expect(copy.shared.date).toBe('2026-07-27');
  });

  it('takes the new slugs and never reuses the source translation key', () => {
    expect(copy.de.slug).toBe('schweden-2026');
    expect(copy.en.slug).toBe('sweden-2026');
    // Reusing the key would overwrite the source post rather than copy it.
    expect(copy.translationKey).toBe('');
  });

  it('is always a draft, even when copied from a published post', () => {
    expect(source.status).toBe('published');
    expect(copy.status).toBe('draft');
  });

  // This previously asserted only on `coordinates` — the ONE field that is a
  // fresh literal regardless — so it passed while every carried-over structure
  // (images, stops, keyFacts, heroImage) was still shared by reference with the
  // source. Check the carried ones, which are the ones that can actually alias.
  it('does not alias the source objects (editing the copy cannot mutate the original)', () => {
    const c = api.duplicatePayload(source, slugs, TODAY);

    c.shared.coordinates.lat = 99;
    expect(source.shared.coordinates.lat).toBe(63.43);

    c.de.images['https://img/x/y']!.alt = 'mutated';
    expect(source.de.images['https://img/x/y']!.alt).toBe('Fjord');

    c.de.heroImage.alt = 'mutated';
    expect(source.de.heroImage.alt).toBe('Fjord');

    c.shared.stops![0]!.name = 'mutated';
    expect(source.shared.stops![0]!.name).toBe('Trondheim');

    c.de.keyFacts!['Währung'] = 'mutated';
    expect(source.de.keyFacts!['Währung']).toBe('NOK');
  });

  it('carries structures by value, not by reference', () => {
    const c = api.duplicatePayload(source, slugs, TODAY);
    expect(c.de.images).toEqual(source.de.images);
    expect(c.de.images).not.toBe(source.de.images);
    expect(c.shared.stops).not.toBe(source.shared.stops);
    expect(c.de.keyFacts).not.toBe(source.de.keyFacts);
    expect(c.de.heroImage).not.toBe(source.de.heroImage);
  });
});

describe('PostsDuplicate.slugError', () => {
  const api = load();

  it('accepts two distinct valid slugs', () => {
    expect(api.slugError({ de: 'a-b', en: 'c-d' })).toBeNull();
  });

  it('rejects blanks — the copy must never be created without slugs', () => {
    expect(api.slugError({ de: '', en: 'x' })).toMatch(/German slug is required/);
    expect(api.slugError({ de: 'x', en: '  ' })).toMatch(/English slug is required/);
    expect(api.slugError(null)).toMatch(/required/);
  });

  it('rejects slugs the server would reject anyway (fail before creating anything)', () => {
    expect(api.slugError({ de: 'Über-Uns', en: 'x' })).toMatch(/Invalid German slug/);
    expect(api.slugError({ de: 'a', en: 'a/b' })).toMatch(/Invalid English slug/);
    expect(api.slugError({ de: '-leading', en: 'x' })).toMatch(/Invalid German slug/);
  });

  it('flags identical DE and EN slugs', () => {
    expect(api.slugError({ de: 'same', en: 'same' })).toMatch(/should differ/);
  });
});

describe('the duplicate round-trips through the real store', () => {
  const api = load();

  it('saves as a new draft alongside the source, leaving it untouched', async () => {
    const store = memoryPostStore();
    const created = await store.upsertDraft(source);
    await store.publish(created.translationKey);

    const payload = api.duplicatePayload(
      (await store.get(created.translationKey))!, slugs, TODAY,
    );
    expect(() => validateDraft(payload)).not.toThrow();
    const copy = await store.upsertDraft(payload);

    expect(copy.translationKey).not.toBe(created.translationKey);
    expect(copy.status).toBe('draft');
    expect(copy.de.slug).toBe('schweden-2026');
    // The source is untouched — still published, still on its own slugs.
    const original = await store.get(created.translationKey);
    expect(original).toMatchObject({ status: 'published' });
    expect(original?.de.slug).toBe('norwegen-2024');
    expect(await store.list()).toHaveLength(2);
  });

  it('cannot steal the source\'s slug — the store rejects it with duplicate_slug', async () => {
    const store = memoryPostStore();
    await store.upsertDraft(source);
    const clash = api.duplicatePayload(source, { de: 'norwegen-2024', en: 'x-2026' }, TODAY);
    await expect(store.upsertDraft(clash)).rejects.toMatchObject({ code: 'duplicate_slug' });
  });

  it('never inherits published status or a slug lock', async () => {
    const store = memoryPostStore();
    const created = await store.upsertDraft(source);
    await store.publish(created.translationKey);
    const copy = await store.upsertDraft(api.duplicatePayload(source, slugs, TODAY));
    // A draft's slug can still be changed; a published post's cannot.
    const renamed = await store.upsertDraft({ ...copy, de: { ...copy.de, slug: 'anders-2026' } });
    expect(renamed.de.slug).toBe('anders-2026');
  });
});

describe('posts.html duplicate wiring', () => {
  const page = readFileSync('public/posts.html', 'utf8');

  it('loads the extracted module rather than inlining the copy semantics', () => {
    expect(page).toContain('<script src="/admin/posts-duplicate.js"></script>');
    expect(page).toContain('PostsDuplicate.duplicatePayload(');
    expect(page).toContain('PostsDuplicate.slugError(');
  });

  it('asks for both slugs before creating anything', () => {
    const dup = page.slice(page.indexOf('async function duplicatePost'), page.indexOf('// ---- bulk actions'));
    expect(dup.indexOf('slugError')).toBeLessThan(dup.indexOf("fetch('/posts'"));
  });

  it('reuses POST /posts — no new endpoint', () => {
    expect(page).toContain("fetch('/posts', {");
    expect(page).not.toContain('/posts/duplicate');
  });
});
