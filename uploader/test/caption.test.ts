import { describe, expect, it } from 'vitest';
import { parseCaption, CaptionError, DEFAULT_PROMPT } from '../src/caption.js';

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
});

describe('DEFAULT_PROMPT', () => {
  it('is non-empty and asks for altEn and altDe', () => {
    expect(DEFAULT_PROMPT.length).toBeGreaterThan(0);
    expect(DEFAULT_PROMPT).toContain('altEn');
    expect(DEFAULT_PROMPT).toContain('altDe');
  });
});
