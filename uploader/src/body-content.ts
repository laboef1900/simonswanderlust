/**
 * Body-markdown normalization and `images`-map validation shared by posts and
 * pages. Both content types store the same shape — a Markdown body plus an
 * `images` map keyed by image URL — and both must apply the same rules, so the
 * rules live here rather than being duplicated (and drifting) in `posts.ts`
 * and `pages.ts`.
 *
 * @ai-context docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md
 *   (§Galleries) — issue #65.
 * @ai-context docs/superpowers/specs/2026-10-19-gallery-library-metadata-design.md
 *   (§Gallery-local caption controls) — the `caption-override="…"` field and
 *   `#captions:` directive, whose readers live in the site tree.
 */

// Cross-tree on purpose, like preview.ts: the renderer must read a photo
// line's gallery-local caption with exactly the rule the save normalizer and
// exporter use, so the one reader (and its escaping) lives beside the
// renderer's other fence readers.
import {
  CAPTION_OVERRIDE_FIELD_RE,
  MAX_GALLERY_TEXT,
  escapeMeta,
  readCaptionOverride,
  unescapeMeta,
} from '../../site/src/lib/gallery-layout.js';
import { analyzeGallerySource } from '../../site/src/lib/gallery-source.js';
import { applyGalleryEdits, galleryLineEdits } from '../public/gallery-source-edits.js';

/**
 * One `images` entry: intrinsic dimensions plus the optional per-locale alt and
 * caption a gallery renders. DE and EN are separate rows, so "per-locale"
 * needs no extra schema — the DE row carries German text, the EN row English.
 *
 * @ai-warning `site/src/lib/body-images.ts` declares this shape independently
 * as `ImageDims` (a different tree with its own tsconfig). Widen both together:
 * because the extra fields are optional, `tsc` and `astro check` stay green
 * when only one side is widened, and the symptom is galleries rendering with
 * empty alt and no captions on a green build. `test/body-content.test.ts` pins
 * the two together with a compile-time assertion — plain assignment does NOT
 * catch this, see the comment there before changing it.
 */
export interface ImageMeta { width: number; height: number; alt?: string; caption?: string; format?: 'jpeg' }

/** Longest alt/caption accepted — these end up in every gallery's HTML. */
const MAX_TEXT = MAX_GALLERY_TEXT;

/**
 * Validate an untyped `images` map from a request body (or a WXR import).
 * Returns a human-readable message for the first problem, or null when the map
 * is acceptable.
 *
 * @ai-warning This is a security control, not a tidiness check. `images` is
 * author-supplied jsonb that reaches the render boundary in
 * `site/src/lib/body-images.ts`, where hastscript treats a node-shaped object
 * in a children array AS A NODE — `{type:'raw', value:'<script>…'}` in a
 * caption would emit a live script tag, and the stringifier runs with
 * `allowDangerousHtml`. Dimensions likewise feed markup arithmetic. The render
 * boundary coerces with `String()` as a backstop, but the map must not be able
 * to hold such a value in the first place.
 *
 * Returning a message instead of throwing keeps this free of `PostError` /
 * `PageError`, so both callers can raise their own error type and get their
 * own 400.
 */
export function imagesMapError(images: unknown): string | null {
  if (images === undefined || images === null) return null;
  if (typeof images !== 'object' || Array.isArray(images)) return 'images must be an object';
  for (const [src, value] of Object.entries(images as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `images["${src}"] must be an object`;
    }
    const v = value as Record<string, unknown>;
    for (const dim of ['width', 'height'] as const) {
      if (!Number.isInteger(v[dim]) || (v[dim] as number) <= 0) {
        return `images["${src}"].${dim} must be a positive integer`;
      }
    }
    if (v.format !== undefined && v.format !== 'jpeg') {
      return `images["${src}"].format must be "jpeg"`;
    }
    for (const text of ['alt', 'caption'] as const) {
      if (v[text] === undefined || v[text] === null) continue;
      if (typeof v[text] !== 'string') return `images["${src}"].${text} must be a string`;
      if ((v[text] as string).length > MAX_TEXT) {
        return `images["${src}"].${text} must be at most ${MAX_TEXT} characters`;
      }
    }
  }
  return null;
}

/**
 * Validate an untyped `heroImage` from a request body. Same posture as
 * `imagesMapError`: the hero's `alt` reaches every reader page's markup, and
 * a draft save (`validateDraft` only checks "is an object") was the one text
 * field with no length cap at all — an AI suggestion that ran away to 2 kB
 * was saved verbatim (#140). Draft-tolerant: `src` may be empty and the
 * dimensions zero (the importer's placeholder); `validateLocale` tightens
 * both at publish time.
 */
export function heroImageError(hero: unknown): string | null {
  if (hero === undefined) return null;
  if (typeof hero !== 'object' || hero === null || Array.isArray(hero)) return 'heroImage must be an object';
  const h = hero as Record<string, unknown>;
  for (const text of ['src', 'alt'] as const) {
    if (typeof h[text] !== 'string') return `heroImage.${text} must be a string`;
  }
  if ((h.alt as string).length > MAX_TEXT) return `heroImage.alt must be at most ${MAX_TEXT} characters`;
  for (const dim of ['width', 'height'] as const) {
    if (!Number.isInteger(h[dim]) || (h[dim] as number) < 0) return `heroImage.${dim} must be a non-negative integer`;
  }
  if (h.format !== undefined && h.format !== 'jpeg') return 'heroImage.format must be "jpeg"';
  // Optional focal point: percentages of the frame, fed to `object-position`
  // by site/src/lib/images.ts so a full-bleed `object-fit: cover` crop keeps
  // the subject in frame. Validated HERE, at the store chokepoint,
  // rather than in validateDraft because the WXR importer bypasses that, and
  // rejected outright rather than coerced — a silently clamped focal point
  // looks like the author's pick failed to save.
  if (h.focus !== undefined) {
    const f = h.focus;
    if (typeof f !== 'object' || f === null || Array.isArray(f)) return 'heroImage.focus must be an object';
    for (const axis of ['x', 'y'] as const) {
      const v = (f as Record<string, unknown>)[axis];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
        return `heroImage.focus.${axis} must be a number between 0 and 100`;
      }
    }
  }
  return null;
}

/**
 * Alt text as a CommonMark image label: `\`, `[` and `]` escaped so the label
 * ends where the author's text does. Composing `![${alt}](${src})` from raw
 * text turned `Blick vom Gipfel [Norwegen]` into a broken image that rendered
 * literally (#140). Mirrored by `public/image-markdown.js` for the editor —
 * `test/image-markdown-mirror.test.ts` keeps the two honest.
 */
export function escapeAltText(alt: string): string {
  return alt.replace(/[\\[\]]/g, '\\$&');
}

/** Inverse of `escapeAltText` — CommonMark §2.4: a backslash escapes ASCII punctuation only. */
export function unescapeAltText(alt: string): string {
  return alt.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

export function imageMarkdown(alt: string, src: string): string {
  return `![${escapeAltText(alt)}](${src})`;
}

/** Rewrite only parser-owned logical photo lines, preserving all other bytes. */
export async function rewriteFences(body: string, rewriteLine: (line: string) => string): Promise<string> {
  const analysis = await analyzeGallerySource(body);
  const edits = analysis.blocks.filter((block) => block.isGallery).flatMap((block) =>
    block.lines.filter((line) => line.text.trim() !== '' && !line.text.trim().startsWith('#'))
      .flatMap((line) => galleryLineEdits(line, rewriteLine(line.text))),
  );
  // Callbacks run in source order (import identity and duplicate-URL metadata
  // precedence depend on it); batch application copies the document only once.
  return applyGalleryEdits(body, edits);
}

/**
 * Inline Markdown/MDX passes must not consume gallery-local captions which
 * happen to contain image syntax. Gallery identity comes from the same sanitized
 * render predicate as publish and preview, including raw HTML and containers.
 */
export async function rewriteOutsideGalleries(
  body: string,
  rewrite: (text: string) => string | Promise<string>,
): Promise<string> {
  const analysis = await analyzeGallerySource(body);
  const parts: string[] = [];
  let at = 0;
  for (const block of analysis.blocks) {
    if (!block.isGallery) continue;
    parts.push(await rewrite(body.slice(at, block.start)), body.slice(block.start, block.end));
    at = block.end;
  }
  parts.push(await rewrite(body.slice(at)));
  return parts.join('');
}

const DIMS_RE = /^(\d{1,6})x(\d{1,6})$/;
const ATTR_RE = /^(alt|caption|format)="([^"]*)"$/;

/**
 * Save-time normalization of gallery fences, the exact inverse of
 * `galleryFencesToMdx`: a line of
 * `url | 3000x2000 | alt="…" | caption="…"` has its metadata lifted into the
 * `images` map and is rewritten to the bare URL, so the stored body stays the
 * canonical "one URL per line" form and the render path has a single place to
 * read dimensions and text from.
 *
 * This is what makes hand-typed captions possible before the library picker
 * exists (#75): the editor exposes no field for `images` metadata, so the
 * author types it on the line and this lifts it.
 *
 * A line whose metadata cannot be resolved to valid dimensions (bad `WxH` and
 * no existing entry for that URL) is left **untouched** rather than stripped —
 * never destroy what the author typed.
 *
 * @ai-warning A `caption-override="…"` field is the ONE piece of line metadata
 * that is NOT lifted: it belongs to this occurrence of the photo in this
 * gallery, and the `images` map is keyed by URL, so lifting it would leak the
 * caption into every other gallery using the same photo. It is re-emitted on
 * the line in canonical form (`url | caption-override="…"`, re-escaped and
 * capped), which makes the normalizer idempotent over its own output.
 */
export async function normalizeGalleryFences(
  bodyMarkdown: string,
  images: Record<string, ImageMeta>,
): Promise<{ bodyMarkdown: string; images: Record<string, ImageMeta> }> {
  const merged: Record<string, ImageMeta> = { ...images };
  const normalized = await rewriteFences(bodyMarkdown, (line) => {
    const fields = line.split('|').map((f) => f.trim());
    const src = fields[0] ?? '';
    if (src === '') return line;
    if (fields.length === 1) return line; // already normalized — nothing to lift
    let width: number | undefined;
    let height: number | undefined;
    let alt: string | undefined;
    let caption: string | undefined;
    let format: 'jpeg' | undefined;
    let invalidFormat = false;
    for (const field of fields.slice(1)) {
      const dims = DIMS_RE.exec(field);
      if (dims) {
        width = Number(dims[1]);
        height = Number(dims[2]);
        continue;
      }
      const attr = ATTR_RE.exec(field);
      if (attr) {
        const value = unescapeMeta(attr[2] ?? '').slice(0, MAX_TEXT);
        if (attr[1] === 'alt') alt = value;
        else if (attr[1] === 'caption') caption = value;
        else if (value === 'jpeg') format = value;
        else invalidFormat = true;
      }
    }
    if (invalidFormat) return line;
    const existing = merged[src];
    const w = width ?? existing?.width ?? 0;
    const hgt = height ?? existing?.height ?? 0;
    if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(hgt) || hgt <= 0) {
      return line; // unresolvable — keep the author's text rather than losing it
    }
    merged[src] = {
      width: w,
      height: hgt,
      ...(format !== undefined ? { format } : existing?.format !== undefined ? { format: existing.format } : {}),
      ...(alt !== undefined ? { alt } : existing?.alt !== undefined ? { alt: existing.alt } : {}),
      ...(caption !== undefined
        ? { caption }
        : existing?.caption !== undefined ? { caption: existing.caption } : {}),
    };
    const override = readCaptionOverride(line);
    return override === undefined ? src : `${src} | caption-override="${escapeMeta(override)}"`;
  });
  return { bodyMarkdown: normalized, images: merged };
}

/**
 * Export-time inverse of `normalizeGalleryFences`: re-attach each gallery
 * photo's dimensions, alt and caption to its line so an MDX backup is
 * self-contained. Without this, "Export all" would preserve the fence text but
 * lose every gallery photo's metadata, and re-importing would produce a
 * gallery the renderer skips entirely. A stored `caption-override="…"` stays
 * on its line, last, so re-importing the backup normalizes back to the same
 * stored line.
 */
export async function galleryFencesToMdx(
  bodyMarkdown: string,
  images: Record<string, ImageMeta>,
): Promise<string> {
  return rewriteFences(bodyMarkdown, (line) => {
    const fields = line.split('|').map((f) => f.trim());
    // Anything beyond a gallery-local caption means the line already carries
    // its metadata (an unresolvable line the normalizer kept verbatim).
    if (fields.slice(1).some((f) => !CAPTION_OVERRIDE_FIELD_RE.test(f))) return line;
    const src = fields[0] ?? '';
    const meta = images[src];
    if (!meta) return line;
    const parts = [src, `${meta.width}x${meta.height}`];
    if (meta.format === 'jpeg') parts.push('format="jpeg"');
    if (meta.alt != null) parts.push(`alt="${escapeMeta(meta.alt)}"`);
    if (meta.caption != null) parts.push(`caption="${escapeMeta(meta.caption)}"`);
    const override = readCaptionOverride(line);
    if (override !== undefined) parts.push(`caption-override="${escapeMeta(override)}"`);
    return parts.join(' | ');
  });
}
