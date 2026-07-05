import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { uploadFile, resetPassword } from '../src/cli.js';
import { memoryUserStore, verifyPassword } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';

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
