import { describe, expect, it } from 'vitest';
import { renderPostToMdx } from '../src/export.js';
import { normalizeBodyImages, type PostPair } from '../src/posts.js';

const pair: PostPair = {
  translationKey: 'k1', status: 'published',
  shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 44.4, lng: 26.1 }, stops: [{ name: 'Bukarest', lat: 44.43, lng: 26.1 }] },
  de: { locale: 'de', slug: 'bukarest', title: 'Bukarest', excerpt: 'E', country: 'Rumänien', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro\n\n![Gasse](https://img/x/y)\n', images: { 'https://img/x/y': { width: 1600, height: 1067 } }, keyFacts: { Einwohner: '19M' } },
  en: { locale: 'en', slug: 'bucharest', title: 'Bucharest', excerpt: 'E', country: 'Romania', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {}, keyFacts: { Population: '19M' } },
};

describe('renderPostToMdx', () => {
  it('renders frontmatter + body and reconstructs <BodyImage> from the images map', () => {
    const mdx = renderPostToMdx(pair, 'de');
    expect(mdx).toContain("title: 'Bukarest'");
    expect(mdx).toContain('translationKey: \'k1\'');
    expect(mdx).toContain("country: 'Rumänien'");
    expect(mdx).toContain('countryCode: \'RO\'');
    expect(mdx).toContain('src: \'https://img/h\'');
    expect(mdx).toContain('coordinates: { lat: 44.4, lng: 26.1 }');
    expect(mdx).toContain('stops: [{"name":"Bukarest","lat":44.43,"lng":26.1}]');
    expect(mdx).toContain('<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Gasse" />');
    expect(mdx).not.toContain('![Gasse]');
  });

  // Regression for issue #87: country and keyFacts are per-locale prose, not
  // shared trip metadata — each locale's export must carry its OWN values,
  // not the other locale's.
  it('renders each locale\'s own country and key facts, not the other locale\'s', () => {
    const deMdx = renderPostToMdx(pair, 'de');
    const enMdx = renderPostToMdx(pair, 'en');
    expect(deMdx).toContain("country: 'Rumänien'");
    expect(deMdx).toContain("'Einwohner': '19M'");
    expect(deMdx).not.toContain('Romania');
    expect(deMdx).not.toContain('Population');
    expect(enMdx).toContain("country: 'Romania'");
    expect(enMdx).toContain("'Population': '19M'");
    expect(enMdx).not.toContain('Rumänien');
    expect(enMdx).not.toContain('Einwohner');
  });

  it('escapes single-quotes in YAML frontmatter by doubling them (valid YAML)', () => {
    const pairWithApostrophe: PostPair = {
      translationKey: 'k1', status: 'published',
      shared: { date: '2024-10-03', countryCode: 'CI', region: 'europe', coordinates: { lat: 0, lng: 0 } },
      de: { locale: 'de', slug: 'test', title: "Simon's Reise", excerpt: 'E', country: "Côte d'Ivoire", heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {} },
      en: { locale: 'en', slug: 'test', title: 'Test', excerpt: 'E', country: "Côte d'Ivoire", heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {} },
    };
    const mdx = renderPostToMdx(pairWithApostrophe, 'de');
    // YAML single-quoted strings escape a quote by doubling it, never with a backslash.
    expect(mdx).toContain("title: 'Simon''s Reise'");
    expect(mdx).toContain("country: 'Côte d''Ivoire'");
    expect(mdx).not.toContain("\\'");
  });

  it('escapes double-quotes in body image alt text', () => {
    const pairWithQuote: PostPair = {
      translationKey: 'k1', status: 'published',
      shared: { date: '2024-10-03', countryCode: 'XX', region: 'europe', coordinates: { lat: 0, lng: 0 } },
      de: { locale: 'de', slug: 'test', title: 'Test', excerpt: 'E', country: 'Test', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro\n\n![He said "hi"](https://img/x/y)\n', images: { 'https://img/x/y': { width: 1600, height: 1067 } }, keyFacts: {} },
      en: { locale: 'en', slug: 'test', title: 'Test', excerpt: 'E', country: 'Test', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {} },
    };
    const mdx = renderPostToMdx(pairWithQuote, 'de');
    expect(mdx).toContain('alt="He said &quot;hi&quot;"');
    expect(mdx).not.toContain('alt="He said "hi""');
  });

  it('escapes &, < and > in body image alt text (so paste-back normalization can invert it)', () => {
    const pairWithAngles: PostPair = {
      translationKey: 'k1', status: 'published',
      shared: { date: '2024-10-03', countryCode: 'XX', region: 'europe', coordinates: { lat: 0, lng: 0 } },
      de: { locale: 'de', slug: 'test', title: 'Test', excerpt: 'E', country: 'Test', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: '![Blick <nach> Westen & zurück](https://img/x/y)', images: { 'https://img/x/y': { width: 1600, height: 1067 } } },
      en: { locale: 'en', slug: 'test', title: 'Test', excerpt: 'E', country: 'Test', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {} },
    };
    const mdx = renderPostToMdx(pairWithAngles, 'de');
    expect(mdx).toContain('alt="Blick &lt;nach&gt; Westen &amp; zurück"');
    expect(mdx).not.toContain('alt="Blick <nach>');
  });

  it('round-trips a gallery: dimensions, alt and caption survive export → normalize', () => {
    // Without this an "Export all" backup keeps the fence text but loses every
    // gallery photo's metadata, and re-importing yields a gallery the renderer
    // skips entirely.
    const a = 'https://img/g/a-1a2b3c4d';
    const b = 'https://img/g/b-9f8e7d6c';
    const images = {
      [a]: { width: 3000, height: 2000, alt: 'Sunrise | dawn', caption: 'Day "3"' },
      [b]: { width: 2000, height: 3000 },
    };
    const withGallery: PostPair = {
      translationKey: 'k1', status: 'published',
      shared: { date: '2024-10-03', countryCode: 'XX', region: 'europe', coordinates: { lat: 0, lng: 0 } },
      de: {
        locale: 'de', slug: 'test', title: 'Test', excerpt: 'E', country: 'Test',
        heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' },
        bodyMarkdown: `Intro\n\n\`\`\`gallery\n${a}\n${b}\n\`\`\`\n`,
        images,
      },
      en: { locale: 'en', slug: 'test', title: 'Test', excerpt: 'E', country: 'Test', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {} },
    };
    const mdx = renderPostToMdx(withGallery, 'de');
    expect(mdx).toContain(`${a} | 3000x2000 | alt="Sunrise &#124; dawn" | caption="Day &quot;3&quot;"`);
    expect(mdx).toContain(`${b} | 2000x3000`);

    // The exact inverse: pasting the exported body back reproduces the map.
    const body = mdx.slice(mdx.indexOf('Intro'));
    expect(normalizeBodyImages(body, {}).images).toEqual(images);
  });
});
