import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { canonicalizeConditional, canonicalizePatch, type MediaConditional } from '../public/media-conditional.js';
import { memoryMediaStore } from '../src/media-store.js';

const seed = { key: 'photo', status: 'ready' as const, width: 800, height: 600, origBytes: 1,
  exif: { takenAt: null, camera: null, lens: null, lat: null, lng: null }, uploadedBy: null };
const makeStore = () => memoryMediaStore({ baseUrl: 'https://img.example' });
const envelope = (patch: unknown, expect: unknown) => ({ conditional: { version: 1, patch, expect } });

describe('shared Media conditional canonicalization', () => {
  it('uses the same persisted values for browser, internal store and conditional writes', async () => {
    const context = vm.createContext({ window: {} });
    // Execute the browser assignment in an isolated realm; exports are the only module syntax.
    vm.runInContext(readFileSync('public/media-conditional.js', 'utf8').replace(/^export /gm, ''), context);
    const browser = context.window.MediaConditional as { canonicalizePatch: typeof canonicalizePatch };
    const input = {
      title: '\u0000' + 'x'.repeat(1005), alt: { de: 'a\u200bb', en: ' EN ' },
      caption: { en: 'one\ntwo', de: '' }, folder: 'Patagonien Süd/Tag 1',
      tags: [' sea ', 'sea', '\u0000', 'x'.repeat(50), ...Array.from({ length: 40 }, (_, i) => `tag${i}`)],
    };
    const expected = canonicalizePatch(input);
    expect(browser.canonicalizePatch(input)).toEqual(expected);
    expect(expected.title).toHaveLength(1000);
    expect(expected.alt?.de).toBe('ab');
    expect(expected.caption?.en).toBe('onetwo');
    expect(expected.tags).toHaveLength(30);
    expect(expected.tags?.slice(0, 2)).toEqual(['sea', 'x'.repeat(40)]);
    const store = makeStore();
    await store.upsert(seed);
    expect(await store.patch('photo', input)).toMatchObject(expected);
    const conditional = canonicalizeConditional(envelope(input, input));
    expect(await store.patchConditional('photo', conditional)).toMatchObject(expected);
  });

  it('validates exact leaf sets and types before canonicalizing', () => {
    expect(canonicalizePatch({})).toEqual({});
    expect(canonicalizeConditional(envelope({ alt: { en: 'new', de: 'neu' } }, { alt: { de: '', en: '' } }))).toMatchObject({ version: 1 });
    for (const value of [
      null, [], {}, { title: 'legacy' },
      { ...envelope({ title: 'a' }, { title: '' }), title: 'legacy' },
      { conditional: { version: 2, patch: { title: 'a' }, expect: { title: '' } } },
      envelope({}, {}), envelope({ alt: {} }, { alt: {} }),
      envelope({ title: 'a' }, {}), envelope({ title: 'a' }, { title: '', tags: [] }),
      envelope({ alt: { de: 'a' } }, { alt: { en: '' } }),
      envelope({ alt: { fr: 'a' } }, { alt: { fr: '' } }),
      envelope({ tags: [1] }, { tags: [] }), envelope({ title: null }, { title: '' }),
      envelope({ title: 'a' }, { title: undefined }), envelope({ folder: 'A\u0301' }, { folder: '' }),
      envelope({ folder: '../bad' }, { folder: '' }), envelope({ status: 'ready' }, { status: 'ready' }),
    ]) expect(() => canonicalizeConditional(value)).toThrow();
  });
});

describe('memory conditional Media writes', () => {
  it('permits exactly one concurrent same-field writer with no partial writes or rejected folders', async () => {
    const store = makeStore();
    await store.upsert(seed);
    const results = await Promise.allSettled(['First', 'Second'].map((title) => store.patchConditional('photo', {
      version: 1, patch: { title, folder: title + '/Child' }, expect: { title: '', folder: '' },
    })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'media_changed' } });
    const saved = await store.get('photo');
    expect(saved?.folder).toBe(saved?.title + '/Child');
    expect(await store.folders()).toEqual([saved?.title, saved?.title + '/Child']);
  });

  it('allows concurrent unrelated locale writes and compares canonical expected values', async () => {
    const store = makeStore();
    await store.upsert({ ...seed, tags: ['sea'], title: 'ab' });
    await Promise.all([
      store.patchConditional('photo', { version: 1, patch: { alt: { de: 'DE' } }, expect: { alt: { de: '' } } }),
      store.patchConditional('photo', { version: 1, patch: { alt: { en: 'EN' } }, expect: { alt: { en: '' } } }),
    ]);
    const saved = await store.patchConditional('photo', {
      version: 1, patch: { title: 'c\u0000d', tags: ['next', 'next'] }, expect: { title: 'a\u0000b', tags: [' sea ', 'sea'] },
    });
    expect(saved).toMatchObject({ alt: { de: 'DE', en: 'EN' }, title: 'cd', tags: ['next'] });
  });

  it('refuses malformed input without mutation and distinguishes missing from conflict', async () => {
    const store = makeStore();
    const before = await store.upsert(seed);
    await expect(store.patchConditional('photo', { version: 1, patch: { title: 'new', folder: 'Created' }, expect: { title: '' } } as MediaConditional))
      .rejects.toThrow('invalid_media_conditional');
    expect(await store.get('photo')).toEqual(before);
    expect(await store.folders()).toEqual([]);
    await expect(store.patchConditional('missing', { version: 1, patch: { title: 'new' }, expect: { title: '' } }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});
