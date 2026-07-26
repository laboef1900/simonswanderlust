import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeKey, contentHashKey, storeVariants, storeOriginal, storeVariantFiles, isOriginalFile } from '../src/storage.js';
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
  original: { data: Buffer.from('original-bytes'), ext: 'jpg' },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgstore-'));
});

describe('storeVariants', () => {
  it('writes one file per variant plus the original under the key path', async () => {
    const stored = await storeVariants('trips/bucharest-2024/hero', 'Old town', result, {
      storageDir: dir,
      baseUrl: 'https://img.simonswanderlust.com',
    });
    const files = await readdir(join(dir, 'trips', 'bucharest-2024'));
    expect(files.sort()).toEqual([
      'hero-2000.avif',
      'hero-2000.webp',
      'hero-640.avif',
      'hero-640.webp',
      'hero-orig.jpg',
    ]);
    expect(stored.files).toContain('trips/bucharest-2024/hero-orig.jpg');
    const orig = await readFile(join(dir, 'trips', 'bucharest-2024', 'hero-orig.jpg'));
    expect(orig.equals(result.original.data)).toBe(true);
  });

  it('rejects an unsafe original extension and writes nothing for it', async () => {
    const evil: ProcessResult = { ...result, original: { data: Buffer.from('x'), ext: '../jpg' } };
    await expect(
      storeVariants('trips/x/hero', 'a', evil, { storageDir: dir, baseUrl: 'https://img.example' }),
    ).rejects.toThrow(/extension/i);
    expect(await readdir(dir)).toEqual([]);
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

describe('isOriginalFile', () => {
  it('matches original filenames but not variants or the base key', () => {
    expect(isOriginalFile('trips/x/hero-orig.jpg')).toBe(true);
    expect(isOriginalFile('/trips/x/hero-orig.png')).toBe(true);
    expect(isOriginalFile('a-orig.webp')).toBe(true);
    // Variants are `-<width>.<fmt>` and the base key has no `-orig.<ext>` suffix.
    expect(isOriginalFile('trips/x/hero-640.avif')).toBe(false);
    expect(isOriginalFile('trips/x/hero-2000.webp')).toBe(false);
    expect(isOriginalFile('trips/x/hero')).toBe(false);
    // A key ending in "-orig" still only excludes its actual original file.
    expect(isOriginalFile('trips/foo-orig-1280.webp')).toBe(false);
    expect(isOriginalFile('trips/foo-orig-orig.jpg')).toBe(true);
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

describe('storeOriginal / storeVariantFiles (the async-upload split)', () => {
  it('storeOriginal writes only the untouched original and returns its rel path', async () => {
    const rel = await storeOriginal('trips/x/hero', Buffer.from('raw-bytes'), 'jpg', { storageDir: dir });
    expect(rel).toBe('trips/x/hero-orig.jpg');
    expect(await readFile(join(dir, rel), 'utf8')).toBe('raw-bytes');
    // No variants yet — that is the whole point of returning before encoding.
    expect(await readdir(join(dir, 'trips/x'))).toEqual(['hero-orig.jpg']);
  });

  // @ai-warning: the traversal guard and the extension check live in
  // storeOriginal, which is what keeps it the single write chokepoint after
  // the split. Do not add a write path that bypasses it.
  it('storeOriginal keeps the traversal and extension guards', async () => {
    for (const key of ['../evil', 'Evil', 'a//b', 'a/../b']) {
      await expect(storeOriginal(key, Buffer.from('x'), 'jpg', { storageDir: dir })).rejects.toThrow(/unsafe storage key/);
    }
    await expect(storeOriginal('ok/key', Buffer.from('x'), '../sh', { storageDir: dir })).rejects.toThrow(/unsafe original extension/);
  });

  it('storeVariantFiles writes every variant and reports the total byte size', async () => {
    const out = await storeVariantFiles('trips/x/hero', result.variants, { storageDir: dir });
    expect(out.files).toEqual([
      'trips/x/hero-640.avif', 'trips/x/hero-640.webp',
      'trips/x/hero-2000.avif', 'trips/x/hero-2000.webp',
    ]);
    expect(out.bytes).toBe(4); // 1 byte per stub variant
  });

  it('storeVariantFiles rejects an unsafe key too', async () => {
    await expect(storeVariantFiles('../evil', result.variants, { storageDir: dir })).rejects.toThrow(/unsafe storage key/);
  });

  it('re-running storeVariantFiles overwrites the same filenames (idempotent re-encode)', async () => {
    // This is what makes a crash mid-encode self-heal on retry rather than
    // needing cleanup.
    await storeVariantFiles('trips/x/hero', result.variants, { storageDir: dir });
    await storeVariantFiles('trips/x/hero', result.variants, { storageDir: dir });
    expect(await readdir(join(dir, 'trips/x'))).toHaveLength(4);
  });
});
