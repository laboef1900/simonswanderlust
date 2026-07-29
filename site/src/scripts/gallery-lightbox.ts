import './gallery-lightbox.css';

/**
 * Gallery island: a lightbox for every layout mode, plus the slider's optional
 * prev/next controls.
 *
 * @ai-context docs/superpowers/specs/2026-07-29-gallery-layout-modes-and-lightbox-design.md
 *
 * @ai-warning This script must NEVER touch the gallery's layout — no measuring,
 * no width/height writes, no class toggling that affects flow. The whole point
 * of computing rows at build time is that the page is correctly laid out before
 * any JavaScript (or any image byte) arrives; a single layout write here brings
 * CLS back. The slider buttons are absolutely positioned and only ever have
 * their `hidden` attribute flipped, which is deliberate for the same reason.
 *
 * Everything degrades: each photo is a real `<a>` to its largest variant, so
 * with JavaScript off clicking opens the full-resolution image, and the slider
 * track scrolls by keyboard and touch on its own.
 */

/** Strings from `site/src/i18n/ui.ts`, passed in via data attributes. */
export interface GalleryLabels {
  /** Accessible name for the slider's scroll track. */
  slider: string;
  /** Accessible name for the lightbox dialog. */
  viewer: string;
  close: string;
  prev: string;
  next: string;
  /** Template containing `{current}` and `{total}`. */
  position: string;
}

interface Slide {
  href: string;
  alt: string;
  caption: string;
  width: number;
  height: number;
  /** `[type, srcset]` pairs lifted off the item's <picture>, best format first. */
  sources: [string, string][];
  fallback: string;
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** Read one gallery's photos straight back out of the rendered markup. */
function slidesOf(gallery: Element): Slide[] {
  const slides: Slide[] = [];
  for (const item of gallery.querySelectorAll('.jgal__item')) {
    const anchor = item.querySelector('a');
    const img = item.querySelector('img');
    if (!anchor || !img) continue;
    const sources: [string, string][] = [];
    for (const source of item.querySelectorAll('source')) {
      const type = source.getAttribute('type');
      const srcset = source.getAttribute('srcset');
      if (type && srcset) sources.push([type, srcset]);
    }
    slides.push({
      // `href` is the build-time largest-variant URL, which passed
      // body-images.ts's origin allow-list before it was ever written. Reading
      // it back is not a new trust decision — but it is also why nothing here
      // may synthesise a URL from user text.
      href: anchor.getAttribute('href') ?? '',
      alt: img.getAttribute('alt') ?? '',
      caption: item.querySelector('.jgal__cap')?.textContent ?? '',
      width: Number(img.getAttribute('width')) || 0,
      height: Number(img.getAttribute('height')) || 0,
      sources,
      fallback: img.getAttribute('src') ?? '',
    });
  }
  return slides;
}

interface Lightbox {
  open(slides: Slide[], index: number): void;
}

function createLightbox(labels: GalleryLabels): Lightbox | null {
  const dialog = document.createElement('dialog');
  if (typeof dialog.showModal !== 'function') return null; // links still work

  dialog.className = 'jgal__lb';
  dialog.setAttribute('aria-label', labels.viewer);

  const figure = document.createElement('figure');
  figure.className = 'jgal__lb-fig';
  const frame = document.createElement('div');
  const caption = document.createElement('figcaption');
  caption.className = 'jgal__lb-cap';
  figure.append(frame, caption);

  const button = (cls: string, label: string, glyph: string) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `jgal__lb-btn ${cls}`;
    el.setAttribute('aria-label', label);
    el.textContent = glyph;
    return el;
  };
  const close = button('jgal__lb-close', labels.close, '✕');
  const prev = button('jgal__lb-prev', labels.prev, '‹');
  const next = button('jgal__lb-next', labels.next, '›');

  const live = document.createElement('p');
  live.className = 'jgal__lb-live';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');

  dialog.append(figure, close, prev, next, live);
  document.body.append(dialog);

  let slides: Slide[] = [];
  let index = 0;

  function show(to: number): void {
    index = Math.max(0, Math.min(slides.length - 1, to));
    const slide = slides[index];
    if (!slide) return;

    // Rebuilt rather than mutated: changing a <source>'s srcset in place does
    // not reliably re-run the browser's format selection.
    const picture = document.createElement('picture');
    for (const [type, srcset] of slide.sources) {
      const source = document.createElement('source');
      source.type = type;
      source.srcset = srcset;
      source.sizes = '100vw';
      picture.append(source);
    }
    const img = document.createElement('img');
    img.className = 'jgal__lb-img';
    img.src = slide.fallback;
    img.alt = slide.alt;
    if (slide.width && slide.height) {
      img.width = slide.width;
      img.height = slide.height;
    }
    picture.append(img);
    frame.replaceChildren(picture);

    caption.textContent = slide.caption;
    caption.hidden = slide.caption === '';
    live.textContent = fill(labels.position, {
      current: String(index + 1),
      total: String(slides.length),
    });
    // Clamped rather than wrapping, so the announced position never lies about
    // where the end is.
    prev.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    const single = slides.length < 2;
    prev.hidden = single;
    next.hidden = single;
  }

  close.addEventListener('click', () => dialog.close());
  prev.addEventListener('click', () => show(index - 1));
  next.addEventListener('click', () => show(index + 1));

  // Backdrop click. The dialog fills the viewport, so "outside the figure" is
  // the honest test — comparing against the dialog itself would never fire.
  dialog.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest('.jgal__lb-fig, .jgal__lb-btn')) dialog.close();
  });

  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') show(index + 1);
    else if (event.key === 'ArrowLeft') show(index - 1);
    else if (event.key === 'Home') show(0);
    else if (event.key === 'End') show(slides.length - 1);
    else return;
    event.preventDefault();
  });

  // Free the decoded image when the dialog closes — Esc and the close button
  // both land here, and <dialog> restores focus on its own.
  dialog.addEventListener('close', () => frame.replaceChildren());

  return {
    open(items, at) {
      slides = items;
      show(at);
      dialog.showModal();
      close.focus();
    },
  };
}

/** Reveal and wire the slider's prev/next buttons; the track already scrolls. */
function initSlider(gallery: Element, labels: GalleryLabels): void {
  const track = gallery.querySelector<HTMLElement>('.jgal__track');
  const prev = gallery.querySelector<HTMLButtonElement>('[data-jgal-nav="prev"]');
  const next = gallery.querySelector<HTMLButtonElement>('[data-jgal-nav="next"]');
  if (!track) return;

  // The name is added here, not at build time: body-images.ts renders the same
  // markup for both locales and has no way to know which one it is in.
  track.setAttribute('role', 'group');
  track.setAttribute('aria-label', labels.slider);
  if (!prev || !next) return;

  prev.setAttribute('aria-label', labels.prev);
  next.setAttribute('aria-label', labels.next);

  const page = (direction: 1 | -1) =>
    track.scrollBy({
      left: direction * track.clientWidth * 0.9,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });

  const sync = () => {
    // 2px of slack: fractional scroll widths otherwise leave "next" enabled at
    // the very end forever.
    prev.disabled = track.scrollLeft <= 2;
    next.disabled = track.scrollLeft >= track.scrollWidth - track.clientWidth - 2;
  };

  prev.addEventListener('click', () => page(-1));
  next.addEventListener('click', () => page(1));
  track.addEventListener('scroll', sync, { passive: true });

  // Only now do the buttons exist for the user: with JS off they stay hidden
  // rather than sitting there inert.
  prev.hidden = false;
  next.hidden = false;
  sync();
}

/**
 * Wire every gallery under `root`. No-ops when the page has none, which is the
 * common case — this island loads on every story and page.
 */
export function initGalleries(root: ParentNode, labels: GalleryLabels): void {
  const galleries = [...root.querySelectorAll('.jgal')];
  if (galleries.length === 0) return;

  let lightbox: Lightbox | null | undefined;
  const ensureLightbox = () => {
    if (lightbox === undefined) lightbox = createLightbox(labels);
    return lightbox;
  };

  for (const gallery of galleries) {
    if (gallery.classList.contains('jgal--slider')) initSlider(gallery, labels);

    gallery.addEventListener('click', (event) => {
      const mouse = event as MouseEvent;
      // Leave every "open elsewhere" gesture alone — the anchor is a real link
      // and must keep behaving like one.
      if (mouse.button !== 0 || mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.altKey) return;
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.jgal__item a')) return;
      const item = event.target.closest('.jgal__item');
      // By POSITION, not by href — the same photo may legitimately appear
      // twice in one gallery, and matching on URL would always open the first.
      const index = item ? [...gallery.querySelectorAll('.jgal__item')].indexOf(item) : -1;
      const slides = slidesOf(gallery);
      const box = ensureLightbox();
      if (!box || index < 0) return; // no <dialog> support ⇒ follow the link
      event.preventDefault();
      box.open(slides, index);
    });
  }
}
