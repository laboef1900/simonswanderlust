(function (root) {
  'use strict';
  function text(key, values = {}) { return root.EditorCopy.en['pages' + key].replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match); }
  function localize(container) { for (const el of container.querySelectorAll('[data-pages-copy]')) el.textContent = text(el.dataset.pagesCopy); }
  function kind(key) { const label = { about: 'About', contact: 'Contact', privacy: 'Privacy', legal: 'Legal' }[key]; return label ? text(label) : key; }
  function paths(pair, language) { return language.locales.map((locale) => root.SiteLanguage.publicPath(language, locale, pair.key === 'about' ? 'about' : 'story', pair[locale].slug)).filter(Boolean); }
  async function request(path, options) {
    const response = await fetch('/pages' + path, options);
    const body = await response.json();
    if (!response.ok) { const error = new Error(body.error || text('Failed')); error.status = response.status; error.body = body; throw error; }
    return body;
  }
  async function remove(key) {
    const info = await request('/' + encodeURIComponent(key) + '/deletion');
    const scope = text('DeleteScope', { kind: kind(key), de: info.titles.de, en: info.titles.en,
      paths: info.paths.join(' · ') || text('None'), revisions: info.revisions,
      navigation: info.navigation.map((item) => item.slot + ': ' + (item.label?.en || item.label?.de || kind(key))).join(', ') || text('None'), references: info.bodyReferences });
    if (!await root.AdminConfirm.ask({ title: text('Delete'), body: scope, confirmLabel: text('Delete'), danger: true })) return null;
    return request('/' + encodeURIComponent(key), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updatedAt: info.updatedAt }) });
  }
  root.PagesUI = { text, localize, kind, paths, request, remove };
})(window);
