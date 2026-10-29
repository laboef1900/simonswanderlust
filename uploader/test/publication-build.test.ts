import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSiteBuilder } from '../src/build.js';
import { createReleaseManifestReader } from '../src/release-manifest.js';
import { createPublicationProjection } from '../src/publication.js';
import { memoryPostStore, type PostPair } from '../src/posts.js';
import { memoryMediaStore } from '../src/media-store.js';
import { writeReleaseManifest, type ReleaseManifestV1 } from '../../site/src/lib/publication-manifest.js';
import { publishTokens } from './publish-tokens.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); vi.restoreAllMocks(); });
function story(): PostPair {
  return { translationKey: '', status: 'draft', shared: { date: '2026-10-29', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } },
    de: { locale: 'de', slug: 'reise', title: 'Reise', country: 'Land', excerpt: 'Intro', bodyMarkdown: 'Body', images: {}, heroImage: { src: 'https://images.example/hero', width: 800, height: 600, alt: 'View' } },
    en: { locale: 'en', slug: 'trip', title: 'Trip', country: 'Country', excerpt: 'Intro', bodyMarkdown: 'Body', images: {}, heroImage: { src: 'https://images.example/hero', width: 800, height: 600, alt: 'View' } },
  };
}

describe('queued build publication membership', () => {
  it.each([false, true])('does not infer inclusion from an earlier run; queued run fails: %s', async (failQueued) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), 'publication-build-')); roots.push(root);
    const siteAppDir = join(root, 'app'); await mkdir(siteAppDir);
    const releasesRoot = join(root, 'site');
    const posts = memoryPostStore();
    const saved = await posts.upsertDraft(story());
    const tk = saved.translationKey;
    const readFirst = Promise.withResolvers<void>();
    const finishFirst = Promise.withResolvers<void>();
    const enteredQueued = Promise.withResolvers<void>();
    const finishQueued = Promise.withResolvers<void>();
    let runs = 0;
    const builder = createSiteBuilder({ siteAppDir, releasesRoot,
      runBuild: async (outDir, manifestPath) => {
        const run = ++runs;
        // Capture once, as the real loader's exported snapshot does; never reread
        // after the gate to manufacture membership for the first build.
        const captured = await posts.publicationFacts();
        const entries: ReleaseManifestV1['posts'] = [];
        for (const row of captured) for (const locale of row.committedLocales) entries.push({
          translationKey: row.translationKey, locale, slug: saved[locale].slug, digest: row.rowDigest[locale]!, gallery: [],
        });
        if (run === 1) { readFirst.resolve(); await finishFirst.promise; }
        if (run === 2) { enteredQueued.resolve(); await finishQueued.promise; if (failQueued) throw new Error('child failed'); }
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, 'index.html'), entries.map((entry) => entry.locale).join(','));
        await writeReleaseManifest(entries, manifestPath);
      },
    });
    const reader = createReleaseManifestReader(releasesRoot);
    const projection = createPublicationProjection({ posts, readRelease: () => reader.read(), media: memoryMediaStore({ baseUrl: 'https://images.example' }), imageBase: 'https://images.example' });
    const first = builder.build('rebuild');
    await readFirst.promise;
    await posts.publish(tk, await publishTokens(posts, tk));
    const queued = builder.build('publish');
    finishFirst.resolve();
    const initialOutcome = await first;
    await enteredQueued.promise;
    expect(initialOutcome.ok).toBe(true);
    expect(await projection.one(tk)).toMatchObject({ status: 'published', live: { de: 'not-live', en: 'not-live' } });
    finishQueued.resolve();
    expect((await queued).ok).toBe(!failQueued);
    expect(await projection.one(tk)).toMatchObject({ live: {
      de: failQueued ? 'not-live' : 'live', en: failQueued ? 'not-live' : 'live',
    } });
    if (failQueued) expect((await builder.build('rebuild')).ok).toBe(true);
    const restartedReader = createReleaseManifestReader(releasesRoot);
    const restartedProjection = createPublicationProjection({ posts, readRelease: () => restartedReader.read(),
      media: memoryMediaStore({ baseUrl: 'https://images.example' }), imageBase: 'https://images.example' });
    expect(await restartedProjection.one(tk)).toMatchObject({ live: { de: 'live', en: 'live' } });
    expect(runs).toBe(failQueued ? 3 : 2);
    await builder.quiesce();
  });
});
