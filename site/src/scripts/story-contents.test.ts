// @vitest-environment happy-dom
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
