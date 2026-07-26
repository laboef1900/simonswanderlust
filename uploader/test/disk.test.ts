import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import {
  diskSpace, formatBytes, insufficientSpace, UPLOAD_HEADROOM_BYTES, UPLOAD_SIZE_FACTOR,
} from '../src/disk.js';

const GiB = 1024 ** 3;

describe('diskSpace', () => {
  it('reports plausible free and total bytes for a real path', async () => {
    const s = await diskSpace(tmpdir());
    expect(s.total).toBeGreaterThan(0);
    expect(s.free).toBeGreaterThanOrEqual(0);
    expect(s.free).toBeLessThanOrEqual(s.total);
  });

  it('rejects for a path that does not exist (callers must treat it as best-effort)', async () => {
    await expect(diskSpace('/definitely/not/a/real/path/xyz')).rejects.toBeTruthy();
  });
});

describe('insufficientSpace', () => {
  const space = (freeGiB: number) => ({ free: freeGiB * GiB, total: 100 * GiB });

  it('allows an upload with ample headroom', () => {
    expect(insufficientSpace(space(50), 10 * 1024 * 1024)).toBeNull();
  });

  it('refuses when free space is below the reserved headroom', () => {
    const msg = insufficientSpace(space(1), 10 * 1024 * 1024);
    expect(msg).toMatch(/not enough free disk space/);
  });

  // @ai-note: the threshold accounts for the FULL cost of a photo — the
  // retained original plus its whole variant set — not just the incoming
  // bytes, plus a floor that keeps a site build and a backup able to run.
  it('scales with the incoming size, not just the fixed floor', () => {
    const justOverFloor = UPLOAD_HEADROOM_BYTES + 1024;
    const tiny = { free: justOverFloor, total: 100 * GiB };
    expect(insufficientSpace(tiny, 100)).toBeNull();
    expect(insufficientSpace(tiny, 10 * 1024 * 1024)).toMatch(/not enough/);
    expect(UPLOAD_SIZE_FACTOR).toBeGreaterThan(1);
  });

  it('treats a negative incoming size as zero rather than shrinking the requirement', () => {
    expect(insufficientSpace(space(0), -1_000_000_000)).toMatch(/not enough/);
  });

  it('does not leak absolute paths or exact capacity internals into the message', () => {
    const msg = insufficientSpace(space(0), 1) ?? '';
    expect(msg).not.toContain('/data');
    expect(msg).not.toContain('statfs');
  });
});

describe('formatBytes', () => {
  it('renders human-readable sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1536)).toBe('1.5 kB');
    expect(formatBytes(5 * GiB)).toBe('5.0 GB');
    expect(formatBytes(120 * GiB)).toBe('120 GB');
  });

  it('degrades safely for nonsense input', () => {
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
  });
});
