/* Explicit searches only: never send place names while the author is typing. */
(function (root) {
  'use strict';

  function attach({ row, nameInput, latInput, lngInput, copy, onChange, onUnauthed }) {
    const mount = document.createElement('div');
    mount.className = 'stop-lookup';
    const search = document.createElement('button');
    search.type = 'button';
    search.className = 'btn-secondary stop-search';
    search.textContent = copy.search;
    const status = document.createElement('p');
    status.className = 'muted stop-search-status';
    status.setAttribute('role', 'status');
    const results = document.createElement('div');
    results.className = 'stop-search-results';
    mount.appendChild(search);
    mount.appendChild(status);
    mount.appendChild(results);
    row.appendChild(mount);

    let generation = 0;
    let controller;
    let disposed = false;
    function invalidate() {
      generation += 1;
      controller?.abort();
      controller = undefined;
      results.replaceChildren();
      status.textContent = '';
      search.disabled = false;
      search.textContent = copy.search;
    }
    [nameInput, latInput, lngInput].forEach((input) => input.addEventListener('input', invalidate));

    async function lookup() {
      if (disposed || search.disabled) return;
      invalidate();
      const query = nameInput.value.trim();
      if (query.length < 2 || query.length > 200 || /[\p{C}]/u.test(query)) {
        status.textContent = copy.enterName;
        nameInput.focus();
        return;
      }
      const version = generation;
      const pending = new AbortController();
      controller = pending;
      const timeout = setTimeout(() => pending.abort(), 12000);
      search.disabled = true;
      search.textContent = copy.searching;
      status.textContent = copy.searching;
      try {
        const response = await fetch('/geocode', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query }), signal: pending.signal, cache: 'no-store',
        });
        if (version !== generation || disposed) return;
        if (response.status === 401) { onUnauthed(); return; }
        if (!response.ok) {
          status.textContent = response.status === 429 ? copy.busy
            : response.status === 503 ? copy.disabled : copy.failed;
          return;
        }
        const data = await response.json();
        if (version !== generation || disposed) return;
        if (!Array.isArray(data.results)) throw new Error('Invalid locations');
        status.textContent = data.results.length ? copy.choose : copy.empty;
        data.results.forEach((location) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn-secondary stop-search-result';
          button.textContent = location.label;
          button.addEventListener('click', () => {
            if (version !== generation || disposed) return;
            latInput.value = String(location.lat);
            lngInput.value = String(location.lng);
            invalidate();
            status.textContent = copy.selected;
            latInput.focus();
            onChange();
          });
          results.appendChild(button);
        });
      } catch {
        if (version === generation && !disposed) status.textContent = copy.failed;
      } finally {
        clearTimeout(timeout);
        if (version === generation && !disposed) {
          controller = undefined;
          search.disabled = false;
          search.textContent = copy.search;
        }
      }
    }
    search.addEventListener('click', lookup);
    nameInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      lookup();
    });
    return function dispose() { invalidate(); disposed = true; };
  }

  root.WaypointLookup = { attach };
})(typeof window !== 'undefined' ? window : globalThis);
