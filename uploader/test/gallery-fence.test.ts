import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { normalizeGalleryFences, galleryFencesToMdx } from '../src/body-content.js';
import { analyzeGallerySource, type GalleryAnalysis, type GalleryBlock } from '../../site/src/lib/gallery-source.js';
import { resolve } from 'node:path';
import { browserScript, galleryCodecBindings } from './gallery-browser-module.js';
import { escapeMeta, unescapeMeta, readCaptionOverride } from '../public/gallery-photo-line.js';
// Cross-tree, exactly as preview.ts imports the render pipeline: the renderer's
// directive reader is the authority the picker's copy is measured against.
import {
  DEFAULT_GALLERY_MODE,
  GALLERY_MODES,
  readCaptionsVisible,
  readLayoutMode,
} from '../../site/src/lib/gallery-layout.js';

// Exercise browser serialization against the real shared ESM codec in a VM.
const src = browserScript('gallery-fence.js');

interface PickedItem {
  src: string;
  width: number;
  height: number;
  alt?: { de?: string; en?: string };
  caption?: { de?: string; en?: string };
  format?: 'jpeg';
  fromPost?: boolean;
}
interface ParsedLine {
  valid?: false;
  raw?: string;
  diagnostic?: { field: string; reason: string; offset: number };
  src: string;
  width?: number;
  height?: number;
  alt?: string;
  caption?: string;
  captionOverride?: string;
  format?: 'jpeg';
}
type PostMeta = Record<string, { alt?: string; caption?: string; format?: 'jpeg' }>;
interface Edit {
  text: string;
  start: number;
  end: number;
  cursor: number;
  replaced: boolean;
  blocked?: 'unterminated' | 'invalid_metadata';
}
interface Insertion {
  text: string;
  start: number;
  cursor: number;
  relocated: boolean;
  blocked?: 'unterminated';
}
interface Api {
  escapeMeta(s: string): string;
  unescapeMeta(s: string): string;
  serialize(
    items: PickedItem[],
    locale: 'de' | 'en',
    directives?: string[],
    postMeta?: PostMeta,
    captionOverrides?: Record<string, string>,
  ): string;
  parse(text: string): { directives: string[]; lines: ParsedLine[] };
  withAlt(text: string, src: string, value: string): string;
  analyze(body: string, options?: { fresh?: boolean }): Promise<GalleryAnalysis>;
  altEdit(body: string, src: string, value: string): Promise<{ start: number; end: number; text: string }[]>;
  scanFences(text: string): Promise<GalleryBlock[]>;
  fenceAt(body: string, cursor: number): Promise<(GalleryBlock & { text: string }) | null>;
  replaceFenceAt(body: string, cursor: number, fence: string): Promise<Edit>;
  insertBlockAt(body: string, cursor: number, block: string): Promise<Insertion>;
  LAYOUTS: string[];
  DEFAULT_LAYOUT: string;
  layoutOf(directives: string[]): string;
  withLayout(directives: string[], mode: string): string[];
  captionsVisible(directives: string[]): boolean;
  withCaptions(directives: string[], visible: boolean): string[];
}

/** What `cm.replaceRange(text, from, to)` does, so tests can assert on the result. */
function apply(body: string, edit: Edit): string {
  return body.slice(0, edit.start) + edit.text + body.slice(edit.end);
}

function load(transport?: typeof fetch): Api {
  const windowStub: { GalleryFence?: Api } = {};
  vm.runInNewContext(src, {
    window: windowStub, AbortController, setTimeout, clearTimeout,
    ...galleryCodecBindings,
    fetch: transport ?? (async (_url: string, init: RequestInit) => {
      const { bodyMarkdown } = JSON.parse(String(init.body));
      return { ok: true, json: () => analyzeGallerySource(bodyMarkdown) };
    }),
  }, { filename: resolve('public/gallery-fence.js'), importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  if (!windowStub.GalleryFence) throw new Error('gallery-fence.js did not assign window.GalleryFence');
  return windowStub.GalleryFence;
}

const G = load();

async function logical(body: string): Promise<string> {
  return (await analyzeGallerySource(body)).blocks.find((block) => block.isGallery)?.content ?? body;
}

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

describe('escape parity with gallery-layout.ts', () => {
  it('escapeMeta matches the server implementation exactly', async () => { for (const s of TRICKY) {
    expect(G.escapeMeta(s), `escapeMeta(${JSON.stringify(s)})`).toBe(escapeMeta(s));
  } });

  it('unescapeMeta matches the server implementation exactly', async () => { for (const s of TRICKY) {
    const escaped = escapeMeta(s);
    expect(G.unescapeMeta(escaped), `unescapeMeta(${JSON.stringify(escaped)})`).toBe(unescapeMeta(escaped));
  } });

  it('round-trips every LF string through the browser pair', async () => { for (const s of TRICKY.filter((t) => !t.includes('\r'))) {
    expect(G.unescapeMeta(G.escapeMeta(s))).toBe(s);
  } });

  it('normalizes CRLF to LF — and the server does the same', async () => { // `escapeMeta` maps /\r?\n/ to a single `&#10;`, so a CRLF cannot survive a
  // round trip: it comes back as LF. That is the *server's* behaviour too
  // (gallery-layout.ts uses the same pattern), and normalizing line endings in
  // alt text is desirable — but it means the pair is an exact inverse only
  // for LF input. Asserted here so the asymmetry is deliberate and shared,
  // rather than looking like browser-side drift the next time it surprises
  // someone.
  const crlf = 'carriage\r\nreturn';
  expect(G.unescapeMeta(G.escapeMeta(crlf))).toBe('carriage\nreturn');
  expect(unescapeMeta(escapeMeta(crlf))).toBe('carriage\nreturn'); });

  it('escapes the two characters the line format would otherwise break on', async () => { // `|` is the field separator and a newline would end the line. If either
  // survives unescaped the fence silently gains a field or a row.
  expect(G.escapeMeta('a | b')).not.toContain('|');
  expect(G.escapeMeta('a\nb')).not.toContain('\n'); });
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

  it('emits the documented line format', async () => { const out = G.serialize([item()], 'de');
  expect(out).toContain('```gallery');
  expect(out).toContain(
    'https://img.example.com/trips/x/a | 3000x2000 | alt="Berg" | caption="Am Morgen"',
  );
  expect(out.trimEnd().endsWith('```')).toBe(true); });

  it('picks per-locale alt and caption', async () => { expect(G.serialize([item()], 'en')).toContain('alt="Mountain" | caption="In the morning"'); });

  it('omits empty alt and caption rather than emitting empty attributes', async () => { const out = G.serialize([item({ alt: { de: '' }, caption: {} })], 'de');
  expect(out).toContain('https://img.example.com/trips/x/a | 3000x2000');
  expect(out).not.toContain('alt=""');
  expect(out).not.toContain('caption='); });

  it('serializes the JPEG-only marker from a library row', async () => { const out = G.serialize([item({ format: 'jpeg' })], 'de');
  expect(out).toContain('3000x2000 | format="jpeg" | alt="Berg"'); });

  it('escapes metadata that would break the line format', async () => { const out = G.serialize([item({ alt: { de: 'a | b' }, caption: { de: 'two\nlines' } })], 'de');
  const body = out.split('\n')[1] ?? '';
  // exactly 4 fields — the pipe in the alt text must not have created a 5th
  expect(body.split('|')).toHaveLength(4);
  expect(out.split('\n')).toHaveLength(3); // fence, one photo, fence
  });

  it('preserves selection order', async () => { const out = G.serialize(
    [item({ src: 'https://img.example.com/b' }), item({ src: 'https://img.example.com/a' })],
    'de',
  );
  expect(out.indexOf('/b')).toBeLessThan(out.indexOf('/a')); });

  it('skips items without usable dimensions rather than emitting a broken line', async () => { // A 0-dimension row is what an unreadable probe leaves behind; the renderer
  // drops such a photo, so it must never reach the fence in the first place.
  const out = G.serialize([item({ width: 0 }), item({ src: 'https://img.example.com/ok' })], 'de');
  const photoLines = out.split('\n').filter((l) => l.startsWith('https://'));
  expect(photoLines).toHaveLength(1);
  expect(photoLines[0]).toContain('/ok'); });

  // docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md: a
  // library row's current alt/caption is authoritative (blank included) — the
  // site renders it over the post's copy on every build. The post's metadata
  // (`postMeta`) still carries the JPEG-only marker, and is the whole story for
  // a photo with no library row.
  describe('postMeta — the library row wins, the post fills what the library cannot', () => {
    const meta: PostMeta = {
      'https://img.example.com/trips/x/a': { alt: 'Stale post alt', caption: 'Stale post caption', format: 'jpeg' },
    };

    it('emits the library row’s current text over the post’s older copy, keeping the JPEG marker', async () => { const out = G.serialize([item()], 'de', [], meta);
    expect(out).toContain('3000x2000 | format="jpeg" | alt="Berg" | caption="Am Morgen"');
    expect(out).not.toContain('Stale'); });

    it('writes a blank library alt and caption explicitly, so the save cannot fall back to the stale copy', async () => { const out = G.serialize([item({ alt: { de: '', en: 'Mountain' }, caption: { de: '', en: '' } })], 'de', [], meta);
    expect(out).toContain('format="jpeg" | alt="" | caption=""');
    const saved = (await normalizeGalleryFences(out, {
      'https://img.example.com/trips/x/a': {
        width: 3000, height: 2000, alt: 'Stale post alt', caption: 'Stale post caption', format: 'jpeg',
      },
    }));
    expect(saved.images['https://img.example.com/trips/x/a']).toEqual({
      width: 3000, height: 2000, alt: '', caption: '', format: 'jpeg',
    }); });

    it('keeps locales independent: the EN row text never fills a blank DE field', async () => { const out = G.serialize([item({ alt: { de: '', en: 'Mountain' }, caption: { en: 'Morning' } })], 'de');
    expect(out).not.toContain('Mountain');
    expect(out).not.toContain('Morning'); });

    it('keeps the post’s metadata for a seeded photo whose library row was never found', async () => { const out = G.serialize(
      [{ src: 'https://img.example.com/trips/x/a', width: 3000, height: 2000, fromPost: true }], 'de', [], meta,
    );
    expect(out).toContain('format="jpeg" | alt="Stale post alt" | caption="Stale post caption"'); });

    it('respects a deliberately cleared value on an unresolved photo rather than refilling it', async () => { const src = 'https://img.example.com/trips/x/a';
    const out = G.serialize([{ src, width: 3000, height: 2000, fromPost: true }], 'de', [], { [src]: { alt: '', caption: '' } });
    const saved = (await normalizeGalleryFences(out, { [src]: { width: 3000, height: 2000, alt: 'Old saved alt', caption: 'Old caption' } }));
    expect(saved.images[src]?.alt).toBe('');
    expect(saved.images[src]?.caption).toBe(''); });

    it('escapes post metadata exactly as it escapes library metadata', async () => { const out = G.serialize([{ src: 'https://img.example.com/trips/x/a', width: 3000, height: 2000, fromPost: true }], 'de', [], {
      'https://img.example.com/trips/x/a': { alt: 'a | b', caption: 'two\nlines' },
    });
    expect(out.split('\n')).toHaveLength(3);
    expect((out.split('\n')[1] ?? '').split('|')).toHaveLength(4); });
  });

  it('retains unsaved alt on an existing unresolved photo through picker updates', async () => { const src = 'https://img.example.com/missing';
  const body = G.serialize([{ src, width: 0, height: 0, fromPost: true }], 'de', ['#layout: slider'], {
    [src]: { alt: 'Kept | "description"' },
  });
  const saved = (await normalizeGalleryFences(body, {}));
  expect(G.parse(await logical(saved.bodyMarkdown))).toEqual({
    directives: ['#layout: slider'], lines: [{ src, alt: 'Kept | "description"' }],
  }); });
});

describe('parse', () => {
  it('round-trips its own serialize output', async () => { const items = [
    { src: 'https://i/a', width: 10, height: 20, alt: { de: 'A' }, caption: { de: 'ca' } },
    { src: 'https://i/b', width: 30, height: 40, alt: { de: 'pipe | here' } },
  ];
  const parsed = G.parse(await logical(G.serialize(items, 'de')));
  expect(parsed.lines).toEqual([
    { src: 'https://i/a', width: 10, height: 20, alt: 'A', caption: 'ca' },
    { src: 'https://i/b', width: 30, height: 40, alt: 'pipe | here' },
  ]); });

  it('round-trips the JPEG-only marker', async () => { const item: PickedItem = { src: 'https://i/jpeg', width: 30, height: 20, format: 'jpeg' };
  expect(G.parse(await logical(G.serialize([item], 'de'))).lines).toEqual([
    { src: item.src, width: 30, height: 20, format: 'jpeg' },
  ]); });

  it('accepts bare stored photo lines', async () => { const parsed = G.parse('https://i/a\nhttps://i/b');
  expect(parsed.lines.map((l) => l.src)).toEqual(['https://i/a', 'https://i/b']);
  expect(parsed.lines[0]?.width).toBeUndefined(); });

  it('tolerates text with no fence delimiters', async () => { expect(G.parse('https://i/a | 1x2').lines).toEqual([{ src: 'https://i/a', width: 1, height: 2 }]); });

  it('ignores blank lines', async () => { expect(G.parse('\nhttps://i/a\n').lines).toHaveLength(1); });

  // @ai-context #66 adds a `#layout: <mode>` directive as the first line inside
  // the fence. #75's picker regenerates fences, so it MUST carry directives
  // through untouched or editing a gallery silently resets its layout. Both
  // issues flag this round-trip as the thing that breaks when they interleave.
  it('preserves #-prefixed directive lines across a parse → serialize cycle', async () => { const parsed = G.parse('#layout: slider\nhttps://i/a | 1x2 | alt="A"');
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
  expect(round.indexOf('#layout')).toBeLessThan(round.indexOf('https://i/a')); });
});

describe('the server accepts what the picker emits', () => {
  // The guarantee that matters: picker output must survive the real store
  // chokepoint with its metadata intact. If this fails, galleries render with
  // empty alt and no captions on an otherwise green build.
  it('normalizeGalleryFences lifts picker output into the images map', async () => { const fence = G.serialize(
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
  const { bodyMarkdown, images } = (await normalizeGalleryFences(fence, {}));
  
  expect(images['https://img.example.com/trips/x/a']).toEqual({
    width: 3000,
    height: 2000,
    alt: 'Berg | Tal',
    caption: 'Zeile eins\nZeile zwei',
  });
  // and the line is reduced to a bare URL, as the stored form requires
  expect(bodyMarkdown).toContain('\nhttps://img.example.com/trips/x/a\n');
  expect(bodyMarkdown).not.toContain('alt='); });

  // The full "edit an existing gallery" loop: the stored fence is bare URLs, so
  // `parse` yields no alt/caption; editor.html layers the post's `images` map
  // into `postMeta`, and the picker supplies library rows for the photos it
  // found. After the save, the stored fallback must agree with Media.
  function postMetaFor(parsed: { lines: ParsedLine[] }, storedImages: Record<string, { alt?: string; caption?: string; format?: 'jpeg' }>) {
    const postMeta: PostMeta = {};
    for (const line of parsed.lines) {
      postMeta[line.src] = {
        alt: line.alt ?? storedImages[line.src]?.alt,
        caption: line.caption ?? storedImages[line.src]?.caption,
        format: line.format ?? storedImages[line.src]?.format,
      };
    }
    return postMeta;
  }

  it('re-editing a gallery stores the library’s current text, blank caption included, and keeps JPEG', async () => { const stored = '```gallery\nhttps://i/a\n```';
  const storedImages: Record<string, { width: number; height: number; alt?: string; caption?: string; format?: 'jpeg' }> = {
    'https://i/a': {
      width: 10, height: 20, alt: 'Copied alt', caption: 'Copied caption', format: 'jpeg',
    },
  };
  const libraryRow = { src: 'https://i/a', width: 10, height: 20, alt: { de: 'Edited in Media' }, caption: { de: '' } };
  
  const parsed = G.parse(await logical(stored));
  expect(parsed.lines).toEqual([{ src: 'https://i/a' }]); // nothing to recover from the line itself
  const fence = G.serialize([libraryRow], 'de', parsed.directives, postMetaFor(parsed, storedImages));
  const { images } = (await normalizeGalleryFences(fence, storedImages));
  expect(images['https://i/a']).toEqual({ width: 10, height: 20, alt: 'Edited in Media', caption: '', format: 'jpeg' }); });

  it('re-editing keeps the post’s text for a photo with no library row, beside one that has a row', async () => { const storedImages = {
    'https://i/a': { width: 10, height: 20, alt: 'Copied A' },
    'https://i/gone': { width: 30, height: 40, alt: 'Imported alt', caption: 'Imported caption', format: 'jpeg' as const },
  };
  const parsed = G.parse('https://i/a\nhttps://i/gone');
  const fence = G.serialize([
    { src: 'https://i/a', width: 10, height: 20, alt: { de: 'Library A' }, caption: { de: '' } },
    { src: 'https://i/gone', width: 30, height: 40, fromPost: true },
  ], 'de', parsed.directives, postMetaFor(parsed, storedImages));
  const { images } = (await normalizeGalleryFences(fence, storedImages));
  expect(images['https://i/a']).toEqual({ width: 10, height: 20, alt: 'Library A' });
  expect(images['https://i/gone']).toEqual(storedImages['https://i/gone']); });

  it('survives a fence carrying a #66 layout directive', async () => { const fence = G.serialize(
    [{ src: 'https://i/a', width: 10, height: 20, alt: { de: 'A' } }],
    'de',
    ['#layout: breakout'],
  );
  const { bodyMarkdown, images } = (await normalizeGalleryFences(fence, {}));
  expect(images['https://i/a']).toMatchObject({ width: 10, height: 20, alt: 'A' });
  // isSkippableLine treats `#` lines as comments, so the directive must be
  // carried through the normalizer untouched.
  expect(bodyMarkdown).toContain('#layout: breakout'); });
});

describe('replaceFenceAt', () => {
  const body = 'intro\n\n```gallery\nhttps://i/a\n```\n\noutro';
  const FENCE = '```gallery\nhttps://i/b\n```';

  it('replaces the fence the cursor sits inside, as a range edit', async () => { const cursor = body.indexOf('https://i/a');
  const out = (await G.replaceFenceAt(body, cursor, FENCE));
  expect(out.replaced).toBe(true);
  // Only gallery content changes; opener/closer and surrounding source survive.
  expect(out.start).toBeGreaterThan(body.indexOf('```gallery'));
  expect(out.end).toBeLessThanOrEqual(body.lastIndexOf('```'));
  expect(apply(body, out)).toBe('intro\n\n```gallery\nhttps://i/b\n```\n\noutro'); });

  it('inserts at the cursor when it is not inside a fence', async () => { const out = (await G.replaceFenceAt(body, 0, FENCE));
  expect(out.replaced).toBe(false);
  expect(apply(body, out)).toContain('https://i/b');
  expect(apply(body, out)).toContain('https://i/a'); // the existing gallery is untouched
  });

  it('never damages a fence it does not own', async () => { const withCode = 'a\n\n```js\nconst x = 1;\n```\n\nb';
  const out = (await G.replaceFenceAt(withCode, withCode.indexOf('const'), FENCE));
  expect(out.replaced).toBe(false);
  expect(apply(withCode, out)).toContain('const x = 1;'); });

  // A fence only opens at column 0. Splicing raw at the cursor produced
  // `some te```gallery…` — literal text that neither the renderer nor
  // normalizeGalleryFences treats as a gallery, i.e. a silent no-op for the
  // author. Every insertion must land on its own line.
  describe('insertion always produces a real fence', () => {
    const opensAtColumnZero = (out: string) =>
      out.split('\n').some((l) => l === '```gallery');

    it('breaks out of a mid-paragraph cursor', async () => { const prose = 'some text here';
    const out = (await G.replaceFenceAt(prose, 5, FENCE));
    const next = apply(prose, out);
    expect(opensAtColumnZero(next)).toBe(true);
    expect(next).toBe('some \n\n```gallery\nhttps://i/b\n```\n\ntext here'); });

    it('does not stack blank lines when the cursor is already on one', async () => { const prose = 'a\n\nb';
    expect(apply(prose, (await G.replaceFenceAt(prose, 3, FENCE)))).toBe('a\n\n```gallery\nhttps://i/b\n```\n\nb'); });

    it('pads a cursor at the start of a line following text', async () => { const prose = 'a\nb';
    expect(apply(prose, (await G.replaceFenceAt(prose, 2, FENCE)))).toBe('a\n\n```gallery\nhttps://i/b\n```\n\nb'); });

    it('leaves a blank-line insertion point after an EOF gallery, including in an empty body', async () => { const emptyEdit = (await G.replaceFenceAt('', 0, FENCE));
    const empty = apply('', emptyEdit);
    expect(empty).toBe(FENCE + '\n\n');
    expect(emptyEdit.cursor).toBe(empty.length);
    expect((await G.scanFences(empty))).toMatchObject([{ isGallery: true, unterminated: false }]);
    
    const prose = 'a\n\n';
    const edit = (await G.replaceFenceAt(prose, prose.length, FENCE));
    const out = apply(prose, edit);
    expect(out).toBe(prose + FENCE + '\n\n');
    expect(edit.cursor).toBe(out.length);
    // This is the editor's next replaceSelection(ImageMarkdown.image(...)):
    // the caret lands after the suffix, so the image starts on its own line.
    const continued = out + '![Second](https://i/second)\n\nFOLLOWING STORY TEXT';
    expect((await G.scanFences(continued))).toMatchObject([{ isGallery: true, unterminated: false }]);
    expect(continued).toContain('![Second](https://i/second)');
    expect(continued).toContain('FOLLOWING STORY TEXT'); });

    // The suffix is empty when the body already has the blank line, so the end
    // of the range edit — where CodeMirror leaves the caret — is the closing
    // ```. The editor moves the caret to `cursor` instead: the first line after
    // the separator, whatever came after the insertion point.
    it('puts the caret past the blank line that already followed the insertion point', async () => { const prose = 'Intro\n\nMore';
    const edit = (await G.replaceFenceAt(prose, 'Intro'.length, FENCE));
    const out = apply(prose, edit);
    expect(out).toBe('Intro\n\n' + FENCE + '\n\nMore');
    expect(out.slice(edit.cursor)).toBe('More');
    expect(out.slice(0, edit.cursor).endsWith('```\n\n')).toBe(true); });

    it('puts the caret after an updated gallery and its existing separator, changing nothing around it', async () => { const edit = (await G.replaceFenceAt(body, body.indexOf('https://i/a'), FENCE));
    const out = apply(body, edit);
    expect(out.slice(edit.cursor)).toBe('outro');
    // An update at EOF with no newline after the closer has nowhere further
    // to go; it stays byte-identical rather than appending one.
    const eof = 'intro\n\n```gallery\nhttps://i/a\n```';
    const tail = (await G.replaceFenceAt(eof, eof.length - 1, FENCE));
    expect(apply(eof, tail)).toBe('intro\n\n' + FENCE);
    expect(tail.cursor).toBe(apply(eof, tail).length); });
  });

  // The upload button's `![alt](src)` must never land inside a fence: on the
  // closer's line it turned ``` into `` ```![…](…) ``, which is no closer, so
  // the gallery ran to EOF and the preview dropped every image and paragraph
  // after it while the saved Markdown still held them (#333).
  describe('insertBlockAt keeps an image out of every fence', () => {
    const IMG = '![Second](https://i/second)';
    const galleryBody = 'Intro\n\n```gallery\nhttps://i/a\n```\n\nFOLLOWING STORY TEXT';
    const closer = galleryBody.indexOf('```\n\nFOLLOWING') + 3;
    const place = (text: string, ins: Insertion) => text.slice(0, ins.start) + ins.text + text.slice(ins.start);

    it('inserts at the cursor itself outside every fence', async () => { const ins = (await G.insertBlockAt(galleryBody, 'Intro'.length, IMG));
    expect(ins).toEqual({ text: IMG, start: 'Intro'.length, cursor: 'Intro'.length + IMG.length, relocated: false });
    // The line right after the closer is outside the block, too.
    expect((await G.insertBlockAt(galleryBody, closer + 1, IMG)).relocated).toBe(false); });

    it('relocates a cursor on the closing ``` to after the block, without stacking blank lines', async () => { const ins = (await G.insertBlockAt(galleryBody, closer, IMG));
    expect(ins.relocated).toBe(true);
    const out = place(galleryBody, ins);
    expect(out).toBe('Intro\n\n```gallery\nhttps://i/a\n```\n\n' + IMG + '\n\nFOLLOWING STORY TEXT');
    expect(out.slice(ins.cursor)).toBe('FOLLOWING STORY TEXT');
    expect((await G.scanFences(out))).toMatchObject([{ isGallery: true, unterminated: false }]); });

    it('relocates from the opener line, a photo line, and a code block alike', async () => { const opener = galleryBody.indexOf('```gallery') + '```gallery'.length;
    const photo = galleryBody.indexOf('https://i/a') + 4;
    for (const cursor of [opener, photo]) {
      const out = place(galleryBody, (await G.insertBlockAt(galleryBody, cursor, IMG)));
      expect(out).toBe('Intro\n\n```gallery\nhttps://i/a\n```\n\n' + IMG + '\n\nFOLLOWING STORY TEXT');
    }
    const code = 'a\n\n```js\nconst x = 1;\n```\nb';
    const ins = (await G.insertBlockAt(code, code.indexOf('const') + 2, IMG));
    expect(place(code, ins)).toBe('a\n\n```js\nconst x = 1;\n```\n\n' + IMG + '\n\nb');
    expect(place(code, ins).slice(ins.cursor)).toBe('b'); });

    it('pads an EOF block so the caret ends on a fresh line', async () => { const eof = '```gallery\nhttps://i/a\n```';
    const ins = (await G.insertBlockAt(eof, eof.length, IMG));
    const out = place(eof, ins);
    expect(out).toBe(eof + '\n\n' + IMG + '\n\n');
    expect(ins.cursor).toBe(out.length); });

    it('refuses inside an unterminated fence instead of guessing where it ends', async () => { const open = 'Intro\n\n```gallery\nhttps://i/a\n';
    expect((await G.insertBlockAt(open, open.length, IMG))).toMatchObject({ blocked: 'unterminated', text: '', relocated: false }); });
  });

  describe('an empty fence removes the gallery', () => {
    it('preserves every byte outside the mapped gallery node', async () => { const out = (await G.replaceFenceAt(body, body.indexOf('https://i/a'), ''));
    expect(out.replaced).toBe(true);
    expect(apply(body, out)).toBe('intro\n\n\n\noutro'); });

    it('leaves a trailing gallery cleanly removed', async () => { const trailing = 'intro\n\n```gallery\nhttps://i/a\n```';
    const out = (await G.replaceFenceAt(trailing, trailing.length - 1, ''));
    expect(apply(trailing, out)).toBe('intro\n\n'); });

    it('is a no-op when the cursor is not in a gallery', async () => { const out = (await G.replaceFenceAt(body, 0, ''));
    expect(out.replaced).toBe(false);
    expect(out.start).toBe(out.end);
    expect(apply(body, out)).toBe(body); });
  });
});

describe('scanFences public seam', () => {
  it('exposes the same gallery ranges as fenceAt while retaining enclosing code blocks', async () => { const sections = [
    '````md\r\n```gallery\r\nhttps://i/example\r\n```\r\n`````',
    '```gallery\r\n#layout: slider\r\nhttps://i/a\r\n````',
    '~~~js\r\n# Not a heading\r\n~~~~',
    '````gallery\r\nhttps://i/b',
  ];
  const body = 'intro\r\n' + sections.join('\r\nbetween\r\n');
  const blocks = (await G.scanFences(body));
  expect(blocks).toMatchObject(sections.map((section, index) => ({
    isGallery: index === 1 || index === 3,
    unterminated: index === 3,
  })));
  blocks.forEach((block, index) => expect(body.slice(block.start, block.end).replace(/\r$/, '')).toBe(sections[index]));
  for (const block of blocks) {
    const found = (await G.fenceAt(body, block.start + 1));
    if (block.isGallery) {
      expect(found).toMatchObject({
        start: block.start, end: block.end,
        text: body.slice(block.start, block.end), unterminated: block.unterminated,
      });
    } else {
      expect(found).toBeNull();
    }
  } });

  it('shares the strict closer rule and gallery classification used by the picker', async () => { const protectedBlock = '````gallery\n```\n````\u00a0\nhttps://i/a\n`````';
  const prose = '\nAfter\n';
  const other = '  ```gallery\nhttps://i/b\n```';
  const body = protectedBlock + prose + other;
  expect((await G.scanFences(body))).toMatchObject([
    { isGallery: true, unterminated: false },
    { isGallery: true, unterminated: false },
  ]);
  expect((await G.fenceAt(body, body.indexOf('https://i/a')))?.text).toBe(protectedBlock);
  expect((await G.fenceAt(body, body.indexOf('https://i/b')))?.content).toContain('https://i/b'); });
});

describe('fenceAt', () => {
  const body = 'intro\n\n```gallery\n#layout: slider\nhttps://i/a\n```\n\nouttro';

  it('edits the innermost rendered gallery while protecting its nongallery HTML container', async () => {
    const inner = '<pre><code class="language-gallery">https://i/a</code></pre>';
    const nested = '<pre>literal before\n' + inner + '\nliteral after</pre>';
    expect((await G.fenceAt(nested, nested.indexOf('https://i/a')))?.text).toBe(inner);
    expect(await G.fenceAt(nested, nested.indexOf('literal before'))).toBeNull();
    const edit = await G.replaceFenceAt(nested, nested.indexOf('https://i/a'), '```gallery\nhttps://i/b\n```');
    const changed = apply(nested, edit);
    expect(changed.startsWith('<pre>literal before\n<pre><code class="language-gallery">')).toBe(true);
    expect(changed.endsWith('</code></pre>\nliteral after</pre>')).toBe(true);
    expect((await G.fenceAt(changed, changed.indexOf('https')))?.content).toBe('https://i/b');
  });

  it('returns the whole fence when the cursor is inside it', async () => { const found = (await G.fenceAt(body, body.indexOf('https://i/a')));
  expect(found?.text).toBe('```gallery\n#layout: slider\nhttps://i/a\n```'); });

  it('is inclusive of both delimiter lines', async () => { expect((await G.fenceAt(body, body.indexOf('```gallery')))).not.toBeNull();
  expect((await G.fenceAt(body, body.indexOf('```', body.indexOf('https://i/a'))))).not.toBeNull(); });

  it('returns null outside any fence', async () => { expect((await G.fenceAt(body, 0))).toBeNull();
  expect((await G.fenceAt(body, body.length - 1))).toBeNull(); });

  it('ignores a non-gallery fence', async () => { const js = 'a\n\n```js\nconst x = 1;\n```\n';
  expect((await G.fenceAt(js, js.indexOf('const')))).toBeNull(); });

  it('handles a closing fence longer than its opener (CommonMark)', async () => { // rewriteFences in body-content.ts was rewritten from a regex precisely
  // because the old one required the closer to match the opener's length.
  const longer = '```gallery\nhttps://i/a\n`````\n';
  const found = (await G.fenceAt(longer, longer.indexOf('https://i/a')));
  expect(found?.text).toBe('```gallery\nhttps://i/a\n`````'); });

  it('does not treat a gallery example nested in a wrapper fence as editable', async () => { // docs/authoring-workflow.md demonstrates the syntax with a 4-backtick
  // wrapper around a 3-backtick gallery. The inner block is documentation,
  // not an editable gallery.
  const nested = '````\n```gallery\nhttps://i/a\n```\n````\n';
  expect((await G.fenceAt(nested, nested.indexOf('https://i/a')))).toBeNull(); });

  describe('agrees with the server about what a gallery is', () => {
    it('does not claim a fence whose info string merely starts with "gallery"', async () => { const other = '```gallery-notes\nhttps://i/a\n```\n';
    expect((await G.fenceAt(other, other.indexOf('https://i/a')))).toBeNull(); });

    it('claims a 4-backtick gallery, which the server treats as one', async () => { const wide = '````gallery\nhttps://i/a\n````\n';
    expect((await G.fenceAt(wide, wide.indexOf('https://i/a')))?.text).toBe('````gallery\nhttps://i/a\n````'); });

    it('recognizes an indented gallery through the real parser', async () => { const indented = '  ```gallery\n  https://i/a\n  ```\n';
    expect((await G.fenceAt(indented, indented.indexOf('https://i/a')))?.content).toContain('https://i/a'); });

    it('ignores a backtick in an info string, which CommonMark says cannot open a fence', async () => { // `a ``` b` is inline code, not a fence — so the ```gallery below is a
    // real, editable top-level gallery and not the inside of an open block.
    const body = 'text ```js `x` weird\n\n```gallery\nhttps://i/a\n```\n';
    expect((await G.fenceAt(body, body.indexOf('https://i/a')))?.text).toBe('```gallery\nhttps://i/a\n```'); });
  });
});


describe('#layout: directive — the picker\'s half of the rule (#66)', () => {
  const gf = load();

  it('agrees with the renderer about every mode it offers', async () => { expect(gf.LAYOUTS).toEqual([...GALLERY_MODES]);
  expect(gf.DEFAULT_LAYOUT).toBe(DEFAULT_GALLERY_MODE); });

  // @ai-warning This is the parity guard, and it is the only thing keeping
  // layoutOf honest against readLayoutMode: a browser IIFE cannot import the
  // site's ESM module, so the directive rule is written out twice. If they
  // diverge the picker shows one mode and the site renders another, silently,
  // and only after publishing.
  it('reads the same mode out of a directive as readLayoutMode does', async () => { const corpus = [
    '#layout: breakout', '#layout: column', '#layout: slider',
    '#layout:slider', '# layout: slider', '   #layout :  slider   ',
    '#LAYOUT: Slider', '#layout: carousel', '#layout:', '#layout',
    '#layout: slider extra', '# just a note', '#', '',
    '#layout: SLIDER', '#Layout:Column',
  ];
  for (const line of corpus) {
    expect(gf.layoutOf([line]), line).toBe(readLayoutMode(line));
  } });

  it('agrees on which of several directives wins', async () => { const lines = ['# a note', '#layout: slider', '#layout: column'];
  expect(gf.layoutOf(lines)).toBe(readLayoutMode(lines.join('\n')));
  expect(gf.layoutOf(lines)).toBe('slider'); });

  it('defaults to the column for a fence with no directive at all', async () => { expect(gf.layoutOf([])).toBe('column'); });

  it('writes no directive for the default, so an untouched gallery is unchanged', async () => { expect(gf.withLayout([], 'column')).toEqual([]);
  expect(gf.withLayout(['#layout: slider'], 'column')).toEqual([]); });

  // The default flipped from break-out to column on 2026-09-20; a gallery
  // that should stay wide now has to say so.
  it('writes the directive for break-out, which is no longer the default', async () => { expect(gf.withLayout([], 'breakout')).toEqual(['#layout: breakout']); });

  it('replaces the layout directive and keeps every other comment line', async () => { expect(gf.withLayout(['# shot on the pass', '#layout: column'], 'slider'))
    .toEqual(['#layout: slider', '# shot on the pass']); });

  it('never writes a mode the renderer would reject', async () => { // A bogus value must not be written through: the fence would then carry a
  // directive the site silently ignores, so the picker would keep showing a
  // mode the reader never gets.
  for (const bogus of ['carousel', '', 'SLIDER; drop table', 'breakout ', 'slider\n#layout: column']) {
    const out = gf.withLayout([], bogus);
    const text = out.join('\n');
    expect(readLayoutMode(text), bogus).toBe(gf.layoutOf(out));
    expect(gf.LAYOUTS, bogus).toContain(gf.layoutOf(out));
  } });

  it('round-trips a directive through parse → withLayout → serialize', async () => { // The risk the #66 review named: #75's picker regenerating a fence must not
  // clobber the layout an author chose.
  const fence = [
    '```gallery',
    '#layout: slider',
    '# a note the picker knows nothing about',
    'https://img.test/a | 3000x2000 | alt="A"',
    '```',
  ].join('\n');
  const parsed = gf.parse(await logical(fence));
  expect(gf.layoutOf(parsed.directives)).toBe('slider');
  
  // Re-serializing with the mode unchanged keeps both directives…
  const same = gf.serialize(
    parsed.lines.map((l) => ({ src: l.src, width: l.width!, height: l.height! })),
    'de',
    gf.withLayout(parsed.directives, 'slider'),
    { 'https://img.test/a': { alt: 'A' } },
  );
  expect(same).toContain('#layout: slider');
  expect(same).toContain('# a note the picker knows nothing about');
  expect(readLayoutMode(same)).toBe('slider');
  
  // …and switching to the default drops only the layout line.
  const switched = gf.serialize(
    parsed.lines.map((l) => ({ src: l.src, width: l.width!, height: l.height! })),
    'de',
    gf.withLayout(parsed.directives, 'column'),
    {},
  );
  expect(switched).not.toContain('#layout');
  expect(switched).toContain('# a note the picker knows nothing about');
  expect(readLayoutMode(switched)).toBe('column'); });

  it('survives normalizeGalleryFences — the directive is not mistaken for a photo', async () => { const body = ['```gallery', '#layout: slider', 'https://img.test/a | 3000x2000 | alt="A"', '```'].join('\n');
  const out = (await normalizeGalleryFences(body, {}));
  expect(out.bodyMarkdown).toContain('#layout: slider');
  expect(readLayoutMode(out.bodyMarkdown)).toBe('slider');
  expect(Object.keys(out.images)).toEqual(['https://img.test/a']); });
});

// docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md,
// "Gallery-local caption controls": `#captions: hidden` and a per-line
// `caption-override="…"` belong to ONE gallery and must never leak into the
// URL-keyed images map, which every gallery using that photo shares.
describe('#captions: directive — the picker\'s half of the rule', () => {
  // @ai-warning Parity guard, like the #layout one above: the browser copy and
  // readCaptionsVisible must agree, or the picker shows "Show captions" ticked
  // for a gallery the site renders without them.
  it('reads visibility exactly as the renderer does', async () => { const corpus = [
    '#captions: hidden', '#captions:hidden', '# captions : hidden', '   #CAPTIONS:  Hidden   ',
    '#captions: visible', '#captions: shown', '#captions: off', '#captions:', '#captions',
    '#captions: hidden extra', '#captionsx: hidden', '# note about hidden captions', '',
  ];
  for (const line of corpus) {
    expect(G.captionsVisible([line]), line).toBe(readCaptionsVisible(line));
  }
  expect(G.captionsVisible(['#captions: hidden'])).toBe(false);
  expect(G.captionsVisible(['#captions: off'])).toBe(true); // unknown ⇒ visible
  });

  it('lets the first matching directive win, as the renderer does', async () => { for (const lines of [
    ['#layout: slider', '#captions: hidden', '#captions: visible'],
    ['#captions: visible', '#captions: hidden'],
    ['#captions: unknown', '#captions: hidden'],
  ]) {
    expect(G.captionsVisible(lines), lines.join(' / ')).toBe(readCaptionsVisible(lines.join('\n')));
  }
  expect(G.captionsVisible(['#captions: visible', '#captions: hidden'])).toBe(true); });

  it('defaults to visible, and showing captions writes no directive', async () => { expect(G.captionsVisible([])).toBe(true);
  expect(G.withCaptions([], true)).toEqual([]); });

  it('hides with one directive and shows by removing every captions directive, keeping the rest in order', async () => { const authored = ['#layout: slider', '# shot on the pass'];
  const hidden = G.withCaptions(authored, false);
  expect(G.captionsVisible(hidden)).toBe(false);
  expect(hidden.filter((line) => line !== '#captions: hidden')).toEqual(authored);
  expect(G.withCaptions(hidden, false).filter((line) => /captions/i.test(line))).toHaveLength(1);
  // A second, later hidden line would win once the first is gone.
  const twice = ['#captions: hidden', '#layout: slider', '#CAPTIONS: Hidden', '# shot on the pass'];
  const shown = G.withCaptions(twice, true);
  expect(shown).toEqual(authored);
  expect(readCaptionsVisible(G.serialize([], 'de', shown))).toBe(true); });

  it('survives layout changes and normalizeGalleryFences', async () => { const directives = G.withLayout(G.withCaptions(['#layout: slider'], false), 'column');
  expect(G.captionsVisible(directives)).toBe(false);
  const fence = G.serialize([{ src: 'https://img.test/a', width: 30, height: 20 }], 'de', directives);
  const saved = (await normalizeGalleryFences(fence, {}));
  expect(readCaptionsVisible(saved.bodyMarkdown)).toBe(false);
  expect(readLayoutMode(saved.bodyMarkdown)).toBe('column');
  expect(Object.keys(saved.images)).toEqual(['https://img.test/a']); });
});

describe('caption-override="…" — a gallery-local caption on the photo line', () => {
  const a = 'https://img.example.com/trips/x/a';
  const b = 'https://img.example.com/trips/x/b';
  const row = (src: string, caption: string): PickedItem =>
    ({ src, width: 30, height: 20, alt: { de: 'Alt ' + src.slice(-1) }, caption: { de: caption } });

  it('parses an override as the renderer does: escaped, empty, absent, capped, last one wins', async () => { const corpus = [
    a,
    a + ' | caption-override=""',
    a + ' | caption-override="x &#124; y &quot;z&quot;&#10;two &lt;b&gt; &amp;amp;"',
    a + ' | 30x20 | caption="Library" | caption-override="Local"',
    a + ' | caption-override="first" | caption-override="second"',
    a + ' |caption-override="tight"|alt="A"',
    a + ' | caption-override=unquoted',
    a + ' | Caption-Override="case"',
    a + ' | caption-override="' + 'x'.repeat(1200) + '"',
  ];
  for (const line of corpus) {
    expect(G.parse(line).lines[0]?.captionOverride, line).toBe(readCaptionOverride(line));
  }
  const [absent, empty, escaped] = corpus.map((line) => G.parse(line).lines[0]!);
  expect('captionOverride' in absent!).toBe(false);
  expect(empty!.captionOverride).toBe('');
  expect(escaped!.captionOverride).toBe('x | y "z"\ntwo <b> &amp;');
  expect(G.parse(corpus[8]!).lines[0]?.captionOverride).toHaveLength(1000); });

  it('writes explicit overrides, empty included, only for the photos that have one', async () => { const fence = G.serialize([row(a, 'Library A'), row(b, 'Library B')], 'de', [], {}, { [a]: '' });
  const [lineA, lineB] = G.parse(await logical(fence)).lines;
  expect(lineA).toMatchObject({ src: a, caption: 'Library A', captionOverride: '' });
  expect(lineB).toMatchObject({ src: b, caption: 'Library B' });
  expect('captionOverride' in lineB!).toBe(false);
  expect(G.serialize([row(a, 'Library A')], 'de', [], {})).not.toContain('caption-override'); });

  it('round-trips text that would otherwise break the line or the fence, capped at 1000 characters', async () => { for (const value of [...TRICKY.filter((text) => !text.includes('\r')), '```\n#captions: visible\n<script>x</script>', 'y'.repeat(1500)]) {
    const fence = G.serialize([row(a, 'Library A')], 'de', [], {}, { [a]: value });
    expect(fence.split('\n'), value).toHaveLength(3);
    expect(G.captionsVisible(G.parse(await logical(fence)).directives)).toBe(true);
    expect(G.parse(await logical(fence)).lines[0]?.captionOverride, value).toBe(value.slice(0, 1000));
    expect(readCaptionOverride(fence.split('\n')[1]!), value).toBe(value.slice(0, 1000));
  } });

  it('ignores an override for a photo that is not in the gallery', async () => { const fence = G.serialize([row(a, 'Library A')], 'de', [], {}, { [b]: 'Stray' });
  expect(G.parse(await logical(fence)).lines.map((line) => line.src)).toEqual([a]);
  expect(fence).not.toContain('Stray'); });

  it('stays on its own gallery’s line through save and export, never in the shared images map', async () => { const local = 'Nur hier | "lokal"';
  const first = G.serialize([row(a, 'Library A')], 'de', G.withCaptions([], false), {}, { [a]: local });
  const second = G.serialize([row(a, 'Library A')], 'de', [], {});
  const saved = (await normalizeGalleryFences(first + '\n\nBetween\n\n' + second, {}));
  expect(saved.images).toEqual({ [a]: { width: 30, height: 20, alt: 'Alt a', caption: 'Library A' } });
  const [stored1, stored2] = (await G.scanFences(saved.bodyMarkdown))
    .map((block) => G.parse(block.content));
  expect(stored1).toEqual({ directives: ['#captions: hidden'], lines: [{ src: a, captionOverride: local }] });
  expect(stored2).toEqual({ directives: [], lines: [{ src: a }] });
  
  // Saving again (a re-save of the stored form) changes nothing.
  expect((await normalizeGalleryFences(saved.bodyMarkdown, saved.images))).toEqual(saved);
  
  const exported = (await galleryFencesToMdx(saved.bodyMarkdown, saved.images));
  const [mdx1, mdx2] = (await G.scanFences(exported)).map((block) => G.parse(block.content));
  expect(mdx1?.lines).toEqual([{ src: a, width: 30, height: 20, alt: 'Alt a', caption: 'Library A', captionOverride: local }]);
  expect(G.captionsVisible(mdx1!.directives)).toBe(false);
  expect(mdx2?.lines).toEqual([{ src: a, width: 30, height: 20, alt: 'Alt a', caption: 'Library A' }]);
  // And re-importing the export restores the same stored form.
  expect((await normalizeGalleryFences(exported, {}))).toEqual(saved); });

  it('leaves an override alone when the author edits the photo’s alt in the widget', async () => { const fence = G.serialize([row(a, 'Library A')], 'de', [], {}, { [a]: 'Local' });
  const edited = G.parse(await logical(G.withAlt(fence, a, 'New alt'))).lines[0];
  expect(edited).toMatchObject({ alt: 'New alt', caption: 'Library A', captionOverride: 'Local' }); });
});

describe('authoritative gallery transport and source edits', () => {
  it('sends the exact unsaved snapshot once for simultaneous read-only consumers', async () => {
    const calls: RequestInit[] = [];
    const transport: typeof fetch = async (url, init) => {
      expect(url).toBe('/gallery/analyze');
      calls.push(init!);
      return Response.json(await analyzeGallerySource(JSON.parse(String(init!.body)).bodyMarkdown));
    };
    const api = load(transport);
    const body = '> ~~~~gallery extra\r\n> https://i/a\r\n> ~~~~';
    const [analysis, blocks] = await Promise.all([api.analyze(body), api.scanFences(body)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bodyMarkdown: body }) });
    expect(analysis.bodyMarkdown).toBe(body);
    expect(blocks).toEqual(analysis.blocks);
    expect(blocks[0]?.content).toContain('https://i/a');
  });

  it('rejects a mismatched snapshot and retries failed analysis without a lexical fallback', async () => {
    let calls = 0;
    const api = load(async () => {
      calls++;
      if (calls === 1) throw new TypeError('offline');
      return Response.json({ bodyMarkdown: 'wrong', blocks: [] });
    });
    const body = '```gallery\nhttps://i/a\n```';
    await expect(api.replaceFenceAt(body, 5, '')).rejects.toThrow('offline');
    await expect(api.analyze(body)).rejects.toThrow('snapshot mismatch');
    expect(calls).toBe(2);
  });

  it.each([
    '> ~~~~gallery extra\r\n> https://i/a | 3x2 | alt="Old"\r\n> ~~~~\r\n>\r\n> Following',
    '- ~~~gallery extra\n  https://i/a | 3x2 | alt="Old"\n  ~~~\n\n- Following',
    '<pre data-note="keep"><code class="language-gallery">https://i/a | 3x2 | alt="Old"</code></pre>\n\nFollowing',
  ])('preserves container, opener, info string and HTML wrapper when updating %s', async (body) => {
    const original = await G.fenceAt(body, body.indexOf('https://i/a'));
    expect(original).not.toBeNull();
    const edit = await G.replaceFenceAt(body, body.indexOf('https://i/a'),
      G.serialize([{ src: 'https://i/b', width: 3, height: 2, alt: { de: 'A & <ridge>' } }], 'de'));
    const next = apply(body, edit);
    expect(next.slice(0, edit.start)).toBe(body.slice(0, edit.start));
    expect(next.slice(edit.start + edit.text.length)).toBe(body.slice(edit.end));
    const updated = await G.fenceAt(next, next.indexOf('https://i/b'));
    expect(G.parse(updated!.content).lines).toEqual([{ src: 'https://i/b', width: 3, height: 2, alt: 'A & <ridge>' }]);
    expect(next).toContain('Following');
    if (original!.kind === 'html') expect(next).toContain('<pre data-note="keep"><code class="language-gallery">');
    else expect(next).toContain('~~~gallery extra');
  });

  it('edits raw HTML alt text through its entity layer without touching adjacent text', async () => {
    const body = 'Before\n\n<pre><code class="language-gallery">https://i/a | 3x2 | alt=&quot;Old&quot; | caption=&quot;Keep &amp;amp; this&quot;</code></pre>\n\nAfter';
    const edits = await G.altEdit(body, 'https://i/a', '<New> & "quote"');
    const next = edits.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), body);
    expect(next).toContain('caption=&quot;Keep &amp;amp; this&quot;');
    const block = (await G.analyze(next)).blocks.find((entry) => entry.isGallery)!;
    expect(G.parse(block.content).lines[0]?.alt).toBe('<New> & "quote"');
    expect(next.startsWith('Before\n\n<pre><code class="language-gallery">')).toBe(true);
    expect(next.endsWith('</code></pre>\n\nAfter')).toBe(true);
  });

  it('blocks unfinished gallery mutation while retaining audit membership', async () => {
    const body = '> ~~~gallery extra\n> https://i/a';
    expect((await G.analyze(body)).blocks[0]).toMatchObject({ isGallery: true, unterminated: true });
    expect(await G.replaceFenceAt(body, body.indexOf('https://i/a'), '')).toMatchObject({ blocked: 'unterminated', text: '' });
  });
});

describe('gallery analysis request lifetime', () => {
  it('bounds an unavailable server request and permits an explicit retry', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const api = load(async (_url, init) => {
        calls++;
        if (calls > 1) return Response.json(await analyzeGallerySource(''));
        const pending = Promise.withResolvers<Response>();
        init!.signal!.addEventListener('abort', () => pending.reject(new DOMException('Aborted', 'AbortError')), { once: true });
        return pending.promise;
      });
      const failure = expect(api.analyze('')).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(10000);
      await failure;
      expect((await api.analyze('')).bodyMarkdown).toBe('');
      expect(calls).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('never associates a late result with a newer editor snapshot', async () => {
    const first = Promise.withResolvers<Response>();
    const api = load(async (_url, init) => {
      const body = JSON.parse(String(init!.body)).bodyMarkdown;
      return body === 'old' ? first.promise : Response.json(await analyzeGallerySource(body));
    });
    const old = api.analyze('old');
    const current = await api.analyze('~~~gallery\nhttps://i/a\n~~~');
    first.resolve(Response.json(await analyzeGallerySource('old')));
    expect((await old).bodyMarkdown).toBe('old');
    expect(current.bodyMarkdown).toBe('~~~gallery\nhttps://i/a\n~~~');
    expect(current.blocks[0]?.isGallery).toBe(true);
  });
});

describe('atomic malformed photo lines in browser editing', () => {
  const probes = [
    'caption="The \\"Old\\" Bridge"',
    'caption="Rom | Tag 2"',
    'capton="typo"',
    'alt = "spaces"',
    "alt='single quote'",
    'caption-override="broken',
    'caption-override="valid" | unknown="no"',
    'caption="raw | alt="valid-looking suffix"',
    'format="png"',
    '0x100',
  ];
  it.each(probes)('preserves all bytes and exposes no partial metadata for %s', async (field) => {
    const line = '  https://i/a | 10x20 | alt="before" | ' + field + '  \r';
    expect(G.parse(line).lines).toEqual([expect.objectContaining({
      valid: false, raw: line, src: 'https://i/a', diagnostic: expect.any(Object),
    })]);
    const photo = G.parse(line).lines[0]!;
    expect(photo.width).toBeUndefined();
    expect(photo.alt).toBeUndefined();
    expect(photo.captionOverride).toBeUndefined();
    expect(G.withAlt(line, 'https://i/a', 'replacement')).toBe(line);
    const body = '> ~~~gallery extra\r\n> ' + line + '\n> ~~~';
    expect(await G.altEdit(body, 'https://i/a', 'replacement')).toEqual([]);
    const removal = await G.replaceFenceAt(body, body.indexOf('https://'), '');
    expect(removal.blocked).toBe('invalid_metadata');
    expect(apply(body, removal)).toBe(body);
  });

  it('edits valid occurrences only and leaves invalid duplicates byte-identical', async () => {
    const bad = 'https://i/a | 10x20 | caption="raw | delimiter"';
    const body = '> ~~~gallery\n> ' + bad + '\n> https://i/a | 10x20 | alt="old"\n> ~~~';
    let result = body;
    for (const edit of await G.altEdit(body, 'https://i/a', 'new | "alt"')) {
      result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    }
    expect(result).toContain('> ' + bad + '\n');
    expect(result).toContain('alt="new &#124; &quot;alt&quot;"');
  });

  it('restores visual editing after only the invalid syntax is repaired', async () => {
    const body = '~~~gallery extra\nhttps://i/a | 10x20 | caption="Rom &#124; Tag 2"\nhttps://i/b\n~~~';
    const out = await G.replaceFenceAt(body, body.indexOf('https://'), G.serialize([
      { src: 'https://i/a', width: 10, height: 20 },
      { src: 'https://i/b', width: 20, height: 10 },
    ], 'de'));
    expect(out.blocked).toBeUndefined();
    expect(apply(body, out)).toContain('https://i/b');
  });
});
