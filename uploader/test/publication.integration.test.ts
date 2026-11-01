import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, ensureSchema } from '../src/db.js';
import { pgPostStore, type PostPair } from '../src/posts.js';
import { memoryMediaStore } from '../src/media-store.js';
import { createPublicationProjection } from '../src/publication.js';
import { createReleaseManifestReader } from '../src/release-manifest.js';
import { PUBLISHED_SNAPSHOT_DIGEST_SQL, type ReleaseManifestV1 } from '../../site/src/lib/publication-manifest.js';
import { publishTokens } from './publish-tokens.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
maybe('PostgreSQL content identity versus current release', () => {
  it('uses real snapshot digests across no-op saves, changed publish, rollback-style restore and restart', async () => {
    const pool = createPool(url!);
    const root = await mkdtemp(join(tmpdir(), 'publication-pg-'));
    const tk = randomUUID();
    const posts = pgPostStore(pool);
    try {
      await ensureSchema(pool);
      const pair: PostPair = { translationKey: tk, status: 'draft',
        shared: { date: '2026-10-29', countryCode: 'DE', region: 'europe', coordinates: { lat: 1, lng: 2 } },
        de: { locale: 'de', slug: `publication-de-${tk}`, title: 'Reise', country: 'Land', excerpt: 'Intro', bodyMarkdown: 'Original DE', images: {}, heroImage: { src: 'https://images.example/hero', width: 800, height: 600, alt: 'View' } },
        en: { locale: 'en', slug: `publication-en-${tk}`, title: 'Trip', country: 'Country', excerpt: 'Intro', bodyMarkdown: 'Original EN', images: {}, heroImage: { src: 'https://images.example/hero', width: 800, height: 600, alt: 'View' } },
      };
      const saved = await posts.upsertDraft(pair);
      await posts.publish(tk, await publishTokens(posts, tk));
      const mode = await posts.language.get();
      const original = await pool.query<{ locale: 'de' | 'en'; published_snapshot: Record<string, unknown> }>(
        'SELECT locale,published_snapshot FROM posts WHERE translation_key=$1', [tk]);
      async function promote(stamp: string) {
        // Query the same real PostgreSQL representation the loader renders;
        // no JS canonicalizer or synthetic memory digest participates.
        const { rows } = await pool.query<{ locale: 'de' | 'en'; slug: string; digest: string }>(
          `SELECT locale,published_snapshot->>'slug' AS slug,${PUBLISHED_SNAPSHOT_DIGEST_SQL} AS digest
             FROM posts WHERE translation_key=$1 AND status='published' AND published_snapshot IS NOT NULL AND locale=ANY($2::text[])`, [tk, mode.locales]);
        const manifest: ReleaseManifestV1 = { schema: 1, stamp, posts: rows.map((row) => ({ ...row, translationKey: tk, gallery: [] })) };
        await mkdir(join(root, 'manifests'), { recursive: true });
        await mkdir(join(root, 'releases', stamp), { recursive: true });
        await writeFile(join(root, 'manifests', `${stamp}.json`), JSON.stringify(manifest));
        await symlink(join('releases', stamp), join(root, 'next'));
        await rename(join(root, 'next'), join(root, 'current'));
      }
      await promote('1793000000000-1-0001');
      const reader = createReleaseManifestReader(root);
      const projection = createPublicationProjection({ posts, readRelease: () => reader.read(),
        media: memoryMediaStore({ baseUrl: 'https://images.example' }), imageBase: 'https://images.example' });
      const matchingLive = Object.fromEntries((['de', 'en'] as const).map((locale) => [locale, mode.locales.includes(locale) ? 'live' : 'not-live']));
      expect(await projection.one(tk)).toMatchObject({ draftDiffers: false, live: matchingLive });
      await posts.upsertDraft(saved);
      expect(await projection.one(tk)).toMatchObject({ draftDiffers: false, live: matchingLive });
      const current = (await posts.get(tk))!;
      await posts.upsertDraft({ ...current, [mode.primary]: { ...current[mode.primary], bodyMarkdown: 'Changed working content' } });
      expect(await projection.one(tk)).toMatchObject({ draftDiffers: true, live: matchingLive });
      await posts.publish(tk, await publishTokens(posts, tk));
      expect(await projection.one(tk)).toMatchObject({ draftDiffers: false, live: { [mode.primary]: 'older-version-live' } });
      await promote('1793000000001-1-0002');
      expect(await projection.one(tk)).toMatchObject({ live: matchingLive });
      // A restored historical snapshot can have an arbitrarily old published_at.
      // Only content identity, never wall-clock ordering, can identify this mismatch.
      const old = original.rows.find((row) => row.locale === mode.primary)!;
      await pool.query(`UPDATE posts SET published_snapshot=$3::jsonb,published_at='2000-01-01T00:00:00Z'
        WHERE translation_key=$1 AND locale=$2`, [tk, mode.primary, JSON.stringify(old.published_snapshot)]);
      const restarted = createReleaseManifestReader(root);
      const fresh = createPublicationProjection({ posts, readRelease: () => restarted.read(),
        media: memoryMediaStore({ baseUrl: 'https://images.example' }), imageBase: 'https://images.example' });
      expect(await fresh.one(tk)).toMatchObject({ draftDiffers: true, live: { [mode.primary]: 'older-version-live' } });
    } finally {
      await posts.remove(tk).catch(() => {});
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
