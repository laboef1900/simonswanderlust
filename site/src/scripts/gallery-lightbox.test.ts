// @vitest-environment happy-dom
//
// The only DOM-environment suite in either tree — every other browser-code test
// here runs pure logic in a `vm` sandbox (posts-filter.js, gallery-fence.js).
// That precedent does not stretch to this island: what needs locking down IS
// the DOM behaviour — which keys move the lightbox, when a control is disabled,
// that revealing the slider buttons never writes layout, and that a
// modifier-click still follows the link. happy-dom implements <dialog>
// including showModal/close and focus, which is what makes this testable at all.
import { beforeEach, describe, expect, it } from 'vitest';
import { initGalleries, type GalleryLabels } from './gallery-lightbox.js';

const labels: GalleryLabels = {
  slider: 'Photo gallery, scrolls horizontally',
  viewer: 'Photo viewer',
  close: 'Close',
  prev: 'Previous photo',
  next: 'Next photo',
  position: 'Photo {current} of {total}',
};

const item = (n: number, caption = '') => `
  <figure class="jgal__item" style="--r:1.5000">
    <a href="https://img.test/p${n}-3000.webp">
      <picture>
        <source type="image/avif" srcset="https://img.test/p${n}-640.avif 640w">
        <source type="image/webp" srcset="https://img.test/p${n}-640.webp 640w">
        <img src="https://img.test/p${n}-1280.webp" alt="photo ${n}" width="3000" height="2000">
      </picture>
    </a>
    ${caption ? `<figcaption class="jgal__cap">${caption}</figcaption>` : ''}
  </figure>`;

function mountJustified(count = 3): HTMLElement {
  document.body.innerHTML = `
    <div class="jgal jgal--breakout not-prose">
      <div class="jgal__row">
        ${Array.from({ length: count }, (_, i) => item(i, i === 0 ? 'Day one' : '')).join('')}
      </div>
    </div>`;
  return document.querySelector('.jgal') as HTMLElement;
}

function mountSlider(count = 3): HTMLElement {
  document.body.innerHTML = `
    <div class="jgal jgal--slider not-prose">
      <div class="jgal__track" tabindex="0">
        ${Array.from({ length: count }, (_, i) => item(i)).join('')}
      </div>
      <button type="button" class="jgal__nav jgal__nav--prev" hidden data-jgal-nav="prev">‹</button>
      <button type="button" class="jgal__nav jgal__nav--next" hidden data-jgal-nav="next">›</button>
    </div>`;
  return document.querySelector('.jgal') as HTMLElement;
}

const dialog = () => document.querySelector<HTMLDialogElement>('dialog.jgal__lb');
const lbButton = (cls: string) => dialog()?.querySelector<HTMLButtonElement>(`.jgal__lb-${cls}`) ?? null;
const liveText = () => dialog()?.querySelector('.jgal__lb-live')?.textContent ?? '';
const shownSrc = () => dialog()?.querySelector<HTMLImageElement>('.jgal__lb-img')?.getAttribute('src') ?? '';

/** A plain primary click, the only gesture that should open the lightbox. */
function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(event);
  return event;
}

function press(key: string): void {
  dialog()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

const photos = () => [...document.querySelectorAll<HTMLAnchorElement>('.jgal__item a')];

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('initGalleries — degradation and inertness', () => {
  it('does nothing at all on a page with no gallery', () => {
    document.body.innerHTML = '<article><p>Just prose.</p></article>';
    initGalleries(document, labels);
    expect(dialog()).toBeNull();
  });

  it('creates no dialog until a photo is actually clicked', () => {
    mountJustified();
    initGalleries(document, labels);
    expect(dialog()).toBeNull();
  });

  it('leaves the anchors as real links for modifier and middle clicks', () => {
    mountJustified();
    initGalleries(document, labels);
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      const event = click(photos()[0]!, init);
      expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(dialog()).toBeNull();
  });
});

describe('initGalleries — lightbox', () => {
  it('opens on the clicked photo and suppresses the navigation', () => {
    mountJustified(3);
    initGalleries(document, labels);
    const event = click(photos()[1]!);
    expect(event.defaultPrevented).toBe(true);
    expect(dialog()?.open).toBe(true);
    expect(shownSrc()).toBe('https://img.test/p1-1280.webp');
    expect(liveText()).toBe('Photo 2 of 3');
  });

  it('carries alt and caption across, and hides an empty caption', () => {
    mountJustified(3);
    initGalleries(document, labels);
    click(photos()[0]!);
    expect(dialog()?.querySelector('.jgal__lb-img')?.getAttribute('alt')).toBe('photo 0');
    expect(dialog()?.querySelector('.jgal__lb-cap')?.textContent).toBe('Day one');
    click(lbButton('next')!);
    expect((dialog()?.querySelector('.jgal__lb-cap') as HTMLElement).hidden).toBe(true);
  });

  it('offers every source format the item had, so the lightbox is not webp-only', () => {
    mountJustified(1);
    initGalleries(document, labels);
    click(photos()[0]!);
    const types = [...(dialog()?.querySelectorAll('source') ?? [])].map((s) => s.getAttribute('type'));
    expect(types).toEqual(['image/avif', 'image/webp']);
  });

  it('moves the lightbox with the arrow keys and Home/End', () => {
    mountJustified(4);
    initGalleries(document, labels);
    click(photos()[0]!);
    press('ArrowRight');
    expect(liveText()).toBe('Photo 2 of 4');
    press('End');
    expect(liveText()).toBe('Photo 4 of 4');
    press('ArrowLeft');
    expect(liveText()).toBe('Photo 3 of 4');
    press('Home');
    expect(liveText()).toBe('Photo 1 of 4');
  });

  it('clamps at both ends rather than wrapping, and says so on the controls', () => {
    mountJustified(2);
    initGalleries(document, labels);
    click(photos()[0]!);
    expect(lbButton('prev')?.disabled).toBe(true);
    press('ArrowLeft');
    expect(liveText()).toBe('Photo 1 of 2'); // no wrap to the last photo
    press('ArrowRight');
    expect(lbButton('next')?.disabled).toBe(true);
    press('ArrowRight');
    expect(liveText()).toBe('Photo 2 of 2');
  });

  it('hides both arrows for a one-photo gallery', () => {
    mountJustified(1);
    initGalleries(document, labels);
    click(photos()[0]!);
    expect(lbButton('prev')?.hidden).toBe(true);
    expect(lbButton('next')?.hidden).toBe(true);
  });

  it('names the dialog and its controls from the passed-in strings', () => {
    mountJustified(2);
    initGalleries(document, labels);
    click(photos()[0]!);
    expect(dialog()?.getAttribute('aria-label')).toBe('Photo viewer');
    expect(lbButton('close')?.getAttribute('aria-label')).toBe('Close');
    expect(lbButton('prev')?.getAttribute('aria-label')).toBe('Previous photo');
    expect(lbButton('next')?.getAttribute('aria-label')).toBe('Next photo');
    expect(dialog()?.querySelector('.jgal__lb-live')?.getAttribute('aria-live')).toBe('polite');
  });

  it('puts focus inside the dialog on open', () => {
    mountJustified(2);
    initGalleries(document, labels);
    click(photos()[0]!);
    expect(document.activeElement).toBe(lbButton('close'));
  });

  it('closes on the close button and on a backdrop click, but not on the figure', () => {
    mountJustified(2);
    initGalleries(document, labels);
    click(photos()[0]!);
    click(dialog()!.querySelector('.jgal__lb-fig')!);
    expect(dialog()?.open).toBe(true);
    click(dialog()!);
    expect(dialog()?.open).toBe(false);
    click(photos()[0]!);
    click(lbButton('close')!);
    expect(dialog()?.open).toBe(false);
  });

  it('opens the right photo when the same one appears twice in a gallery', () => {
    // Matching on href would always reopen the first copy.
    document.body.innerHTML = `
      <div class="jgal jgal--breakout not-prose"><div class="jgal__row">
        ${item(0)}${item(1)}${item(0)}
      </div></div>`;
    initGalleries(document, labels);
    click(photos()[2]!);
    expect(liveText()).toBe('Photo 3 of 3');
  });

  it('reuses one dialog across several galleries on the same page', () => {
    document.body.innerHTML = `
      <div class="jgal jgal--breakout"><div class="jgal__row">${item(0)}</div></div>
      <div class="jgal jgal--column"><div class="jgal__row">${item(1)}${item(2)}</div></div>`;
    initGalleries(document, labels);
    click(photos()[0]!);
    click(document.querySelector('.jgal__lb-close')!);
    click(photos()[2]!);
    expect(document.querySelectorAll('dialog.jgal__lb')).toHaveLength(1);
    expect(liveText()).toBe('Photo 2 of 2'); // scoped to the second gallery
  });
});

describe('initGalleries — slider controls', () => {
  it('names the track and reveals the buttons only once JS has wired them', () => {
    const gallery = mountSlider(5);
    const prev = gallery.querySelector<HTMLButtonElement>('[data-jgal-nav="prev"]')!;
    const next = gallery.querySelector<HTMLButtonElement>('[data-jgal-nav="next"]')!;
    expect(prev.hidden).toBe(true); // as shipped: an inert button would be a lie

    initGalleries(document, labels);

    const track = gallery.querySelector('.jgal__track')!;
    expect(track.getAttribute('role')).toBe('group');
    expect(track.getAttribute('aria-label')).toBe('Photo gallery, scrolls horizontally');
    expect(track.getAttribute('tabindex')).toBe('0'); // keyboard-scrollable without JS
    expect(prev.hidden).toBe(false);
    expect(next.hidden).toBe(false);
    expect(prev.getAttribute('aria-label')).toBe('Previous photo');
  });

  it('disables "previous" at the start of the track', () => {
    const gallery = mountSlider(5);
    initGalleries(document, labels);
    expect(gallery.querySelector<HTMLButtonElement>('[data-jgal-nav="prev"]')!.disabled).toBe(true);
  });

  it('never writes to the layout — no inline sizing on the gallery or its items', () => {
    // The build-time layout is the layout; a single width/height write here
    // brings CLS back. The only inline style allowed is the --r the renderer
    // emitted.
    const gallery = mountSlider(4);
    const before = [...gallery.querySelectorAll<HTMLElement>('*')].map((el) => el.getAttribute('style'));
    initGalleries(document, labels);
    const after = [...gallery.querySelectorAll<HTMLElement>('*')].map((el) => el.getAttribute('style'));
    expect(after).toEqual(before);
  });

  it('still opens the lightbox from a slider tile', () => {
    mountSlider(3);
    initGalleries(document, labels);
    click(photos()[2]!);
    expect(dialog()?.open).toBe(true);
    expect(liveText()).toBe('Photo 3 of 3');
  });
});
