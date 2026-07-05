// Server-side draft preview: renders a post (draft or published) through the
// SAME markdown pipeline the site build uses, so the author sees exactly what
// publish would produce — without touching the public site.
//
// @ai-context The cross-tree imports below reach into site/src/lib on purpose:
// the runtime executes via tsx with both trees present (/app/uploader and
// /app/site in the image — see the repo-root Dockerfile), and reusing
// renderMarkdown + transformBodyImages guarantees build/preview parity,
// including the sanitize-then-inject <picture> XSS defense. Their deps
// (@astrojs/markdown-satteri, unified, rehype-*) resolve from site/node_modules,
// so typecheck/tests here need `npm ci` in site/ too (CI does this).
import { renderMarkdown } from '../../site/src/lib/render-markdown.js';
import { transformBodyImages } from '../../site/src/lib/body-images.js';
import { srcset, fallbackSrc } from '../../site/src/lib/images.js';
import { coordsLabel, dateLabel } from '../../site/src/lib/format.js';
import type { HeroImage, Locale, PostPair } from './posts.js';

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Hero <picture> mirroring RemoteImage.astro; empty for the draft '' placeholder. */
function heroHtml(hero: HeroImage | undefined): string {
  if (!hero || !hero.src || hero.width <= 0 || hero.height <= 0) return '';
  return `<div class="hero"><picture>
    <source type="image/avif" srcset="${escapeHtml(srcset(hero, 'avif'))}" sizes="100vw">
    <source type="image/webp" srcset="${escapeHtml(srcset(hero, 'webp'))}" sizes="100vw">
    <img src="${escapeHtml(fallbackSrc(hero))}" alt="${escapeHtml(hero.alt)}" width="${hero.width}" height="${hero.height}">
  </picture></div>`;
}

function keyFactsHtml(facts: Record<string, string> | undefined): string {
  const entries = Object.entries(facts ?? {});
  if (entries.length === 0) return '';
  const rows = entries
    .map(([label, value]) => `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('\n');
  return `<dl class="keyfacts">\n${rows}\n</dl>`;
}

// Design tokens from site/src/styles/global.css, inlined so the preview page
// is fully standalone (no site CSS is built for drafts).
const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #fbfbfd; color: #16212e; font: 16px/1.7 ui-sans-serif, system-ui, sans-serif; }
  .banner { position: sticky; top: 0; z-index: 10; background: #d23b30; color: #fff; padding: 0.7rem 1rem; text-align: center; font-family: ui-monospace, monospace; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.25em; text-transform: uppercase; }
  .hero img { display: block; width: 100%; height: auto; max-height: 55vh; object-fit: cover; }
  main { max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  .meta { color: #d23b30; font-family: ui-monospace, monospace; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.25em; text-transform: uppercase; margin: 0; }
  h1 { color: #142a42; font-size: 2.1rem; line-height: 1.15; margin: 0.5rem 0; }
  .coords { color: #5b6875; font-family: ui-monospace, monospace; font-size: 0.75rem; letter-spacing: 0.2em; margin: 0 0 1.5rem; }
  .lede { font-style: italic; color: #4a5563; }
  .keyfacts { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0.75rem; margin: 2rem 0; padding: 1.25rem; border: 1px solid #dfe3e8; border-radius: 0.5rem; }
  .keyfacts dt { font-family: ui-monospace, monospace; font-size: 0.7rem; letter-spacing: 0.15em; text-transform: uppercase; color: #5b6875; }
  .keyfacts dd { margin: 0.15rem 0 0; font-weight: 600; color: #142a42; }
  article h2, article h3, article h4 { color: #142a42; }
  article a { color: #d23b30; }
  article img { max-width: 100%; height: auto; border-radius: 0.5rem; }
  article figure { margin: 2rem 0; }
  article pre { overflow-x: auto; padding: 1rem; border-radius: 0.5rem; }
  article blockquote { border-left: 3px solid #d23b30; margin-left: 0; padding-left: 1rem; color: #4a5563; }
`;

/**
 * Full standalone HTML page for one locale of a post pair. All frontmatter
 * strings are HTML-escaped; the body goes through renderMarkdown →
 * transformBodyImages (which sanitizes the HTML before injecting <picture>).
 */
export async function renderPreviewHtml(pair: PostPair, locale: Locale): Promise<string> {
  const post = pair[locale];
  const shared = pair.shared;
  const body = transformBodyImages(await renderMarkdown(post.bodyMarkdown), post.images);

  const parsedDate = shared.date ? new Date(shared.date) : undefined;
  const metaParts = [
    parsedDate && !Number.isNaN(parsedDate.getTime()) ? dateLabel(parsedDate, locale) : '',
    shared.country,
  ].filter((part) => part.trim() !== '');
  // {lat:0,lng:0} is the incomplete-draft placeholder (see draftWithDefaults
  // in posts.ts) — don't render a bogus "0.0000° N" line for it.
  const hasCoords = shared.coordinates && (shared.coordinates.lat !== 0 || shared.coordinates.lng !== 0);
  const banner = pair.status === 'draft' ? 'Draft preview — not published' : 'Preview — published post';
  const title = post.title.trim() === '' ? '(untitled)' : post.title;

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Preview</title>
<style>${STYLE}</style>
</head>
<body>
<div class="banner">${escapeHtml(banner)} · ${locale.toUpperCase()}</div>
${heroHtml(post.heroImage)}
<main>
  <p class="meta">${escapeHtml(metaParts.join(' · '))}</p>
  <h1>${escapeHtml(title)}</h1>
  ${hasCoords ? `<p class="coords">${escapeHtml(coordsLabel(shared.coordinates))}</p>` : ''}
  ${post.excerpt.trim() !== '' ? `<p class="lede">${escapeHtml(post.excerpt)}</p>` : ''}
  ${keyFactsHtml(shared.keyFacts)}
  <article>
${body}
  </article>
</main>
</body>
</html>
`;
}
