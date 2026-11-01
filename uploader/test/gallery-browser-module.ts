import { readFileSync } from 'node:fs';
import * as codec from '../public/gallery-photo-line.js';

// VM DOM harnesses execute classic entry bodies. Bind the real ESM codec rather
// than copying its implementation; native browser entrypoints import it normally.
export const galleryCodecBindings = { ...codec, MAX_TEXT: codec.MAX_GALLERY_TEXT };
export function browserScript(file: string): string {
  const source = readFileSync('public/' + file, 'utf8');
  return file === 'gallery-fence.js'
    ? source.replace(/^import \{[^\n]+\} from '\.\/gallery-photo-line\.js';\n/m, '')
    : source;
}
