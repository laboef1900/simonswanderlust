import { readFile } from 'node:fs/promises';
import { processImage } from './pipeline.js';
import { contentHashKey, storeVariants, type StorageOptions, type StoredImage } from './storage.js';
import type { UserStore } from './users.js';
import type { SessionStore } from './sessions.js';

/** Reusable: process an in-memory image and store its variants.
 * Keys are content-hash versioned like POST /upload, so a re-upload mints a
 * new URL instead of overwriting immutable-cached variants (issue #26). */
export async function uploadFile(
  input: Buffer,
  key: string,
  alt: string,
  opts: StorageOptions,
): Promise<StoredImage> {
  const result = await processImage(input);
  return storeVariants(contentHashKey(key, input), alt, result, opts);
}

async function restoreMain(file: string | undefined): Promise<void> {
  if (!file) {
    // @ai-warning: the DHI runtime image has no shell, so `docker compose exec`
    // must invoke node directly — `tsx src/cli.ts ...` cannot run there.
    console.error(
      'usage: docker compose exec app node --import tsx src/cli.ts restore /data/backup/db/db-YYYYMMDD-HHmmss.json.gz\n' +
      '       (bare dev: npx tsx src/cli.ts restore <file>)',
    );
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
  } catch (e) {
    // A typo'd username is the expected failure in a lockout — print a clean
    // one-liner instead of a stack trace. process.exitCode (not exit()) lets
    // the finally block still close the pool before the process ends.
    if (e instanceof Error && e.message.startsWith('user not found')) {
      console.error(e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  } finally {
    await pool.end();
  }
}

async function auditExifMain(): Promise<void> {
  const { auditExif } = await import('./exif-audit.js');
  const storageDir = process.env.STORAGE_DIR ?? './data/images';
  const r = await auditExif(storageDir);
  console.log(`scanned ${r.variants} variant file(s) across ${r.keys} key(s) in ${storageDir}`);
  console.log(`  carrying EXIF      : ${r.withExif}`);
  console.log(`  carrying GPS       : ${r.withGps}  (checked EXIF and XMP)`);
  if (r.skippedDirs.length) {
    console.log(
      `\n${r.skippedDirs.length} director${r.skippedDirs.length === 1 ? 'y' : 'ies'} could not be read ` +
      'and were skipped (permission error or similar) — the counts above are a PARTIAL view of the corpus:',
    );
    for (const d of r.skippedDirs) console.log(`  ${d}`);
  }
  if (r.withGps === 0) {
    console.log(
      r.skippedDirs.length
        ? '\nNo GPS found (EXIF or XMP) in the readable part of the corpus, but the scan was partial ' +
          '(see above) — fix the permissions and re-run before concluding no rewrite is needed.'
        : '\nNo stored variant carries GPS, in EXIF or XMP. No rewrite is needed.',
    );
    return;
  }
  console.log(`\n${r.gpsKeys.length} key(s) publish coordinates:`);
  for (const k of r.gpsKeys) console.log(`  ${k}`);
  if (r.gpsKeysWithoutOriginal.length) {
    console.log(
      `\n${r.gpsKeysWithoutOriginal.length} of them have NO -orig file and can only be ` +
      're-encoded from an existing variant (one generation of quality loss):',
    );
    for (const k of r.gpsKeysWithoutOriginal) console.log(`  ${k}`);
  }
  console.log('\nBack up first, then: node --import tsx src/cli.ts strip-gps --dry-run');
}

async function main(): Promise<void> {
  if (process.argv[2] === 'audit-exif') return auditExifMain();
  if (process.argv[2] === 'restore') return restoreMain(process.argv[3]);
  if (process.argv[2] === 'set-password') return setPasswordMain(process.argv[3], process.argv[4]);
  const [, , file, key, alt = ''] = process.argv;
  if (!file || !key) {
    console.error('usage: npm run upload -- <imageFile> <key> [alt]   |   docker compose exec app node --import tsx src/cli.ts restore /data/backup/db/<file>   |   docker compose exec app node --import tsx src/cli.ts set-password <username> [newPassword]   |   docker compose exec app node --import tsx src/cli.ts audit-exif');
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
