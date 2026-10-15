import { describe, expect, it } from 'vitest';
import { splitOpening } from './story-opening';

const h = (depth: number, slug: string, text = slug) => `<h${depth} id="${slug}">${text}</h${depth}>`;
const heading = (depth: number, slug: string) => ({ depth, slug, text: slug });

describe('splitOpening', () => {
  it('keeps the intro heading, its paragraphs and its image together, then cuts', () => {
    const html = `${h(2, 'odyssee')}\n<p>Willkommen.</p>\n<figure><img src="x"></figure>\n${h(2, 'anreise')}\n<p>Flug.</p>`;
    const { opening, rest } = splitOpening(html, [heading(2, 'odyssee'), heading(2, 'anreise')]);
    expect(opening).toBe(`${h(2, 'odyssee')}\n<p>Willkommen.</p>\n<figure><img src="x"></figure>\n`);
    expect(rest).toBe(`${h(2, 'anreise')}\n<p>Flug.</p>`);
  });

  it('cuts at the first heading when the body opens with bare paragraphs', () => {
    const html = `<p>Intro.</p>\n${h(2, 'a')}\n<p>A.</p>\n${h(2, 'b')}`;
    const { opening, rest } = splitOpening(html, [heading(2, 'a'), heading(2, 'b')]);
    expect(opening).toBe('<p>Intro.</p>\n');
    expect(rest.startsWith(h(2, 'a'))).toBe(true);
  });

  it('treats stacked headings with nothing between them as one opening', () => {
    // The Cuyabeno stories: `## Ecuador: Cuyabeno` straight into `## Jungle`.
    const html = `${h(2, 'ecuador')}\n\n${h(2, 'jungle')}\n<p>Der Amazonas.</p>\n${h(2, 'lodge')}\n<p>…</p>`;
    const { opening, rest } = splitOpening(html, [heading(2, 'ecuador'), heading(2, 'jungle'), heading(2, 'lodge')]);
    expect(opening).toBe(`${h(2, 'ecuador')}\n\n${h(2, 'jungle')}\n<p>Der Amazonas.</p>\n`);
    expect(rest).toBe(`${h(2, 'lodge')}\n<p>…</p>`);
  });

  it('ignores deeper headings when deciding where the first section ends', () => {
    const html = `${h(2, 'a')}\n<p>A.</p>\n${h(3, 'a-1')}\n<p>A1.</p>\n${h(2, 'b')}`;
    const { opening, rest } = splitOpening(html, [heading(2, 'a'), heading(3, 'a-1'), heading(2, 'b')]);
    expect(opening).toContain(h(3, 'a-1'));
    expect(rest).toBe(h(2, 'b'));
  });

  it('uses the shallowest depth the body has, not h2 by decree', () => {
    const html = `${h(3, 'a')}\n<p>A.</p>\n${h(3, 'b')}`;
    const { rest } = splitOpening(html, [heading(3, 'a'), heading(3, 'b')]);
    expect(rest).toBe(h(3, 'b'));
  });

  it('returns the whole body as the opening when there is nothing to cut at', () => {
    expect(splitOpening('<p>Only.</p>', [])).toEqual({ opening: '<p>Only.</p>', rest: '' });
    const one = `${h(2, 'a')}\n<p>A.</p>`;
    expect(splitOpening(one, [heading(2, 'a')])).toEqual({ opening: one, rest: '' });
  });

  it('returns the whole body rather than guessing when a heading id is not in the markup', () => {
    const html = `${h(2, 'a')}\n<p>A.</p>\n${h(2, 'renamed')}`;
    expect(splitOpening(html, [heading(2, 'a'), heading(2, 'b')])).toEqual({ opening: html, rest: '' });
  });

  it('does not mistake a mention of the id in the intro for the heading', () => {
    const html = `${h(2, 'a')}\n<p>See <a href="#b" id="b-link">b</a>.</p>\n${h(2, 'b')}`;
    const { rest } = splitOpening(html, [heading(2, 'a'), heading(2, 'b')]);
    expect(rest).toBe(h(2, 'b'));
  });
});
