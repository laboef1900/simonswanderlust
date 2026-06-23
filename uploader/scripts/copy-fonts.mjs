// Copy the self-hosted webfonts out of node_modules into public/fonts/ so the
// admin UI can serve them itself (no Google Fonts, no binaries committed to git).
// Run via `npm run copy:fonts`; also run in the Dockerfile after install.
import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'fonts');

const files = [
  '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
  '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2',
];

await mkdir(out, { recursive: true });
for (const rel of files) {
  const name = rel.split('/').pop();
  await copyFile(join(root, 'node_modules', rel), join(out, name));
  console.log('copied', name);
}
