import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { analyzeGallerySource } from '../../site/src/lib/gallery-source.js';

type Status = 'pass' | 'warn';
interface Finding {
  code: string;
  message: string;
  line?: number;
  target?: 'hero' | 'inline' | 'gallery';
}
interface Findings { status: Status; findings: Finding[]; count?: number }
interface LengthCheck { status: Status; count: number; message?: string }
interface Story {
  title?: string;
  excerpt?: string;
  markdown?: string;
  heroSrc?: string;
  heroAlt?: string;
  galleryAlt?: { library?: Record<string, string>; stored?: Record<string, string> };
}
interface StoryResult {
  title: LengthCheck;
  excerpt: LengthCheck;
  headings: Findings;
  altText: Findings;
  internalLinks: Findings;
  pass: boolean;
  warningCount: number;
}
interface Api {
  lintTitle(text?: string): LengthCheck;
  lintExcerpt(text?: string): LengthCheck;
  lintHeadings(markdown?: string): Promise<Findings>;
  lintAltText(input: Pick<Story, 'heroSrc' | 'heroAlt' | 'markdown' | 'galleryAlt'>): Promise<Findings>;
  lintInternalLinks(markdown?: string): Promise<Findings>;
  lintStory(input?: Story): Promise<StoryResult>;
  findImage(markdown: string, src: string): Promise<{ start: number; end: number; line: number } | null>;
}

// The transport returns real source analysis, never a second gallery classifier.
const windowStub: { EditorLinter?: Api } = {};
const sandbox = vm.createContext({ window: windowStub, AbortController, setTimeout, clearTimeout,
  fetch: async (_url: string, init: RequestInit) => ({
    ok: true, json: () => analyzeGallerySource(JSON.parse(String(init.body)).bodyMarkdown),
  }),
});
vm.runInContext(readFileSync('public/gallery-fence.js', 'utf8'), sandbox);
vm.runInContext(readFileSync('public/editor-linter.js', 'utf8'), sandbox);
if (!windowStub.EditorLinter) throw new Error('EditorLinter was not exported');
const L = windowStub.EditorLinter;

function locations(result: Findings) {
  return result.findings.map(({ code, line, target }) => ({ code, line, target }));
}

const validStory: Story = {
  title: 'A walking route through Bergen',
  excerpt: 'x'.repeat(120),
  markdown: '## Arrival\n### Getting there\n## The walk\n[Another story](/reisen/)',
  heroSrc: '/images/hero.webp',
  heroAlt: 'Wooden houses beside the harbour',
};

describe('exact title and excerpt lengths', () => {
  it.each<[number, Status]>([[19, 'warn'], [20, 'pass'], [70, 'pass'], [71, 'warn']])('title length %i is %s', (length, status) => {
    expect(L.lintTitle('a'.repeat(length))).toMatchObject({ status, count: length });
  });

  it.each<[number, Status]>([[99, 'warn'], [100, 'pass'], [160, 'pass'], [161, 'warn']])('excerpt length %i is %s', (length, status) => {
    expect(L.lintExcerpt('a'.repeat(length))).toMatchObject({ status, count: length });
  });

  it('counts the exact field value, including spaces and UTF-16 units, without trimming', async () => { expect(L.lintTitle(' ' + 'ä'.repeat(17) + '\u{10400}')).toEqual({ status: 'pass', count: 20 });
  expect(L.lintTitle()).toMatchObject({ status: 'warn', count: 0 });
  expect(L.lintExcerpt()).toMatchObject({ status: 'warn', count: 0 }); });
});

describe('CommonMark ATX headings', () => {
  it('allows nested levels, siblings, and returning to an earlier level', async () => { expect((await L.lintHeadings('## One\n### Two\n#### Three\n##### Four\n###### Five\n### Six\n## Seven'))).toEqual({ status: 'pass', findings: [] }); });

  it('locates body H1 and skipped levels, treating the title as the initial H1', async () => { expect(locations((await L.lintHeadings('### Too deep\n## Section\n#### Skipped\n# Body title')))).toEqual([
    { code: 'heading-level-skipped', line: 1, target: undefined },
    { code: 'heading-level-skipped', line: 3, target: undefined },
    { code: 'body-h1', line: 4, target: undefined },
  ]); });

  it('requires an ATX delimiter and respects three-space indentation and six levels', async () => { const body = ['#tag', '##anchor', '####### Too many', '    # Indented code', '\t# Indented code', '\\# Escaped', '#\u00a0Not a space', '#`code`', '   ##\tValid', '   #### Skips H3'].join('\n');
  expect(locations((await L.lintHeadings(body)))).toEqual([{ code: 'heading-level-skipped', line: 10, target: undefined }]); });

  it('recognizes empty ATX headings and CRLF line locations', async () => { expect(locations((await L.lintHeadings('##\r\n###\t\r\n#\r\n#### After H1')))).toEqual([
    { code: 'body-h1', line: 3, target: undefined },
    { code: 'heading-level-skipped', line: 4, target: undefined },
  ]); });

  it('isolates longer/nested gallery examples, tildes, and unterminated code fences', async () => { const markdown = ['## Real', '````md', '# Code', '```gallery', '#### Not a heading', '```', '`````', '~~~js', '# Still code', '~~~~', '````gallery', '#layout: slider', '# Not a heading', '````', '### Real subsection', '```js', '# Unclosed code'].join('\n');
  expect((await L.lintHeadings(markdown))).toEqual({ status: 'pass', findings: [] }); });

  it('does not let a short or NBSP-tailed closer end the scanner’s protected range', async () => { const body = '````gallery\r\n```\r\n````\u00a0\r\n# Still protected\r\n`````\r\n# Real';
  expect(locations((await L.lintHeadings(body)))).toEqual([{ code: 'body-h1', line: 6, target: undefined }]); });

  it('detects headings that interrupt prose with unmatched backticks', async () => { expect(locations((await L.lintHeadings('``example\n# Body heading\n` nested\n``\n# Real')))).toEqual([
    { code: 'body-h1', line: 2, target: undefined },
    { code: 'body-h1', line: 5, target: undefined },
  ]); });

  it('does not let backticks in separate paragraphs conceal a heading', async () => { expect(locations((await L.lintHeadings('`open\r\n\r\n# Body title\r\n\r\nclose`')))).toEqual([
    { code: 'body-h1', line: 3, target: undefined },
  ]); });
});

describe('missing alt text', () => {
  it.each([undefined, '', ' \t\n '])('flags absent/blank hero alt (%j) only when a hero is present', async (heroAlt) => { expect(locations((await L.lintAltText({ heroSrc: '/hero.webp', heroAlt })))).toEqual([{ code: 'missing-alt', target: 'hero', line: undefined }]);
  expect((await L.lintAltText({ heroAlt })).status).toBe('pass'); });

  it('passes meaningful hero/inline/gallery alt text without generic-text heuristics', async () => { const markdown = '![A summit](/photo.webp)\n```gallery\nhttps://images.example/a | 3x2 | alt="A ridge &quot;above&quot; the valley"\n```';
  expect((await L.lintAltText({ heroSrc: '/hero.webp', heroAlt: ' Image ', markdown }))).toEqual({ status: 'pass', findings: [] }); });

  it('locates empty and whitespace-only inline alt text, including multiline labels', async () => { const markdown = '![](/first.webp)\r\nText\r\n![ \r\n\t ](</photo (two).webp> "Caption")\r\n![](/last.webp)';
  expect(locations((await L.lintAltText({ markdown })))).toEqual([
    { code: 'missing-alt', line: 1, target: 'inline' },
    { code: 'missing-alt', line: 3, target: 'inline' },
    { code: 'missing-alt', line: 5, target: 'inline' },
  ]); });

  it('accepts escaped labels, URL parentheses, optional titles, and code in real alt text', async () => { expect((await L.lintAltText({ markdown: '![A \\[ridge\\]](/a_(b).webp "View")\n![`Summit`](/b.webp)' })).status).toBe('pass');
  expect(locations((await L.lintAltText({ markdown: '![](/a_(b).webp "View")' })))).toEqual([{ code: 'missing-alt', line: 1, target: 'inline' }]); });

  it('uses gallery metadata decoding, ignores directives/blanks, and preserves CRLF locations', async () => { const markdown = ['Intro', '````gallery', '#layout: slider', '', 'https://images.example/a', 'https://images.example/b | 3x2 | alt=""', 'https://images.example/c | alt=" &#10; "', 'https://images.example/d | alt="A &#124; B"', '`````'].join('\r\n');
  expect(locations((await L.lintAltText({ markdown })))).toEqual([
    { code: 'missing-alt', line: 5, target: 'gallery' },
    { code: 'missing-alt', line: 6, target: 'gallery' },
    { code: 'missing-alt', line: 7, target: 'gallery' },
  ]); });

  // docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md: a
  // photo with a Media row renders its current Media alt, empty included, over
  // anything the post says; a saved bare line falls back to the stored alt.
  it('judges gallery alt by what the build renders: Media first, then the line, then the stored entry', async () => { const markdown = ['```gallery',
    'https://images.example/media-filled | 3x2 | alt=""',
    'https://images.example/media-cleared | 3x2 | alt="Stale post copy"',
    'https://images.example/saved',
    'https://images.example/saved-empty',
    'https://images.example/__proto__',
    '```'].join('\n');
  const galleryAlt = {
    library: { 'https://images.example/media-filled': 'Current Media alt', 'https://images.example/media-cleared': '' },
    stored: { 'https://images.example/saved': 'Stored alt', 'https://images.example/saved-empty': ' ' },
  };
  expect(locations((await L.lintAltText({ markdown, galleryAlt })))).toEqual([
    { code: 'missing-alt', line: 3, target: 'gallery' },
    { code: 'missing-alt', line: 5, target: 'gallery' },
    { code: 'missing-alt', line: 6, target: 'gallery' },
  ]); });

  it('reports hero and mixed markdown findings in source order, including EOF galleries', async () => { const markdown = '```gallery\nhttps://images.example/a\n```\n![](/photo.webp)\n```gallery\nhttps://images.example/b';
  expect(locations((await L.lintAltText({ heroSrc: '/hero.webp', markdown })))).toEqual([
    { code: 'missing-alt', target: 'hero', line: undefined },
    { code: 'missing-alt', target: 'gallery', line: 2 },
    { code: 'missing-alt', target: 'inline', line: 4 },
    { code: 'missing-alt', target: 'gallery', line: 6 },
  ]); });

  it('ignores escaped images and fenced/inline code examples', async () => { const markdown = '\\![](/escaped.webp)\n`![](/inline.webp)`\n````md\n![](/code.webp)\n```gallery\nhttps://images.example/a\n```\n````\n~~~gallery\nhttps://images.example/b\n~~~';
  expect(locations(await L.lintAltText({ markdown }))).toEqual([{ code: 'missing-alt', target: 'gallery', line: 10 }]); });
});

describe('relative internal links', () => {
  it.each(['/reisen/', '/en/trips/', './next/', '../next/', 'next/', '/reisen/?day=2#arrival'])('accepts %s', async (destination) => { expect((await L.lintInternalLinks('[Story](' + destination + ')'))).toEqual({ status: 'pass', findings: [], count: 1 }); });

  it.each(['https://external.example/trip', '//external.example/trip', 'mailto:author@example.test', '#arrival', '?day=2', ''])('does not count %s as another relative story', async (destination) => { expect((await L.lintInternalLinks('[Story](' + destination + ')'))).toMatchObject({ status: 'warn', count: 0, findings: [{ code: 'missing-internal-link' }] }); });

  it('does not count images, escaped syntax, code examples, or absent links', async () => { const markdown = '![Photo](/photo.webp)\n\\[Escaped](/trip/)\n`[Code](/trip/)`\n```md\n[Example](/trip/)\n```';
  expect((await L.lintInternalLinks(markdown)).count).toBe(0);
  expect((await L.lintInternalLinks('Just prose.')).status).toBe('warn'); });

  it('counts angle destinations and multiline labels with optional titles', async () => { expect((await L.lintInternalLinks('[Another\nstory](</reisen/> "Trip") and [One more](/en/trips/)'))).toEqual({ status: 'pass', findings: [], count: 2 }); });
});

describe('inline code block boundaries', () => {
  it.each([
    ['`open\n\n![](/photo.webp)\n[Story](/reisen/)\n\nclose`', 3],
    ['`open\r\n# ![](/photo.webp) [Story](/reisen/)\r\nclose`', 2],
  ] as const)('does not conceal real images or links across paragraph/heading boundaries', async (markdown, line) => { expect(locations((await L.lintAltText({ markdown })))).toEqual([
    { code: 'missing-alt', line, target: 'inline' },
  ]);
  expect((await L.lintInternalLinks(markdown))).toEqual({ status: 'pass', findings: [], count: 1 }); });

  it('still hides multiline inline-code examples inside one paragraph', async () => { const markdown = '``example\n![](/photo.webp) [Story](/reisen/)\n` nested\n``';
  expect((await L.lintAltText({ markdown }))).toEqual({ status: 'pass', findings: [] });
  expect((await L.lintInternalLinks(markdown))).toMatchObject({ status: 'warn', count: 0 }); });
});

describe('lintStory aggregation', () => {
  it('passes a valid story and agrees with the individual checks', async () => { expect((await L.lintStory(validStory))).toEqual({
    title: L.lintTitle(validStory.title), excerpt: L.lintExcerpt(validStory.excerpt),
    headings: (await L.lintHeadings(validStory.markdown)), altText: (await L.lintAltText(validStory)),
    internalLinks: (await L.lintInternalLinks(validStory.markdown)), pass: true, warningCount: 0,
  }); });

  it('counts each warning rather than each category and does not mutate its input', async () => { const story = Object.freeze({ title: 'Short', excerpt: 'Short', heroSrc: '/hero.webp', markdown: '# Title\n#### Skip\n![](/a.webp)\n```gallery\nhttps://images.example/b\n```' });
  const original = JSON.stringify(story);
  const first = (await L.lintStory(story));
  expect(first.warningCount).toBe(8); // two lengths, two headings, three alts, one link
  expect(first.pass).toBe(false);
  expect((await L.lintStory(story))).toEqual(first);
  expect(JSON.stringify(story)).toBe(original);
  expect((await L.lintStory(validStory)).pass).toBe(true); // no regex state leaked from prior calls
  });

  it('returns actionable warnings for an empty unsaved locale without invented locations', async () => { const checked = (await L.lintStory());
  expect(checked).toMatchObject({ pass: false, warningCount: 3 });
  expect(checked.altText.findings).toEqual([]);
  expect(checked.internalLinks.findings[0]?.line).toBeUndefined(); });
});

describe('photo repair locations', () => {
  it.each([
    ['![a\\]b](https://img/a\\(b\\).webp "caption")', 'https://img/a(b).webp', 'a\\]b'],
    ['![two\nlines](<https://img/a b.webp>)', 'https://img/a b.webp', 'two\nlines'],
    ['![](https://img/empty.webp)', 'https://img/empty.webp', ''],
  ])('locates editable alt text in %s', async (image, src, alt) => { const markdown = 'Intro\n\n' + image;
  const target = (await L.findImage(markdown, src))!;
  expect(markdown.slice(target.start, target.end)).toBe(alt);
  expect(target.line).toBe(3);
  expect((await L.findImage(markdown, 'https://img/absent'))).toBeNull(); });

  it('does not target examples, links or gallery fences as body images', async () => { const src = 'https://img/photo';
  const markdown = '`![example](' + src + ')`\n\n````markdown\n![](' + src + ')\n````\n\n[link](' + src + ')\n\n```gallery\n' + src + '\n```';
  expect((await L.findImage(markdown, src))).toBeNull(); });
});

describe('authoritative gallery quick checks', () => {
  it.each([
    ['> ~~~gallery extra\n> https://images.example/a\n> ~~~', 2],
    ['- ````gallery\n  https://images.example/a\n  ````', 2],
    ['<pre><code class="language-gallery">https://images.example/a</code></pre>', 1],
  ] as const)('audits logical photo lines in %s', async (markdown, line) => {
    expect(locations(await L.lintAltText({ markdown }))).toEqual([
      { code: 'missing-alt', target: 'gallery', line },
    ]);
  });
});
