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

// @ai-warning: several fields escaped here (hero.alt, keyFacts labels/values,
// coordinate/date strings) are typed as string but come from untyped jsonb
// columns, and draft saves only run validateDraft (title + slug) — so a draft
// may carry a non-string value where a string belongs. `.replaceAll` only
// exists on strings, so coerce first (mirrors the width/height guard in
// heroHtml); otherwise a non-string alt/keyFact would throw a TypeError and
// 500 the whole preview.
function escapeHtml(s: string): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Hero <picture> mirroring RemoteImage.astro; empty for the draft '' placeholder. */
function heroHtml(hero: HeroImage | undefined): string {
  if (!hero || !hero.src) return '';
  // @ai-warning: heroImage is typed {width,height: number} but comes from the
  // posts.hero_image jsonb column, and draft saves only run validateDraft
  // (title + slug) — so width/height may be ANY JSON value here, including a
  // hostile string. Coerce to positive integers (mirrors validateForPublish)
  // before they reach the markup; the strings around them are escapeHtml'd,
  // but width/height are emitted as bare attribute values.
  const width = Number.isInteger(hero.width) && hero.width > 0 ? hero.width : 0;
  const height = Number.isInteger(hero.height) && hero.height > 0 ? hero.height : 0;
  if (width === 0 || height === 0) return '';
  const safeHero: HeroImage = { ...hero, width, height };
  return `<div class="hero"><picture>
    <source type="image/avif" srcset="${escapeHtml(srcset(safeHero, 'avif'))}" sizes="100vw">
    <source type="image/webp" srcset="${escapeHtml(srcset(safeHero, 'webp'))}" sizes="100vw">
    <img src="${escapeHtml(fallbackSrc(safeHero))}" alt="${escapeHtml(hero.alt)}" width="${width}" height="${height}">
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
  /* @ai-warning: hand-mirrored from site/src/styles/global.css (the .keyfacts
     block above is the same pattern). This page loads NO site CSS, so without
     these rules a gallery renders as a stacked column of full-width images.
     preview.test.ts asserts every .jgal selector in global.css appears here —
     change the two together. */
  .jgal { margin-block: 2rem; container-type: inline-size; }
  .jgal__item { margin: 0; min-width: 0; }
  .jgal__item a { display: block; }
  .jgal__item img { display: block; width: 100%; height: auto; border-radius: 0.5rem; }
  .jgal__cap { margin-top: 0.4rem; font-size: 0.8rem; line-height: 1.4; color: #4a5563; }
  .jgal__item a:focus-visible, .jgal__track:focus-visible { outline: 3px solid #d23b30; outline-offset: 3px; }
  .jgal--breakout, .jgal--slider { --jgal-w: min(100% + 24rem, 100vw - 3.5rem, 1112px); width: var(--jgal-w); margin-inline: calc((100% - var(--jgal-w)) / 2); }
  .jgal--breakout, .jgal--column { display: flex; flex-direction: column; gap: 0.75rem; }
  .jgal__row { display: flex; flex-wrap: nowrap; gap: 0.75rem; max-width: var(--jgal-maxw, none); }
  .jgal__row > .jgal__item { flex: calc(var(--r) * 100) 1 0; }
  .jgal--slider { position: relative; }
  .jgal__track { display: flex; flex-wrap: nowrap; gap: 0.75rem; overflow-x: auto; scroll-snap-type: x mandatory; scroll-behavior: smooth; scrollbar-width: thin; padding-bottom: 0.5rem; }
  .jgal__track > .jgal__item { flex: 0 0 calc((100% - 1.5rem) / 3); scroll-snap-align: start; }
  .jgal__track > .jgal__item img { aspect-ratio: 3 / 2; object-fit: cover; }
  /* The nav buttons stay hidden here for real: the preview page loads no JS,
     so nothing would ever reveal them. The rules are mirrored anyway, because
     the parity test compares selector sets, not what the preview uses. */
  .jgal__nav { position: absolute; top: calc(50% - 1.75rem); z-index: 1; display: flex; align-items: center; justify-content: center; width: 2.75rem; height: 2.75rem; padding: 0; border: 0; border-radius: 999px; background: rgb(20 42 66 / 0.82); color: #fff; font-size: 1.5rem; line-height: 1; cursor: pointer; }
  .jgal__nav[hidden] { display: none; }
  .jgal__nav--prev { left: 0.5rem; }
  .jgal__nav--next { right: 0.5rem; }
  .jgal__nav:disabled { opacity: 0.3; cursor: default; }
  .jgal__nav:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
  @container (max-width: 900px) {
    .jgal__track > .jgal__item { flex-basis: calc((100% - 0.75rem) / 2); }
  }
  @container (max-width: 600px) {
    .jgal__row { flex-wrap: wrap; max-width: none; }
    .jgal__row > .jgal__item { flex: 1 0 100%; }
    .jgal__track > .jgal__item { flex-basis: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    .jgal__track { scroll-behavior: auto; }
  }
`;

/**
 * Full standalone HTML page for one locale of a post pair. All frontmatter
 * strings are HTML-escaped; the body goes through renderMarkdown →
 * transformBodyImages (which sanitizes the HTML before injecting <picture>).
 *
 * @param imageOrigin the app's own image base URL (`cfg.baseUrl`) — the only
 *   origin a ```gallery fence may reference. Passed in rather than read from
 *   the environment so `transformBodyImages` stays pure: it runs both under
 *   `astro build` and here under tsx, where `import.meta.env` does not exist.
 *   Sourcing it from the app's own config (instead of the site build's
 *   `PUBLIC_BASE_URL` fallback) is what makes draft galleries work on a dev
 *   machine as well as in production.
 */
export async function renderPreviewHtml(pair: PostPair, locale: Locale, imageOrigin: string): Promise<string> {
  const post = pair[locale];
  const shared = pair.shared;
  const body = transformBodyImages(await renderMarkdown(post.bodyMarkdown), post.images, imageOrigin);

  const parsedDate = shared.date ? new Date(shared.date) : undefined;
  const metaParts = [
    parsedDate && !Number.isNaN(parsedDate.getTime()) ? dateLabel(parsedDate, locale) : '',
    post.country,
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
  ${keyFactsHtml(post.keyFacts)}
  <article>
${body}
  </article>
</main>
</body>
</html>
`;
}
