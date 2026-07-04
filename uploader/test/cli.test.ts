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
    const files = await readdir(join(dir, 'trips', 'test'));
    expect(files).toHaveLength(4);
    for (const f of files) {
      expect(f).toMatch(/^hero-[0-9a-f]{8}-(640|800)\.(avif|webp)$/);
    }
    expect(stored.snippet).toMatch(/src: 'https:\/\/img\.simonswanderlust\.com\/trips\/test\/hero-[0-9a-f]{8}'/);
  });
});
