import { describe, expect, it } from 'vitest';
import { parseCaption, CaptionError, DEFAULT_PROMPT, MAX_ALT } from '../src/caption.js';

describe('parseCaption', () => {
  it('parses a clean JSON object', () => {
    expect(parseCaption('{"altEn":"A beach","altDe":"Ein Strand"}'))
      .toEqual({ altEn: 'A beach', altDe: 'Ein Strand' });
  });

  it('extracts JSON from a fenced/prose-wrapped reply', () => {
    expect(parseCaption('Here you go:\n```json\n{"altEn":"X","altDe":"Y"}\n```'))
      .toEqual({ altEn: 'X', altDe: 'Y' });
  });

  it('trims surrounding whitespace in fields', () => {
    expect(parseCaption('{"altEn":"  A  ","altDe":"  B  "}'))
      .toEqual({ altEn: 'A', altDe: 'B' });
  });

  it('throws CaptionError on a reply with no JSON object', () => {
    expect(() => parseCaption('no json here')).toThrow(CaptionError);
  });

  it('throws CaptionError on malformed JSON', () => {
    expect(() => parseCaption('{altEn: nope}')).toThrow(CaptionError);
  });

  it('throws CaptionError when altEn or altDe is missing/empty', () => {
    expect(() => parseCaption('{"altEn":"X","altDe":""}')).toThrow(CaptionError);
    expect(() => parseCaption('{"altEn":"X"}')).toThrow(CaptionError);
  });

  it('extracts the first object when the model appends trailing chatter', () => {
    expect(parseCaption('{"altEn":"A","altDe":"B"} — let me know, e.g. {shorter}'))
      .toEqual({ altEn: 'A', altDe: 'B' });
  });

  it('skips a stray brace group in prose BEFORE the real object', () => {
    expect(parseCaption('Sure {here}: {"altEn":"A harbor","altDe":"Ein Hafen"}'))
      .toEqual({ altEn: 'A harbor', altDe: 'Ein Hafen' });
  });

  it('keeps a literal brace inside a string value', () => {
    expect(parseCaption('{"altEn":"a sign reading {open}","altDe":"ein Schild"}'))
      .toEqual({ altEn: 'a sign reading {open}', altDe: 'ein Schild' });
  });

  it('handles a nested object among the fields', () => {
    expect(parseCaption('{"altEn":"A","meta":{"x":1},"altDe":"B"}'))
      .toEqual({ altEn: 'A', altDe: 'B' });
  });

  it('skips a valid non-caption object and uses the real one', () => {
    expect(parseCaption('{"status":"ok"} {"altEn":"A","altDe":"B"}'))
      .toEqual({ altEn: 'A', altDe: 'B' });
  });

  // Model output is untrusted input (CLAUDE.md §AI): it lands in an alt field
  // and then in every reader's markup, so it is bounded here, not trusted (#140).
  it('collapses whitespace to one line and caps a runaway answer at MAX_ALT', () => {
    const long = 'word '.repeat(500);
    const out = parseCaption(JSON.stringify({ altEn: long, altDe: 'Ein\n\n  Strand\tam   Abend' }));
    expect(out.altDe).toBe('Ein Strand am Abend');
    expect(out.altEn).toHaveLength(MAX_ALT);
    expect(out.altEn).toBe(long.slice(0, MAX_ALT));
  });

  it('treats a whitespace-only field as missing', () => {
    expect(() => parseCaption('{"altEn":" \\n ","altDe":"B"}')).toThrow(CaptionError);
  });

  it('never cuts a surrogate pair in half at the cap', () => {
    const alt = 'x'.repeat(MAX_ALT - 1) + '😀';
    expect(parseCaption(JSON.stringify({ altEn: alt, altDe: 'B' })).altEn).toBe('x'.repeat(MAX_ALT - 1));
  });

  // #351: a reasoning model may draft the JSON while thinking; only the final
  // answer counts, and a thought cut off mid-way is not an answer.
  it('takes the final answer over a draft inside a closed think block', () => {
    const reply = '<think>Draft: {"altEn":"draft guess","altDe":"Entwurf"} but wait, the sign says</think>\n' +
      '{"altEn":"final answer","altDe":"endgültige Antwort"}';
    expect(parseCaption(reply)).toEqual({ altEn: 'final answer', altDe: 'endgültige Antwort' });
    expect(parseCaption(reply.replace(/think>/g, 'THINK>'))).toEqual({ altEn: 'final answer', altDe: 'endgültige Antwort' });
  });

  it('refuses a reply whose only caption sits in an unclosed think block', () => {
    expect(() => parseCaption('<think>Draft: {"altEn":"draft guess","altDe":"Entwurf"} but wait, the sign actually'))
      .toThrow(CaptionError);
    expect(() => parseCaption('<think>first</think> prose <think>{"altEn":"A","altDe":"B"}')).toThrow(CaptionError);
  });
});

describe('DEFAULT_PROMPT', () => {
  it('is non-empty and asks for altEn and altDe', () => {
    expect(DEFAULT_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_PROMPT).toContain('altEn');
    expect(DEFAULT_PROMPT).toContain('altDe');
  });
});
