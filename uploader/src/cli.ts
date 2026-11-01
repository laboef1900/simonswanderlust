import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { SESSION_COOKIE } from './authn.js';
import { normalizeProcessOptions, processImage, type ProcessOptions } from './pipeline.js';
import { contentHashKey, storeVariants, type StorageOptions, type StoredImage } from './storage.js';
import { BACKUP_FILE_RE, BackupError, dumpDatabase, dumpLanguage, readDump, resolveBackupDir, restoreDatabase, validateIdentityAssets, IDENTITY_DUMP_VERSION, PAGES_NAV_DUMP_VERSION, pageRecoverySummary, type Dump } from './backup.js';
import { passwordPolicyViolation, type UserStore } from './users.js';
import type { SessionStore } from './sessions.js';
import { validateNavigation } from '../../site/src/lib/navigation.js';
import { createSettingsStore, defaultSettings } from './settings.js';
import { StorageReadOnlyError, type StorageOwner } from './storage-owner.js';
import { acquireDataOwner } from './data-owner.js';
import { createGpxFiles } from './gpx-files.js';
import { verifyRouteArchive, routeRecoverySummary } from './gpx-backup.js';
import { createPool, type DbPool } from './db.js';
import { readLanguage, type LanguageConfig } from './language.js';
import { prepareNativeRestore, restoreWithOnboarding } from './onboarding-restore.js';
import { publishRestoreFence } from './onboarding-fence.js';
import { buildFailureMessage, type BuildFailureCode } from './build-state.js';
import { configuredOriginRoles, validateCanonicalRoles, type OriginRoles } from './canonical-origin.js';

/** Reusable: process an in-memory image and store its variants.
 * Keys are content-hash versioned like POST /upload, so a re-upload mints a
 * new URL instead of overwriting immutable-cached variants (issue #26). */
export async function uploadFile(
  input: Buffer,
  key: string,
  alt: string,
  opts: StorageOptions,
  encoding: ProcessOptions = {},
): Promise<StoredImage> {
  const profile = normalizeProcessOptions(encoding);
  const result = await processImage(input, profile);
  return storeVariants(contentHashKey(key, input, profile), alt, result, opts);
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

const RESTORE_TABLES = ['users', 'posts', 'pages', 'media', 'media_folders', 'comments', 'post_routes', 'site_identity', 'site_identity_assets', 'site_language', 'site_nav', 'journeys', 'journey_locales', 'journey_members'] as const;
type RowCounts = Record<(typeof RESTORE_TABLES)[number], number>;

/** `users 3, posts 12, …` — the same shape for the dump and for the live rows,
 * so the operator compares them column by column. */
function formatCounts(c: RowCounts): string {
  return RESTORE_TABLES.map((t) => `${t} ${c[t]}`).join(', ');
}

/** Restore flags may appear on either side of the path. */
export function parseRestoreArgs(args: string[]): { yes: boolean; acceptLanguageChange: boolean; file: string | undefined } {
  const yes = args.includes('--yes');
  const acceptLanguageChange = args.includes('--accept-language-change');
  const rest = args.filter((a) => a !== '--yes' && a !== '--accept-language-change');
  return { yes, acceptLanguageChange, file: rest[0] };
}

export function requiresLanguageAcceptance(live: LanguageConfig & { lockedAt: Date | null }, restored: LanguageConfig): boolean {
  return live.lockedAt !== null && (live.primary !== restored.primary
    || live.locales.length !== restored.locales.length
    || live.locales.some(locale => !restored.locales.includes(locale)));
}

function describeLanguage(language: LanguageConfig): string {
  return `${language.locales.map(locale => locale.toUpperCase()).join('+')}, ${language.primary.toUpperCase()} primary`;
}

/**
 * Offline recovery: validate the set, acquire exclusive storage ownership,
 * refuse draining app sessions, confirm scope, verify an undo set, then replace
 * rows transactionally. The owner stops the app first and restarts it afterward.
 */
async function restoreMain(args: string[]): Promise<void> {
  const { yes, acceptLanguageChange, file } = parseRestoreArgs(args);
  if (!file) {
    console.error(
      'usage: docker compose stop app\n' +
      '       docker compose run --rm --no-deps --entrypoint node app --import tsx src/cli.ts restore [--yes] [--accept-language-change] /data/backup/db/db-YYYYMMDD-HHmmss.json.gz\n' +
      '       (bare dev: stop the app, then node --import tsx src/cli.ts restore [--yes] [--accept-language-change] <file>)\n' +
      '       --yes skips confirmation, never exclusive ownership, language-change acceptance or the verified pre-restore backup.',
    );
    process.exit(1);
  }
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
  let originRoles: OriginRoles;
  try {
    dump = readDump(file);
    originRoles = configuredOriginRoles();
    if (dump.version >= IDENTITY_DUMP_VERSION) validateCanonicalRoles(dump.tables.site_identity![0]!.canonical_origin, originRoles);
    await validateIdentityAssets(dump);
    await verifyRouteArchive(file, dump.routeArchive, dump.tables.post_routes ?? []);
  } catch (e) {
    const reason = e instanceof BackupError ? e.message : `cannot read dump (${e instanceof Error ? e.message : String(e)})`;
    console.error(`refusing to restore ${file}: ${reason}. nothing was changed.`);
    process.exit(1);
  }
  const dumpCounts: RowCounts = {
    users: dump.tables.users.length, posts: dump.tables.posts.length,
    pages: dump.tables.pages?.length ?? 0, media: dump.tables.media?.length ?? 0,
    media_folders: dump.tables.media_folders?.length ?? 0,
    comments: dump.tables.comments?.length ?? 0,
    post_routes: dump.tables.post_routes?.length ?? 0,
    site_identity: dump.version < IDENTITY_DUMP_VERSION ? 1 : dump.tables.site_identity!.length,
    site_identity_assets: dump.tables.site_identity_assets?.length ?? 0,
    site_language: 1,
    site_nav: dump.tables.site_nav?.length ?? 0,
    journeys: dump.tables.journeys?.length ?? 0,
    journey_locales: dump.tables.journey_locales?.length ?? 0,
    journey_members: dump.tables.journey_members?.length ?? 0,
  };
  const { createPool } = await import('./db.js');
  let owner: StorageOwner | undefined;
  let pool: DbPool | undefined;
  let admitted = false;
  try {
    const lease = owner = await acquireDataOwner(databaseUrl, { role: 'restore', storageDir: process.env.STORAGE_DIR ?? '/data/images' });
    const assertOwner = async () => {
      lease.assertWritable();
      await lease.assertNoAppSessions();
      lease.assertWritable();
    };
    await assertOwner();
    admitted = true;
    pool = createPool(databaseUrl, lease.applicationName);
    const routeFiles = createGpxFiles({ storageDir: process.env.STORAGE_DIR ?? '/data/images', isWritable: lease.isWritable });
    const live = {} as RowCounts;
    for (const t of RESTORE_TABLES) {
      live[t] = Number((await pool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
    }
    const liveLanguage = await readLanguage(pool);
    if (liveLanguage.lockedAt === null) {
      liveLanguage.lockedAt = (await pool.query<{ published_at: Date | null }>('SELECT min(published_at) AS published_at FROM posts')).rows[0]?.published_at ?? null;
    }
    const restoredLanguage = dumpLanguage(dump);
    console.log(`target database: ${describeDatabase(databaseUrl)}`);
    console.log(`dump:            ${file} (v${dump.version}, created ${dump.createdAt}) — ${formatCounts(dumpCounts)}`);
    console.log(`about to REPLACE the live rows: ${formatCounts(live)} — and invalidate every session.`);
    const retainedPages = dump.version < PAGES_NAV_DUMP_VERSION ? {
      navigation: validateNavigation((await pool.query('SELECT config FROM site_nav WHERE id=1')).rows[0]?.config),
      pages: dump.tables.pages ? [] : (await pool.query('SELECT * FROM pages')).rows,
    } : undefined;
    const pageRecovery = pageRecoverySummary(dump, retainedPages);
    console.log(`Unresolved navigation items after restore: ${pageRecovery.unresolvedNavigation}`);
    console.log(`Page namespace collisions after restore: ${pageRecovery.collisions.length ? pageRecovery.collisions.join(', ') : 'none'}`);
    console.log(dump.tables.app_secrets === undefined
      ? 'app_secrets preserved: absent from dump.'
      : `app_secrets: replace ${Number((await pool.query('SELECT count(*) AS n FROM app_secrets')).rows[0].n)} live rows with ${dump.tables.app_secrets.length} encrypted rows from dump.`);
    console.log('Encrypted credentials require their original master key; reconcile settings.json before using remote AI.');
    console.log(dump.version < IDENTITY_DUMP_VERSION
      ? 'identity: will restore the legacy brand (dump predates identity), keep the live canonical origin if set, and remove identity assets.'
      : 'identity: will replace the complete stored identity and assets, including retained locale values.');
    console.log(`language: live ${describeLanguage(liveLanguage)} (${liveLanguage.lockedAt ? 'locked' : 'unlocked'}); dump ${describeLanguage(restoredLanguage)}.`);
    if (requiresLanguageAcceptance(liveLanguage, restoredLanguage) && !acceptLanguageChange) {
      console.error('refusing a language-mode change on a locked install: pass --accept-language-change in addition to yes/--yes. nothing was changed.');
      process.exitCode = 1;
      return;
    }
    const recovery = routeRecoverySummary(dump.routeArchive);
    console.log(`Private routes: ${dumpCounts.post_routes}; originals: ${recovery.status} ` +
      `(present ${recovery.present}, missing ${recovery.missing}, corrupt ${recovery.corrupt}, unreadable ${recovery.unreadable}, oversized ${recovery.oversized}).`);
    console.log('Private recovery sets retain original locations and timestamps. Keep the app stopped until this command finishes.');
    console.log('Onboarding will be permanently retired for this data root, even if the admitted restore later fails or is undone.');
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
    const backupDir = join(resolveBackupDir(), 'db');
    let preDump: string;
    try {
      preDump = resolve(backupDir, await dumpDatabase(pool, backupDir, new Date(), { routeFiles, isWritable: owner.isWritable }));
      const undo = readDump(preDump);
      await validateIdentityAssets(undo);
      await verifyRouteArchive(preDump, undo.routeArchive, undo.tables.post_routes ?? []);
    } catch (e) {
      console.error(`pre-restore dump into ${backupDir} failed (${e instanceof Error ? e.message : String(e)}); restore aborted, nothing was changed.`);
      process.exitCode = 1;
      return;
    }
    console.log(`pre-restore recovery set verified: ${preDump}`);
    const counts = await restoreWithOnboarding(pool, file, {
      storageDir: process.env.STORAGE_DIR ?? '/data/images', routeFiles, assertOwner, originRoles,
    });
    console.log(`restored ${counts.users} users, ${counts.posts} posts, ${counts.pages} pages, ${counts.media} media rows, ${counts.comments} comments, ${counts.journeys} journeys (${dumpCounts.journey_locales} journey_locales, ${dumpCounts.journey_members} journey_members), and ${counts.routes} private routes (all sessions invalidated).`);
    console.log(counts.appSecrets === null ? 'app_secrets preserved.' : `restored ${counts.appSecrets} encrypted app_secrets rows.`);
    console.log(dump.version < IDENTITY_DUMP_VERSION
      ? 'identity: restored legacy brand (dump predates identity). Review Settings → Site identity'
      : 'identity: restored stored identity and assets. Public output updates at the next rebuild.');
    console.log(`to undo: restore --yes --accept-language-change ${preDump}`);
    console.log('Restart the app with the same data/settings configuration, then rebuild through /admin/settings.html → \"Rebuild site now\".');
  } catch (e) {
    // Only admission is guaranteed not to have written anything. Later restore
    // failures may have created an undo set or staged originals.
    if (!(e instanceof StorageReadOnlyError) || admitted) throw e;
    console.error(`refusing to restore ${file}: exclusive storage ownership and drained app database sessions could not be confirmed. Stop the app, wait for it to exit and its database sessions to drain, check database availability, then retry. nothing was changed.`);
    process.exitCode = 1;
  } finally {
    try { await pool?.end(); } finally { await owner?.close(); }
  }
}

async function onboardingRecoveryMain(command: 'onboarding-retire' | 'prepare-native-restore', args: string[]): Promise<void> {
  if (args.some((arg) => arg !== '--yes') || args.length > 1) throw new Error(`usage: ${command} [--yes]`);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for offline recovery.');
  const storageDir = process.env.STORAGE_DIR ?? '/data/images';
  const owner = await acquireDataOwner(databaseUrl, { role: 'restore', storageDir });
  let pool: DbPool | undefined;
  try {
    const assertOwner = async () => {
      owner.assertWritable();
      await owner.assertNoAppSessions();
      owner.assertWritable();
    };
    await assertOwner();
    console.log(`target database: ${describeDatabase(databaseUrl)}`);
    console.log(`target data root: ${dirname(resolve(storageDir))}`);
    console.log('Onboarding retirement is permanent. Keep app and maintenance writers stopped, with automatic restart disabled, through the entire recovery.');
    if (command === 'onboarding-retire') {
      await publishRestoreFence(storageDir, assertOwner);
      console.log('Retirement fence verified. No application schema or content was changed. This lease ends on exit; it does not guard subsequent SQL or filesystem recovery.');
    } else {
      pool = createPool(databaseUrl, owner.applicationName);
      const prepared = await prepareNativeRestore(pool, {
        storageDir, assertOwner,
        confirm: async () => args.includes('--yes') || (await promptLine("type 'yes' to permanently retire onboarding and prepare bootstrap defaults: ")).trim() === 'yes',
      });
      if (!prepared) { console.error('aborted; no retirement or initialization performed.'); process.exitCode = 1; return; }
      console.log('Offline initialization completed; onboarding is permanently retired. No undo set has been created or verified. Keep services stopped and run the ordinary native restore to capture and validate the actual target recovery set.');
    }
    await assertOwner();
  } finally {
    try { await pool?.end(); } finally { await owner.close(); }
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
  // Same rule as the web paths — the hash rejects it anyway, but checking here
  // fails before a pool is opened and prints one line instead of a stack (#109).
  const violation = passwordPolicyViolation(password);
  if (violation) {
    console.error(`the new ${violation}.`);
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

/** A 60s window is a whole build's worth of headroom for a request the CLI
 * makes and revokes in the same function. It is not a login. */
export const REBUILD_SESSION_TTL_MS = 60_000;

/** How `triggerRebuild` reaches the running app. Injected so the contract
 * below can be tested without a socket. */
export type RebuildTransport = (cookie: string) => Promise<{ status: number; body: string }>;

/**
 * Ask the RUNNING app to rebuild the site, as an admin, over loopback.
 *
 * @ai-warning It deliberately does NOT build here. `work-lock.ts` makes a site
 * build and image encoding mutually exclusive WITHIN ONE PROCESS, and
 * docker-compose.yml sizes `mem_limit` as `max(build, encode) + baseline`
 * (~4.4 GB) on exactly that assumption. A CLI that spawned its own
 * `astro build` would be a second, unlocked builder: concurrent with the
 * encode queue that is ~0.47 + 3.9 + 0.5 ≈ 4.9 GB against a 4.6 GB ceiling,
 * i.e. an OOM of the whole container — blog, admin, image host and the
 * in-flight build together. Two racing builders would also both flip the
 * `current` symlink and both prune `releases/`.
 *
 * @ai-note Minting a session for an existing admin is not a new trust
 * boundary: this same CLI already offers `set-password`, which takes over any
 * account outright, so anyone who can run it has more power than this. The
 * session lives for one request and is destroyed in `finally`, including when
 * the build fails or the socket dies.
 */
export async function triggerRebuild(
  users: UserStore,
  sessions: SessionStore,
  post: RebuildTransport,
): Promise<string> {
  const admin = (await users.list()).find((u) => u.isAdmin);
  if (!admin) throw new Error('no admin user exists yet — create one in the admin UI first');
  const token = await sessions.create(admin.id, REBUILD_SESSION_TTL_MS);
  try {
    const { status, body } = await post(`${SESSION_COOKIE}=${token}`);
    // /rebuild answers 200 with `{ ok: false, error }` for a FAILED build — a
    // status check alone would report a schema error as success.
    if (status !== 200) throw new Error(`the app answered ${status}: ${body.slice(0, 300)}`);
    let outcome: { ok?: boolean; release?: string; code?: unknown };
    try {
      outcome = JSON.parse(body) as typeof outcome;
    } catch {
      throw new Error(`the app answered 200 with a non-JSON body: ${body.slice(0, 300)}`);
    }
    if (!outcome.ok) {
      const code: BuildFailureCode = outcome.code === 'build_timeout' || outcome.code === 'build_failed'
        || outcome.code === 'build_unavailable' || outcome.code === 'no_space'
        || outcome.code === 'release_write_failed' || outcome.code === 'build_stopped'
        ? outcome.code : 'internal';
      throw new Error(`rebuild failed (${code}): ${buildFailureMessage(code)} — details: docker compose logs app`);
    }
    return outcome.release ?? '(unnamed release)';
  } finally {
    await sessions.destroy(token);
  }
}

/** Loopback POST with no client-side deadline: a build may legitimately run
 * for `BUILD_TIMEOUT_MS` (15 min) plus its wait for the exclusive lock, and
 * the route answers only when it is done. `node:http` is used rather than
 * `fetch` for exactly that reason — undici's 5-minute `headersTimeout` would
 * abort a long but healthy build, and raising it means taking on undici as a
 * direct dependency. */
function loopbackRebuild(port: number): RebuildTransport {
  return (cookie) => {
    // `settle`, not `resolve`: `resolve` is node:path's, imported at the top.
    const { promise, resolve: settle, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = request(
      { host: '127.0.0.1', port, path: '/rebuild', method: 'POST', headers: { cookie } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { body += c; });
        res.on('end', () => settle({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
    return promise;
  };
}

async function rebuildMain(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required for rebuild.');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 3000);
  const { createPool } = await import('./db.js');
  const { pgUserStore } = await import('./users.js');
  const { pgSessionStore } = await import('./sessions.js');
  const pool = createPool(databaseUrl);
  try {
    console.log(`rebuilding the site via the running app on 127.0.0.1:${port} — this can take a few minutes…`);
    const release = await triggerRebuild(pgUserStore(pool), pgSessionStore(pool), loopbackRebuild(port));
    console.log(`site rebuilt and released as ${release}.`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      (e as NodeJS.ErrnoException)?.code === 'ECONNREFUSED'
        // The one failure an operator will actually hit, and the fix is not obvious.
        ? `nothing is listening on 127.0.0.1:${port}. A rebuild runs INSIDE the app process, which holds ` +
          'the build/encode lock, so the app has to be up. Start it (`docker compose up -d app`); if there ' +
          'is no release at all yet, boot builds one by itself.'
        : msg,
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'audit-exif') return auditExifMain();
  if (process.argv[2] === 'restore') return restoreMain(process.argv.slice(3));
  if (process.argv[2] === 'onboarding-retire' || process.argv[2] === 'prepare-native-restore') {
    return onboardingRecoveryMain(process.argv[2], process.argv.slice(3));
  }
  if (process.argv[2] === 'set-password') return setPasswordMain(process.argv[3], process.argv[4]);
  if (process.argv[2] === 'rebuild') return rebuildMain();
  const [, , file, key, alt = ''] = process.argv;
  if (!file || !key) {
    // @ai-warning: the DHI runtime image has no shell, so `docker compose exec`
    // must invoke node directly — `tsx src/cli.ts ...` cannot run there.
    const exec = 'docker compose exec app node --import tsx src/cli.ts';
    const offline = 'docker compose run --rm --no-deps --entrypoint node app --import tsx src/cli.ts';
    console.error(
      'usage:\n' +
      '  npm run upload -- <imageFile> <key> [alt]\n' +
      `  ${exec} rebuild\n` +
      '  docker compose stop app\n' +
      `  (stop app and all writers first) ${offline} restore [--yes] /data/backup/db/db-YYYYMMDD-HHmmss.json.gz\n` +
      `  (offline) ${offline} prepare-native-restore [--yes]\n` +
      `  (offline) ${offline} onboarding-retire\n` +
      `  ${exec} set-password <username> [newPassword]\n` +
      `  ${exec} audit-exif`,
    );
    process.exit(1);
  }
  const opts: StorageOptions = {
    storageDir: process.env.STORAGE_DIR ?? './data/images',
    baseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
  };
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for offline upload.');
  const owner = await acquireDataOwner(databaseUrl, { role: 'restore', storageDir: opts.storageDir });
  try {
    await owner.assertNoAppSessions();
    const settingsPath = process.env.SETTINGS_PATH ?? join(dirname(opts.storageDir), 'settings.json');
    const current = createSettingsStore({ path: settingsPath, defaults: defaultSettings() }).get();
    const stored = await uploadFile(await readFile(file), key, alt, {
      ...opts, signal: owner.signal, isWritable: owner.isWritable,
    }, {
      convertJpeg: current.convertJpeg,
      webpQuality: current.webpQuality,
      avifQuality: current.avifQuality,
    });
    console.log(stored.snippet);
  } finally {
    await owner.close();
  }
}

// Run main only when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('cli.ts')) {
  await main();
}
