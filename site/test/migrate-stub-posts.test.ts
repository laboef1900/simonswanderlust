import { describe, expect, it } from 'vitest';
import { parseMdxFile, mdxBodyToMarkdown } from '../scripts/migrate-stub-posts.mjs';
import { join } from 'node:path';

const de = join(process.cwd(), 'src/content/trips/de');

describe('parseMdxFile', () => {
  it('parses a stub post into row fields with locale/slug from the path', () => {
    const r = parseMdxFile(join(de, 'reisebericht-4-tage-bukarest.mdx'), 'de');
    expect(r.locale).toBe('de');
    expect(r.slug).toBe('reisebericht-4-tage-bukarest');
    expect(r.data.translationKey).toBe('bucharest-2024');
    expect(r.data.heroImage.src).toContain('/trips/bucharest-2024/hero');
    expect(r.bodyMarkdown).toContain('## Ankommen');
    expect(r.images).toEqual({});
  });
});

describe('mdxBodyToMarkdown', () => {
  it('rewrites a <BodyImage> tag to a markdown image and records its dimensions', () => {
    const body = 'Intro\n\n<BodyImage src="https://img/x/y" width={1600} height={1067} alt="A caption" />\n\nMore';
    const { markdown, images } = mdxBodyToMarkdown(body);
    expect(markdown).toContain('![A caption](https://img/x/y)');
    expect(markdown).not.toContain('<BodyImage');
    expect((images as Record<string, unknown>)['https://img/x/y']).toEqual({ width: 1600, height: 1067 });
  });
});
