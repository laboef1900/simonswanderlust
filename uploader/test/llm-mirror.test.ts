import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCaption as serverParseCaption } from '../src/caption.js';

// Load the browser llm.js in Node (its top-level body only assigns window.LLM;
// the fetch/canvas/Image calls live inside method bodies, so no DOM is needed).
const src = readFileSync(fileURLToPath(new URL('../public/llm.js', import.meta.url)), 'utf8');
const win: { LLM?: { parseCaption(content: string): { altEn: string; altDe: string } } } = {};
// eslint-disable-next-line no-new-func
new Function('window', src)(win);
const browserParseCaption = win.LLM!.parseCaption;

describe('llm.js parseCaption (shipped browser parser)', () => {
  const cases = [
    '{"altEn":"A beach","altDe":"Ein Strand"}',
    'Here you go:\n```json\n{"altEn":"X","altDe":"Y"}\n```',
    '{"altEn":"A","altDe":"B"} — trailing note {x}',
  ];
  it('parses the same valid cases as the server caption.ts contract', () => {
    for (const c of cases) {
      expect(browserParseCaption(c)).toEqual(serverParseCaption(c));
    }
  });
  it('throws on non-JSON and on a missing/empty field (mirrors server behavior)', () => {
    expect(() => browserParseCaption('no json here')).toThrow();
    expect(() => browserParseCaption('{"altEn":"X","altDe":""}')).toThrow();
  });
});
