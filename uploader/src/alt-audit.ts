/**
 * The alt-text audit: which of a stored post's photos have no useful
 * description, or carry the WordPress attachment filename instead.
 *
 * @ai-warning This is a WARNING, never a gate. It is deliberately NOT part of
 * `validateForPublish` and shares nothing with `publish-gate.ts`'s 409 paths:
 * every WordPress-imported post stores the post title as its hero alt, so a
 * refusal here would strand the whole imported corpus. A post with zero
 * described photos MUST still publish.
 *
 * @ai-warning The empty/title-repeat part of the rule MUST stay behaviourally
 * identical to `heroAltOf` in `site/src/lib/trips.ts`. At render time an alt
 * that only repeats the title is emitted as `alt=""` (decorative), because the
 * heading beside the photo already says those words; an empty alt is `alt=""`
 * in the first place. Filename-like text is an audit-only editorial warning:
 * it renders verbatim, but describes file provenance rather than the photo.
 * The two trees have separate tsconfigs and cannot share the code, so changes
 * to the shared empty/title-repeat rule MUST be made in both.
 */
import { rewriteFences, unescapeAltText } from './body-content.js';
import { markdownImages } from './wp-content.js';
import type { Locale, PostLocale, PostPair } from './posts.js';

/** Where the photo sits in the post — the author fixes each in a different place. */
export type AltImageKind = 'hero' | 'body' | 'gallery';
/** Why the alt needs editorial attention. This audit warns; it never gates Publish. */
export type AltIssueReason = 'empty' | 'repeats-title' | 'filename';

export interface UndescribedImage {
  locale: Locale;
  kind: AltImageKind;
  /** The hero's `src`, or the `images`-map key of a body/gallery photo. */
  src: string;
  reason: AltIssueReason;
}

export interface AltAudit {
  count: number;
  images: UndescribedImage[];
}

/**
 * The rule, in one place: trimmed-empty, the locale's own title again, or the
 * WordPress attachment-title pattern `Name - d.m.yyyy hhmmss`.
 *
 * Case-insensitive on purpose for title repetition — "RHODOS" over a post
 * titled "Rhodos" describes the photograph no better than the exact string
 * does. Plain `toLowerCase()`, never `toLocaleLowerCase()`: the latter follows
 * the host's default locale, so the same post would audit differently on a
 * Turkish server.
 */
function issueFor(alt: string | undefined, title: string): AltIssueReason | null {
  const a = (alt ?? '').trim();
  if (a === '') return 'empty';
  if (a.toLowerCase() === title.trim().toLowerCase()) return 'repeats-title';
  return /^.+\s-\s\d{1,2}\.\d{1,2}\.\d{4}\s+\d{6}$/.test(a) ? 'filename' : null;
}

interface BodyRef { src: string; kind: 'body' | 'gallery'; alt: string | undefined }

/**
 * Every photo the body puts on the page, with the alt text that photo actually
 * carries — which lives in a DIFFERENT place per kind, and getting that wrong
 * would report described photos as undescribed:
 *
 *  • a ```gallery line is a bare URL and its alt sits in `images[src].alt`
 *    (`normalizeGalleryFences` lifts it off the line at save time);
 *  • an inline `![alt](src)` carries its alt in the Markdown label, and its
 *    `images` entry holds only width/height.
 *
 * Both readers are the existing ones — `rewriteFences` (the scanner that
 * decides what a gallery is) and `markdownImages` (the CommonMark subset
 * Turndown can produce, issue #125) — rather than a third parser of the same
 * grammar.
 *
 * Restricted to keys the `images` map carries: that is the contract's scope,
 * and it is also what the renderer resolves — `body-images.ts` skips a gallery
 * line with no entry. A duplicate reference is reported once.
 */
function bodyRefs(l: PostLocale): BodyRef[] {
  const out: BodyRef[] = [];
  const seen = new Set<string>();
  const add = (src: string, kind: 'body' | 'gallery', alt: string | undefined): void => {
    if (src === '' || seen.has(src) || !(src in l.images)) return;
    seen.add(src);
    out.push({ src, kind, alt });
  };
  rewriteFences(l.bodyMarkdown, (line) => {
    const src = (line.split('|')[0] ?? '').trim();
    add(src, 'gallery', l.images[src]?.alt);
    return line;
  });
  for (const img of markdownImages(l.bodyMarkdown)) add(img.url, 'body', unescapeAltText(img.alt));
  return out;
}

/**
 * Pure: takes the stored pair, returns the undescribed photos of both locales
 * in a stable, author-visible order — DE before EN, each locale's hero first,
 * then its gallery photos, then its inline body photos. No store, no I/O.
 */
export function auditAltText(pair: Pick<PostPair, 'de' | 'en'>): AltAudit {
  const images: UndescribedImage[] = [];
  for (const locale of ['de', 'en'] as const) {
    const l = pair[locale];
    if (!l) continue;
    const title = l.title;
    // A locale nobody has written yet contributes nothing: the write-DE-first
    // workflow leaves EN as a blank title, a blank body and the placeholder
    // hero (`src: ''`), and warning about photos that do not exist is noise.
    if (title.trim() === '' && l.bodyMarkdown.trim() === '' && l.heroImage.src.trim() === '') continue;
    const heroSrc = l.heroImage.src.trim();
    if (heroSrc !== '') {
      const reason = issueFor(l.heroImage.alt, title);
      if (reason) images.push({ locale, kind: 'hero', src: heroSrc, reason });
    }
    for (const ref of bodyRefs(l)) {
      const reason = issueFor(ref.alt, title);
      if (reason) images.push({ locale, kind: ref.kind, src: ref.src, reason });
    }
  }
  return { count: images.length, images };
}
