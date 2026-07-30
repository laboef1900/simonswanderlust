import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { galleryFencesToMdx } from './body-content.js';
import type { Locale, PostLocale, PostPair } from './posts.js';

// YAML single-quoted scalar: a literal quote is escaped by doubling it ('' ),
// never with a backslash. Mirrors storage.ts so exported MDX re-parses cleanly.
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Turn markdown body images back into <BodyImage> tags using the images map,
 * and re-attach each ```gallery photo's dimensions/alt/caption to its line.
 * Without the gallery pass a backup would keep the fence text but lose every
 * gallery photo's metadata, and re-importing it would yield a gallery the
 * renderer skips entirely. Exact inverse of posts.ts `normalizeBodyImages`.
 */
function bodyToMdx(p: PostLocale): string {
  return galleryFencesToMdx(p.bodyMarkdown, p.images).replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => {
    const dims = p.images[src];
    if (!dims) return `![${alt}](${src})`;
    // Escape &, ", <, > (& first) so posts.ts normalizeBodyImages can decode the exact
    // inverse — a raw '>' in alt would otherwise defeat its tag regex on paste-back.
    const escapedAlt = alt
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<BodyImage src="${src}" width={${dims.width}} height={${dims.height}} alt="${escapedAlt}" />`;
  });
}

export function renderPostToMdx(pair: PostPair, locale: Locale): string {
  const p = locale === 'de' ? pair.de : pair.en;
  const s = pair.shared;
  const lines = [
    '---',
    `title: ${q(p.title)}`,
    `date: ${s.date}`,
    `country: ${q(p.country)}`,
    `countryCode: ${q(s.countryCode)}`,
    `region: ${q(s.region)}`,
    `translationKey: ${q(pair.translationKey)}`,
    `excerpt: ${q(p.excerpt)}`,
    'heroImage:',
    `  src: ${q(p.heroImage.src)}`,
    `  width: ${p.heroImage.width}`,
    `  height: ${p.heroImage.height}`,
    `  alt: ${q(p.heroImage.alt)}`,
    `coordinates: { lat: ${s.coordinates.lat}, lng: ${s.coordinates.lng} }`,
  ];
  if (s.route) lines.push(`route: ${q(s.route)}`);
  if (s.stops?.length) lines.push(`stops: ${JSON.stringify(s.stops)}`);
  if (p.keyFacts && Object.keys(p.keyFacts).length) {
    lines.push('keyFacts:');
    for (const [k, v] of Object.entries(p.keyFacts)) lines.push(`  ${q(k)}: ${q(v)}`);
  }
  lines.push('---', '', bodyToMdx(p).trim(), '');
  return lines.join('\n');
}

export async function exportPost(pair: PostPair, baseDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const locale of ['de', 'en'] as Locale[]) {
    const dir = join(baseDir, 'trips', locale);
    await mkdir(dir, { recursive: true });
    const slug = locale === 'de' ? pair.de.slug : pair.en.slug;
    const path = join(dir, `${slug}.mdx`);
    await writeFile(path, renderPostToMdx(pair, locale), 'utf8');
    out.push(path);
  }
  return out;
}

export async function exportAll(pairs: PostPair[], baseDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of pairs) out.push(...(await exportPost(p, baseDir)));
  return out;
}
