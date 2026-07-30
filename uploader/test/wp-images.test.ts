import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createRehostResume, rehostImage } from '../src/wp-images.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'wpimg-')); });

/** Re-host one image into `dir` so the resume index has something real to find. */
async function seed(key: string, width = 800, height = 600): Promise<void> {
  const jpeg = await sharp({ create: { width, height, channels: 3, background: '#345' } }).jpeg().toBuffer();
  const fetchImpl = (async () => new Response(new Uint8Array(jpeg))) as unknown as typeof fetch;
  await rehostImage('https://wp/seed.jpg', key, 'a', { storageDir: dir, baseUrl: 'https://img.example', fetchImpl });
}

describe('rehostImage', () => {
  it('downloads, processes via the pipeline, and returns src + dimensions', async () => {
    const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#345' } }).jpeg().toBuffer();
    const fetchImpl = (async () => new Response(new Uint8Array(jpeg))) as unknown as typeof fetch;
    const r = await rehostImage('https://wp/x.jpg', 'trips/t/body', 'Alt', { storageDir: dir, baseUrl: 'https://img.example', fetchImpl });
    expect(r.src).toBe('https://img.example/trips/t/body');
    expect(r.width).toBe(800);
    expect(r.height).toBe(600);
    // @ai-warning: rehost keys are deliberately NOT content-hash versioned
    // (unlike /upload — issue #26): deterministic {key}-{width}.{format} names
    // keep WXR re-imports idempotent. Do not route this through contentHashKey.
    const files = await readdir(join(dir, 'trips', 't'));
    expect(files.sort()).toEqual([
      'body-640.avif',
      'body-640.webp',
      'body-800.avif',
      'body-800.webp',
      'body-orig.jpg', // the untouched original is persisted next to the variants (issue #21)
    ]);
  });
  it('throws on a non-200 download', async () => {
    const fetchImpl = (async () => new Response('missing', { status: 404 })) as unknown as typeof fetch;
    await expect(rehostImage('https://wp/missing.jpg', 'trips/t/x', 'a', { storageDir: dir, baseUrl: 'https://img.example', fetchImpl })).rejects.toThrow(/404/);
  });
  it('refuses to fetch internal addresses (SSRF guard)', async () => {
    const fetchImpl = (async () => new Response(new Uint8Array(1))) as unknown as typeof fetch;
    await expect(rehostImage('http://169.254.169.254/latest/meta-data/', 'trips/t/x', 'a', { storageDir: dir, baseUrl: 'https://img.example', fetchImpl })).rejects.toThrow(/internal/i);
  });
});

/**
 * Resumability for issue #85 is DERIVED FROM DISK — there is no state file. The
 * importer's keys are deterministic and un-hashed (every other write path adds
 * `-<hash8>` via contentHashKey), so /data/images is itself the record of what
 * has already been re-hosted.
 *
 * @ai-context docs/superpowers/specs/2026-07-30-wxr-import-hardening-design.md
 *   §Resumability.
 */
describe('createRehostResume', () => {
  it('resolves a complete variant set to the dimensions read off disk', async () => {
    await seed('trips/t/strand', 1000, 750);
    const resume = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await resume.lookup('trips/t/strand')).toEqual({
      src: 'https://img.example/trips/t/strand', width: 1000, height: 750,
    });
  });

  it('resolves nothing for a key that was never re-hosted', async () => {
    await seed('trips/t/strand');
    const resume = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await resume.lookup('trips/t/never')).toBeNull();
    expect(await resume.lookup('trips/other/strand')).toBeNull();
  });

  // The pair-scoping invariant of wp-import.ts:23-37 ("deleting one trip cannot
  // strip another's images") now holds STRUCTURALLY: the slug is inside the key.
  it('keeps two trips separate even for the same photo', async () => {
    await seed('trips/a/shared');
    const resume = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await resume.lookup('trips/a/shared')).not.toBeNull();
    expect(await resume.lookup('trips/b/shared')).toBeNull();
  });

  // Fail-closed: a crashed encode or an ENOSPC leaves a PARTIAL variant set, and
  // storeVariantFiles has no cleanup on failure. Trusting it would attach a photo
  // whose srcset points at files that were never written.
  it('refuses an incomplete variant set so it gets re-fetched', async () => {
    await seed('trips/t/partial', 1000, 750);
    await rm(join(dir, 'trips', 't', 'partial-640.avif'));
    const resume = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await resume.lookup('trips/t/partial')).toBeNull();
  });

  /**
   * The partial set a crash ACTUALLY leaves.
   *
   * @ai-warning storeVariants writes the original first, then variants in
   * ascending width (pipeline.ts's `for (const w of variantWidths(width))`), so a
   * SIGKILL / OOM / ENOSPC truncates the TOP widths. If the expected set is
   * derived from the largest surviving variant, such a set is byte-for-byte
   * indistinguishable from a complete set for a smaller photo — it resumes with
   * silently downscaled dimensions and never re-fetches, on this run or any
   * later one. Deleting a MIDDLE file does not exercise this; deleting from the
   * top does. The intrinsic width must come from the retained original.
   */
  it('refuses a set truncated at the top, which is the shape a crash leaves', async () => {
    await seed('trips/t/cut', 1000, 750); // widths 640, 1000
    await rm(join(dir, 'trips', 't', 'cut-1000.webp'));
    const resume = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await resume.lookup('trips/t/cut')).toBeNull();
  });

  it('refuses a set truncated a whole width short of the original', async () => {
    await seed('trips/t/cut2', 1400, 1000); // widths 640, 1280, 1400
    for (const f of ['cut2-1400.webp', 'cut2-1400.avif']) await rm(join(dir, 'trips', 't', f));
    const resume = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await resume.lookup('trips/t/cut2')).toBeNull();
  });

  it('refuses every truncation point of an interrupted variant write', async () => {
    await seed('trips/t/kill', 1400, 1000);
    const written = ['kill-640.avif', 'kill-640.webp', 'kill-1280.avif', 'kill-1280.webp', 'kill-1400.avif', 'kill-1400.webp'];
    // Walk backwards through the write order; every prefix must fail closed.
    for (let keep = written.length - 1; keep >= 0; keep--) {
      await rm(join(dir, 'trips', 't', written[keep]!));
      const resume = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
      expect(await resume.lookup('trips/t/kill'), `after ${keep} of 6 variants written`).toBeNull();
    }
  });

  // The original is the only independent record of the intrinsic width, so
  // without it a set cannot be shown complete.
  it('refuses a set whose original is gone', async () => {
    await seed('trips/t/noorig', 1000, 750);
    await rm(join(dir, 'trips', 't', 'noorig-orig.jpg'));
    const resume = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await resume.lookup('trips/t/noorig')).toBeNull();
  });

  it('refuses a variant that exists but is unreadable', async () => {
    await seed('trips/t/empty', 1000, 750);
    await writeFile(join(dir, 'trips', 't', 'empty-1000.webp'), '');
    const resume = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await resume.lookup('trips/t/empty')).toBeNull();
  });

  // The hero key encodes NO url identity, so disk cannot tell "the featured image
  // I already fetched" from "a different one now in that slot". Always re-fetch.
  it('never resumes the hero slot', async () => {
    await seed('trips/t/hero');
    const resume = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await resume.lookup('trips/t/hero')).toBeNull();
    // ...but a body image merely *named* hero-something is fine.
    await seed('trips/t/hero-shot');
    const again = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await again.lookup('trips/t/hero-shot')).not.toBeNull();
  });

  // src is derived from the LIVE baseUrl, never stored. This is what makes a
  // database portable between environments (cf. #88 on the site side).
  it('derives src from the baseUrl it was given, not from disk', async () => {
    await seed('trips/t/strand', 1000, 750);
    const local = await createRehostResume({ storageDir: dir, baseUrl: 'http://localhost:3000' });
    expect((await local.lookup('trips/t/strand'))?.src).toBe('http://localhost:3000/trips/t/strand');
  });

  it('resolves nothing at all when the storage dir does not exist yet', async () => {
    const resume = await createRehostResume({ storageDir: join(dir, 'nope'), baseUrl: 'https://img.example' });
    expect(await resume.lookup('trips/t/strand')).toBeNull();
  });

  it('rejects a key that could escape the storage dir', async () => {
    const resume = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await resume.lookup('../../etc/passwd')).toBeNull();
  });

  // The case above would also pass on a plain miss, so it does not pin the guard.
  // Here the complete set IS on disk under a key assertSafeKey must reject
  // (`_priv` fails the leading-[a-z0-9] rule), so only the guard can return null.
  it('rejects an unsafe key even when its files are present', async () => {
    await seed('trips/t/strand', 1000, 750);
    await rename(join(dir, 'trips'), join(dir, '_priv'));
    const resume = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await resume.lookup('_priv/t/strand')).toBeNull();
    // control: the same set under a safe key resolves, so the null above is the guard
    await rename(join(dir, '_priv'), join(dir, 'trips'));
    const ok = await createRehostResume({ storageDir: dir, baseUrl: 'https://img.example' });
    expect(await ok.lookup('trips/t/strand')).not.toBeNull();
  });
});
