import { dirname, join } from 'node:path';
import { buildServer } from './server.js';
import { createSettingsStore, defaultsFromEnv } from './settings.js';
import { memoryUserStore } from './users.js';
import { memorySessionStore } from './sessions.js';

const storageDir = process.env.STORAGE_DIR ?? '/data/images';
const settingsPath = process.env.SETTINGS_PATH ?? join(dirname(storageDir), 'settings.json');
const settings = createSettingsStore({ path: settingsPath, defaults: defaultsFromEnv(process.env) });

// @ai-note: Task 7 replaces these in-memory stores with Postgres-backed ones (pgUserStore / pgSessionStore).
const users = memoryUserStore();
const sessions = memorySessionStore();

const app = buildServer({
  storageDir,
  baseUrl: process.env.PUBLIC_BASE_URL ?? 'https://img.simonswanderlust.com',
  users,
  sessions,
  settings,
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`image uploader listening on :${port}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
