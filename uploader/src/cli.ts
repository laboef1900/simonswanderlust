import { readFile } from 'node:fs/promises';
import { processImage } from './pipeline.js';
import { storeVariants, type StorageOptions, type StoredImage } from './storage.js';

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

async function main(): Promise<void> {
  if (process.argv[2] === 'restore') return restoreMain(process.argv[3]);
  const [, , file, key, alt = ''] = process.argv;
  if (!file || !key) {
    console.error('usage: npm run upload -- <imageFile> <key> [alt]   |   docker compose exec app node --import tsx src/cli.ts restore /data/backup/db/<file>');
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
