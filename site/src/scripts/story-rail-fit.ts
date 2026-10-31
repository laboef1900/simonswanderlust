/** Stick only when the complete rail fits, without introducing an inner scroll area. */
export function initStoryRailFit(rail: HTMLElement): () => void {
  // Without height observation, leave the CSS's nonsticky fallback in place.
  if (typeof ResizeObserver === 'undefined') return () => {};

  const update = (): void => {
    const style = getComputedStyle(rail);
    const top = Number.parseFloat(style.top);
    const height = rail.getBoundingClientRect().height;
    rail.toggleAttribute('data-sticky-fit',
      style.display !== 'contents' && height > 0 && Number.isFinite(top) &&
      top >= 0 && height + top <= window.innerHeight,
    );
  };
  const observer = new ResizeObserver(update);
  // Border-box observation also catches disclosure, font and lazy-map changes.
  observer.observe(rail, { box: 'border-box' });
  window.addEventListener('resize', update);
  update();

  return () => {
    observer.disconnect();
    window.removeEventListener('resize', update);
    rail.removeAttribute('data-sticky-fit');
  };
}
