// #579 renderer-backed differential check: whatever `LLM.parseDraft` accepts is
// rendered through the site's real Markdown pipeline and body sanitizer, and
// must produce no link, image, active element, language-classed code or
// gallery block. Every hostile form the spec lists must be refused outright.
// A finite corpus and a seeded randomized corpus are regression checks, not a
// proof; a renderer upgrade that adds a new link shape should fail here.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../site/src/lib/render-markdown.js';
import { galleryCode, sanitizedBodyTree } from '../../site/src/lib/gallery-identity.js';

interface Draft { title: string; excerpt: string; bodyMarkdown: string }
const source = readFileSync(new URL('../public/llm.js', import.meta.url), 'utf8');
const browser: { LLM?: { parseDraft(content: unknown): Draft } } = {};
new Function('window', source)(browser);
const parseDraft = browser.LLM!.parseDraft;

// The site modules own the hast types and the uploader has no `hast` package of
// its own, so the node types are taken from the exact helpers under test.
type HastElement = Parameters<typeof galleryCode>[0];
type HastParent = ReturnType<typeof sanitizedBodyTree> | HastElement;

const ACTIVE = ['a', 'img', 'script', 'iframe', 'svg', 'math', 'object', 'embed'];
const RAW_ACTIVE = /<(?:a|img|script|iframe|svg|math|object|embed)[\s>/]/i;

function elementsOf(parent: HastParent, out: HastElement[] = []): HastElement[] {
  for (const child of parent.children) {
    if (child.type !== 'element') continue;
    out.push(child);
    elementsOf(child, out);
  }
  return out;
}

/** What a draft body renders to that a generated draft must never contain. */
async function activeOutput(bodyMarkdown: string): Promise<string[]> {
  const html = await renderMarkdown(bodyMarkdown);
  const found: string[] = [];
  const raw = RAW_ACTIVE.exec(html);
  if (raw) found.push('raw ' + raw[0]);
  for (const element of elementsOf(sanitizedBodyTree(html))) {
    if (ACTIVE.includes(element.tagName)) found.push(element.tagName);
    const classes = element.properties.className;
    if (element.tagName === 'code' && Array.isArray(classes) && classes.some((name) => String(name).startsWith('language-'))) {
      found.push('code.' + classes.join('.'));
    }
    if (galleryCode(element) !== null) found.push('gallery');
  }
  return found;
}

/** The accepted body, or null when parseDraft refuses the draft. */
function accepted(bodyMarkdown: string): string | null {
  try {
    return parseDraft(JSON.stringify({ title: 'A day in Lisbon', excerpt: 'Trams and tiles.', bodyMarkdown })).bodyMarkdown;
  } catch {
    return null;
  }
}

const BENIGN = [
  '## Arrival\n\nThe night train reached Lisbon before dawn. We walked up to the castle.\n\n### Belém\n\n- **Pastéis** warm from the oven\n- *Quiet* cloisters\n\n1. Tram 28\n2. Tram 15',
  '# A level-one heading (accepted residual)\n\nTickets cost 3 € — less than 5 < 10, and 10 > 5. Fish & chips at 10:30; ask @tram28 or AT&T.',
  '> A quote with **bold**, _italic_ and ~~strike~~.\n>\n> - nested list\n>   - deeper',
  '| Day | Place |\n|---|---|\n| 1 | Lisbon |\n| 2 | Sintra |',
  '    indented code stays an accepted residual\n\nParagraph after it.',
  'Plain [bracket] and (parenthesis) and !bang and a lone ] or [ and `inline code`.',
  'First paragraph.\n\n---\n\nAfter a thematic break\n---\n\nAnd a setext heading above.',
  '- [ ] pack the bag\n- [x] book the train',
  'Prices: 12.50 EUR, 3.5 km, 08:15 departure, e.g. by bus; i.e. slowly.',
  'Unicode: Ελλάδα, 日本, emoji 🚋, NBSP\u00a0here, tab\tthere.',
];

const HOSTILE = [
  'See <b>this</b>', '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '<!-- hidden -->', '<iframe src=x>',
  '<svg onload=x>', '<math><mi>x</mi></math>', '<object data=x>', '<embed src=x>',
  '<https://evil.example>', '<me@evil.example>', '<javascript:alert(1)>',
  '![castle](castle.jpg)', '![castle][c]\n\n[c]: castle.jpg', '![castle]',
  '[castle](https://evil.example)', '[x](javascript:alert(1))', '[castle][c]\n\n[c]: /castle', '[castle]\n\n[castle]: /castle',
  '[castle][]\n\n[castle]: /castle', 'Note[^1].\n\n[^1]: A footnote',
  'http://evil.example', 'https://evil.example', 'HTTPS://EVIL.EXAMPLE', 'www.evil.example', 'WWW.Evil.Example',
  'mailto:me@evil.example', 'xmpp:me@evil.example', 'contact@evil.example', 'a@b.cd', 'a@.b.cd', 'contact@.evil.example',
  'first.last@evil.example', 'x_y@evil.example',
  'https&#58;//evil.example', '&#x3C;img src=x onerror=alert(1)&#x3E;', 'contact&#64;evil.example', 'www&period;evil.example',
  '&lt;script&gt;', 'https\\://evil.example', '\\<script>', 'contact\\@evil.example', '\\[x\\](https\\://evil.example)',
  '```js\nalert(1)\n```', '```gallery\nhttps://img.example/a.jpg\n```', '```math\nx^2\n```', '~~~\ncode\n~~~',
  '> ```gallery\n> a.jpg\n> ```', '- ```gallery\n  a.jpg\n  ```', '> - ~~~math\n>   x\n>   ~~~',
  '---\ntitle: x\n---\nBody', '--- \ntitle: x\n---\nBody', '---\t\ntitle: x\n---\nBody', '+++ \ntitle = "x"\n+++\nBody',
  '+++\ntitle = "x"\n+++\nBody', '\uFEFF---\ntitle: x\n---\nBody',
];
const NESTINGS: ((text: string) => string)[] = [
  (text) => text.split('\n').map((line) => '> ' + line).join('\n'),
  (text) => text.split('\n').map((line, i) => (i ? '  ' : '- ') + line).join('\n'),
  (text) => text.split('\n').map((line, i) => (i ? '   ' : '1. ') + line).join('\n'),
  (text) => text.split('\n').map((line, i) => (i ? '>   ' : '> - ') + line).join('\n'),
  (text) => text.split('\n').map((line, i) => (i ? '  > ' : '- > ') + line).join('\n'),
];

describe('story draft output against the real renderer', () => {
  it('accepts the benign travel corpus, which renders no link, image, active element or gallery', async () => {
    for (const body of BENIGN) {
      const kept = accepted(body);
      expect(kept, body.slice(0, 60)).toBe(body);
      expect(await activeOutput(kept!), body.slice(0, 60)).toEqual([]);
    }
  });

  it('refuses every hostile form, plain and inside blockquote and list containers', () => {
    // Front matter is only front matter on the first line; nesting turns it into prose.
    const nestable = HOSTILE.filter((text) => !/^\uFEFF?(?:---|\+\+\+)/.test(text));
    for (const text of HOSTILE) expect(accepted(text), text).toBeNull();
    for (const text of nestable) {
      for (const nest of NESTINGS) expect(accepted('Intro.\n\n' + nest(text)), nest(text)).toBeNull();
    }
  });

  it('is not vacuous: unrefused, the obfuscated forms do render links, images and gallery blocks', async () => {
    for (const text of ['www.evil.example', 'a@.b.cd', 'contact@.evil.example', '<https://evil.example>', '<me@evil.example>',
      '[x](/x)', '[x]\n\n[x]: /x', '![x](x.jpg)', '```gallery\na.jpg\n```', '> ```gallery\n> a.jpg\n> ```', '- > www.evil.example']) {
      expect(await activeOutput(text), text).not.toEqual([]);
    }
  });

  it('a seeded randomized corpus never renders an active element from an accepted draft', async () => {
    // mulberry32: a fixed seed makes every CI run test the same few thousand bodies.
    let seed = 0x579a11ce;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const TOKENS = [
      '[', ']', '(', ')', '!', '<', '>', '&', '#', ';', '\\', '@', '.', ':', '/', '|', '`', '*', '_', '~', '"', '\'', '=', '^',
      'http', 'https', 'www', 'mailto', 'xmpp', 'ftp', 'javascript', 'example', 'com', 'cd', 'a', 'b', 'x1', '42', 'lt', 'amp',
      ' ', ' ', ' ', '\n', '\n', '\n\n', '\t', '    ', '> ', '- ', '1. ', '* ', '+ ', '```', '~~~', '``', '~~', '---', '+++', '===',
      'gallery', 'math', '\uFEFF', '\u00a0', '\uFF1C', '\uFF3B', '\uFF3D', '\uFF08', '\uFF09', '\uFF20', '\uFF0E', '\uFF1A',
      '\uFF0F', '\uFF01', '\u3002', '\u2024', '\u2215',
    ];
    const deadline = performance.now() + 20000;
    let cases = 0;
    let kept = 0;
    const failures: string[] = [];
    while (cases < 5000 && performance.now() < deadline) {
      cases++;
      const length = 1 + Math.floor(random() * 40);
      let body = '';
      for (let i = 0; i < length; i++) body += TOKENS[Math.floor(random() * TOKENS.length)];
      const ok = accepted(body);
      if (ok === null) continue;
      kept++;
      const found = await activeOutput(ok);
      if (found.length) failures.push(JSON.stringify(ok) + ' → ' + found.join(', '));
    }
    expect(failures).toEqual([]);
    // The bound must still leave a meaningful sample on a slow runner.
    expect(cases).toBeGreaterThanOrEqual(500);
    expect(kept).toBeGreaterThanOrEqual(100);
  }, 60000);
});
