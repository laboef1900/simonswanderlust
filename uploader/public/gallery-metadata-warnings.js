// Warnings belong to submitted source snapshots, never normalized response bodies.
// Navigation only reads/analyzes source; it never replaces text or touches undo.
window.GalleryMetadataWarnings = (function () {
  function label(warning, copy) {
    const reasons = { unknown_field: 'metadataUnknown', malformed_field: 'metadataMalformed',
      invalid_dimensions: 'metadataDimensions', unsupported_format: 'metadataFormat' };
    const values = { locale: warning.locale.toUpperCase(), line: warning.line, column: warning.column,
      field: warning.field === 'unknown' ? copy.metadataUnknownField : warning.field,
      reason: copy[reasons[warning.reason]] };
    return copy.metadataLocation.replace(/\{(locale|line|column|field|reason)\}/g, (_, key) => String(values[key]));
  }

  function create({ root, editors, activate, reveal, onUnauthed }) {
    const states = new Map();
    const versions = { de: 0, en: 0 };
    let navigation = 0;
    root.hidden = true;
    root.setAttribute('aria-live', 'polite');

    async function focus(warning, snapshot, status) {
      const ticket = ++navigation;
      const cm = editors[warning.locale];
      const copy = window.EditorGalleryCopy[warning.locale];
      const source = cm.getValue();
      let current = warning;
      if (source !== snapshot) {
        try {
          const analysis = await window.GalleryFence.analyze(source, { fresh: true });
          if (ticket !== navigation || cm.getValue() !== source) return;
          current = window.GalleryFence.galleryWarnings(analysis, warning.locale)
            .find((item) => item.field === warning.field && item.reason === warning.reason);
        } catch (error) {
          if (ticket !== navigation || cm.getValue() !== source) return;
          if (error?.status === 401) onUnauthed?.();
          status.textContent = copy.analysisFailed;
          return;
        }
      }
      if (!current) { status.textContent = copy.metadataCurrent; return; }
      if (ticket !== navigation || cm.getValue() !== source) return;
      activate(current.locale);
      const position = { line: current.line - 1, ch: current.column - 1 };
      reveal?.(current.locale, position.line);
      cm.setSelection(position, { line: position.line, ch: cm.getLine(position.line).length });
      cm.scrollIntoView(position, 80);
      cm.focus();
    }

    function render() {
      root.textContent = '';
      root.hidden = !Array.from(states.values()).some((state) => state.warnings.length);
      for (const [locale, state] of states) {
        if (!state.warnings.length) continue;
        const copy = window.EditorGalleryCopy[locale];
        const section = document.createElement('section');
        section.lang = locale;
        const summary = document.createElement('p');
        summary.textContent = state.saved ? copy.metadataSaved : copy.metadataAdvisory;
        section.appendChild(summary);
        const syntax = document.createElement('p');
        syntax.textContent = copy.metadataSyntax;
        section.appendChild(syntax);
        const list = document.createElement('ul');
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        for (const warning of state.warnings) {
          const item = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn-secondary';
          button.textContent = label(warning, copy);
          button.addEventListener('click', () => { void focus(warning, state.snapshot, status); });
          item.appendChild(button);
          list.appendChild(item);
        }
        section.appendChild(list);
        section.appendChild(status);
        root.appendChild(section);
      }
    }

    return {
      // Call only after a successful write. A failed request never clears warnings.
      saved(warnings, payload) {
        ++navigation;
        for (const locale of ['de', 'en']) {
          ++versions[locale];
          states.set(locale, { snapshot: payload[locale].bodyMarkdown, saved: true,
            warnings: (warnings || []).filter((warning) => warning.locale === locale) });
        }
        render();
      },
      async reopen(locale) {
        const version = ++versions[locale];
        const snapshot = editors[locale].getValue();
        try {
          const analysis = await window.GalleryFence.analyze(snapshot);
          if (version !== versions[locale] || snapshot !== editors[locale].getValue()) return;
          const prior = states.get(locale);
          states.set(locale, { snapshot, saved: prior?.snapshot === snapshot && prior.saved,
            warnings: window.GalleryFence.galleryWarnings(analysis, locale) });
          render();
        } catch (error) {
          if (error?.status === 401) onUnauthed?.();
          // An unavailable advisory cannot erase an earlier saved warning.
        }
      },
    };
  }
  return { create, label };
})();
