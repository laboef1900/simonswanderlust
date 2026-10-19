import { describe, expect, it } from 'vitest';
import { loadGalleryMetadata } from '../src/gallery-metadata.js';
import { memoryMediaStore, type MediaStore } from '../src/media-store.js';
import type { ImageDims, PostLocale } from '../src/posts.js';

// The draft preview and the alt audit resolve current Media-library gallery
// text through this one function (2026-10-19 gallery-library-metadata spec).
const BASE = 'https://img.example.com';
const exif = { takenAt: null, camera: null, lens: null, lat: 51.5, lng: -0.1 };
const dims: ImageDims = { width: 800, height: 600, alt: 'Kopie', caption: 'Kopie' };

function loc(locale: 'de' | 'en', images: Record<string, ImageDims>): PostLocale {
  return {
    locale, slug: locale, title: 't', excerpt: 'e', country: 'c',
    heroImage: { src: `${BASE}/trips/x/hero`, width: 9, height: 9, alt: 'h' },
    bodyMarkdown: '', images,
  };
}

async function seeded() {
  const store = memoryMediaStore({ baseUrl: BASE });
  await store.upsert({
    key: 'trips/x/lib', status: 'ready', width: 800, height: 600, origBytes: 1, exif, uploadedBy: 'simon',
    title: 'Library label', alt: { de: 'Alt DE', en: 'Alt EN' }, caption: { de: 'Text DE', en: 'Text EN' },
  });
  await store.upsert({ key: 'trips/x/blank', status: 'ready', width: 800, height: 600, origBytes: 1, exif, uploadedBy: null });
  return store;
}

describe('loadGalleryMetadata', () => {
  it('keys each locale by the exact images-map URL, honours blank rows, and omits URLs without a row', async () => {
    const store = await seeded();
    const meta = await loadGalleryMetadata({
      de: loc('de', { [`${BASE}/trips/x/lib`]: dims, [`${BASE}/trips/x/blank`]: dims, [`${BASE}/trips/x/legacy`]: dims }),
      en: loc('en', { [`${BASE}/trips/x/lib`]: dims }),
    }, store, BASE);
    expect([...meta.de]).toEqual([
      [`${BASE}/trips/x/lib`, { alt: 'Alt DE', caption: 'Text DE' }],
      [`${BASE}/trips/x/blank`, { alt: '', caption: '' }],
    ]);
    expect(meta.en.get(`${BASE}/trips/x/lib`)).toEqual({ alt: 'Alt EN', caption: 'Text EN' });
    // Only alt/caption leave the store — no title fallback, GPS or uploader.
    expect(JSON.stringify([...meta.de, ...meta.en])).not.toMatch(/Library label|51\.5|simon/);
  });

  it('asks the store once, only for exact base URLs on the image origin', async () => {
    const store = await seeded();
    const asked: string[][] = [];
    const spy: Pick<MediaStore, 'descriptions'> = {
      descriptions: async (keys) => { asked.push(keys); return store.descriptions(keys); },
    };
    const meta = await loadGalleryMetadata({
      de: loc('de', {
        [`${BASE}/trips/x/lib`]: dims,
        [`${BASE}/trips/x/lib-1280.webp`]: dims,          // a variant URL is not a base URL
        ['https://img.example.com.evil.test/trips/x/lib']: dims,
        ['https://old.example/trips/x/lib']: dims,
      }),
      en: loc('en', { [`${BASE}/trips/x/lib`]: dims }),
    }, spy, `${BASE}/`);
    expect(asked).toEqual([['trips/x/lib', 'trips/x/lib-1280.webp']]);
    expect([...meta.de.keys()]).toEqual([`${BASE}/trips/x/lib`]);
  });

  it('skips the store entirely when no image is ours', async () => {
    const spy: Pick<MediaStore, 'descriptions'> = { descriptions: async () => { throw new Error('unexpected'); } };
    const meta = await loadGalleryMetadata({ de: loc('de', {}), en: loc('en', {}) }, spy, BASE);
    expect(meta.de.size + meta.en.size).toBe(0);
  });

  it('propagates a store failure instead of falling back to stale copies', async () => {
    const spy: Pick<MediaStore, 'descriptions'> = { descriptions: async () => { throw new Error('db down'); } };
    await expect(loadGalleryMetadata({ de: loc('de', { [`${BASE}/trips/x/lib`]: dims }), en: loc('en', {}) }, spy, BASE))
      .rejects.toThrow('db down');
  });
});
