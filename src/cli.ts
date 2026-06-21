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

async function main(): Promise<void> {
  const [, , file, key, alt = ''] = process.argv;
  if (!file || !key) {
    console.error('usage: npm run upload -- <imageFile> <key> [alt]');
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
