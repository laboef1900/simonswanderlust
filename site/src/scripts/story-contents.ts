/**
 * Close before native fragment navigation, preserving browser history and no-JS links.
 *
 * `rail` reports whether the list is laid out as the story rail (open beside
 * the article, ≥ lg) rather than the sticky strip above it. In the rail a
 * section link must NOT collapse the list — it is the page's table of
 * contents, not a menu — and Escape has nothing to dismiss. A live
 * `MediaQueryList` fits; tests pass `{ matches }`.
 */
export function initStoryContents(contents: HTMLDetailsElement, rail?: { matches: boolean }): void {
  contents.addEventListener('click', (event) => {
    if (
      event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    ) return;

    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    const href = anchor?.getAttribute('href');
    if (!href?.startsWith('#')) return;

    let id: string;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      return;
    }
    const target = contents.ownerDocument.getElementById(id);
    if (!target || !target.closest('.story-body')) return;

    if (!rail?.matches) contents.open = false;
    // Headings need a temporary focus stop, not a place in the page's tab order.
    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
    }
    target.focus({ preventScroll: true });
    // Do not preventDefault: the browser resolves the fragment and scrolls after
    // closing has settled layout, including repeated clicks on the same hash.
  });

  contents.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !contents.open || rail?.matches) return;
    contents.open = false;
    contents.querySelector('summary')?.focus();
    event.preventDefault();
  });
}
