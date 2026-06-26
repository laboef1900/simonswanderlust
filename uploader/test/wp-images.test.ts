import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { rehostImage } from '../src/wp-images.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'wpimg-')); });

describe('rehostImage', () => {
  it('downloads, processes via the pipeline, and returns src + dimensions', async () => {
    const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#345' } }).jpeg().toBuffer();
    const fetchImpl = (async () => new Response(new Uint8Array(jpeg))) as unknown as typeof fetch;
    const r = await rehostImage('https://wp/x.jpg', 'trips/t/body', 'Alt', { storageDir: dir, baseUrl: 'https://img.example', fetchImpl });
    expect(r.src).toBe('https://img.example/trips/t/body');
    expect(r.width).toBe(800);
    expect(r.height).toBe(600);
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
