import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { processImage } from './pipeline.js';
import { contentHashKey, storeVariants, type StorageOptions, type StoredImage } from './storage.js';
import type { Dump } from './backup.js';
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

/** One line from stdin. Resolves '' when stdin closes without a line (EOF /
 * Ctrl-D, or a spawned process with stdin closed) — `question()` alone never
 * settles in that case, so it is raced against 'close'. */
async function promptLine(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const closed = new Promise<string>((res) => rl.once('close', () => res('')));
    return await Promise.race([rl.question(question), closed]);
  } finally {
    rl.close();
  }
}

/** `host:port/dbname` for the confirmation summary — never the credentials. */
function describeDatabase(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

const RESTORE_TABLES = ['users', 'posts', 'pages', 'media', 'media_folders'] as const;
type RowCounts = Record<(typeof RESTORE_TABLES)[number], number>;

/** `users 3, posts 12, …` — the same shape for the dump and for the live rows,
 * so the operator compares them column by column. */
function formatCounts(c: RowCounts): string {
  return RESTORE_TABLES.map((t) => `${t} ${c[t]}`).join(', ');
}

/** Parse `restore [--yes] <file>`; the flag may appear on either side of the path. */
export function parseRestoreArgs(args: string[]): { yes: boolean; file: string | undefined } {
  const yes = args.includes('--yes');
  const rest = args.filter((a) => a !== '--yes');
  return { yes, file: rest[0] };
}

/**
 * Destructive: replaces users/posts/pages/media in the live database. Order is
 * load-bearing (issue #114, spec 2026-09-05-restore-cli-confirmation-design.md):
 * refuse a bad filename or unrestorable version BEFORE connecting, show what is
 * about to be replaced, require confirmation, write a pre-restore dump, and
 * only then run the transaction. Every early exit leaves the database untouched.
 */
async function restoreMain(args: string[]): Promise<void> {
  const { yes, file } = parseRestoreArgs(args);
  if (!file) {
    // @ai-warning: the DHI runtime image has no shell, so `docker compose exec`
    // must invoke node directly — `tsx src/cli.ts ...` cannot run there.
    console.error(
      'usage: docker compose exec app node --import tsx src/cli.ts restore [--yes] /data/backup/db/db-YYYYMMDD-HHmmss.json.gz\n' +
      '       (bare dev: npx tsx src/cli.ts restore [--yes] <file>)\n' +
      '       --yes skips the interactive confirmation; a pre-restore dump is written either way.',
    );
    process.exit(1);
  }
  // Lazy like every subcommand here: `uploadFile` is imported by tests and by
  // the upload path, neither of which should load pg.
  const { BACKUP_FILE_RE, BackupError, dumpDatabase, readDump, restoreDatabase } = await import('./backup.js');
  if (!BACKUP_FILE_RE.test(basename(file))) {
    console.error(`refusing to restore ${file}: the file name must match db-YYYYMMDD-HHmmss.json.gz. nothing was changed.`);
    process.exit(1);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required for restore.');
    process.exit(1);
  }
  let dump: Dump;
  try {
    dump = readDump(file);
  } catch (e) {
    const reason = e instanceof BackupError ? e.message : `cannot read dump (${e instanceof Error ? e.message : String(e)})`;
    console.error(`refusing to restore ${file}: ${reason}. nothing was changed.`);
    process.exit(1);
  }
  const dumpCounts: RowCounts = {
    users: dump.tables.users.length, posts: dump.tables.posts.length,
    pages: dump.tables.pages?.length ?? 0, media: dump.tables.media?.length ?? 0,
    media_folders: dump.tables.media_folders?.length ?? 0,
  };
  const { createPool } = await import('./db.js');
  const pool = createPool(databaseUrl);
  try {
    const live = {} as RowCounts;
    for (const t of RESTORE_TABLES) {
      live[t] = Number((await pool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
    }
    console.log(`target database: ${describeDatabase(databaseUrl)}`);
    console.log(`dump:            ${file} (v${dump.version}, created ${dump.createdAt}) — ${formatCounts(dumpCounts)}`);
    console.log(`about to REPLACE the live rows: ${formatCounts(live)} — and invalidate every session.`);
    if (!yes) {
      const answer = await promptLine("type 'yes' to continue (or pass --yes): ");
      if (answer.trim() !== 'yes') {
        console.error('aborted; nothing was changed.');
        process.exitCode = 1;
        return;
      }
    }
    // Golden Rule 3: a dump of the state being replaced lands next to the
    // scheduled backups BEFORE the first DELETE. A restore that cannot be
    // undone is not run. `dumpDatabase` never reuses an existing name, so
    // neither the file being restored (a back-to-back undo) nor an earlier
    // pre-dump can be overwritten by this one.
    const backupDir = join(process.env.BACKUP_DIR ?? '/data/backup', 'db');
    let preDump: string;
    try {
      preDump = resolve(backupDir, await dumpDatabase(pool, backupDir));
    } catch (e) {
      console.error(`pre-restore dump into ${backupDir} failed (${e instanceof Error ? e.message : String(e)}); restore aborted, nothing was changed.`);
      process.exitCode = 1;
      return;
    }
    console.log(`pre-restore dump written: ${preDump}`);
    const counts = await restoreDatabase(pool, file);
    console.log(`restored ${counts.users} users, ${counts.posts} posts, ${counts.pages} pages, and ${counts.media} media rows (all sessions invalidated).`);
    console.log(`to undo: restore --yes ${preDump}`);
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
    password = await promptLine('New password (input is echoed): ');
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
  if (process.argv[2] === 'restore') return restoreMain(process.argv.slice(3));
  if (process.argv[2] === 'set-password') return setPasswordMain(process.argv[3], process.argv[4]);
  const [, , file, key, alt = ''] = process.argv;
  if (!file || !key) {
    console.error('usage: npm run upload -- <imageFile> <key> [alt]   |   docker compose exec app node --import tsx src/cli.ts restore [--yes] /data/backup/db/<file>   |   docker compose exec app node --import tsx src/cli.ts set-password <username> [newPassword]   |   docker compose exec app node --import tsx src/cli.ts audit-exif');
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
