import { describe, expect, it } from 'vitest';
import { renderPreviewHtml } from '../src/preview.js';
import type { PostPair } from '../src/posts.js';

/** A complete draft pair; override pieces per test. */
function pair(overrides: Partial<PostPair> = {}): PostPair {
  return {
    translationKey: 'tk-1',
    status: 'draft',
    shared: {
      date: '2024-10-03',
      country: 'Rumänien',
      countryCode: 'RO',
      region: 'europe',
      coordinates: { lat: 44.4268, lng: 26.1025 },
      keyFacts: { Währung: 'Leu', Sprache: 'Rumänisch' },
    },
    de: {
      locale: 'de',
      slug: 'bukarest',
      title: 'Bukarest im Herbst',
      excerpt: 'Ein Wochenende in der Hauptstadt.',
      heroImage: { src: 'https://img.example.com/trips/bukarest/hero', width: 1600, height: 900, alt: 'Altstadt' },
      bodyMarkdown: '## Anreise\n\n**fett** und mehr.',
      images: {},
    },
    en: {
      locale: 'en',
      slug: 'bucharest',
      title: 'Bucharest in autumn',
      excerpt: 'A weekend in the capital.',
      heroImage: { src: '', width: 0, height: 0, alt: '' }, // the draft placeholder
      bodyMarkdown: 'Plain text.',
      images: {},
    },
    ...overrides,
  };
}

describe('renderPreviewHtml', () => {
  it('renders the markdown body like the site build (heading ids, bold)', async () => {
    const html = await renderPreviewHtml(pair(), 'de');
    expect(html).toContain('<h2 id="anreise">Anreise</h2>');
    expect(html).toContain('<strong>fett</strong>');
  });

  it('upgrades known body images (extension-less base keys) to responsive <picture>', async () => {
    const p = pair();
    p.de.bodyMarkdown = '![Old town](https://img.example.com/trips/bukarest/old-town)';
    p.de.images = { 'https://img.example.com/trips/bukarest/old-town': { width: 1600, height: 1200 } };
    const html = await renderPreviewHtml(p, 'de');
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
    const html = await renderPreviewHtml(p, 'de');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:alert');
  });

  it('HTML-escapes hostile frontmatter strings (title, country, key facts, alt)', async () => {
    const p = pair();
    p.de.title = '<script>x</script>';
    p.shared.country = '<b>evil</b>';
    p.shared.keyFacts = { '<i>k</i>': '"v" & more' };
    p.de.heroImage.alt = '"><script>y</script>';
    const html = await renderPreviewHtml(p, 'de');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<b>evil</b>');
    expect(html).not.toContain('<i>k</i>');
    expect(html).not.toContain('<script>y</script>');
  });

  it('renders the hero <picture> when heroImage.src is set', async () => {
    const html = await renderPreviewHtml(pair(), 'de');
    expect(html).toContain('class="hero"');
    expect(html).toContain('https://img.example.com/trips/bukarest/hero-1280.webp');
    expect(html).toContain('alt="Altstadt"');
  });

  it('omits the hero block for the empty-src draft placeholder', async () => {
    const html = await renderPreviewHtml(pair(), 'en');
    expect(html).not.toContain('class="hero"');
    expect(html).toContain('Plain text.');
  });

  it('renders key facts entries', async () => {
    const html = await renderPreviewHtml(pair(), 'de');
    expect(html).toContain('<dt>Währung</dt>');
    expect(html).toContain('<dd>Leu</dd>');
  });

  it('carries a draft banner and a robots noindex meta', async () => {
    const html = await renderPreviewHtml(pair(), 'de');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('Draft preview — not published');
    expect(html).toContain('· DE');
  });

  it('labels a published post as published instead', async () => {
    const html = await renderPreviewHtml(pair({ status: 'published' }), 'en');
    expect(html).toContain('Preview — published post');
    expect(html).not.toContain('Draft preview');
  });

  it('skips the {0,0} placeholder coordinates and shows real ones', async () => {
    const withCoords = await renderPreviewHtml(pair(), 'de');
    expect(withCoords).toContain('44.4268° N · 26.1025° E');
    const p = pair();
    p.shared.coordinates = { lat: 0, lng: 0 };
    const placeholder = await renderPreviewHtml(p, 'de');
    expect(placeholder).not.toContain('0.0000° N');
  });
});
