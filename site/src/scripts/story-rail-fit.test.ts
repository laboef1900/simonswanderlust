// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initStoryRailFit } from './story-rail-fit';

let rail: HTMLElement;
let height: number;
let notifyResize: () => void;
let dispose: () => void;
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  document.body.innerHTML = `
    <div class="story-rail" style="display: block; top: 8px">
      <div class="story-rail__stack">
        <details open><summary>Contents</summary><a href="#section">Section</a></details>
        <details open><summary>Route</summary><button>Map control</button></details>
      </div>
    </div>`;
  rail = document.querySelector<HTMLElement>('.story-rail')!;
  height = 792;
  dispose = () => {};
  vi.clearAllMocks();
  vi.stubGlobal('innerHeight', 800);
  vi.spyOn(rail, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 288, height));
  vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      notifyResize = () => callback([], this);
    }
    observe = observe;
    disconnect = disconnect;
    unobserve = vi.fn();
  });
});

afterEach(() => {
  dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('story rail viewport fit', () => {
  it('sticks at the exact fit boundary, counting the CSS top offset', () => {
    dispose = initStoryRailFit(rail);
    expect(rail.hasAttribute('data-sticky-fit')).toBe(true);
    expect(observe).toHaveBeenCalledWith(rail, { box: 'border-box' });

    // Fractional overflow must not be rounded down to a fitting rail.
    height = 792.25;
    notifyResize();
    expect(rail.hasAttribute('data-sticky-fit')).toBe(false);
  });

  it('leaves an oversized rail in page flow with its lower controls intact', () => {
    height = 1314;
    dispose = initStoryRailFit(rail);
    expect(rail.hasAttribute('data-sticky-fit')).toBe(false);
    const control = rail.querySelector('button')!;
    control.focus();
    expect(document.activeElement).toBe(control);
    expect(rail.querySelectorAll('details[open]')).toHaveLength(2);
  });

  it('re-evaluates both ways when the viewport height changes', () => {
    dispose = initStoryRailFit(rail);
    vi.stubGlobal('innerHeight', 700);
    window.dispatchEvent(new Event('resize'));
    expect(rail.hasAttribute('data-sticky-fit')).toBe(false);
    vi.stubGlobal('innerHeight', 900);
    window.dispatchEvent(new Event('resize'));
    expect(rail.hasAttribute('data-sticky-fit')).toBe(true);
  });

  it('responds to disclosure and late content growth without a viewport resize', () => {
    height = 1000;
    dispose = initStoryRailFit(rail);
    const details = rail.querySelector('details')!;
    details.open = false;
    height = 500;
    notifyResize();
    expect(rail.hasAttribute('data-sticky-fit')).toBe(true);
    details.open = true;
    height = 1000;
    notifyResize();
    expect(rail.hasAttribute('data-sticky-fit')).toBe(false);
    height = 600;
    notifyResize();
    expect(rail.hasAttribute('data-sticky-fit')).toBe(true);
    height = 810;
    notifyResize();
    expect(rail.hasAttribute('data-sticky-fit')).toBe(false);
  });

  it('removes fit state in the narrow display-contents layout and restores it on return', () => {
    dispose = initStoryRailFit(rail);
    rail.style.display = 'contents';
    height = 0;
    window.dispatchEvent(new Event('resize'));
    expect(rail.hasAttribute('data-sticky-fit')).toBe(false);
    rail.style.display = 'block';
    rail.style.top = '16px';
    height = 790;
    window.dispatchEvent(new Event('resize'));
    expect(rail.hasAttribute('data-sticky-fit')).toBe(false);
    height = 784;
    notifyResize();
    expect(rail.hasAttribute('data-sticky-fit')).toBe(true);
  });

  it('keeps the nonsticky fallback when resize observation is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    dispose = initStoryRailFit(rail);
    window.dispatchEvent(new Event('resize'));
    expect(rail.hasAttribute('data-sticky-fit')).toBe(false);
    expect(observe).not.toHaveBeenCalled();
  });

  it('releases observation and fit state on disposal', () => {
    dispose = initStoryRailFit(rail);
    dispose();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(rail.hasAttribute('data-sticky-fit')).toBe(false);
    window.dispatchEvent(new Event('resize'));
    expect(rail.hasAttribute('data-sticky-fit')).toBe(false);
  });
});
