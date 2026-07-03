import { dirname, join } from 'node:path';
import { buildServer } from './server.js';
import { createSettingsStore, defaultsFromEnv } from './settings.js';
import { createPool, ensureSchema } from './db.js';
import { pgUserStore } from './users.js';
import { pgSessionStore } from './sessions.js';
import { pgPostStore } from './posts.js';
import { createSiteBuilder } from './build.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required; refusing to start without it.');
  process.exit(1);
}

const storageDir = process.env.STORAGE_DIR ?? '/data/images';
const settingsPath = process.env.SETTINGS_PATH ?? join(dirname(storageDir), 'settings.json');
const settings = createSettingsStore({ path: settingsPath, defaults: defaultsFromEnv(process.env) });

const pool = createPool(databaseUrl);
await ensureSchema(pool);
const users = pgUserStore(pool);
const sessions = pgSessionStore(pool);
const posts = pgPostStore(pool);

// Periodically drop expired session rows (best-effort).
setInterval(() => { void sessions.sweepExpired().catch(() => {}); }, 3_600_000).unref();

// @ai-note: this is a minimal stopgap so `main.ts` keeps compiling against the
// new ServerConfig shape (Task 3 of docs/superpowers/plans/2026-07-03-single-app-container.md).
// Task 10 replaces this block wholesale with the full builder/backup/scheduler wiring.
const baseUrl = process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com';
const builder = createSiteBuilder({
  siteAppDir: process.env.SITE_APP_DIR ?? '/app/site',
  releasesRoot: process.env.SITE_DIR ?? '/data/site',
});

const app = buildServer({
  storageDir,
  baseUrl,
  imgHost: process.env.IMG_HOST ?? new URL(baseUrl).host,
  siteDir: process.env.SITE_DIR ?? '/data/site',
  users,
  sessions,
  settings,
  posts,
  builder,
  backupDir: process.env.BACKUP_DIR ?? '/data/backup',
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`image uploader listening on :${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
