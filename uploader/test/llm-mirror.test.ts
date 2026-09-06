import { describe, expect, it } from 'vitest';
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
