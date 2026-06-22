import { describe, expect, it } from 'vitest';
import { slugify, parseCaption, captionImage, CaptionError } from '../src/caption.js';

describe('slugify', () => {
  it('lowercases, strips diacritics, and dashes non-alphanumerics', () => {
    expect(slugify('Old Town at Dusk')).toBe('old-town-at-dusk');
    expect(slugify('  Café  Münster!! ')).toBe('cafe-munster');
    expect(slugify('a---b c')).toBe('a-b-c');
  });
});

describe('parseCaption', () => {
  it('parses a clean JSON object', () => {
    const c = parseCaption('{"altEn":"A beach","altDe":"Ein Strand","slug":"A Beach"}');
    expect(c).toEqual({ altEn: 'A beach', altDe: 'Ein Strand', slug: 'a-beach' });
  });
  it('extracts JSON from a fenced/prose-wrapped reply', () => {
    const c = parseCaption('Here you go:\n```json\n{"altEn":"X","altDe":"Y","slug":"z-z"}\n```');
    expect(c).toEqual({ altEn: 'X', altDe: 'Y', slug: 'z-z' });
  });
  it('throws CaptionError on non-JSON', () => {
    expect(() => parseCaption('no json here')).toThrow(CaptionError);
  });
  it('throws CaptionError when a field is missing/empty', () => {
    expect(() => parseCaption('{"altEn":"X","altDe":"","slug":"z"}')).toThrow(CaptionError);
  });
});

describe('captionImage', () => {
  const ok = {
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"altEn":"A","altDe":"B","slug":"c-d"}' } }] }),
  };
  it('posts to /chat/completions and returns a parsed Caption', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: string) => { calledUrl = url; return ok; }) as unknown as typeof fetch;
    const c = await captionImage(Buffer.from('x'), { baseUrl: 'http://h:1234/v1', model: 'm', fetchImpl });
    expect(calledUrl).toBe('http://h:1234/v1/chat/completions');
    expect(c).toEqual({ altEn: 'A', altDe: 'B', slug: 'c-d' });
  });
  it('throws CaptionError on a network failure', async () => {
    const fetchImpl = (async () => { throw new Error('econn'); }) as unknown as typeof fetch;
    await expect(captionImage(Buffer.from('x'), { baseUrl: 'http://h/v1', model: 'm', fetchImpl }))
      .rejects.toBeInstanceOf(CaptionError);
  });
  it('throws CaptionError on a non-OK response', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(captionImage(Buffer.from('x'), { baseUrl: 'http://h/v1', model: 'm', fetchImpl }))
      .rejects.toBeInstanceOf(CaptionError);
  });
});
