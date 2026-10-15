import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeAltText, imageMarkdown, unescapeAltText } from '../src/body-content.js';
import { markdownImages } from '../src/wp-content.js';

// The editor composes `![alt](src)` in the browser (public/image-markdown.js)
// and the server composes it in posts.ts normalizeBodyImages; both must write
// the label the same way or an alt with `]` breaks on one side only (#140).
const src = readFileSync(fileURLToPath(new URL('../public/image-markdown.js', import.meta.url)), 'utf8');
const win: { ImageMarkdown?: { escapeAlt(alt: unknown): string; image(alt: unknown, src: string): string } } = {};
// eslint-disable-next-line no-new-func
new Function('window', src)(win);
const browser = win.ImageMarkdown!;

const SRC = 'https://img.example.com/trips/x/a-1a2b3c4d';
const CORPUS = [
  'Old town at dusk',
  'Blick vom Gipfel [Norwegen]',
  'a \\ backslash',
  '[[nested]] and ] stray [',
  'quotes "and" <angles> & amps',
  '',
];

describe('image-markdown.js mirrors body-content.ts', () => {
  for (const alt of CORPUS) {
    it(`agrees on: ${JSON.stringify(alt)}`, () => {
      expect(browser.escapeAlt(alt)).toBe(escapeAltText(alt));
      expect(browser.image(alt, SRC)).toBe(imageMarkdown(alt, SRC));
    });
  }

  it('treats a missing alt as empty', () => {
    expect(browser.image(null, SRC)).toBe(`![](${SRC})`);
    expect(browser.image(undefined, SRC)).toBe(`![](${SRC})`);
  });
});

describe('the composed image survives the importer-grade parser', () => {
  for (const alt of CORPUS) {
    it(`parses back: ${JSON.stringify(alt)}`, () => {
      const [img, ...rest] = markdownImages(`intro ${imageMarkdown(alt, SRC)} outro`);
      expect(rest).toEqual([]);
      expect(img?.url).toBe(SRC);
      expect(unescapeAltText(img?.alt ?? '')).toBe(alt);
    });
  }
});
