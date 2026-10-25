import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'vendor');
mkdirSync(out, { recursive: true });
// Remove the obsolete pre-v6 UMD asset from incremental local vendor copies.
rmSync(join(out, 'maplibre-gl.js'), { force: true });

const files = [
  ['easymde/dist/easymde.min.js', 'easymde.min.js'],
  ['easymde/dist/easymde.min.css', 'easymde.min.css'],
  ['htm/preact/standalone.module.js', 'preact-htm.js'],
  ['maplibre-gl/dist/maplibre-gl.mjs', 'maplibre-gl.mjs'],
  ['maplibre-gl/dist/maplibre-gl-worker.mjs', 'maplibre-gl-worker.mjs'],
  ['maplibre-gl/dist/maplibre-gl-shared.mjs', 'maplibre-gl-shared.mjs'],
  ['maplibre-gl/dist/maplibre-gl.css', 'maplibre-gl.css'],
  ['maplibre-gl/LICENSE.txt', 'maplibre-LICENSE.txt'],
  ['pmtiles/dist/pmtiles.js', 'pmtiles.js'],
  ['fflate/LICENSE', 'fflate-LICENSE.txt'],
  ['font-awesome/css/font-awesome.min.css', 'font-awesome/css/font-awesome.min.css'],
  ['font-awesome/fonts/fontawesome-webfont.woff2', 'font-awesome/fonts/fontawesome-webfont.woff2'],
  ['font-awesome/fonts/fontawesome-webfont.woff', 'font-awesome/fonts/fontawesome-webfont.woff'],
  ['font-awesome/fonts/fontawesome-webfont.ttf', 'font-awesome/fonts/fontawesome-webfont.ttf'],
  ['font-awesome/fonts/fontawesome-webfont.svg', 'font-awesome/fonts/fontawesome-webfont.svg'],
  ['font-awesome/fonts/fontawesome-webfont.eot', 'font-awesome/fonts/fontawesome-webfont.eot'],
];

for (const [from, to] of files) {
  const destination = join(out, to);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(here, '..', 'node_modules', from), destination);
  console.log('copied', to);
}

// pmtiles@4.4.1 omits its BSD notice from the npm package. Source:
// https://github.com/protomaps/PMTiles/blob/0cebcaeade40034b86facb6e7da4ec726b9053fb/LICENSE
copyFileSync(join(here, 'vendor-licenses', 'pmtiles-LICENSE.txt'), join(out, 'pmtiles-LICENSE.txt'));
// font-awesome@4.7.0 npm package omits the applicable OFL and MIT notices. These are
// the official v4.7.0 license texts from https://fontawesome.com/v4/license.
copyFileSync(join(here, 'vendor-licenses', 'font-awesome-LICENSE.txt'), join(out, 'font-awesome-LICENSE.txt'));
