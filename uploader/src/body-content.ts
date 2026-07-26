/**
 * Body-markdown normalization and `images`-map validation shared by posts and
 * pages. Both content types store the same shape — a Markdown body plus an
 * `images` map keyed by image URL — and both must apply the same rules, so the
 * rules live here rather than being duplicated (and drifting) in `posts.ts`
 * and `pages.ts`.
 *
 * @ai-context docs/superpowers/specs/2026-07-26-media-library-and-galleries-design.md
 *   (§Galleries) — issue #65.
 */

/**
 * One `images` entry: intrinsic dimensions plus the optional per-locale alt and
 * caption a gallery renders. DE and EN are separate rows, so "per-locale"
 * needs no extra schema — the DE row carries German text, the EN row English.
 *
 * @ai-warning `site/src/lib/body-images.ts` declares this shape independently
 * (it is a different tree with its own tsconfig). Widen both together: because
 * the extra fields are optional, `tsc` and `astro check` stay green when only
 * one side is widened, and the symptom is galleries rendering with empty alt
 * and no captions on a green build.
 */
export interface ImageMeta { width: number; height: number; alt?: string; caption?: string }

/** Longest alt/caption accepted — these end up in every gallery's HTML. */
const MAX_TEXT = 1000;

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
 * Escape a gallery-line alt/caption value. Extends export.ts's existing
 * `& " < >` rule with the two characters this one-line-per-photo format adds:
 * `|` is the field separator and a newline would end the line. `unescapeMeta`
 * is the exact inverse.
 */
export function escapeMeta(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;')
    .replace(/\r?\n/g, '&#10;');
}

/** Inverse of escapeMeta — `&amp;` last, so `&amp;quot;` round-trips to `&quot;`. */
export function unescapeMeta(s: string): string {
  return s
    .replace(/&#10;/g, '\n')
    .replace(/&#124;/g, '|')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * A ```gallery fenced block. Only column-0 backtick fences are matched — that
 * is what the editor and `export.ts` produce, and being conservative here
 * means an indented example inside a post about galleries is left alone.
 */
const GALLERY_FENCE_RE = /^((`{3,})gallery[ \t]*\r?\n)([\s\S]*?)(^\2[ \t\r]*$)/gm;

/** A line is a comment/spacer when blank or `#`-prefixed (spec §Body encoding). */
function isSkippableLine(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** Apply `rewriteLine` to every photo line of every ```gallery fence. */
function rewriteFences(body: string, rewriteLine: (line: string) => string): string {
  return body.replace(
    GALLERY_FENCE_RE,
    (_match, open: string, _fence: string, inner: string, close: string) => {
      const rewritten = inner
        .split('\n')
        .map((line) => (isSkippableLine(line) ? line : rewriteLine(line)))
        .join('\n');
      return `${open}${rewritten}${close}`;
    },
  );
}

const DIMS_RE = /^(\d{1,6})x(\d{1,6})$/;
const ATTR_RE = /^(alt|caption)="([^"]*)"$/;

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
 */
export function normalizeGalleryFences(
  bodyMarkdown: string,
  images: Record<string, ImageMeta>,
): { bodyMarkdown: string; images: Record<string, ImageMeta> } {
  const merged: Record<string, ImageMeta> = { ...images };
  const normalized = rewriteFences(bodyMarkdown, (line) => {
    const fields = line.split('|').map((f) => f.trim());
    const src = fields[0] ?? '';
    if (src === '') return line;
    if (fields.length === 1) return line; // already normalized — nothing to lift
    let width: number | undefined;
    let height: number | undefined;
    let alt: string | undefined;
    let caption: string | undefined;
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
        else caption = value;
      }
    }
    const existing = merged[src];
    const w = width ?? existing?.width ?? 0;
    const hgt = height ?? existing?.height ?? 0;
    if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(hgt) || hgt <= 0) {
      return line; // unresolvable — keep the author's text rather than losing it
    }
    merged[src] = {
      width: w,
      height: hgt,
      ...(alt !== undefined ? { alt } : existing?.alt !== undefined ? { alt: existing.alt } : {}),
      ...(caption !== undefined
        ? { caption }
        : existing?.caption !== undefined ? { caption: existing.caption } : {}),
    };
    return src;
  });
  return { bodyMarkdown: normalized, images: merged };
}

/**
 * Export-time inverse of `normalizeGalleryFences`: re-attach each gallery
 * photo's dimensions, alt and caption to its line so an MDX backup is
 * self-contained. Without this, "Export all" would preserve the fence text but
 * lose every gallery photo's metadata, and re-importing would produce a
 * gallery the renderer skips entirely.
 */
export function galleryFencesToMdx(
  bodyMarkdown: string,
  images: Record<string, ImageMeta>,
): string {
  return rewriteFences(bodyMarkdown, (line) => {
    if (line.includes('|')) return line; // already carries metadata
    const src = line.trim();
    const meta = images[src];
    if (!meta) return line;
    const parts = [src, `${meta.width}x${meta.height}`];
    if (meta.alt) parts.push(`alt="${escapeMeta(meta.alt)}"`);
    if (meta.caption) parts.push(`caption="${escapeMeta(meta.caption)}"`);
    return parts.join(' | ');
  });
}
