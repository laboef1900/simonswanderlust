import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { uploadFile, resetPassword, triggerRebuild } from '../src/cli.js';
import { memoryUserStore, verifyPassword, PasswordPolicyError } from '../src/users.js';
import { memorySessionStore } from '../src/sessions.js';
import { SESSION_COOKIE } from '../src/authn.js';
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

  it('can use a snapped JPEG profile and includes the discriminator in its result', async () => {
    const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#222' } })
      .jpeg().toBuffer();
    const stored = await uploadFile(img, 'trips/test/jpeg', 'A test', {
      storageDir: dir, baseUrl: 'https://img.simonswanderlust.com',
    }, { convertJpeg: false, webpQuality: 80, avifQuality: 60 });
    expect(stored.format).toBe('jpeg');
    expect(stored.snippet).toContain("format: 'jpeg'");
    expect((await readdir(join(dir, 'trips', 'test'))).sort()).toEqual([
      expect.stringMatching(/^jpeg-[0-9a-f]{8}-640\.jpeg$/),
      expect.stringMatching(/^jpeg-[0-9a-f]{8}-800\.jpeg$/),
      expect.stringMatching(/^jpeg-[0-9a-f]{8}-orig\.jpg$/),
    ]);
  });

  it('the CLI entry point reads the persisted conversion setting', async () => {
    const imagePath = join(dir, 'input.jpg');
    const settingsPath = join(dir, 'settings.json');
    const storageDir = join(dir, 'images');
    await writeFile(imagePath, await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#345' },
    }).jpeg().toBuffer());
    await writeFile(settingsPath, JSON.stringify({ convertJpeg: false }));
    const result = await runCli(
      [imagePath, 'trips/test/from-settings', 'Alt'],
      {
        ...envWithoutDatabaseUrl(),
        STORAGE_DIR: storageDir,
        SETTINGS_PATH: settingsPath,
        PUBLIC_BASE_URL: 'https://img.example',
      },
    );
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain("format: 'jpeg'");
    expect((await readdir(join(storageDir, 'trips/test'))).sort()).toEqual([
      expect.stringMatching(/^from-settings-[0-9a-f]{8}-640\.jpeg$/),
      expect.stringMatching(/^from-settings-[0-9a-f]{8}-800\.jpeg$/),
      expect.stringMatching(/^from-settings-[0-9a-f]{8}-orig\.jpg$/),
    ]);
  }, 30_000);

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
    const u = await users.create({ username: 'Simon', password: 'old-password-1', isAdmin: true });
    const token = await sessions.create(u.id, 60_000);
    await resetPassword(users, sessions, 'simon', 'new-password-1');
    const after = await users.findById(u.id);
    expect(verifyPassword('new-password-1', after!.passwordHash)).toBe(true);
    expect(verifyPassword('old-password-1', after!.passwordHash)).toBe(false);
    expect(await sessions.find(token)).toBeNull();
  });

  it('throws for an unknown username', async () => {
    await expect(resetPassword(memoryUserStore(), memorySessionStore(), 'ghost', 'password123456'))
      .rejects.toThrow('user not found');
  });

  it('rejects a policy-violating password and keeps the old one working (#109)', async () => {
    // The documented lockout-recovery path used to accept `set-password simon x`.
    const users = memoryUserStore();
    const sessions = memorySessionStore();
    const u = await users.create({ username: 'simon', password: 'old-password-1', isAdmin: true });
    const token = await sessions.create(u.id, 60_000);
    await expect(resetPassword(users, sessions, 'simon', 'x')).rejects.toBeInstanceOf(PasswordPolicyError);
    expect(verifyPassword('old-password-1', (await users.findById(u.id))!.passwordHash)).toBe(true);
    expect(await sessions.find(token)).not.toBeNull();
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
    // this pins the Promise.race('close') fallback and the policy guard on ''.
    const r = await runCli(['set-password', 'simon'],
      { ...process.env, DATABASE_URL: 'postgres://nobody:nope@127.0.0.1:1/nope' });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('New password');
    expect(r.stderr).toContain('the new password must be between 12 and 1024 characters');
  }, 30_000);

  it('a too-short argv password exits 1 before any database work (#109)', async () => {
    const r = await runCli(['set-password', 'simon', 'x'],
      { ...process.env, DATABASE_URL: 'postgres://nobody:nope@127.0.0.1:1/nope' });
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe('the new password must be between 12 and 1024 characters.');
  }, 30_000);
});

// Wiring tests for restoreMain's pre-connection guards (issue #114). Every one
// fires before a pool is created, so no DATABASE_URL is needed — and the
// filename check is asserted to fire even WITHOUT one, i.e. before the env guard.
describe('restore CLI wiring (spawned process)', () => {
  it('prints usage (with --yes) and exits 1 when the file is missing', async () => {
    const r = await runCli(['restore'], envWithoutDatabaseUrl());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('restore [--yes] /data/backup/db/db-YYYYMMDD-HHmmss.json.gz');
  }, 30_000);

  it('refuses a file name outside BACKUP_FILE_RE before touching env or database', async () => {
    for (const bad of ['/data/backup/db/state.json', 'images-20260101-000000.tar', 'db-20260101-000000.json.gz.bak']) {
      const r = await runCli(['restore', '--yes', bad], envWithoutDatabaseUrl());
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('the file name must match db-YYYYMMDD-HHmmss.json.gz');
      expect(r.stderr).not.toContain('DATABASE_URL');
    }
  }, 30_000);

  it('accepts --yes after the path too, then stops at the missing DATABASE_URL', async () => {
    const r = await runCli(['restore', 'db-20260101-000000.json.gz', '--yes'], envWithoutDatabaseUrl());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DATABASE_URL is required for restore');
  }, 30_000);
});

/*
 * `triggerRebuild` mints an admin session, spends it on one request, and must
 * revoke it whatever happens. The transport is injected, so these exercise the
 * contract rather than a socket; `rebuild CLI wiring` below covers the argv and
 * env guards in a real process.
 */
describe('triggerRebuild', () => {
  async function withAdmin() {
    const users = memoryUserStore();
    const sessions = memorySessionStore();
    await users.create({ username: 'author', password: 'password123456', isAdmin: false });
    await users.create({ username: 'boss', password: 'password123456', isAdmin: true });
    return { users, sessions };
  }

  it('spends an admin session on the request and returns the release', async () => {
    const { users, sessions } = await withAdmin();
    let seen = '';
    const release = await triggerRebuild(users, sessions, async (cookie) => {
      seen = cookie;
      // The session must be live AT THE MOMENT the app would resolve it.
      const token = cookie.slice(`${SESSION_COOKIE}=`.length);
      const session = await sessions.find(token);
      expect(session, 'the cookie the app receives resolves to no session').not.toBeNull();
      const admin = await users.findByUsername('boss');
      expect(session?.userId, 'the session belongs to a non-admin').toBe(admin?.id);
      return { status: 200, body: JSON.stringify({ ok: true, release: '1789-7-0000' }) };
    });
    expect(release).toBe('1789-7-0000');
    expect(seen.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    // Revoked: the token must not outlive the one request it was minted for.
    expect(await sessions.find(seen.slice(`${SESSION_COOKIE}=`.length))).toBeNull();
  });

  it('revokes the session even when the build fails or the socket dies', async () => {
    for (const transport of [
      async () => ({ status: 200, body: JSON.stringify({ ok: false, error: 'astro build timed out' }) }),
      async () => ({ status: 403, body: 'forbidden' }),
      async () => ({ status: 200, body: 'not json at all' }),
      () => Promise.reject(new Error('ECONNRESET')),
    ]) {
      const { users, sessions } = await withAdmin();
      const created: string[] = [];
      const spy = { ...sessions, create: async (id: string, ttl: number) => {
        const t = await sessions.create(id, ttl);
        created.push(t);
        return t;
      } };
      await expect(triggerRebuild(users, spy, transport)).rejects.toThrow();
      expect(created).toHaveLength(1);
      expect(await sessions.find(created[0]!), 'a failed rebuild leaked its session').toBeNull();
    }
  });

  it('reports a failed build instead of reading 200 as success', async () => {
    const { users, sessions } = await withAdmin();
    await expect(
      triggerRebuild(users, sessions, async () => ({
        status: 200,
        body: JSON.stringify({ ok: false, error: 'trips/de/x.mdx: country is required' }),
      })),
    ).rejects.toThrow('country is required');
  });

  it('refuses when no admin exists, without minting anything', async () => {
    const users = memoryUserStore();
    const sessions = memorySessionStore();
    await users.create({ username: 'author', password: 'password123456', isAdmin: false });
    let called = false;
    await expect(
      triggerRebuild(users, sessions, async () => { called = true; return { status: 200, body: '{}' }; }),
    ).rejects.toThrow('no admin user');
    expect(called).toBe(false);
  });
});

describe('rebuild CLI wiring (spawned process)', () => {
  it('stops at the missing DATABASE_URL rather than guessing a database', async () => {
    const r = await runCli(['rebuild'], envWithoutDatabaseUrl());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('DATABASE_URL is required for rebuild');
  }, 30_000);

  it('lists rebuild in the usage when no subcommand matches', async () => {
    const r = await runCli([], envWithoutDatabaseUrl());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('src/cli.ts rebuild');
  }, 30_000);
});
