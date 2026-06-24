import { describe, expect, it } from 'vitest';
import { renderPostToMdx } from '../src/export.js';
import type { PostPair } from '../src/posts.js';

const pair: PostPair = {
  translationKey: 'k1', status: 'published',
  shared: { date: '2024-10-03', country: 'Rumänien', countryCode: 'RO', region: 'europe', coordinates: { lat: 44.4, lng: 26.1 }, keyFacts: { Einwohner: '19M' } },
  de: { locale: 'de', slug: 'bukarest', title: 'Bukarest', excerpt: 'E', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro\n\n![Gasse](https://img/x/y)\n', images: { 'https://img/x/y': { width: 1600, height: 1067 } } },
  en: { locale: 'en', slug: 'bucharest', title: 'Bucharest', excerpt: 'E', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {} },
};

describe('renderPostToMdx', () => {
  it('renders frontmatter + body and reconstructs <BodyImage> from the images map', () => {
    const mdx = renderPostToMdx(pair, 'de');
    expect(mdx).toContain("title: 'Bukarest'");
    expect(mdx).toContain('translationKey: \'k1\'');
    expect(mdx).toContain('countryCode: \'RO\'');
    expect(mdx).toContain('src: \'https://img/h\'');
    expect(mdx).toContain('coordinates: { lat: 44.4, lng: 26.1 }');
    expect(mdx).toContain('<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Gasse" />');
    expect(mdx).not.toContain('![Gasse]');
  });

  it('escapes double-quotes in body image alt text', () => {
    const pairWithQuote: PostPair = {
      translationKey: 'k1', status: 'published',
      shared: { date: '2024-10-03', country: 'Test', countryCode: 'XX', region: 'europe', coordinates: { lat: 0, lng: 0 }, keyFacts: {} },
      de: { locale: 'de', slug: 'test', title: 'Test', excerpt: 'E', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro\n\n![He said "hi"](https://img/x/y)\n', images: { 'https://img/x/y': { width: 1600, height: 1067 } } },
      en: { locale: 'en', slug: 'test', title: 'Test', excerpt: 'E', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {} },
    };
    const mdx = renderPostToMdx(pairWithQuote, 'de');
    expect(mdx).toContain('alt="He said &quot;hi&quot;"');
    expect(mdx).not.toContain('alt="He said "hi""');
  });
});
