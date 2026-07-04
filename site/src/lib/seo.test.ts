import { describe, expect, it } from 'vitest';
import { blogPostingJsonLd, serializeJsonLd, type BlogPostingInput } from './seo';

const input: BlogPostingInput = {
  title: 'Roadtrip durch Rumänien',
  dateIso: '2024-10-03T00:00:00.000Z',
  excerpt: 'Zwei Wochen Karpaten.',
  locale: 'de',
  image: {
    src: 'https://img.simonswanderlust.com/rumaenien/hero-1600.avif',
    width: 1600,
    height: 900,
    alt: 'Bergpanorama in den Karpaten',
  },
  url: 'https://simonswanderlust.com/roadtrip-rumaenien/',
};

describe('blogPostingJsonLd', () => {
  it('maps all fields onto the schema.org BlogPosting shape', () => {
    expect(blogPostingJsonLd(input)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: 'Roadtrip durch Rumänien',
      datePublished: '2024-10-03T00:00:00.000Z',
      description: 'Zwei Wochen Karpaten.',
      inLanguage: 'de',
      image: {
        '@type': 'ImageObject',
        url: 'https://img.simonswanderlust.com/rumaenien/hero-1600.avif',
        width: 1600,
        height: 900,
      },
      author: { '@type': 'Person', name: 'Simon' },
      mainEntityOfPage: 'https://simonswanderlust.com/roadtrip-rumaenien/',
    });
  });

  it('carries the locale through as inLanguage (en)', () => {
    expect(blogPostingJsonLd({ ...input, locale: 'en' }).inLanguage).toBe('en');
  });
});

describe('serializeJsonLd', () => {
  it('escapes every "<" so CMS content cannot break out of the script element', () => {
    const hostile = blogPostingJsonLd({
      ...input,
      title: '</script><script>alert(1)</script>',
      excerpt: '<!-- sneaky comment -->',
    });
    const out = serializeJsonLd(hostile);
    expect(out).not.toContain('<');
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003c/script>');
  });

  it('round-trips: parsing the serialized output yields the original object', () => {
    const obj = blogPostingJsonLd({ ...input, title: 'a < b </script>' });
    expect(JSON.parse(serializeJsonLd(obj))).toEqual(obj);
  });
});
