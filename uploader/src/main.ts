import { dirname, join, resolve } from 'node:path';
import { buildServer } from './server.js';
import { createSettingsStore, defaultSettings } from './settings.js';
import { createPool, ensureSchema } from './db.js';
import { pgUserStore } from './users.js';
import { pgSessionStore } from './sessions.js';
import { pgPostStore } from './posts.js';
import { pgPageStore } from './pages.js';
import { createSiteBuilder } from './build.js';
import { createDbBackup, isBackupDue } from './backup.js';
import { createShutdown } from './shutdown.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required; refusing to start without it.');
  process.exit(1);
}

const storageDir = process.env.STORAGE_DIR ?? '/data/images';
const settingsPath = process.env.SETTINGS_PATH ?? join(dirname(storageDir), 'settings.json');
const settings = createSettingsStore({ path: settingsPath, defaults: defaultSettings() });

const pool = createPool(databaseUrl);
await ensureSchema(pool);
const users = pgUserStore(pool);
const sessions = pgSessionStore(pool);
const posts = pgPostStore(pool);
const pages = pgPageStore(pool);

const baseUrl = process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com';
let imgHost: string;
try {
  imgHost = process.env.IMG_HOST ?? new URL(baseUrl).host;
} catch {
  console.error(`PUBLIC_BASE_URL is not a valid URL (set IMG_HOST explicitly): ${baseUrl}`);
  process.exit(1);
}
// Resolve once so a relative SITE_DIR (dev) can't produce broken relative
// symlink targets in the builder or an invalid @fastify/static root.
const siteDir = resolve(process.env.SITE_DIR ?? '/data/site');
const builder = createSiteBuilder({
  siteAppDir: process.env.SITE_APP_DIR ?? '/app/site',
  releasesRoot: siteDir,
});
const backupDir = process.env.BACKUP_DIR ?? '/data/backup';
const dbBackup = createDbBackup({
  db: pool,
  dir: join(backupDir, 'db'),
  retention: () => settings.get().backupRetention,
});

// Hourly housekeeping: sweep expired sessions and run a due scheduled backup.
const housekeeping = () => {
  void sessions.sweepExpired().catch(() => {});
  if (isBackupDue(dbBackup.state(), settings.get().backupSchedule, Date.now())) {
    void dbBackup.runNow().then((s) => { if (s.lastError) console.error('scheduled backup failed:', s.lastError); });
  }
};
setInterval(housekeeping, 3_600_000).unref();

const app = buildServer({
  storageDir,
  baseUrl,
  imgHost,
  siteDir,
  mapDir: process.env.MAP_DIR ?? '/map-assets',
  users,
  sessions,
  settings,
  posts,
  pages,
  builder,
  dbBackup,
  backupDir,
  dbCheck: async () => { await pool.query('SELECT 1'); },
});

// Clean shutdown on docker stop / compose recreate: close the HTTP server,
// end the pg pool, exit 0 (any failure exits 1 — docker kills us anyway).
const onSignal = createShutdown({
  close: () => app.close(),
  end: () => pool.end(),
  exit: (code) => process.exit(code),
  log: (msg) => console.log(msg),
  error: (msg, err) => console.error(msg, err),
});
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    console.log(`app listening on :${port}`);
    // First boot on a fresh volume: populate the site in the background
    // (blog routes 503 until the release lands). Restarts skip this.
    if (!builder.hasRelease()) {
      void builder.build().then((r) =>
        console.log(r.ok ? `initial build released ${r.release}` : `initial build failed: ${r.error}`));
    }
    housekeeping();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
