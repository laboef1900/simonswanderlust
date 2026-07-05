import { describe, expect, it } from 'vitest';
import { mdxBodyToMarkdown } from './migrate-stub-posts.mjs';

// @ai-note: parseMdxFile is no longer tested here — it lazy-loads gray-matter, which was
// removed from site/ dependencies after the one-off migration completed (issue #33).
// This suite doubles as a regression test that importing the module works WITHOUT gray-matter.
describe('mdxBodyToMarkdown', () => {
  it('rewrites a <BodyImage> tag to a markdown image and records its dimensions', () => {
    const body = 'Intro\n\n<BodyImage src="https://img/x/y" width={1600} height={1067} alt="A caption" />\n\nMore';
    const { markdown, images } = mdxBodyToMarkdown(body);
    expect(markdown).toContain('![A caption](https://img/x/y)');
    expect(markdown).not.toContain('<BodyImage');
    expect((images as Record<string, unknown>)['https://img/x/y']).toEqual({ width: 1600, height: 1067 });
  });
});
