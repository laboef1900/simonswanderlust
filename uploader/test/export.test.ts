import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { exportPost, renderPostToMdx } from '../src/export.js';
import { normalizeBodyImages, type PostPair } from '../src/posts.js';
import { escapeMeta } from '../../site/src/lib/gallery-layout.js';
import * as bodyContent from '../src/body-content.js';

const pair: PostPair = {
  translationKey: 'k1', status: 'published',
  shared: { date: '2024-10-03', countryCode: 'RO', region: 'europe', coordinates: { lat: 44.4, lng: 26.1 }, stops: [{ name: 'Bukarest', lat: 44.43, lng: 26.1 }] },
  de: { locale: 'de', slug: 'bukarest', title: 'Bukarest', excerpt: 'E', country: 'Rumänien', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro\n\n![Gasse](https://img/x/y)\n', images: { 'https://img/x/y': { width: 1600, height: 1067 } }, keyFacts: { Einwohner: '19M' } },
  en: { locale: 'en', slug: 'bucharest', title: 'Bucharest', excerpt: 'E', country: 'Romania', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {}, keyFacts: { Population: '19M' } },
};

describe('renderPostToMdx', () => {
  it('renders frontmatter + body and reconstructs <BodyImage> from the images map', async () => {
    const mdx = (await renderPostToMdx(pair, 'de'));
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

  it('exports JPEG-only hero and body references without losing their format', async () => {
    const jpegPair: PostPair = {
      ...pair,
      de: {
        ...pair.de,
        heroImage: { ...pair.de.heroImage, format: 'jpeg' },
        images: { 'https://img/x/y': { width: 1600, height: 1067, format: 'jpeg' } },
      },
    };
    const mdx = (await renderPostToMdx(jpegPair, 'de'));
    expect(mdx).toContain('\n  format: jpeg\n');
    expect(mdx).toContain('alt="Gasse" format="jpeg"');
    const body = mdx.slice(mdx.indexOf('Intro'));
    expect((await normalizeBodyImages(body, {})).images['https://img/x/y']).toEqual({
      width: 1600,
      height: 1067,
      format: 'jpeg',
    });
  });

  // Regression for issue #87: country and keyFacts are per-locale prose, not
  // shared trip metadata — each locale's export must carry its OWN values,
  // not the other locale's.
  it('renders each locale\'s own country and key facts, not the other locale\'s', async () => {
    const deMdx = (await renderPostToMdx(pair, 'de'));
    const enMdx = (await renderPostToMdx(pair, 'en'));
    expect(deMdx).toContain("country: 'Rumänien'");
    expect(deMdx).toContain("'Einwohner': '19M'");
    expect(deMdx).not.toContain('Romania');
    expect(deMdx).not.toContain('Population');
    expect(enMdx).toContain("country: 'Romania'");
    expect(enMdx).toContain("'Population': '19M'");
    expect(enMdx).not.toContain('Rumänien');
    expect(enMdx).not.toContain('Einwohner');
  });

  it('escapes single-quotes in YAML frontmatter by doubling them (valid YAML)', async () => {
    const pairWithApostrophe: PostPair = {
      translationKey: 'k1', status: 'published',
      shared: { date: '2024-10-03', countryCode: 'CI', region: 'europe', coordinates: { lat: 0, lng: 0 } },
      de: { locale: 'de', slug: 'test', title: "Simon's Reise", excerpt: 'E', country: "Côte d'Ivoire", heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {} },
      en: { locale: 'en', slug: 'test', title: 'Test', excerpt: 'E', country: "Côte d'Ivoire", heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {} },
    };
    const mdx = (await renderPostToMdx(pairWithApostrophe, 'de'));
    // YAML single-quoted strings escape a quote by doubling it, never with a backslash.
    expect(mdx).toContain("title: 'Simon''s Reise'");
    expect(mdx).toContain("country: 'Côte d''Ivoire'");
    expect(mdx).not.toContain("\\'");
  });

  it('escapes double-quotes in body image alt text', async () => {
    const pairWithQuote: PostPair = {
      translationKey: 'k1', status: 'published',
      shared: { date: '2024-10-03', countryCode: 'XX', region: 'europe', coordinates: { lat: 0, lng: 0 } },
      de: { locale: 'de', slug: 'test', title: 'Test', excerpt: 'E', country: 'Test', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro\n\n![He said "hi"](https://img/x/y)\n', images: { 'https://img/x/y': { width: 1600, height: 1067 } }, keyFacts: {} },
      en: { locale: 'en', slug: 'test', title: 'Test', excerpt: 'E', country: 'Test', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {} },
    };
    const mdx = (await renderPostToMdx(pairWithQuote, 'de'));
    expect(mdx).toContain('alt="He said &quot;hi&quot;"');
    expect(mdx).not.toContain('alt="He said "hi""');
  });

  it('escapes &, < and > in body image alt text (so paste-back normalization can invert it)', async () => {
    const pairWithAngles: PostPair = {
      translationKey: 'k1', status: 'published',
      shared: { date: '2024-10-03', countryCode: 'XX', region: 'europe', coordinates: { lat: 0, lng: 0 } },
      de: { locale: 'de', slug: 'test', title: 'Test', excerpt: 'E', country: 'Test', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: '![Blick <nach> Westen & zurück](https://img/x/y)', images: { 'https://img/x/y': { width: 1600, height: 1067 } } },
      en: { locale: 'en', slug: 'test', title: 'Test', excerpt: 'E', country: 'Test', heroImage: { src: 'https://img/h', width: 768, height: 512, alt: 'Alt' }, bodyMarkdown: 'Intro', images: {} },
    };
    const mdx = (await renderPostToMdx(pairWithAngles, 'de'));
    expect(mdx).toContain('alt="Blick &lt;nach&gt; Westen &amp; zurück"');
    expect(mdx).not.toContain('alt="Blick <nach>');
  });

  it('round-trips a gallery: dimensions, alt and caption survive export → normalize', async () => {
    // Without this an "Export all" backup keeps the fence text but loses every
    // gallery photo's metadata, and re-importing yields a gallery the renderer
    // skips entirely.
    const a = 'https://img/g/a-1a2b3c4d';
    const b = 'https://img/g/b-9f8e7d6c';
    const images = {
      [a]: { width: 3000, height: 2000, format: 'jpeg' as const, alt: 'Sunrise | dawn', caption: 'Day "3"' },
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
    const mdx = (await renderPostToMdx(withGallery, 'de'));
    expect(mdx).toContain(`${a} | 3000x2000 | format="jpeg" | alt="Sunrise &#124; dawn" | caption="Day &quot;3&quot;"`);
    expect(mdx).toContain(`${b} | 2000x3000`);

    // The exact inverse: pasting the exported body back reproduces the map.
    const body = mdx.slice(mdx.indexOf('Intro'));
    expect((await normalizeBodyImages(body, {})).images).toEqual(images);
  });

  // Gallery-local captions (2026-10-19): the backup must carry a caption
  // override's exact text, even when that text reads like an inline image of
  // a photo the post hosts — the inline pass would otherwise turn it into a
  // <BodyImage> tag whose quotes break the field, and re-import would drop it.
  it('round-trips gallery-local captions and image-like gallery text through export → normalize', async () => {
    const a = 'https://img/g/a-1a2b3c4d';
    const b = 'https://img/g/b-9f8e7d6c';
    const override = `Wie ![Gasse](${a}) und <BodyImage src={${a}} width={1} height={1} /> | "zitiert"`;
    const alt = `Alt ![Gasse](${a})`;
    const images = {
      [a]: { width: 3000, height: 2000, alt },
      [b]: { width: 2000, height: 3000, caption: 'Library fallback' },
    };
    const stored = `Intro\n\n![Gasse](${a})\n\n\`\`\`gallery\n#captions: hidden\n`
      + `${a} | caption-override="${escapeMeta(override)}"\n${b} | caption-override=""\n${b}\n\`\`\`\n`;
    const withOverrides: PostPair = { ...pair, de: { ...pair.de, bodyMarkdown: stored, images } };
    const mdx = (await renderPostToMdx(withOverrides, 'de'));
    // The inline image outside the fence still becomes a tag…
    expect(mdx).toContain(`<BodyImage src="${a}" width={3000} height={2000} alt="Gasse" />`);
    // …while every gallery line keeps its text, override last.
    expect(mdx).toContain([
      '```gallery',
      '#captions: hidden',
      `${a} | 3000x2000 | alt="${escapeMeta(alt)}" | caption-override="${escapeMeta(override)}"`,
      `${b} | 2000x3000 | caption="Library fallback" | caption-override=""`,
      `${b} | 2000x3000 | caption="Library fallback"`,
      '```',
    ].join('\n'));
    expect(mdx.match(/<BodyImage/g)).toHaveLength(1);

    const back = (await normalizeBodyImages(mdx.slice(mdx.indexOf('Intro')), {}));
    expect(back.bodyMarkdown).toBe(stored);
    expect(back.images).toEqual(images);
  });

  it('round-trips a bracketed alt: escaped in the body, plain in the tag, escaped again on paste-back (#140)', async () => {
    const src = 'https://img/x/y';
    // `$&` would be a replacement token if the tag were passed as a string.
    const body = 'Intro\n\n![Blick vom Gipfel \\[Norwegen\\] \\\\ hoch $& $1](https://img/x/y)\n';
    const withBrackets: PostPair = {
      ...pair,
      de: { ...pair.de, bodyMarkdown: body, images: { [src]: { width: 1600, height: 1067 } } },
    };
    const mdx = (await renderPostToMdx(withBrackets, 'de'));
    expect(mdx).toContain('<BodyImage src="https://img/x/y" width={1600} height={1067} alt="Blick vom Gipfel [Norwegen] \\ hoch $&amp; $1" />');
    const back = (await normalizeBodyImages(mdx.slice(mdx.indexOf('Intro')), {}));
    expect(back.bodyMarkdown).toBe(body);
    expect(back.images).toEqual({ [src]: { width: 1600, height: 1067 } });
  });

  // The MDX files are the recovery path, so the cover choice has to survive
  // them — but the Zod field is `z.boolean().optional()` with no default, so
  // an unflagged post must export exactly as it did before the flag existed.
  it('emits `featured: true` only when the flag is set, in both locales', async () => {
    expect((await renderPostToMdx(pair, 'de'))).not.toContain('featured');
    const flagged: PostPair = { ...pair, shared: { ...pair.shared, featured: true } };
    expect((await renderPostToMdx(flagged, 'de'))).toContain('\nfeatured: true\n');
    // Shared, not per-locale: the EN backup carries it too.
    expect((await renderPostToMdx(flagged, 'en'))).toContain('\nfeatured: true\n');
    const unflagged: PostPair = { ...pair, shared: { ...pair.shared, featured: false } };
    expect((await renderPostToMdx(unflagged, 'de'))).toBe((await renderPostToMdx(pair, 'de')));
  });
});

describe('exportPost', () => {
  const dirs: string[] = [];
  afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

  it('writes neither locale when analysis of the second locale fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sw-export-'));
    dirs.push(dir);
    const render = bodyContent.galleryFencesToMdx;
    const analysis = vi.spyOn(bodyContent, 'galleryFencesToMdx').mockImplementation((body, images) => {
      if (body === pair.en.bodyMarkdown) return Promise.reject(new Error('source mapping unavailable'));
      return render(body, images);
    });
    try {
      await expect(exportPost(pair, dir)).rejects.toThrow('source mapping unavailable');
      expect(await readdir(dir)).toEqual([]);
    } finally { analysis.mockRestore(); }
  });

  // Issue #119: a DE-first draft has en.slug '' — that is "no EN yet", not a
  // file called `.mdx`.
  it('skips the locale whose slug is unset instead of writing trips/en/.mdx', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sw-export-'));
    dirs.push(dir);
    const deOnly: PostPair = { ...pair, en: { ...pair.en, slug: '', title: '', bodyMarkdown: '' } };
    const written = await exportPost(deOnly, dir);
    expect(written).toEqual([join(dir, 'trips', 'de', 'bukarest.mdx')]);
    expect(await readdir(join(dir, 'trips'))).toEqual(['de']);
  });
});
