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
    const files = await readdir(join(dir, 'trips', 'test'));
    expect(files.sort()).toEqual(['hero-640.avif', 'hero-640.webp', 'hero-800.avif', 'hero-800.webp']);
    expect(stored.snippet).toContain("src: 'https://img.simonswanderlust.com/trips/test/hero'");
  });
});
