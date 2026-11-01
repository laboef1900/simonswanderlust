import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCaption as serverParseCaption } from '../src/caption.js';

// Load the browser llm.js in Node (its top-level body only assigns window.LLM;
// the fetch/canvas/Image calls live inside method bodies, so no DOM is needed).
const src = readFileSync(fileURLToPath(new URL('../public/llm.js', import.meta.url)), 'utf8');
const win: {
  LLM?: {
    parseCaption(content: string): { altEn: string; altDe: string };
    mixedContentWarning(baseUrl: string, pageProtocol: string): string;
  };
} = {};
// eslint-disable-next-line no-new-func
new Function('window', src)(win);
const browserParseCaption = win.LLM!.parseCaption;
const mixedContentWarning = win.LLM!.mixedContentWarning;

const FINAL = { altEn: 'final answer', altDe: 'endgültige Antwort' };
const DRAFT_THOUGHT = '<think>Draft: {"altEn":"draft guess","altDe":"Entwurf"} but wait, the sign actually';
const closedThinking: [string, { altEn: string; altDe: string }][] = [
  [DRAFT_THOUGHT + ' reads otherwise</think>\n' + JSON.stringify(FINAL), FINAL],
  [DRAFT_THOUGHT.replace('<think>', '<THINK>') + '</Think>Here:\n```json\n' + JSON.stringify(FINAL) + '\n```', FINAL],
  ['<think>{"altEn":"one","altDe":"eins"}</think><think>{"altEn":"two","altDe":"zwei"}</think>' + JSON.stringify(FINAL), FINAL],
  // Thinking after the answer is dropped too; the answer itself stays.
  [JSON.stringify(FINAL) + '\n<think>{"altEn":"afterthought","altDe":"Nachgedanke"}', FINAL],
];
// An unclosed thought runs to EOF: what it drafted is not an answer.
const unclosedThinking = [
  DRAFT_THOUGHT,
  '<think>planning</think> Sure: <think>{"altEn":"A","altDe":"B"}',
];

describe('llm.js parseCaption (shipped browser parser)', () => {
  const cases = [
    '{"altEn":"A beach","altDe":"Ein Strand"}',
    'Here you go:\n```json\n{"altEn":"X","altDe":"Y"}\n```',
    '{"altEn":"A","altDe":"B"} — trailing note {x}',
    'Sure {here}: {"altEn":"A harbor","altDe":"Ein Hafen"}',      // stray brace before
    '{"altEn":"a sign reading {open}","altDe":"ein Schild"}',      // brace inside a value
    '{"status":"ok"} {"altEn":"A","altDe":"B"}',                   // non-caption object first
    // #140: the cap, whitespace collapse and surrogate trim must agree too
    JSON.stringify({ altEn: 'word '.repeat(500), altDe: 'Ein\n\n  Strand\tam   Abend' }),
    JSON.stringify({ altEn: 'x'.repeat(299) + '😀', altDe: 'B' }),
  ];
  it('parses the same valid cases as the server caption.ts contract', () => {
    for (const c of cases) {
      expect(browserParseCaption(c)).toEqual(serverParseCaption(c));
    }
  });
  it('throws on non-JSON and on a missing/empty field (mirrors server behavior)', () => {
    for (const c of ['no json here', '{"altEn":"X","altDe":""}', '{"altEn":"X","altDe":" \\n "}', ...unclosedThinking]) {
      expect(() => browserParseCaption(c)).toThrow();
      expect(() => serverParseCaption(c)).toThrow();
    }
  });

  // #351: a draft written while thinking never wins over the final answer.
  it('discards closed think blocks in both parsers and returns the final answer', () => {
    for (const [reply, expected] of closedThinking) {
      expect(serverParseCaption(reply)).toEqual(expected);
      expect(browserParseCaption(reply)).toEqual(expected);
    }
  });
});

describe('llm.js mixedContentWarning', () => {
  it('names a plain-http non-local model URL on an https page', () => {
    expect(mixedContentWarning('http://10.0.0.5:1234/v1', 'https:')).toMatch(/mixed content/);
    expect(mixedContentWarning('http://lmstudio.lan:1234/v1', 'https:')).toContain('http://lmstudio.lan:1234');
  });
  it('stays quiet where the browser allows the request', () => {
    for (const u of ['http://localhost:1234/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:1234/v1', 'http://lm.localhost:1234', 'https://lm.example.com/v1']) {
      expect(mixedContentWarning(u, 'https:')).toBe('');
    }
    expect(mixedContentWarning('http://10.0.0.5:1234/v1', 'http:')).toBe('');
  });
  it('leaves an unparseable URL to the fetch error', () => {
    expect(mixedContentWarning('not a url', 'https:')).toBe('');
  });
});

/** A fresh llm.js instance whose requests go to `fetcher`. */
function client(fetcher: typeof fetch) {
  const window: { LLM?: {
    caption(base: string, model: string, prompt: string, image: string, timeout: number, maxTokens: number, signal?: AbortSignal, key?: string): Promise<{ altEn: string; altDe: string }>;
    listModels(base: string, key?: string): Promise<string[]>;
  } } = {};
  new Function('window', 'fetch', src)(window, fetcher);
  return window.LLM!;
}

describe('browser caption credentials', () => {
  it('keeps authorization request-local across remote caption, discovery and subsequent local calls', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/models')
      ? Response.json({ data: [{ id: 'vision' }] })
      : Response.json({ choices: [{ message: { content: '{"altEn":"A mountain","altDe":"Ein Berg"}' } }] }));
    const llm = client(fetcher);
    expect(await llm.caption('https://vision.example/v1', 'vision', 'describe', 'data:image/jpeg;base64,AA==', 5000, 8000, undefined, 'fixture-key'))
      .toEqual({ altEn: 'A mountain', altDe: 'Ein Berg' });
    expect(await llm.listModels('https://vision.example/v1', 'fixture-key')).toEqual(['vision']);
    await llm.caption('http://localhost:1234/v1', 'vision', 'describe', 'data:image/jpeg;base64,AA==', 5000, 8000);
    await llm.listModels('http://localhost:1234/v1');
    expect(fetcher.mock.calls.map(([, options]) => new Headers(options?.headers).get('authorization')))
      .toEqual(['Bearer fixture-key', 'Bearer fixture-key', null, null]);
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    }
  });

  it('refuses credential-bearing endpoints before any request and sanitizes remote transport failures', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('fixture-secret-from-provider'); });
    const llm = client(fetcher);
    await expect(llm.caption('https://user:password@example.test/v1', 'vision', 'describe', 'data:image/jpeg;base64,AA==', 5000, 8000))
      .rejects.toThrow('Invalid caption endpoint');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(llm.caption('https://vision.example/v1', 'vision', 'describe', 'data:image/jpeg;base64,AA==', 5000, 8000, undefined, 'fixture-key'))
      .rejects.toThrow('Caption request failed');
    await expect(llm.listModels('https://vision.example/v1', 'fixture-key')).rejects.not.toThrow('fixture-secret');
  });
});

describe('browser OpenRouter identity headers', () => {
  function transport(identity?: { canonicalOrigin: string | null; siteName: string }) {
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      // Exercise the browser's ByteString constraint, not just a plain header object.
      new Headers(options?.headers);
      return Response.json({ choices: [{ message: { content: '{"excerpt":"Walking through the old town."}' } }] });
    });
    const window: {
      SiteIdentity?: { canonicalOrigin: string | null; siteName: string };
      LLM?: { suggestExcerpt(base: string, model: string, guidance: string,
        draft: { locale: string; title: string; markdown: string }, key: string | null, timeout: number): Promise<unknown> };
    } = { SiteIdentity: identity };
    new Function('window', 'fetch', src)(window, fetcher);
    const request = (base = 'https://openrouter.ai/api/v1', key: string | null = 'request-key') =>
      window.LLM!.suggestExcerpt(base, 'model', '', {
        locale: 'en', title: 'Old town', markdown: 'We walked through the old town.',
      }, key, 5000);
    return { window, fetcher, request };
  }

  it.each(['Field notes', 'Café unterwegs', 'x'.repeat(80), '\u00a0\u00ff'])('sends printable Latin-1 title %j and the canonical origin directly', async (siteName) => {
    const h = transport({ canonicalOrigin: 'https://xn--bcher-kva.example:8443', siteName });
    await h.request();
    const [url, options] = h.fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(options?.headers).toMatchObject({
      'HTTP-Referer': 'https://xn--bcher-kva.example:8443', 'X-Title': siteName, Authorization: 'Bearer request-key',
    });
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  });

  it.each(['', 'x'.repeat(81), 'Notes 🗺', '旅', 'A\nB', 'A\rB', 'A\tB', 'A\n', 'A\r', '\u007f', '\u0080', '\u009f'])(
    'omits unsafe title %j without failing inference', async (siteName) => {
      const h = transport({ canonicalOrigin: 'https://blog.example', siteName });
      await expect(h.request()).resolves.toBe('Walking through the old town.');
      const headers = new Headers(h.fetcher.mock.calls[0]![1]?.headers);
      expect(headers.get('x-title')).toBeNull();
      expect(headers.get('http-referer')).toBe('https://blog.example');
    },
  );

  it('omits unset identity and never carries headers or credentials into another provider request', async () => {
    const h = transport();
    await h.request();
    h.window.SiteIdentity = { canonicalOrigin: null, siteName: 'Field notes' };
    await h.request();
    h.window.SiteIdentity = { canonicalOrigin: 'https://blog.example', siteName: 'Field notes' };
    await h.request();
    await h.request('http://localhost:1234/v1', null);
    await h.request('https://openrouter.ai.attacker.example/v1', null);
    const headers = h.fetcher.mock.calls.map(([, options]) => new Headers(options?.headers));
    expect(headers.map((header) => header.get('http-referer'))).toEqual([null, null, 'https://blog.example', null, null]);
    expect(headers.map((header) => header.get('x-title'))).toEqual([null, 'Field notes', 'Field notes', null, null]);
    expect(headers.map((header) => header.get('authorization'))).toEqual([
      'Bearer request-key', 'Bearer request-key', 'Bearer request-key', null, null,
    ]);
  });
});

// #351: the reply the request returns decides; a draft never fills the field.
describe('browser caption replies', () => {
  const IMAGE = 'data:image/jpeg;base64,AA==';
  function replying(content: string, finishReason: string) {
    return client(vi.fn<typeof fetch>(async () =>
      Response.json({ choices: [{ finish_reason: finishReason, message: { content } }] })));
  }

  it('returns the final answer after a closed thought that drafted other JSON', async () => {
    for (const [content, expected] of closedThinking) {
      expect(await replying(content, 'stop').caption('http://localhost:1234/v1', 'm', 'p', IMAGE, 5000, 256))
        .toEqual(expected);
    }
  });

  it('refuses a token-truncated reply with a fixed message, even when a caption object is complete', async () => {
    for (const content of [DRAFT_THOUGHT, JSON.stringify(FINAL), ...closedThinking.map(([reply]) => reply)]) {
      await expect(replying(content, 'length').caption('http://localhost:1234/v1', 'm', 'p', IMAGE, 5000, 256))
        .rejects.toThrow(/^Caption response was truncated$/);
    }
  });

  it('keeps the generic failure for an unclosed thought that finished normally', async () => {
    await expect(replying(DRAFT_THOUGHT, 'stop').caption('http://localhost:1234/v1', 'm', 'p', IMAGE, 5000, 256))
      .rejects.toThrow(/^Caption request failed\. Check the provider/);
  });
});
