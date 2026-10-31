// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStoryContents } from './story-contents';

function mount(href = '#%C3%BCber-den-fluss', rail?: { matches: boolean }): {
  contents: HTMLDetailsElement;
  anchor: HTMLAnchorElement;
  heading: HTMLHeadingElement;
  summary: HTMLElement;
} {
  document.body.innerHTML = `
    <div class="story-reading">
      <details id="story-contents" open>
        <summary>Contents</summary>
        <nav><a href="${href}"><span>Über den Fluss</span></a></nav>
      </details>
      <article class="story-body"><h2 id="über-den-fluss">Über den Fluss</h2></article>
    </div>`;
  const contents = document.querySelector<HTMLDetailsElement>('details')!;
  initStoryContents(contents, rail);
  return {
    contents,
    anchor: document.querySelector<HTMLAnchorElement>('a')!,
    heading: document.querySelector<HTMLHeadingElement>('h2')!,
    summary: document.querySelector<HTMLElement>('summary')!,
  };
}

function activate(target: Element, options: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...options });
  target.dispatchEvent(event);
  return event;
}

// Execute the actual synchronous page script, rather than a second implementation
// of its disclosure behavior. The media-query fixture emits browser boundary
// changes; ordinary resizes do not emit a MediaQueryList change.
const storyPage = readFileSync(resolve(process.cwd(), 'src/components/pages/StoryPage.astro'), 'utf8');
const disclosureScript = storyPage.match(/<script is:inline>([\s\S]*?)<\/script>/)?.[1];
if (!disclosureScript) throw new Error('StoryPage disclosure script not found');
const initializeDisclosures = new Function('document', 'matchMedia', disclosureScript);

function mountRail(matches: boolean) {
  const rail = Object.assign(new EventTarget(), { matches });
  const fixture = mount(undefined, rail);
  const stack = document.createElement('div');
  stack.className = 'story-rail__stack';
  const facts = document.createElement('details');
  facts.innerHTML = '<summary>Key facts</summary><p>Three days</p>';
  const map = document.createElement('details');
  map.innerHTML = '<summary>Route map</summary>';
  stack.append(fixture.contents, facts, map);
  document.querySelector('.story-reading')!.prepend(stack);
  initializeDisclosures(document, () => rail);
  return {
    ...fixture,
    disclosures: [fixture.contents, facts, map],
    crossBoundary(matches: boolean) {
      if (rail.matches === matches) return;
      rail.matches = matches;
      rail.dispatchEvent(Object.assign(new Event('change'), { matches }));
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('story contents navigation', () => {
  it('closes and focuses an encoded heading without taking over native fragment navigation', () => {
    const { contents, anchor, heading, summary } = mount();
    anchor.focus();
    // Keyboard activation emits click with detail 0; nested text remains a link target.
    const event = activate(anchor.querySelector('span')!, { detail: 0 });
    expect(contents.open).toBe(false);
    expect(document.activeElement).toBe(heading);
    expect(event.defaultPrevented).toBe(false);
    summary.focus();
    expect(heading.hasAttribute('tabindex')).toBe(false);
  });

  it('keeps the disclosure and focus usable when a fragment has no destination', () => {
    const { contents, anchor } = mount('#missing');
    anchor.focus();
    const event = activate(anchor);
    expect(contents.open).toBe(true);
    expect(document.activeElement).toBe(anchor);
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves modified activation to the browser without moving focus', () => {
    const { contents, anchor } = mount();
    anchor.focus();
    const event = activate(anchor, { metaKey: true });
    expect(contents.open).toBe(true);
    expect(document.activeElement).toBe(anchor);
    expect(event.defaultPrevented).toBe(false);
  });

  it('lets Escape return from the open section list to its summary', () => {
    const { contents, anchor, summary } = mount();
    anchor.focus();
    anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(contents.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it('keeps the rail list open on a section link and ignores Escape there', () => {
    const { contents, anchor, heading } = mount(undefined, { matches: true });
    anchor.focus();
    const event = activate(anchor);
    expect(contents.open).toBe(true);
    expect(document.activeElement).toBe(heading);
    expect(event.defaultPrevented).toBe(false);
    anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(contents.open).toBe(true);
  });
});

describe('story rail responsive disclosures', () => {
  it('opens synchronously on desktop, closes on leaving the rail, and reopens on return', () => {
    const { disclosures, crossBoundary } = mountRail(true);
    expect(disclosures.map((details) => details.open)).toEqual([true, true, true]);
    crossBoundary(false);
    expect(disclosures.map((details) => details.open)).toEqual([false, false, false]);
    crossBoundary(true);
    expect(disclosures.map((details) => details.open)).toEqual([true, true, true]);
  });

  it('starts collapsed on narrow screens and opens every disclosure on entering the rail', () => {
    const { disclosures, crossBoundary } = mountRail(false);
    expect(disclosures.map((details) => details.open)).toEqual([false, false, false]);
    crossBoundary(true);
    expect(disclosures.map((details) => details.open)).toEqual([true, true, true]);
  });

  it('preserves manual toggles and ordinary resizes until the layout boundary changes', () => {
    const { disclosures, crossBoundary } = mountRail(true);
    disclosures[0]!.open = false;
    disclosures[1]!.open = false;
    window.dispatchEvent(new Event('resize'));
    expect(disclosures.map((details) => details.open)).toEqual([false, false, true]);

    crossBoundary(false);
    disclosures[0]!.open = true;
    disclosures[2]!.open = true;
    window.dispatchEvent(new Event('resize'));
    expect(disclosures.map((details) => details.open)).toEqual([true, false, true]);
    crossBoundary(true);
    expect(disclosures.map((details) => details.open)).toEqual([true, true, true]);
  });

  it('keeps section focus and Escape behavior aligned with the current layout after crossings', () => {
    const { contents, anchor, heading, summary, crossBoundary } = mountRail(true);
    crossBoundary(false);
    contents.open = true;
    anchor.focus();
    expect(activate(anchor).defaultPrevented).toBe(false);
    expect(contents.open).toBe(false);
    expect(document.activeElement).toBe(heading);
    contents.open = true;
    anchor.focus();
    anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(contents.open).toBe(false);
    expect(document.activeElement).toBe(summary);

    crossBoundary(true);
    anchor.focus();
    expect(activate(anchor).defaultPrevented).toBe(false);
    expect(contents.open).toBe(true);
    expect(document.activeElement).toBe(heading);
    anchor.focus();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    anchor.dispatchEvent(escape);
    expect(contents.open).toBe(true);
    expect(document.activeElement).toBe(anchor);
    expect(escape.defaultPrevented).toBe(false);
  });
});
