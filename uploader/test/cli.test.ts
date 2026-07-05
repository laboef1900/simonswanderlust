import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { uploadFile, resetPassword } from '../src/cli.js';
import { memoryUserStore, verifyPassword } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { runCli, envWithoutDatabaseUrl } from './run-cli.js';

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
    // Every variant carries the same hash suffix, plus the untouched original
    // (`-orig.<ext>`, issue #21) written next to them.
    expect(files.sort()).toEqual([
      `hero-${hash}-640.avif`,
      `hero-${hash}-640.webp`,
      `hero-${hash}-800.avif`,
      `hero-${hash}-800.webp`,
      `hero-${hash}-orig.jpg`,
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
    // both uploads' file sets coexist — nothing was overwritten or deleted
    // (each upload writes 4 variants + 1 untouched original = 5 files)
    const files = await readdir(join(dir, 'trips', 'test'));
    expect(files).toHaveLength(10);
    expect(files.filter((f) => a.files.some((rel) => rel.endsWith(f)))).toHaveLength(5);
  });
});

describe('resetPassword', () => {
  it('updates the hash (case-insensitive lookup) and destroys the user\'s sessions', async () => {
    const users = memoryUserStore();
    const sessions = memorySessionStore();
    const u = await users.create({ username: 'Simon', password: 'old-pw', isAdmin: true });
    const token = await sessions.create(u.id, 60_000);
    await resetPassword(users, sessions, 'simon', 'new-pw');
    const after = await users.findById(u.id);
    expect(verifyPassword('new-pw', after!.passwordHash)).toBe(true);
    expect(verifyPassword('old-pw', after!.passwordHash)).toBe(false);
    expect(await sessions.find(token)).toBeNull();
  });

  it('throws for an unknown username', async () => {
    await expect(resetPassword(memoryUserStore(), memorySessionStore(), 'ghost', 'pw'))
      .rejects.toThrow('user not found');
  });
});

// Wiring tests for setPasswordMain: spawn the CLI exactly as production invokes
// it. None of these paths reach the database — the guards (and the EOF-on-prompt
// fallback) all fire before a pool is created, so a bogus DATABASE_URL is fine.
describe('set-password CLI wiring (spawned process)', () => {
  it('prints usage and exits 1 when the username is missing', async () => {
    const r = await runCli(['set-password'], envWithoutDatabaseUrl());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('usage: tsx src/cli.ts set-password <username> [newPassword]');
  }, 30_000);

  it('exits 1 when DATABASE_URL is missing', async () => {
    const r = await runCli(['set-password', 'simon'], envWithoutDatabaseUrl());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DATABASE_URL is required for set-password');
  }, 30_000);

  it('EOF on the password prompt exits 1 cleanly instead of hanging', async () => {
    // runCli closes stdin immediately, so rl.question() sees EOF without a line —
    // this pins the Promise.race('close') fallback and the empty-password guard.
    const r = await runCli(['set-password', 'simon'],
      { ...process.env, DATABASE_URL: 'postgres://nobody:nope@127.0.0.1:1/nope' });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('New password');
    expect(r.stderr).toContain('the new password must not be empty');
  }, 30_000);
});
