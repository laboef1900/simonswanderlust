import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locale, PostLocale, PostPair } from './posts.js';

const q = (s: string) => `'${s.replace(/'/g, "\\'")}'`;

/** Turn markdown body images back into <BodyImage> tags using the images map. */
function bodyToMdx(p: PostLocale): string {
  return p.bodyMarkdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => {
    const dims = p.images[src];
    if (!dims) return `![${alt}](${src})`;
    const escapedAlt = alt.replace(/"/g, '&quot;');
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
    `country: ${q(s.country)}`,
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
  if (s.keyFacts && Object.keys(s.keyFacts).length) {
    lines.push('keyFacts:');
    for (const [k, v] of Object.entries(s.keyFacts)) lines.push(`  ${q(k)}: ${q(v)}`);
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
