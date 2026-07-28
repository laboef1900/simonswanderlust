import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { escapeMeta, unescapeMeta, normalizeGalleryFences } from '../src/body-content.js';

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
interface Api {
  escapeMeta(s: string): string;
  unescapeMeta(s: string): string;
  serialize(items: PickedItem[], locale: 'de' | 'en', directives?: string[]): string;
  parse(text: string): { directives: string[]; lines: ParsedLine[] };
  replaceFenceAt(body: string, cursor: number, fence: string): { body: string; replaced: boolean };
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

  it('replaces the fence the cursor sits inside', () => {
    const cursor = body.indexOf('https://i/a');
    const out = G.replaceFenceAt(body, cursor, '```gallery\nhttps://i/b\n```');
    expect(out.replaced).toBe(true);
    expect(out.body).toBe('intro\n\n```gallery\nhttps://i/b\n```\n\noutro');
  });

  it('inserts at the cursor when it is not inside a fence', () => {
    const out = G.replaceFenceAt(body, 0, '```gallery\nhttps://i/c\n```');
    expect(out.replaced).toBe(false);
    expect(out.body).toContain('https://i/c');
    expect(out.body).toContain('https://i/a'); // the existing gallery is untouched
  });

  it('never damages a fence it does not own', () => {
    const withCode = 'a\n\n```js\nconst x = 1;\n```\n\nb';
    const out = G.replaceFenceAt(withCode, withCode.indexOf('const'), '```gallery\nhttps://i/d\n```');
    expect(out.replaced).toBe(false);
    expect(out.body).toContain('const x = 1;');
  });
});
