import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { uploadFile } from '../src/cli.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgcli-'));
});

describe('uploadFile', () => {
  it('processes a buffer and writes variants, returning the snippet', async () => {
    const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#222' } })
      .jpeg().toBuffer();
    const stored = await uploadFile(img, 'trips/test/hero', 'A test', {
      storageDir: dir, baseUrl: 'https://img.simonswanderlust.com',
    });
    // Keys are content-hash versioned (issue #26): hero-<hash8>-<width>.<fmt>.
    // Extract the hash once and pin the exact file set so every variant must
    // carry the SAME suffix and no width/format pairing can go missing.
    const files = await readdir(join(dir, 'trips', 'test'));
    const hash = files[0]?.match(/^hero-([0-9a-f]{8})-/)?.[1];
    expect(hash).toBeDefined();
    expect(files.sort()).toEqual([
      `hero-${hash}-640.avif`,
      `hero-${hash}-640.webp`,
      `hero-${hash}-800.avif`,
      `hero-${hash}-800.webp`,
    ]);
    expect(stored.snippet).toContain(`src: 'https://img.simonswanderlust.com/trips/test/hero-${hash}'`);
  });

  it('a different image under the same key mints a new hash; the first files stay on disk', async () => {
    const imgA = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#222' } })
      .jpeg().toBuffer();
    const imgB = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#eee' } })
      .jpeg().toBuffer();
    const opts = { storageDir: dir, baseUrl: 'https://img.simonswanderlust.com' };
    const a = await uploadFile(imgA, 'trips/test/hero', 'A', opts);
    const b = await uploadFile(imgB, 'trips/test/hero', 'B', opts);
    expect(b.src).not.toBe(a.src);
    // idempotent: identical bytes reuse the same URL
    const a2 = await uploadFile(imgA, 'trips/test/hero', 'A', opts);
    expect(a2.src).toBe(a.src);
    // both uploads' variant sets coexist — nothing was overwritten or deleted
    const files = await readdir(join(dir, 'trips', 'test'));
    expect(files).toHaveLength(8);
    expect(files.filter((f) => a.files.some((rel) => rel.endsWith(f)))).toHaveLength(4);
  });
});
