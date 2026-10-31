import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { galleryFencesToMdx, rewriteOutsideGalleries, unescapeAltText } from './body-content.js';
import { markdownImages } from './wp-content.js';
import { checkSlug, type HeroImage, type Locale, type PostLocale, type PostPair } from './posts.js';
import { validatePublicTrack, type PublicTrack } from '../public/gpx-public-track.js';
import { analyzeGallerySource } from '../../site/src/lib/gallery-source.js';
import { galleryDiagnostics } from '../public/gallery-photo-line.js';

// YAML single-quoted scalar: a literal quote is escaped by doubling it ('' ),
// never with a backslash. Mirrors storage.ts so exported MDX re-parses cleanly.
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function imageYaml(name: string, image: HeroImage): string[] {
  return [
    `${name}:`,
    `  src: ${q(image.src)}`,
    `  width: ${image.width}`,
    `  height: ${image.height}`,
    `  alt: ${q(image.alt)}`,
    ...(image.format === 'jpeg' ? ['  format: jpeg'] : []),
    ...(image.focus ? [`  focus: { x: ${image.focus.x}, y: ${image.focus.y} }`] : []),
  ];
}

/**
 * Turn markdown body images back into <BodyImage> tags using the images map,
 * and re-attach each ```gallery photo's dimensions/alt/caption to its line.
 * Without the gallery pass a backup would keep the fence text but lose every
 * gallery photo's metadata, and re-importing it would yield a gallery the
 * renderer skips entirely. Exact inverse of posts.ts `normalizeBodyImages`.
 *
 * The inline pass runs only OUTSIDE gallery fences (`rewriteOutsideGalleries`):
 * a gallery line's text — a `caption-override` above all — may read like an
 * inline image and must reach the backup byte-for-byte.
 */
async function bodyToMdx(p: PostLocale): Promise<string> {
  return rewriteOutsideGalleries(await galleryFencesToMdx(p.bodyMarkdown, p.images), async (text) => {
    let out = text;
    // `markdownImages` reads the label with its backslash escapes (posts.ts
    // writes `\[`/`\]` via `imageMarkdown`); a naive `[^\]]*` stopped at the
    // first escaped bracket and exported the photo without its dimensions.
    for (const img of await markdownImages(text)) {
      const dims = p.images[img.url];
      if (!dims) continue;
      // Escape &, ", <, > (& first) so posts.ts normalizeBodyImages can decode the exact
      // inverse — a raw '>' in alt would otherwise defeat its tag regex on paste-back.
      const escapedAlt = unescapeAltText(img.alt)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const tag = `<BodyImage src="${img.url}" width={${dims.width}} height={${dims.height}} alt="${escapedAlt}"${dims.format === 'jpeg' ? ' format="jpeg"' : ''} />`;
      // Callback form: a string replacement would read `$&`/`$1` in the alt as tokens.
      out = out.replaceAll(img.full, () => tag);
    }
    return out;
  });
}

export async function renderPostToMdx(pair: PostPair, locale: Locale, track?: PublicTrack): Promise<string> {
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
    ...imageYaml('heroImage', p.heroImage),
    ...(p.titleImage ? imageYaml('titleImage', p.titleImage) : []),
    `coordinates: { lat: ${s.coordinates.lat}, lng: ${s.coordinates.lng} }`,
  ];
  if (s.route) lines.push(`route: ${q(s.route)}`);
  if (s.stops?.length) lines.push(`stops: ${JSON.stringify(s.stops)}`);
  if (track !== undefined) lines.push(`track: ${JSON.stringify(validatePublicTrack(track))}`);
  // Zod has it as `featured: z.boolean().optional()` (site/src/content.config.ts):
  // absent = not the cover. Writing `featured: false` would be valid but would
  // change every existing backup file, so the key is omitted when unset.
  if (s.featured) lines.push('featured: true');
  if (p.keyFacts && Object.keys(p.keyFacts).length) {
    lines.push('keyFacts:');
    for (const [k, v] of Object.entries(p.keyFacts)) lines.push(`  ${q(k)}: ${q(v)}`);
  }
  const body = await bodyToMdx(p);
  // Trimming an unterminated gallery's last invalid photo line would destroy
  // retained whitespace. Invalid source is an opaque backup payload, not a
  // candidate for export's otherwise unchanged outer-whitespace convention.
  const invalid = galleryDiagnostics(await analyzeGallerySource(body)).length > 0;
  lines.push('---', '', invalid ? body : body.trim());
  if (!invalid) lines.push('');
  return lines.join('\n');
}

export async function exportPost(pair: PostPair, baseDir: string, track?: PublicTrack): Promise<string[]> {
  // Validate the entire pair before mkdir/write: a legacy EN slug must not
  // leave a fresh DE backup behind, nor overwrite an existing one.
  for (const locale of ['de', 'en'] as const) {
    if (pair[locale].slug !== '') checkSlug(pair[locale].slug, locale);
  }
  const out: string[] = [];
  // Analyze both locales before writing either file: a later source-map failure
  // must not leave one half of a translation pair exported.
  const rendered: Partial<Record<Locale, string>> = {};
  for (const locale of ['de', 'en'] as const) {
    if (pair[locale].slug !== '') rendered[locale] = await renderPostToMdx(pair, locale, track);
  }
  for (const locale of ['de', 'en'] as Locale[]) {
    const slug = pair[locale].slug;
    // An unset slug (DE-first draft without an EN title, issue #119) has no
    // filename — writing `trips/en/.mdx` would just be a hidden file.
    if (slug === '') continue;
    const dir = join(baseDir, 'trips', locale);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${slug}.mdx`);
    await writeFile(path, rendered[locale]!, 'utf8');
    out.push(path);
  }
  return out;
}

export async function exportAll(
  pairs: PostPair[],
  baseDir: string,
  readTrack: (translationKey: string) => Promise<PublicTrack | undefined>,
): Promise<string[]> {
  const out: string[] = [];
  for (const pair of pairs) {
    // Snapshot retrieval validates BOTH locale artifacts before this pair writes
    // anything. Working-copy route edits/detachment must never reach this path.
    const track = await readTrack(pair.translationKey);
    out.push(...(await exportPost(pair, baseDir, track)));
  }
  return out;
}
