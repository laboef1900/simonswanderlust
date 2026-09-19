/** Close before native fragment navigation, preserving browser history and no-JS links. */
export function initStoryContents(contents: HTMLDetailsElement): void {
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
    if (!target || !target.closest('#story-body')) return;

    contents.open = false;
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
    if (event.key !== 'Escape' || !contents.open) return;
    contents.open = false;
    contents.querySelector('summary')?.focus();
    event.preventDefault();
  });
}
