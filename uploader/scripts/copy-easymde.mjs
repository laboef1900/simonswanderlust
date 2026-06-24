// Copy the EasyMDE editor JS + CSS out of node_modules into public/vendor/ so the
// admin UI can serve them itself (no CDN, no binaries committed to git).
// Run via `npm run copy:easymde`; also run in the Dockerfile after install.
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'vendor');
mkdirSync(out, { recursive: true });
for (const [from, to] of [
  ['easymde/dist/easymde.min.js', 'easymde.min.js'],
  ['easymde/dist/easymde.min.css', 'easymde.min.css'],
]) {
  copyFileSync(join(here, '..', 'node_modules', from), join(out, to));
  console.log('copied', to);
}
