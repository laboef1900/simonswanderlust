import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildServer } from './server.js';
import { createSettingsStore, defaultSettings } from './settings.js';
import { createPool } from './db.js';
import { pgUserStore } from './users.js';
import { pgSessionStore } from './sessions.js';
import { pgPostStore } from './posts.js';
import { pgPageStore } from './pages.js';
import { reportNamespaceCollisions } from './namespace-report.js';
import { bootstrapRelease, createSiteBuilder } from './build.js';
import { createDbBackup, createRouteManifestPinReader, isBackupDue, resolveBackupDir, dumpDatabase } from './backup.js';
import { createImportRunner, pgImportJobStore } from './import-jobs.js';
import { createShutdown } from './shutdown.js';
import { makeDbCheck } from './health.js';
import { createWorkLock } from './work-lock.js';
import { pgMediaStore } from './media-store.js';
import { createEncodeQueue } from './encode-queue.js';
import { pgUploadReceiptStore } from './upload-receipts.js';
import { createUploadService } from './upload-service.js';
import { createMediaSync, createReconciler } from './media-sync.js';
import { parseEncryptionKey, pgSecretsStore } from './secrets.js';
import { LEGACY_AI_KEY_SLOT, slotFor } from './ai-providers.js';
import { pgCommentStore } from './comments.js';
import { pgCommentAdminStore } from './comments-admin.js';
import { acquireDataOwner } from './data-owner.js';
import { createGpxFiles } from './gpx-files.js';
import { createGpxWorker } from './gpx-worker.js';
import { createPublicTrackWorker } from './gpx-public-worker.js';
import { createGpxService } from './gpx-service.js';
import { pgSiteIdentityStore } from './site-identity.js';
import { captureBootEvidence, initializeApplicationSchema, initializeOnboarding } from './onboarding-bootstrap.js';
import { pgOnboardingStore } from './onboarding.js';
import { LEGACY_REVIEW_PROMPT } from './site-identity-legacy.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required; refusing to start without it.');
  process.exit(1);
}

// Validate before connecting/migrating. Absence disables only optional remote AI.
const encryptionKey = parseEncryptionKey(process.env.ENCRYPTION_KEY);
if (encryptionKey === undefined) console.info('ENCRYPTION_KEY not configured in .env; encrypted remote AI credentials are unavailable.');

// Every app/restore entry point acquires the stable filesystem lock before PG.
const storageDir = process.env.STORAGE_DIR ?? '/data/images';
const owner = await acquireDataOwner(databaseUrl, { role: 'app', storageDir });
const runtime = { signal: owner.signal, isWritable: owner.isWritable };
const settingsPath = process.env.SETTINGS_PATH ?? join(dirname(storageDir), 'settings.json');
const siteDir = resolve(process.env.SITE_DIR ?? '/data/site');
const backupDir = resolveBackupDir();
const settings = createSettingsStore({ path: settingsPath, defaults: defaultSettings() });

const pool = createPool(databaseUrl, owner.applicationName);
pool.on('error', () => console.error('Application database connection unavailable.'));
const bootEvidence = await captureBootEvidence(pool, owner.assertWritable);
// A logical pre-migration recovery set precedes the first language schema write.
// Fresh databases have no content to back up; partial boot migrations stay recoverable.
const languageMigration = await pool.query<{ posts: string | null; language: string | null; omitted: boolean; constraint_present: boolean; navigation: string | null }>(`
  SELECT to_regclass('posts')::text AS posts, to_regclass('site_language')::text AS language,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='posts' AND column_name='omitted') AS omitted,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('posts') AND conname='posts_omitted_unpublished') AS constraint_present,
    to_regclass('site_nav')::text AS navigation
`);
const migration = languageMigration.rows[0]!;
if (migration.posts && (!migration.language || !migration.omitted || !migration.constraint_present || !migration.navigation)) {
  const migrationFiles = createGpxFiles({ storageDir, isWritable: owner.isWritable });
  await dumpDatabase(pool, join(resolveBackupDir(), 'db'), new Date(), {
    routeFiles: migrationFiles, isWritable: owner.isWritable, preLanguageMigration: true, prePagesMigration: true,
  });
  owner.assertWritable();
}
await initializeApplicationSchema(pool, owner.assertWritable);
await initializeOnboarding(pool, { storageDir, settingsPath, backupDir, siteDir }, bootEvidence, owner.assertWritable);
await reportNamespaceCollisions(pool, (message) => console.warn(message));
const identityStore = await pgSiteIdentityStore(pool);
const secrets = pgSecretsStore(pool, encryptionKey);
// AI provider registry migration (spec §5), before listen(): copy the legacy
// shared key to every provider that already received it, THEN persist the
// derived settings. A crash in between reruns to the same ids; a failure here
// fails boot exactly as an unreachable ensureSchema does.
const aiMigration = settings.pendingAiMigration();
if (aiMigration) await secrets.migrateLegacyKey(LEGACY_AI_KEY_SLOT, aiMigration.keyedProviderIds.map(slotFor));
if (identityStore.get().seedSource === 'legacy') settings.preserveLegacyReviewPrompt(LEGACY_REVIEW_PROMPT);
if (aiMigration) {
  settings.completeAiMigration();
  console.log(`settings: migrated AI settings to the provider registry (${settings.get().aiProviders.length} providers)`);
}
const users = pgUserStore(pool);
const sessions = pgSessionStore(pool);
await mkdir(dirname(resolve(storageDir)), { recursive: true, mode: 0o700 });
owner.assertWritable();
const routeFiles = createGpxFiles({ storageDir, isWritable: owner.isWritable });
await routeFiles.assertRoot();
const publicTrackWorker = createPublicTrackWorker();
const posts = pgPostStore(pool, { routeFiles, isWritable: owner.isWritable, publicTrackWorker });
const pages = pgPageStore(pool);
// issue #92: a job the previous process left `running` is marked interrupted
// BEFORE listen(), so no request can observe a stale row as "busy".
const importJobs = createImportRunner({ store: pgImportJobStore(pool, runtime), ...runtime });
await importJobs.recover();
owner.assertWritable();

const baseUrl = process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com';
let imgHost: string;
try {
  imgHost = process.env.IMG_HOST ?? new URL(baseUrl).host;
} catch {
  console.error(`PUBLIC_BASE_URL is not a valid URL (set IMG_HOST explicitly): ${baseUrl}`);
  process.exit(1);
}
// siteDir is resolved before onboarding classification and shared with the builder.
// @ai-warning: ONE lock instance, shared by the builder and the encode queue.
// `astro build` and sharp both peak around 2 GB in a container with no
// mem_limit headroom to spare, so they must never run at the same time; the
// build takes it exclusively and preempts the encode backlog (work-lock.ts).
// Constructing a second lock here would silently remove that protection.
const workLock = createWorkLock();
const builder = createSiteBuilder({
  siteAppDir: process.env.SITE_APP_DIR ?? '/app/site',
  releasesRoot: siteDir,
  lock: workLock,
  pool,
  ...runtime,
  applicationName: owner.applicationName + ':build',
});
// Ownership is acquired above; only this owner may interpret a persisted run as interrupted.
owner.assertWritable();
await builder.initialize();
const media = pgMediaStore(pool, { baseUrl });
const uploadReceipts = pgUploadReceiptStore(pool);
const encodeQueue = createEncodeQueue({
  store: media, storageDir, lock: workLock, ...runtime,
  canRecover: async (key) => !await uploadReceipts.hasPendingMedia(key),
});
const reconciler = createReconciler({
  sync: createMediaSync({
    store: media,
    storageDir,
    baseUrl,
    corpus: async () => {
      const [postRows, pageKeys] = await Promise.all([posts.usageRows(), pages.keys()]);
      return { posts: postRows, pages: await Promise.all(pageKeys.map((k) => pages.get(k))) };
    },
  }),
  queue: encodeQueue,
});
const uploads = createUploadService({
  receipts: uploadReceipts, media, queue: encodeQueue, storageDir, baseUrl, settings, ...runtime,
});
// Establish bounded receipt recovery under exclusive native/PG ownership before
// accepting new requests. A failed pass fails boot rather than guessing ownership.
await reconciler.run();
await uploads.start();
owner.assertWritable();
const gpx = createGpxService({
  pool, files: routeFiles, worker: createGpxWorker(), backupDir: join(backupDir, 'db'),
  isWritable: owner.isWritable, readManifestPins: createRouteManifestPinReader(join(backupDir, 'db')),
});
const dbBackup = createDbBackup({
  db: pool,
  dir: join(backupDir, 'db'),
  retention: () => settings.get().backupRetention,
  storageDir, // scheduled/on-demand runs also write the incremental images tar
  routeFiles,
  ...runtime,
});
// A SIGKILLed archive leaves its multi-GB .tmp behind; reclaim it before the
// first run can stack another on top (#113).
dbBackup.sweepTempFiles();

// Hourly housekeeping: sweep expired sessions and run a due scheduled backup.
const housekeeping = () => {
  if (!owner.isWritable()) return;
  void sessions.sweepExpired().catch(() => {});
  if (isBackupDue(dbBackup.state(), settings.get().backupSchedule, Date.now())) {
    void dbBackup.runNow().then((s) => { if (s.lastError) console.error('scheduled backup failed:', s.lastError); })
      .catch(() => console.error('Scheduled backup stopped before completion.'));
  }
};
const housekeepingTimer = setInterval(housekeeping, 3_600_000);
housekeepingTimer.unref();

const app = buildServer({
  storageDir,
  baseUrl,
  imgHost,
  siteDir,
  mapDir: process.env.MAP_DIR ?? '/map-assets',
  users,
  sessions,
  settings,
  identityStore,
  language: posts.language,
  onboarding: pgOnboardingStore(pool, owner.isWritable),
  secrets,
  posts,
  pages,
  // Optional in ServerConfig so tests can omit them; omitted here, every
  // public and moderation comment route answers 503 in production.
  comments: pgCommentStore(pool),
  commentsAdmin: pgCommentAdminStore(pool),
  importJobs,
  media,
  encodeQueue,
  uploads,
  workLock,
  reconciler,
  builder,
  dbBackup,
  backupDir,
  dbCheck: makeDbCheck(() => pool.query('SELECT 1')),
  gpx,
  isWritable: owner.isWritable,
  storageSignal: owner.signal,
});

let quiescing: Promise<void> | undefined;
let poolEnding: Promise<void> | undefined;
const endPool = () => poolEnding ??= pool.end();
function quiesceWork(): Promise<void> {
  clearInterval(housekeepingTimer);
  return quiescing ??= Promise.allSettled([
    app.quiesceMutations(), uploads.quiesce(), gpx.close(), publicTrackWorker.close(), builder.quiesce(), encodeQueue.quiesce(), importJobs.quiesce(), dbBackup.quiesce(),
  ]).then((results) => {
    if (results.some((result) => result.status === 'rejected')) console.error('Background storage work stopped with errors; restart recovery is required.');
  });
}
function storageLost(): void {
  console.error('Storage ownership lost. Mutations are disabled until an owner-operated restart.');
  // Keep the HTTP/static server alive. Pool closure waits for guarded workers;
  // restore also refuses any app-tagged session that is still draining.
  void quiesceWork().then(endPool).catch(() => console.error('Database pool draining failed after storage ownership loss.'));
}
owner.signal.addEventListener('abort', storageLost, { once: true });
if (owner.signal.aborted) storageLost();

// Clean shutdown on docker stop / compose recreate: close the HTTP server,
// end the pg pool, exit 0 (any failure exits 1 — docker kills us anyway).
const onSignal = createShutdown({
  close: async () => { await Promise.all([app.close(), quiesceWork()]); },
  end: async () => { try { await endPool(); } finally { await owner.close(); } },
  exit: (code) => process.exit(code),
  log: (msg) => console.log(msg),
  error: (msg, err) => console.error(msg, err),
});
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: process.env.HOST ?? '0.0.0.0' })
  .then(() => {
    console.log(`app listening on :${port}`);
    // First boot on a fresh volume: populate the site in the background
    // (blog routes 503 until the release lands), retrying a failed build with
    // backoff (#110). Restarts against an existing release skip this.
    if (!builder.hasRelease()) void bootstrapRelease(builder, { log: (msg) => console.log(msg), ...runtime });
    housekeeping();
    if (owner.isWritable()) {
      void gpx.reconcile().catch(() => console.error('Private route reconciliation requires attention.'));
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
