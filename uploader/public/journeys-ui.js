window.JourneysUI = (function () {
  'use strict';
  function text(key, values = {}) { return EditorCopy[document.documentElement?.lang === 'de' ? 'de' : 'en']['journey' + key].replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match); }
  function el(tag, content, className) { const node = document.createElement(tag); if (content !== undefined) node.textContent = content; if (className) node.className = className; return node; }
  function localize(root) { root.querySelectorAll('[data-journey-copy]').forEach(node => { node.textContent = text(node.dataset.journeyCopy); }); }
  function error(body) {
    if (body.code === 'journey_build_failed') return text('BuildFailed');
    if (body.code === 'conflict') return text('Conflict');
    if (body.code === 'story_in_other_journey') return text('Owner', { title: body.owner?.title || body.owner?.id || '' });
    return text('Invalid') + (body.locale ? ' (' + body.locale.toUpperCase() + ')' : '') + (body.code ? ' [' + body.code + ']' : '');
  }
  async function request(path, options = {}, guard) {
    const response = await fetch('/journey-admin' + path, { cache: 'no-store', ...options, headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers } });
    if (response.status === 401) {
      if (guard) guard.redirectToLogin(); else location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      throw new Error(text('Failed'));
    }
    const body = await response.json();
    if (!response.ok) { const failure = new Error(error(body)); failure.body = body; throw failure; }
    return body;
  }
  function path(language, locale, slug) { return (locale === language.primary ? '' : '/' + locale) + '/' + (locale === 'de' ? 'rundreisen' : 'journeys') + '/' + slug + '/'; }
  async function claim(key, target) {
    target.hidden = true; target.replaceChildren();
    if (!key) return;
    try {
      const journey = await request('?member=' + encodeURIComponent(key));
      if (!journey) return;
      const link = el('a', text('Claim', { title: journey.titles.de || journey.titles.en || journey.id }));
      link.href = '/admin/journey-editor.html?id=' + encodeURIComponent(journey.id); target.append(link); target.hidden = false;
    } catch { target.textContent = text('ClaimFailed'); target.hidden = false; }
  }
  return { text, el, localize, request, path, claim };
})();
