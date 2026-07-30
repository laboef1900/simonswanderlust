import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPreviewHtml } from '../src/preview.js';
import type { PostPair } from '../src/posts.js';

/** The app's own image base — what server.ts passes as the gallery allow-list. */
const ORIGIN = 'https://img.example.com';

/** A complete draft pair; override pieces per test. */
function pair(overrides: Partial<PostPair> = {}): PostPair {
  return {
    translationKey: 'tk-1',
    status: 'draft',
    shared: {
      date: '2024-10-03',
      countryCode: 'RO',
      region: 'europe',
      coordinates: { lat: 44.4268, lng: 26.1025 },
    },
    de: {
      locale: 'de',
      slug: 'bukarest',
      title: 'Bukarest im Herbst',
      excerpt: 'Ein Wochenende in der Hauptstadt.',
      country: 'Rumänien',
      heroImage: { src: 'https://img.example.com/trips/bukarest/hero', width: 1600, height: 900, alt: 'Altstadt' },
      bodyMarkdown: '## Anreise\n\n**fett** und mehr.',
      images: {},
      keyFacts: { Währung: 'Leu', Sprache: 'Rumänisch' },
    },
    en: {
      locale: 'en',
      slug: 'bucharest',
      title: 'Bucharest in autumn',
      excerpt: 'A weekend in the capital.',
      country: 'Romania',
      heroImage: { src: '', width: 0, height: 0, alt: '' }, // the draft placeholder
      bodyMarkdown: 'Plain text.',
      images: {},
    },
    ...overrides,
  };
}

describe('renderPreviewHtml', () => {
  it('renders the markdown body like the site build (heading ids, bold)', async () => {
    const html = await renderPreviewHtml(pair(), 'de', ORIGIN);
    expect(html).toContain('<h2 id="anreise">Anreise</h2>');
    expect(html).toContain('<strong>fett</strong>');
  });

  it('upgrades known body images (extension-less base keys) to responsive <picture>', async () => {
    const p = pair();
    p.de.bodyMarkdown = '![Old town](https://img.example.com/trips/bukarest/old-town)';
    p.de.images = { 'https://img.example.com/trips/bukarest/old-town': { width: 1600, height: 1200 } };
    const html = await renderPreviewHtml(p, 'de', ORIGIN);
    expect(html).toContain('<figure');
    expect(html).toContain('type="image/avif"');
    expect(html).toContain('type="image/webp"');
    expect(html).toContain('https://img.example.com/trips/bukarest/old-town-1280.webp');
    expect(html).toContain('alt="Old town"');
  });

  it('sanitizes the body: strips <script>, inline handlers and javascript: URLs', async () => {
    const p = pair();
    p.de.bodyMarkdown = [
      'hello <script>alert(1)</script>',
      '<img src="https://x/y" onerror="alert(2)">',
      '[click](javascript:alert(3))',
    ].join('\n\n');
    const html = await renderPreviewHtml(p, 'de', ORIGIN);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:alert');
  });

  it('HTML-escapes hostile frontmatter strings (title, country, key facts, alt)', async () => {
    const p = pair();
    p.de.title = '<script>x</script>';
    p.de.country = '<b>evil</b>';
    p.de.keyFacts = { '<i>k</i>': '"v" & more' };
    p.de.heroImage.alt = '"><script>y</script>';
    const html = await renderPreviewHtml(p, 'de', ORIGIN);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<b>evil</b>');
    expect(html).not.toContain('<i>k</i>');
    expect(html).not.toContain('<script>y</script>');
  });

  it('neutralizes non-integer heroImage.width/height (jsonb is untyped on draft saves)', async () => {
    // validateDraft does not type-check heroImage, so a draft can carry a
    // hostile string where a number belongs; it must never reach the markup.
    const p = pair();
    p.de.heroImage = {
      src: 'https://img.example.com/trips/bukarest/hero',
      width: '9" onerror="alert(document.cookie)' as unknown as number,
      height: 1,
      alt: 'Altstadt',
    };
    const html = await renderPreviewHtml(p, 'de', ORIGIN);
    expect(html).not.toContain('onerror');
    // The whole hero block is dropped rather than emitting bogus dimensions.
    expect(html).not.toContain('class="hero"');
  });

  it('tolerates non-string jsonb alt / key-fact values without throwing (draft saves are untyped)', async () => {
    // validateDraft type-checks only title + slug, so hero.alt and keyFacts
    // values can be any JSON on a draft. escapeHtml must coerce them rather
    // than throw a TypeError on .replaceAll and 500 the preview.
    const p = pair();
    p.de.heroImage = {
      src: 'https://img.example.com/trips/bukarest/hero',
      width: 1600,
      height: 900,
      alt: undefined as unknown as string, // missing 'alt' key in the jsonb
    };
    p.de.keyFacts = { Höhe: 42 as unknown as string }; // a number, not a string
    const html = await renderPreviewHtml(p, 'de', ORIGIN);
    expect(html).toContain('class="hero"'); // hero still renders (dims are valid)
    expect(html).toContain('alt=""'); // undefined alt coerced to empty string
    expect(html).toContain('<dd>42</dd>'); // numeric key-fact stringified, not crashed
  });

  it('drops the hero for non-positive or fractional dimensions', async () => {
    const cases: Array<[number, number]> = [[0, 900], [1600, -1], [1600.5, 900], [NaN, 900]];
    for (const [width, height] of cases) {
      const p = pair();
      p.de.heroImage = { src: 'https://img.example.com/trips/bukarest/hero', width, height, alt: 'x' };
      const html = await renderPreviewHtml(p, 'de', ORIGIN);
      expect(html).not.toContain('class="hero"');
    }
  });

  it('renders the hero <picture> when heroImage.src is set', async () => {
    const html = await renderPreviewHtml(pair(), 'de', ORIGIN);
    expect(html).toContain('class="hero"');
    expect(html).toContain('https://img.example.com/trips/bukarest/hero-1280.webp');
    expect(html).toContain('alt="Altstadt"');
  });

  it('omits the hero block for the empty-src draft placeholder', async () => {
    const html = await renderPreviewHtml(pair(), 'en', ORIGIN);
    expect(html).not.toContain('class="hero"');
    expect(html).toContain('Plain text.');
  });

  it('renders key facts entries', async () => {
    const html = await renderPreviewHtml(pair(), 'de', ORIGIN);
    expect(html).toContain('<dt>Währung</dt>');
    expect(html).toContain('<dd>Leu</dd>');
  });

  // Issue #87: country and key facts are per-locale — the EN preview must show
  // its OWN country, never the DE row's.
  it('shows each locale\'s own country, not the other locale\'s', async () => {
    const de = await renderPreviewHtml(pair(), 'de', ORIGIN);
    const en = await renderPreviewHtml(pair(), 'en', ORIGIN);
    expect(de).toContain('Rumänien');
    expect(en).not.toContain('Rumänien');
    expect(en).toContain('Romania');
    expect(de).not.toContain('Romania');
  });

  it('carries a draft banner and a robots noindex meta', async () => {
    const html = await renderPreviewHtml(pair(), 'de', ORIGIN);
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('Draft preview — not published');
    expect(html).toContain('· DE');
  });

  it('labels a published post as published instead', async () => {
    const html = await renderPreviewHtml(pair({ status: 'published' }), 'en', ORIGIN);
    expect(html).toContain('Preview — published post');
    expect(html).not.toContain('Draft preview');
  });

  it('renders a gallery fence as a grid, using the images map for alt/caption', async () => {
    const p = pair();
    const a = `${ORIGIN}/trips/bukarest/a-1a2b3c4d`;
    p.de.bodyMarkdown = `\`\`\`gallery\n${a}\n\`\`\``;
    p.de.images = { [a]: { width: 3000, height: 2000, alt: 'Altstadt bei Nacht', caption: 'Tag 2' } };
    const html = await renderPreviewHtml(p, 'de', ORIGIN);
    expect(html).toContain('class="jgal jgal--breakout not-prose"');
    expect(html).toContain('alt="Altstadt bei Nacht"');
    expect(html).toContain('Tag 2');
  });

  it('rejects a gallery URL from another origin (the allow-list is origin equality)', async () => {
    const p = pair();
    const evil = 'https://img.example.com.evil.com/x';
    p.de.bodyMarkdown = `\`\`\`gallery\n${evil}\n\`\`\``;
    p.de.images = { [evil]: { width: 800, height: 600, alt: 'x' } };
    const html = await renderPreviewHtml(p, 'de', ORIGIN);
    // (`jgal` alone would match the STYLE block, which always ships.)
    expect(html).not.toContain('class="jgal');
    expect(html).not.toContain('href="https://img.example.com.evil.com');
  });

  it('skips the {0,0} placeholder coordinates and shows real ones', async () => {
    const withCoords = await renderPreviewHtml(pair(), 'de', ORIGIN);
    expect(withCoords).toContain('44.4268° N · 26.1025° E');
    const p = pair();
    p.shared.coordinates = { lat: 0, lng: 0 };
    const placeholder = await renderPreviewHtml(p, 'de', ORIGIN);
    expect(placeholder).not.toContain('0.0000° N');
  });
});

describe('preview gallery CSS mirrors the site stylesheet', () => {
  // preview.ts is standalone: it inlines its own STYLE and links no site CSS,
  // so the gallery rules have to be hand-copied. This is the anti-drift guard
  // — if global.css grows or renames a .jgal selector and STYLE doesn't, draft
  // previews silently render galleries as a stacked column of full-width
  // images. (The .keyfacts block is the existing precedent for the mirroring.)
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('declares every .jgal selector that global.css does', async () => {
    const globalCss = read('../../site/src/styles/global.css');
    const previewSrc = read('../src/preview.ts');
    // Leading whitespace is allowed so rules nested inside @container blocks
    // are scraped too — #66 put the stacking and slides-per-view breakpoints
    // there, and an unindented-only scrape would have let exactly those drift.
    const selectors = [...globalCss.matchAll(/^\s*\.jgal[^{]*/gm)].map((m) => m[0].trim());
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(previewSrc).toContain(selector);
  });
});
