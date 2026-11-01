import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blogPostingJsonLd, isoDate, proseDescription, serializeJsonLd, type BlogPostingInput } from './seo';
import { renderMarkdown } from './render-markdown';
import { ABOUT_BODY_SIZES, transformBodyImages } from './body-images';

const configured = vi.hoisted(() => ({ identity: { authorName: 'Simon' } }));
vi.mock('./build-identity', () => configured);
beforeEach(() => { configured.identity.authorName = 'Simon'; });

const input: BlogPostingInput = {
  title: 'Roadtrip durch Rumänien',
  // Local-midnight Date, exactly as node-pg parses a Postgres `date` column.
  date: new Date(2024, 9, 3),
  excerpt: 'Zwei Wochen Karpaten.',
  locale: 'de',
  image: {
    src: 'https://img.simonswanderlust.com/rumaenien/hero',
    width: 1600,
    height: 900,
    alt: 'Bergpanorama in den Karpaten',
  },
  url: 'https://simonswanderlust.com/roadtrip-rumaenien/',
};

describe('blogPostingJsonLd', () => {
  it('omits an unset author rather than publishing a default name', () => {
    configured.identity.authorName = '';
    expect(blogPostingJsonLd(input)).not.toHaveProperty('author');
  });

  it('uses the configured author and safely serializes hostile text', () => {
    configured.identity.authorName = '</script><img src=x onerror=alert(1)>';
    const result = blogPostingJsonLd(input);
    expect(result.author?.name).toBe(configured.identity.authorName);
    expect(serializeJsonLd(result)).not.toContain('<');
    expect(JSON.parse(serializeJsonLd(result)).author.name).toBe(configured.identity.authorName);
  });
  it('maps all fields onto the schema.org BlogPosting shape', () => {
    expect(blogPostingJsonLd(input)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: 'Roadtrip durch Rumänien',
      datePublished: '2024-10-03',
      description: 'Zwei Wochen Karpaten.',
      inLanguage: 'de',
      image: {
        '@type': 'ImageObject',
        url: 'https://img.simonswanderlust.com/rumaenien/hero-1600.webp',
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

  it('uses the real .jpeg variant for JPEG-only structured-data images', () => {
    const jpeg = blogPostingJsonLd({
      ...input,
      image: { ...input.image, format: 'jpeg' },
    });
    expect(jpeg.image.url).toBe('https://img.simonswanderlust.com/rumaenien/hero-1600.jpeg');
    expect(jpeg.image.url).not.toMatch(/\.(?:avif|webp)$/);
  });
});

describe('isoDate', () => {
  it('uses local calendar components, immune to the build-host timezone', () => {
    // toISOString() on this Date would emit the previous UTC day on any UTC+x
    // host (e.g. Europe/Berlin) — isoDate must keep the local calendar day.
    expect(isoDate(new Date(2024, 9, 3))).toBe('2024-10-03');
  });

  it('zero-pads single-digit months and days', () => {
    expect(isoDate(new Date(2025, 0, 7))).toBe('2025-01-07');
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

describe('proseDescription', () => {
  const origin = 'https://img.simonswanderlust.com';
  const photo = `${origin}/pages/about/simon-ab12cd34`;
  const images = {
    [photo]: { width: 1600, height: 1000, alt: 'Simon am Strand', caption: 'A photo caption, not the introduction.' },
  };
  const fallback = 'Über mich';
  const intro = 'Ich bin Simon und reise seit 2015. Hier erzähle ich von unterwegs.';
  const rendered = async (body: string) => transformBodyImages(await renderMarkdown(body), images, origin, { locale: 'en', inlineSizes: ABOUT_BODY_SIZES });

  it('starts with prose after a leading responsive photo, not its alt, caption or URL', async () => {
    const html = await rendered(`![Simon am Strand](${photo})\n\n${intro}`);
    expect(html).toContain('<picture data-body-image');
    expect(proseDescription(html, fallback)).toBe(intro);
  });

  it.each(['column', 'breakout', 'slider'])('skips a leading %s gallery and its directives and captions', async (layout) => {
    const html = await rendered(`\`\`\`gallery\n#layout: ${layout}\n${photo}\n\`\`\`\n\n${intro}`);
    expect(html).toContain('<figcaption');
    expect(proseDescription(html, fallback)).toBe(intro);
  });

  it('preserves inline link text, formatting text and entities with readable paragraph and line spacing', async () => {
    const html = await rendered(
      '## Über mich\n\nIch bin **Simon** &amp; reise nach [Südamerika](https://example.com/reisen).\n\n' +
      'Mit dem Ruck<strong>sack</strong>  \nund viel Neugier.',
    );
    expect(proseDescription(html, fallback)).toBe(
      'Ich bin Simon & reise nach Südamerika. Mit dem Rucksack und viel Neugier.',
    );
  });

  it('ignores code blocks before the first prose paragraph', async () => {
    const html = await rendered(`\`\`\`text\nhttps://example.com/not-prose\n\`\`\`\n\n${intro}`);
    expect(proseDescription(html, fallback)).toBe(intro);
  });

  it('ends at a whole word within 150 characters', async () => {
    const prefix = 'Eine Reise mit vielen Geschichten. '.repeat(4).trim();
    const html = await rendered(`${prefix} Unterwegs entdecken wir mehr.`);
    expect(proseDescription(html, fallback)).toBe(`${prefix} Unterwegs`);
    expect(proseDescription(html, fallback).length).toBeLessThanOrEqual(150);
  });

  it('keeps a complete 150-character description and falls back rather than cutting an oversized first word', async () => {
    const exact = `${'Reise '.repeat(20)}unterwegs unterwegs unterwegs.`;
    expect(exact.length).toBe(150);
    expect(proseDescription(await rendered(exact), fallback)).toBe(exact);
    expect(proseDescription(await rendered('a'.repeat(151)), fallback)).toBe(fallback);
  });

  it.each([
    '',
    ' \n\n ',
    '## Über mich',
    `![Simon am Strand](${photo})`,
    `\`\`\`gallery\n#layout: column\n${photo}\n\`\`\``,
  ])('uses the localized fallback when the body has no prose (%j)', async (body) => {
    expect(proseDescription(await rendered(body), fallback)).toBe(fallback);
  });
});
