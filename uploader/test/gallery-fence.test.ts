import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { escapeMeta, unescapeMeta, normalizeGalleryFences, galleryFencesToMdx } from '../src/body-content.js';

// gallery-fence.js is a plain browser IIFE (window.GalleryFence) holding the
// gallery picker's pure serialize/parse logic. Run it in a vm sandbox — same
// precedent as posts-filter.js — so the behaviour is covered without a browser.
//
// @ai-warning The escape rule is implemented TWICE: here in browser JS and in
// `src/body-content.ts` as `escapeMeta`/`unescapeMeta`. They are not importable
// from one another (browser IIFE vs. an ESM module in a different tsconfig), so
// the parity tests below are the ONLY thing keeping them in step. A silent
// divergence corrupts alt text and captions containing `|`, a newline or a
// quote — and does so on save, where the author cannot see it happen.
const src = readFileSync('public/gallery-fence.js', 'utf8');

interface PickedItem {
  src: string;
  width: number;
  height: number;
  alt?: { de?: string; en?: string };
  caption?: { de?: string; en?: string };
}
interface ParsedLine {
  src: string;
  width?: number;
  height?: number;
  alt?: string;
  caption?: string;
}
type PostMeta = Record<string, { alt?: string; caption?: string }>;
interface Edit {
  text: string;
  start: number;
  end: number;
  replaced: boolean;
}
interface Api {
  escapeMeta(s: string): string;
  unescapeMeta(s: string): string;
  serialize(
    items: PickedItem[],
    locale: 'de' | 'en',
    directives?: string[],
    postMeta?: PostMeta,
  ): string;
  parse(text: string): { directives: string[]; lines: ParsedLine[] };
  fenceAt(body: string, cursor: number): { text: string; start: number; end: number } | null;
  replaceFenceAt(body: string, cursor: number, fence: string): Edit;
}

/** What `cm.replaceRange(text, from, to)` does, so tests can assert on the result. */
function apply(body: string, edit: Edit): string {
  return body.slice(0, edit.start) + edit.text + body.slice(edit.end);
}

function load(): Api {
  const windowStub: { GalleryFence?: Api } = {};
  vm.runInNewContext(src, { window: windowStub });
  if (!windowStub.GalleryFence) throw new Error('gallery-fence.js did not assign window.GalleryFence');
  return windowStub.GalleryFence;
}

const G = load();

/** Strings chosen to exercise every character the fence format gives meaning to. */
const TRICKY = [
  'plain text',
  'pipe | inside',
  'quote " inside',
  'angle <b> & amp',
  'newline\nhere',
  'carriage\r\nreturn',
  'all of it: | " < > & \n done',
  '',
  'ünïcödé äöü',
];

describe('escape parity with body-content.ts', () => {
  it('escapeMeta matches the server implementation exactly', () => {
    for (const s of TRICKY) {
      expect(G.escapeMeta(s), `escapeMeta(${JSON.stringify(s)})`).toBe(escapeMeta(s));
    }
  });

  it('unescapeMeta matches the server implementation exactly', () => {
    for (const s of TRICKY) {
      const escaped = escapeMeta(s);
      expect(G.unescapeMeta(escaped), `unescapeMeta(${JSON.stringify(escaped)})`).toBe(unescapeMeta(escaped));
    }
  });

  it('round-trips every LF string through the browser pair', () => {
    for (const s of TRICKY.filter((t) => !t.includes('\r'))) {
      expect(G.unescapeMeta(G.escapeMeta(s))).toBe(s);
    }
  });

  it('normalizes CRLF to LF — and the server does the same', () => {
    // `escapeMeta` maps /\r?\n/ to a single `&#10;`, so a CRLF cannot survive a
    // round trip: it comes back as LF. That is the *server's* behaviour too
    // (body-content.ts uses the same pattern), and normalizing line endings in
    // alt text is desirable — but it means the pair is an exact inverse only
    // for LF input. Asserted here so the asymmetry is deliberate and shared,
    // rather than looking like browser-side drift the next time it surprises
    // someone.
    const crlf = 'carriage\r\nreturn';
    expect(G.unescapeMeta(G.escapeMeta(crlf))).toBe('carriage\nreturn');
    expect(unescapeMeta(escapeMeta(crlf))).toBe('carriage\nreturn');
  });

  it('escapes the two characters the line format would otherwise break on', () => {
    // `|` is the field separator and a newline would end the line. If either
    // survives unescaped the fence silently gains a field or a row.
    expect(G.escapeMeta('a | b')).not.toContain('|');
    expect(G.escapeMeta('a\nb')).not.toContain('\n');
  });
});

describe('serialize', () => {
  const item = (over: Partial<PickedItem> = {}): PickedItem => ({
    src: 'https://img.example.com/trips/x/a',
    width: 3000,
    height: 2000,
    alt: { de: 'Berg', en: 'Mountain' },
    caption: { de: 'Am Morgen', en: 'In the morning' },
    ...over,
  });

  it('emits the documented line format', () => {
    const out = G.serialize([item()], 'de');
    expect(out).toContain('```gallery');
    expect(out).toContain(
      'https://img.example.com/trips/x/a | 3000x2000 | alt="Berg" | caption="Am Morgen"',
    );
    expect(out.trimEnd().endsWith('```')).toBe(true);
  });

  it('picks per-locale alt and caption', () => {
    expect(G.serialize([item()], 'en')).toContain('alt="Mountain" | caption="In the morning"');
  });

  it('omits empty alt and caption rather than emitting empty attributes', () => {
    const out = G.serialize([item({ alt: { de: '' }, caption: {} })], 'de');
    expect(out).toContain('https://img.example.com/trips/x/a | 3000x2000');
    expect(out).not.toContain('alt=""');
    expect(out).not.toContain('caption=');
  });

  it('escapes metadata that would break the line format', () => {
    const out = G.serialize([item({ alt: { de: 'a | b' }, caption: { de: 'two\nlines' } })], 'de');
    const body = out.split('\n')[1] ?? '';
    // exactly 4 fields — the pipe in the alt text must not have created a 5th
    expect(body.split('|')).toHaveLength(4);
    expect(out.split('\n')).toHaveLength(3); // fence, one photo, fence
  });

  it('preserves selection order', () => {
    const out = G.serialize(
      [item({ src: 'https://img.example.com/b' }), item({ src: 'https://img.example.com/a' })],
      'de',
    );
    expect(out.indexOf('/b')).toBeLessThan(out.indexOf('/a'));
  });

  it('skips items without usable dimensions rather than emitting a broken line', () => {
    // A 0-dimension row is what an unreadable probe leaves behind; the renderer
    // drops such a photo, so it must never reach the fence in the first place.
    const out = G.serialize([item({ width: 0 }), item({ src: 'https://img.example.com/ok' })], 'de');
    const photoLines = out.split('\n').filter((l) => l.startsWith('https://'));
    expect(photoLines).toHaveLength(1);
    expect(photoLines[0]).toContain('/ok');
  });

  // @ai-warning The picker re-serializes from MEDIA LIBRARY rows, but the stored
  // fence is bare URLs — the post's own alt/caption live in its `images` map.
  // Without postMeta winning here, adding one photo to a gallery silently
  // overwrote every other photo's post-specific text with the library default,
  // because normalizeGalleryFences lets a value on the line beat the stored one.
  describe('postMeta — what this post already says wins over the library row', () => {
    const meta: PostMeta = {
      'https://img.example.com/trips/x/a': { alt: 'Hand-tuned alt', caption: 'Hand-tuned caption' },
    };

    it('emits the post metadata instead of the library alt and caption', () => {
      const out = G.serialize([item()], 'de', [], meta);
      expect(out).toContain('alt="Hand-tuned alt" | caption="Hand-tuned caption"');
      expect(out).not.toContain('Berg');
    });

    it('respects a deliberately cleared value rather than refilling it', () => {
      const out = G.serialize([item()], 'de', [], { 'https://img.example.com/trips/x/a': { alt: '' } });
      expect(out).not.toContain('alt=');
      // caption is absent from postMeta, so the library value still fills in
      expect(out).toContain('caption="Am Morgen"');
    });

    it('falls back to the library row for a photo the post has never seen', () => {
      const out = G.serialize([item({ src: 'https://img.example.com/new' })], 'de', [], meta);
      expect(out).toContain('alt="Berg"');
    });

    it('escapes post metadata exactly as it escapes library metadata', () => {
      const out = G.serialize([item()], 'de', [], {
        'https://img.example.com/trips/x/a': { alt: 'a | b', caption: 'two\nlines' },
      });
      expect(out.split('\n')).toHaveLength(3);
      expect((out.split('\n')[1] ?? '').split('|')).toHaveLength(4);
    });
  });
});

describe('parse', () => {
  it('round-trips its own serialize output', () => {
    const items = [
      { src: 'https://i/a', width: 10, height: 20, alt: { de: 'A' }, caption: { de: 'ca' } },
      { src: 'https://i/b', width: 30, height: 40, alt: { de: 'pipe | here' } },
    ];
    const parsed = G.parse(G.serialize(items, 'de'));
    expect(parsed.lines).toEqual([
      { src: 'https://i/a', width: 10, height: 20, alt: 'A', caption: 'ca' },
      { src: 'https://i/b', width: 30, height: 40, alt: 'pipe | here' },
    ]);
  });

  it('accepts a bare-URL fence (the stored form after normalizeGalleryFences)', () => {
    const parsed = G.parse('```gallery\nhttps://i/a\nhttps://i/b\n```');
    expect(parsed.lines.map((l) => l.src)).toEqual(['https://i/a', 'https://i/b']);
    expect(parsed.lines[0]?.width).toBeUndefined();
  });

  it('tolerates text with no fence delimiters', () => {
    expect(G.parse('https://i/a | 1x2').lines).toEqual([{ src: 'https://i/a', width: 1, height: 2 }]);
  });

  it('ignores blank lines', () => {
    expect(G.parse('```gallery\n\nhttps://i/a\n\n```').lines).toHaveLength(1);
  });

  // @ai-context #66 adds a `#layout: <mode>` directive as the first line inside
  // the fence. #75's picker regenerates fences, so it MUST carry directives
  // through untouched or editing a gallery silently resets its layout. Both
  // issues flag this round-trip as the thing that breaks when they interleave.
  it('preserves #-prefixed directive lines across a parse → serialize cycle', () => {
    const parsed = G.parse('```gallery\n#layout: slider\nhttps://i/a | 1x2 | alt="A"\n```');
    expect(parsed.directives).toEqual(['#layout: slider']);
    expect(parsed.lines).toHaveLength(1);

    const items = parsed.lines.map((l) => ({
      src: l.src,
      width: l.width ?? 0,
      height: l.height ?? 0,
      alt: { de: l.alt ?? '' },
      caption: { de: l.caption ?? '' },
    }));
    const round = G.serialize(items, 'de', parsed.directives);
    expect(round).toContain('#layout: slider');
    expect(round.indexOf('#layout')).toBeLessThan(round.indexOf('https://i/a'));
  });
});

describe('the server accepts what the picker emits', () => {
  // The guarantee that matters: picker output must survive the real store
  // chokepoint with its metadata intact. If this fails, galleries render with
  // empty alt and no captions on an otherwise green build.
  it('normalizeGalleryFences lifts picker output into the images map', () => {
    const fence = G.serialize(
      [
        {
          src: 'https://img.example.com/trips/x/a',
          width: 3000,
          height: 2000,
          alt: { de: 'Berg | Tal' },
          caption: { de: 'Zeile eins\nZeile zwei' },
        },
      ],
      'de',
    );
    const { bodyMarkdown, images } = normalizeGalleryFences(fence, {});

    expect(images['https://img.example.com/trips/x/a']).toEqual({
      width: 3000,
      height: 2000,
      alt: 'Berg | Tal',
      caption: 'Zeile eins\nZeile zwei',
    });
    // and the line is reduced to a bare URL, as the stored form requires
    expect(bodyMarkdown).toContain('\nhttps://img.example.com/trips/x/a\n');
    expect(bodyMarkdown).not.toContain('alt=');
  });

  // The full "edit an existing gallery" loop, which is where metadata is lost if
  // anything in the chain forgets the post's own text: the stored fence is bare
  // URLs, so `parse` yields no alt/caption, and the picker re-serializes from
  // library rows. `postMeta` is what carries the post's `images` entry across.
  it('re-editing a gallery keeps the post’s alt and caption, not the library’s', () => {
    const stored = '```gallery\nhttps://i/a\n```';
    const storedImages: Record<string, { width: number; height: number; alt?: string; caption?: string }> = {
      'https://i/a': { width: 10, height: 20, alt: 'Hand-tuned alt', caption: 'Hand-tuned caption' },
    };
    const libraryRow = {
      src: 'https://i/a',
      width: 10,
      height: 20,
      alt: { de: 'Library alt' },
      caption: { de: 'Library caption' },
    };

    // What editor.html does: parse the fence, layer the post's images map under it.
    const parsed = G.parse(stored);
    expect(parsed.lines).toEqual([{ src: 'https://i/a' }]); // nothing to recover from the line itself
    const postMeta: PostMeta = {};
    for (const line of parsed.lines) {
      postMeta[line.src] = {
        alt: line.alt ?? storedImages[line.src]?.alt,
        caption: line.caption ?? storedImages[line.src]?.caption,
      };
    }

    const fence = G.serialize([libraryRow], 'de', parsed.directives, postMeta);
    const { images } = normalizeGalleryFences(fence, storedImages);
    expect(images['https://i/a']).toEqual({
      width: 10,
      height: 20,
      alt: 'Hand-tuned alt',
      caption: 'Hand-tuned caption',
    });
  });

  it('a photo added to an existing gallery still gets the library metadata', () => {
    const fence = G.serialize(
      [
        { src: 'https://i/a', width: 10, height: 20, alt: { de: 'Library A' } },
        { src: 'https://i/new', width: 30, height: 40, alt: { de: 'Library new' } },
      ],
      'de',
      [],
      { 'https://i/a': { alt: 'Hand-tuned' } },
    );
    const { images } = normalizeGalleryFences(fence, { 'https://i/a': { width: 10, height: 20, alt: 'Hand-tuned' } });
    expect(images['https://i/a']?.alt).toBe('Hand-tuned');
    expect(images['https://i/new']?.alt).toBe('Library new');
  });

  it('survives a fence carrying a #66 layout directive', () => {
    const fence = G.serialize(
      [{ src: 'https://i/a', width: 10, height: 20, alt: { de: 'A' } }],
      'de',
      ['#layout: breakout'],
    );
    const { bodyMarkdown, images } = normalizeGalleryFences(fence, {});
    expect(images['https://i/a']).toMatchObject({ width: 10, height: 20, alt: 'A' });
    // isSkippableLine treats `#` lines as comments, so the directive must be
    // carried through the normalizer untouched.
    expect(bodyMarkdown).toContain('#layout: breakout');
  });
});

describe('replaceFenceAt', () => {
  const body = 'intro\n\n```gallery\nhttps://i/a\n```\n\noutro';
  const FENCE = '```gallery\nhttps://i/b\n```';

  it('replaces the fence the cursor sits inside, as a range edit', () => {
    const cursor = body.indexOf('https://i/a');
    const out = G.replaceFenceAt(body, cursor, FENCE);
    expect(out.replaced).toBe(true);
    // The range covers the fence and nothing else — this is what lets the editor
    // use cm.replaceRange and keep CodeMirror's undo history, where the old
    // mde.value(wholeDocument) discarded it.
    expect(body.slice(out.start, out.end)).toBe('```gallery\nhttps://i/a\n```');
    expect(apply(body, out)).toBe('intro\n\n```gallery\nhttps://i/b\n```\n\noutro');
  });

  it('inserts at the cursor when it is not inside a fence', () => {
    const out = G.replaceFenceAt(body, 0, FENCE);
    expect(out.replaced).toBe(false);
    expect(apply(body, out)).toContain('https://i/b');
    expect(apply(body, out)).toContain('https://i/a'); // the existing gallery is untouched
  });

  it('never damages a fence it does not own', () => {
    const withCode = 'a\n\n```js\nconst x = 1;\n```\n\nb';
    const out = G.replaceFenceAt(withCode, withCode.indexOf('const'), FENCE);
    expect(out.replaced).toBe(false);
    expect(apply(withCode, out)).toContain('const x = 1;');
  });

  // A fence only opens at column 0. Splicing raw at the cursor produced
  // `some te```gallery…` — literal text that neither the renderer nor
  // normalizeGalleryFences treats as a gallery, i.e. a silent no-op for the
  // author. Every insertion must land on its own line.
  describe('insertion always produces a real fence', () => {
    const opensAtColumnZero = (out: string) =>
      out.split('\n').some((l) => l === '```gallery');

    it('breaks out of a mid-paragraph cursor', () => {
      const prose = 'some text here';
      const out = G.replaceFenceAt(prose, 5, FENCE);
      const next = apply(prose, out);
      expect(opensAtColumnZero(next)).toBe(true);
      expect(next).toBe('some \n\n```gallery\nhttps://i/b\n```\n\ntext here');
    });

    it('does not stack blank lines when the cursor is already on one', () => {
      const prose = 'a\n\nb';
      expect(apply(prose, G.replaceFenceAt(prose, 3, FENCE))).toBe('a\n\n```gallery\nhttps://i/b\n```\n\nb');
    });

    it('pads a cursor at the start of a line following text', () => {
      const prose = 'a\nb';
      expect(apply(prose, G.replaceFenceAt(prose, 2, FENCE))).toBe('a\n\n```gallery\nhttps://i/b\n```\n\nb');
    });

    it('adds no padding at the very start or very end of the body', () => {
      expect(apply('', G.replaceFenceAt('', 0, FENCE))).toBe(FENCE);
      expect(apply('a\n\n', G.replaceFenceAt('a\n\n', 3, FENCE))).toBe('a\n\n' + FENCE);
    });
  });

  describe('an empty fence removes the gallery', () => {
    it('takes the surrounding blank line with it', () => {
      const out = G.replaceFenceAt(body, body.indexOf('https://i/a'), '');
      expect(out.replaced).toBe(true);
      expect(apply(body, out)).toBe('intro\n\noutro');
    });

    it('leaves a trailing gallery cleanly removed', () => {
      const trailing = 'intro\n\n```gallery\nhttps://i/a\n```';
      const out = G.replaceFenceAt(trailing, trailing.length - 1, '');
      expect(apply(trailing, out)).toBe('intro\n\n');
    });

    it('is a no-op when the cursor is not in a gallery', () => {
      const out = G.replaceFenceAt(body, 0, '');
      expect(out.replaced).toBe(false);
      expect(out.start).toBe(out.end);
      expect(apply(body, out)).toBe(body);
    });
  });
});

describe('fenceAt', () => {
  const body = 'intro\n\n```gallery\n#layout: slider\nhttps://i/a\n```\n\nouttro';

  it('returns the whole fence when the cursor is inside it', () => {
    const found = G.fenceAt(body, body.indexOf('https://i/a'));
    expect(found?.text).toBe('```gallery\n#layout: slider\nhttps://i/a\n```');
  });

  it('is inclusive of both delimiter lines', () => {
    expect(G.fenceAt(body, body.indexOf('```gallery'))).not.toBeNull();
    expect(G.fenceAt(body, body.indexOf('```', body.indexOf('https://i/a')))).not.toBeNull();
  });

  it('returns null outside any fence', () => {
    expect(G.fenceAt(body, 0)).toBeNull();
    expect(G.fenceAt(body, body.length - 1)).toBeNull();
  });

  it('ignores a non-gallery fence', () => {
    const js = 'a\n\n```js\nconst x = 1;\n```\n';
    expect(G.fenceAt(js, js.indexOf('const'))).toBeNull();
  });

  it('handles a closing fence longer than its opener (CommonMark)', () => {
    // rewriteFences in body-content.ts was rewritten from a regex precisely
    // because the old one required the closer to match the opener's length.
    const longer = '```gallery\nhttps://i/a\n`````\n';
    const found = G.fenceAt(longer, longer.indexOf('https://i/a'));
    expect(found?.text).toBe('```gallery\nhttps://i/a\n`````');
  });

  it('does not treat a gallery example nested in a wrapper fence as editable', () => {
    // docs/authoring-workflow.md demonstrates the syntax with a 4-backtick
    // wrapper around a 3-backtick gallery. The inner block is documentation,
    // not an editable gallery.
    const nested = '````\n```gallery\nhttps://i/a\n```\n````\n';
    expect(G.fenceAt(nested, nested.indexOf('https://i/a'))).toBeNull();
  });

  describe('agrees with the server about what a gallery is', () => {
    it('does not claim a fence whose info string merely starts with "gallery"', () => {
      const other = '```gallery-notes\nhttps://i/a\n```\n';
      expect(G.fenceAt(other, other.indexOf('https://i/a'))).toBeNull();
    });

    it('claims a 4-backtick gallery, which the server treats as one', () => {
      const wide = '````gallery\nhttps://i/a\n````\n';
      expect(G.fenceAt(wide, wide.indexOf('https://i/a'))?.text).toBe('````gallery\nhttps://i/a\n````');
    });

    it('does not claim an indented gallery fence (the server requires column 0)', () => {
      const indented = '  ```gallery\n  https://i/a\n  ```\n';
      expect(G.fenceAt(indented, indented.indexOf('https://i/a'))).toBeNull();
    });

    it('ignores a backtick in an info string, which CommonMark says cannot open a fence', () => {
      // `a ``` b` is inline code, not a fence — so the ```gallery below is a
      // real, editable top-level gallery and not the inside of an open block.
      const body = 'text ```js `x` weird\n\n```gallery\nhttps://i/a\n```\n';
      expect(G.fenceAt(body, body.indexOf('https://i/a'))?.text).toBe('```gallery\nhttps://i/a\n```');
    });
  });
});
