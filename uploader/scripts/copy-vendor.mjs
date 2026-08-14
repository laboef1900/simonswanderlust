import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'vendor');
mkdirSync(out, { recursive: true });

const files = [
  ['easymde/dist/easymde.min.js', 'easymde.min.js'],
  ['easymde/dist/easymde.min.css', 'easymde.min.css'],
  ['htm/preact/standalone.module.js', 'preact-htm.js'],
];

for (const [from, to] of files) {
  copyFileSync(join(here, '..', 'node_modules', from), join(out, to));
  console.log('copied', to);
}
