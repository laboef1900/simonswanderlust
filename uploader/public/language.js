// Browser URL mirror of the approved four-mode contract. Disabled locales have no URL.
(function (root) {
  'use strict';
  let current = null;
  let pending = null;
  // Admin chrome remains English; dictionaries still carry both locales.
  function text(key, values = {}) {
    return root.EditorCopy.en['language' + key].replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
  }
  function localize(container) {
    for (const element of container.querySelectorAll('[data-language-copy]')) {
      element.textContent = text(element.dataset.languageCopy);
    }
  }
  function config() {
    if (!current) throw new Error(text('NotLoaded'));
    return current;
  }
  function accept(value) {
    if (!value || !['de', 'en'].includes(value.primary) || !Array.isArray(value.locales)
      || value.locales.length < 1 || value.locales.length > 2
      || new Set(value.locales).size !== value.locales.length
      || !value.locales.includes(value.primary) || value.locales.some((locale) => !['de', 'en'].includes(locale))
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
      throw new Error(text('Invalid'));
    }
    current = Object.freeze({ ...value, locales: Object.freeze([value.primary, ...value.locales.filter((l) => l !== value.primary)]) });
    return current;
  }
  async function get(refresh = false) {
    if (!refresh && current) return current;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetch('/language', { cache: 'no-store' });
      if (!response.ok) throw new Error(text('LoadFailed'));
      return accept(await response.json());
    })();
    try { return await pending; } finally { pending = null; }
  }
  function publicPath(lang, locale, kind, slug) {
    if (!lang.locales.includes(locale)) return null;
    const prefix = locale === lang.primary ? '' : '/' + locale;
    if (kind === 'home') return prefix + '/';
    if (kind === 'rss') return prefix + '/rss.xml';
    if (kind === 'story') return slug ? prefix + '/' + slug + '/' : null;
    const regions = locale === 'de' ? 'reiseziele' : 'destinations';
    if (kind === 'region') return slug ? prefix + '/' + regions + '/' + slug + '/' : null;
    const word = { about: locale === 'de' ? 'uber-mich' : 'about-me',
      map: locale === 'de' ? 'karte' : (locale === lang.primary ? 'travel-map' : 'map'),
      regions }[kind];
    if (!word) throw new Error('Unknown public route kind');
    return prefix + '/' + word + '/';
  }
  function tabs(container, lang, api, candidate) {
    const enabled = candidate ? [candidate] : lang.locales;
    for (const tab of container.querySelectorAll('[role="tab"]')) {
      tab.hidden = !enabled.includes(tab.dataset.tab);
      tab.disabled = tab.hidden;
    }
    container.hidden = enabled.length === 1;
    for (const locale of enabled) {
      const tab = container.querySelector('[data-tab="' + locale + '"]');
      if (tab) container.appendChild(tab);
    }
    api.select(enabled[0]);
  }
  function error(body) {
    const key = ({ language_primary_locked: 'PrimaryLocked', language_locale_published: 'LocaleLocked',
      language_pages_incomplete: 'PagesIncomplete',
      locale_published: 'LocalePublished' })[body.code];
    return key ? text(key) : body.error;
  }
  const api = { get, config, accept, publicPath, tabs, error, text, localize,
    get names() { return { de: text('German'), en: text('English') }; } };
  root.SiteLanguage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
