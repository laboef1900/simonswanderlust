import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeKey, contentHashKey, storeVariants } from '../src/storage.js';
import type { ProcessResult } from '../src/pipeline.js';

const result: ProcessResult = {
  width: 2000,
  height: 1000,
  variants: [
    { width: 640, format: 'avif', data: Buffer.from('a') },
    { width: 640, format: 'webp', data: Buffer.from('b') },
    { width: 2000, format: 'avif', data: Buffer.from('c') },
    { width: 2000, format: 'webp', data: Buffer.from('d') },
  ],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgstore-'));
});

describe('storeVariants', () => {
  it('writes one file per variant under the key path', async () => {
    await storeVariants('trips/bucharest-2024/hero', 'Old town', result, {
      storageDir: dir,
      baseUrl: 'https://img.simonswanderlust.com',
    });
    const files = await readdir(join(dir, 'trips', 'bucharest-2024'));
    expect(files.sort()).toEqual([
      'hero-2000.avif',
      'hero-2000.webp',
      'hero-640.avif',
      'hero-640.webp',
    ]);
  });

  it('rejects keys that try to escape the storage dir (path traversal)', async () => {
    for (const bad of ['../evil', 'trips/../../etc/x', '/abs/path', 'trips/./x', 'a\\b']) {
      await expect(
        storeVariants(bad, 'a', result, { storageDir: dir, baseUrl: 'https://img.example' }),
      ).rejects.toThrow(/key/i);
    }
    // nothing should have been written outside the storage dir
    const files = await readdir(dir);
    expect(files).toEqual([]);
  });

  it('returns the heroImage YAML snippet', async () => {
    const stored = await storeVariants('trips/x/hero', "O'Brien's view", result, {
      storageDir: dir,
      baseUrl: 'https://img.simonswanderlust.com/',
    });
    expect(stored.src).toBe('https://img.simonswanderlust.com/trips/x/hero');
    expect(stored.snippet).toBe(
      [
        'heroImage:',
        "  src: 'https://img.simonswanderlust.com/trips/x/hero'",
        '  width: 2000',
        '  height: 1000',
        "  alt: 'O''Brien''s view'",
      ].join('\n'),
    );
  });
});

describe('contentHashKey', () => {
  it('is deterministic: same key + same bytes give the same result', () => {
    const buf = Buffer.from('same-bytes');
    expect(contentHashKey('trips/x/hero', buf)).toBe(contentHashKey('trips/x/hero', buf));
  });

  it('different bytes give different suffixes (re-upload mints a new key)', () => {
    expect(contentHashKey('trips/x/hero', Buffer.from('photo one'))).not.toBe(
      contentHashKey('trips/x/hero', Buffer.from('photo two')),
    );
  });

  it('appends 8 lowercase hex chars and stays a safe key', () => {
    const versioned = contentHashKey('trips/x/hero', Buffer.from('img'));
    expect(versioned).toMatch(/^trips\/x\/hero-[0-9a-f]{8}$/);
    expect(() => assertSafeKey(versioned)).not.toThrow();
  });

  it('does not launder traversal-shaped keys — storeVariants still rejects them', async () => {
    const versioned = contentHashKey('../evil', Buffer.from('img'));
    await expect(
      storeVariants(versioned, 'a', result, { storageDir: dir, baseUrl: 'https://img.example' }),
    ).rejects.toThrow(/key/i);
  });
});
