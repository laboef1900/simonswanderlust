import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeGalleryFences, galleryFencesToMdx } from '../src/body-content.js';

/**
 * The scanner-parity harness for public/gallery-fence.js.
 *
 * @ai-warning This is the ONLY thing keeping the browser's `fenceAt` and the
 * server's `rewriteFences` (src/body-content.ts) in step, and it exists because
 * hand-written expectations were not enough: a review found two divergences that
 * every one of them passed through — a closing fence with a trailing NBSP
 * (`String.trim()` strips it, the server's `[ \t]*$` does not) and an
 * unterminated fence (the server runs it to EOF, the browser returned null).
 * Both let the picker and the server disagree about which block a gallery is,
 * silently, on an author's post.
 *
 * Add a case to CORPUS rather than writing another one-off assertion: this
 * derives the server's opinion from the server itself instead of restating it.
 */
const src = readFileSync('public/gallery-fence.js', 'utf8');

interface Api {
  serialize(items: unknown[], locale: 'de' | 'en', directives?: string[]): string;
  parse(text: string): { directives: string[]; lines: { src: string }[] };
  fenceAt(body: string, cursor: number): { text: string; start: number; end: number; unterminated: boolean } | null;
  replaceFenceAt(
    body: string,
    cursor: number,
    fence: string,
  ): { text: string; start: number; end: number; replaced: boolean; blocked?: string };
}

function load(): Api {
  const windowStub: { GalleryFence?: Api } = {};
  vm.runInNewContext(src, { window: windowStub });
  if (!windowStub.GalleryFence) throw new Error('gallery-fence.js did not assign window.GalleryFence');
  return windowStub.GalleryFence;
}

const G = load();
const apply = (b: string, e: { text: string; start: number; end: number }) =>
  b.slice(0, e.start) + e.text + b.slice(e.end);

const NBSP = ' ';
const FORM_FEED = '';
const PHOTO = 'https://i/a | 10x20 | alt="A"';

describe('scanner parity: fenceAt vs the server rewriteFences', () => {
  /**
   * Compare only unambiguous photo lines — `url | WxH | …`.
   *
   * The server's opinion is observed through what `normalizeGalleryFences`
   * rewrites, and it declines to rewrite anything it cannot resolve (blank lines,
   * `#` directives, a line with bad dimensions, a stray delimiter). Those are
   * invisible to this probe, not evidence of disagreement — so both sides are
   * filtered to lines the server is guaranteed to act on when it considers them
   * gallery content. Every CORPUS entry therefore puts a resolvable photo line at
   * each position that matters. Both original divergences are still caught: the
   * NBSP bug ended the browser's fence early, dropping a later photo line, and
   * the unterminated bug made the browser see no fence at all.
   */
  const PHOTO_LINE = /^https:\/\/\S+ \| \d+x\d+/;

  function serverGalleryLines(body: string): number[] {
    const after = normalizeGalleryFences(body, {}).bodyMarkdown.split('\n');
    return body
      .split('\n')
      .flatMap((line, i) => (PHOTO_LINE.test(line) && after[i] !== line ? [i] : []));
  }

  function browserGalleryLines(body: string): number[] {
    const lines = body.split('\n');
    const out: number[] = [];
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const found = G.fenceAt(body, pos);
      // Interior lines only: the delimiters are not photo lines.
      if (PHOTO_LINE.test(line) && found && pos > found.start && pos + line.length < found.end) {
        out.push(i);
      }
      pos += line.length + 1;
    }
    return out;
  }

  const CORPUS: Array<[string, string]> = [
    ['plain gallery', '```gallery\n' + PHOTO + '\n```'],
    ['gallery in prose', 'intro\n\n```gallery\n' + PHOTO + '\n```\n\nouttro'],
    ['longer closer', '```gallery\n' + PHOTO + '\n`````'],
    ['four-backtick gallery', '````gallery\n' + PHOTO + '\n````'],
    ['info string is not exactly gallery', '```gallery-notes\n' + PHOTO + '\n```'],
    ['indented opener', '  ```gallery\n  ' + PHOTO + '\n  ```'],
    ['nested in a 4-backtick wrapper', '````\n```gallery\n' + PHOTO + '\n```\n````'],
    ['nested in a tilde wrapper', '~~~\n```gallery\n' + PHOTO + '\n```\n~~~'],
    ['a js block, not a gallery', '```js\nconst x = 1;\n```'],
    ['closer with trailing spaces', '```gallery\n' + PHOTO + '\n```   '],
    ['closer with a trailing tab', '```gallery\n' + PHOTO + '\n```\t'],
    ['closer with a trailing NBSP', '```gallery\n' + PHOTO + '\n```' + NBSP + '\n' + PHOTO + '\n```'],
    ['closer with a trailing form feed', '```gallery\n' + PHOTO + '\n```' + FORM_FEED + '\n' + PHOTO + '\n```'],
    ['unterminated gallery', '```gallery\n' + PHOTO + '\n\nlater prose | with a pipe'],
    ['unterminated js block', '```js\nconst x = 1;\n\nmore | text'],
    ['backtick in the info string', 'text ```js `x`\n\n```gallery\n' + PHOTO + '\n```'],
    ['two galleries', '```gallery\n' + PHOTO + '\n```\n\nmid\n\n```gallery\n' + PHOTO + '\n```'],
    ['directive line', '```gallery\n#layout: slider\n' + PHOTO + '\n```'],
    ['empty gallery', '```gallery\n```'],
    ['no fence at all', 'just prose | with a pipe'],
  ];

  for (const [name, body] of CORPUS) {
    it(`agrees on: ${name}`, () => {
      expect(browserGalleryLines(body)).toEqual(serverGalleryLines(body));
    });
  }
});

describe('an unterminated gallery is reported, not silently edited', () => {
  // The server runs an unclosed fence to EOF, so the block's extent is "the rest
  // of the post". Replacing that range would delete everything after the opener.
  const body = '```gallery\nhttps://i/a | 10x20\n\nreal prose the author wrote\n';

  it('fenceAt sees it, and flags it', () => {
    const found = G.fenceAt(body, body.indexOf('https://i/a'));
    expect(found).not.toBeNull();
    expect(found?.unterminated).toBe(true);
  });

  it('replaceFenceAt refuses to edit it rather than eating the body', () => {
    const out = G.replaceFenceAt(body, body.indexOf('https://i/a'), '```gallery\nhttps://i/b\n```');
    expect(out.blocked).toBe('unterminated');
    expect(out.start).toBe(out.end);
    expect(apply(body, out)).toBe(body);
  });

  it('and refuses removal too', () => {
    expect(G.replaceFenceAt(body, body.indexOf('https://i/a'), '').blocked).toBe('unterminated');
  });
});

describe('inserting near a fence the picker does not own', () => {
  const FENCE = '```gallery\nhttps://i/b\n```';

  // Splicing at the cursor put the new gallery INSIDE the js block, where its
  // closer closed the js fence — turning the code into prose and leaving the js
  // closer to open an unterminated block over the rest of the post.
  it('lands after an enclosing code fence, never inside it', () => {
    const body = 'a\n\n```js\nconst x = 1;\n```\n\nb';
    const next = apply(body, G.replaceFenceAt(body, body.indexOf('const'), FENCE));
    expect(next).toBe('a\n\n```js\nconst x = 1;\n```\n\n' + FENCE + '\n\nb');
    // The js block is still closed by its own fence, so the code is still code.
    expect(next.indexOf('```gallery')).toBeGreaterThan(next.indexOf('const x = 1;\n```'));
  });

  it('lands after a tilde fence too', () => {
    const body = '~~~\nverbatim | text\n~~~\n\nb';
    const next = apply(body, G.replaceFenceAt(body, body.indexOf('verbatim'), FENCE));
    expect(next.indexOf(FENCE)).toBeGreaterThan(next.indexOf('~~~\nverbatim | text\n~~~'));
    expect(next).toContain('verbatim | text');
  });

  it('refuses when the enclosing fence is unterminated', () => {
    const body = 'a\n\n```js\nconst x = 1;\n';
    expect(G.replaceFenceAt(body, body.indexOf('const'), FENCE).blocked).toBe('unterminated');
  });
});

describe('serialize preserves a photo already in the post', () => {
  // Dropping an unsized NEW pick is right — the renderer would skip it. Dropping
  // one already in the gallery would delete the author's photo to avoid writing
  // a line that was already there.
  it('emits a bare URL for a fromPost item with unusable dimensions', () => {
    const out = G.serialize([{ src: 'https://i/a', width: 0, height: 0, fromPost: true }], 'de');
    expect(out).toBe('```gallery\nhttps://i/a\n```');
    // A bare line is the stored form: the server leaves it, and its images entry, alone.
    const images = { 'https://i/a': { width: 10, height: 20, alt: 'kept' } };
    expect(normalizeGalleryFences(out, images).images['https://i/a']).toEqual(images['https://i/a']);
  });

  it('still drops an unsized photo that is only now being picked', () => {
    expect(G.serialize([{ src: 'https://i/new', width: 0, height: 0 }], 'de')).toBe('```gallery\n```');
  });
});

describe('galleryFencesToMdx round-trips what the picker writes', () => {
  // Export re-attaches metadata to bare lines; picker output must survive
  // save → export → re-import without losing alt or captions.
  it('normalize then export returns the picker own line', () => {
    const fence = G.serialize(
      [{ src: 'https://i/a', width: 10, height: 20, alt: { de: 'Berg | Tal' }, caption: { de: 'Zeile' } }],
      'de',
    );
    const { bodyMarkdown, images } = normalizeGalleryFences(fence, {});
    expect(galleryFencesToMdx(bodyMarkdown, images)).toBe(fence);
  });
});
