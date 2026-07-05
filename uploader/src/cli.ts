import { readFile } from 'node:fs/promises';
import { processImage } from './pipeline.js';
import { storeVariants, type StorageOptions, type StoredImage } from './storage.js';
import type { UserStore } from './users.js';
import type { SessionStore } from './sessions.js';

/** Reusable: process an in-memory image and store its variants. */
export async function uploadFile(
  input: Buffer,
  key: string,
  alt: string,
  opts: StorageOptions,
): Promise<StoredImage> {
  const result = await processImage(input);
  return storeVariants(key, alt, result, opts);
}

async function restoreMain(file: string | undefined): Promise<void> {
  if (!file) {
    console.error('usage: tsx src/cli.ts restore <db-YYYYMMDD-HHmmss.json.gz>');
    process.exit(1);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required for restore.');
    process.exit(1);
  }
  const { createPool } = await import('./db.js');
  const { restoreDatabase } = await import('./backup.js');
  const pool = createPool(databaseUrl);
  try {
    const counts = await restoreDatabase(pool, file);
    console.log(`restored ${counts.users} users, ${counts.posts} posts, and ${counts.pages} pages (all sessions invalidated).`);
    console.log('now rebuild the site: /admin/settings.html → "Rebuild site now" (or POST /rebuild).');
  } finally {
    await pool.end();
  }
}

/** Reusable: set a user's password and invalidate all of their sessions. */
export async function resetPassword(
  users: UserStore,
  sessions: SessionStore,
  username: string,
  password: string,
): Promise<void> {
  const user = await users.findByUsername(username);
  if (!user) throw new Error(`user not found: ${username}`);
  await users.setPassword(user.id, password);
  await sessions.destroyAllForUser(user.id);
}

async function setPasswordMain(username: string | undefined, passwordArg: string | undefined): Promise<void> {
  if (!username) {
    console.error('usage: tsx src/cli.ts set-password <username> [newPassword]   (prompts when newPassword is omitted; input is echoed)');
    process.exit(1);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required for set-password.');
    process.exit(1);
  }
  let password = passwordArg;
  if (password === undefined) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      // question() never settles if stdin closes without a line (EOF/Ctrl-D),
      // so race it against 'close' and fall through to the empty-password error.
      const closed = new Promise<string>((res) => rl.once('close', () => res('')));
      password = await Promise.race([rl.question('New password (input is echoed): '), closed]);
    } finally {
      rl.close();
    }
  }
  if (!password) {
    console.error('the new password must not be empty.');
    process.exit(1);
  }
  const { createPool } = await import('./db.js');
  const { pgUserStore } = await import('./users.js');
  const { pgSessionStore } = await import('./sessions.js');
  const pool = createPool(databaseUrl);
  try {
    await resetPassword(pgUserStore(pool), pgSessionStore(pool), username, password);
    console.log(`password updated for ${username}; all sessions for that user were invalidated.`);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'restore') return restoreMain(process.argv[3]);
  if (process.argv[2] === 'set-password') return setPasswordMain(process.argv[3], process.argv[4]);
  const [, , file, key, alt = ''] = process.argv;
  if (!file || !key) {
    console.error('usage: npm run upload -- <imageFile> <key> [alt]   |   tsx src/cli.ts restore <file>   |   tsx src/cli.ts set-password <username> [newPassword]');
    process.exit(1);
  }
  const opts: StorageOptions = {
    storageDir: process.env.STORAGE_DIR ?? './data/images',
    baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com',
  };
  const stored = await uploadFile(await readFile(file), key, alt, opts);
  console.log(stored.snippet);
}

// Run main only when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('cli.ts')) {
  await main();
}
