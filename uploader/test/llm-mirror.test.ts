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
    expect(() => browserParseCaption('no json here')).toThrow();
    expect(() => browserParseCaption('{"altEn":"X","altDe":""}')).toThrow();
    expect(() => browserParseCaption('{"altEn":"X","altDe":" \\n "}')).toThrow();
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

describe('browser caption credentials', () => {
  function client(fetcher: typeof fetch) {
    const window: { LLM?: {
      caption(base: string, model: string, prompt: string, image: string, timeout: number, maxTokens: number, signal?: AbortSignal, key?: string): Promise<{ altEn: string }>;
      listModels(base: string, key?: string): Promise<string[]>;
    } } = {};
    new Function('window', 'fetch', src)(window, fetcher);
    return window.LLM!;
  }

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
