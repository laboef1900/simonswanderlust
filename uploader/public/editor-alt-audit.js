// A read-only queue over the server's saved-draft findings. Visiting a photo
// never resolves it optimistically or writes to Media; the next audit owns that.
window.EditorAltAudit = (function () {
  'use strict';

  function create(options) {
    const copy = EditorCopy.en;
    const byId = (id) => document.getElementById(id);
    const box = byId('altAudit');
    const list = byId('altAuditList');
    const filter = byId('altAuditLocale');
    const previous = byId('altAuditPrevious');
    const next = byId('altAuditNext');
    const nextUnresolved = byId('altAuditNextUnresolved');
    const pageSize = 4;
    const where = { hero: copy.auditHero, body: copy.auditBody, gallery: copy.auditGallery };
    const why = { empty: copy.auditEmpty, 'repeats-title': copy.auditTitle, filename: copy.auditFilename };
    let images = [];
    let page = 0;
    let lastVisited = null;
    let languages = '';

    byId('altAuditQueueHeading').textContent = copy.auditOpen;
    byId('altAuditLocaleLabel').textContent = copy.auditLanguage;
    previous.textContent = copy.auditPrevious;
    next.textContent = copy.auditNext;
    nextUnresolved.textContent = copy.auditNextUnresolved;

    function key(image) { return JSON.stringify([image.locale, image.kind, image.src, image.reason]); }
    function filtered() { return images.filter((image) => filter.value === 'all' || image.locale === filter.value); }
    function node(tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    }

    function visit(image) {
      lastVisited = key(image);
      void options.jump(image.locale, image.kind, image.src);
    }

    function render() {
      const focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.auditKey : null;
      const rows = filtered();
      page = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
      const start = page * pageSize;
      list.replaceChildren();
      for (const image of rows.slice(start, start + pageSize)) {
        const item = node('li', 'alt-audit__item');
        const button = node('button', 'alt-audit__photo');
        button.type = 'button';
        button.dataset.auditKey = key(image);
        const preview = node('span', 'alt-audit__preview', copy.auditPreviewUnavailable);
        const src = options.thumbnail(image);
        if (src) {
          const photo = node('img');
          photo.alt = '';
          photo.loading = 'lazy';
          photo.width = 80;
          photo.height = 60;
          photo.setAttribute('src', src);
          photo.addEventListener('error', () => { preview.textContent = copy.auditPreviewUnavailable; });
          preview.replaceChildren(photo);
        }
        const description = node('span', 'alt-audit__description');
        description.appendChild(node('strong', '', image.locale.toUpperCase() + ' · ' + where[image.kind]));
        description.appendChild(node('span', '', why[image.reason]));
        const name = String(image.src).split('?')[0].split('#')[0].split('/').pop();
        description.appendChild(node('span', 'alt-audit__filename', name));
        description.appendChild(node('span', 'alt-audit__edit', copy.auditEdit));
        button.append(preview, description);
        button.addEventListener('click', () => visit(image));
        item.appendChild(button);
        list.appendChild(item);
        if (focusKey === button.dataset.auditKey) button.focus({ preventScroll: true });
      }
      byId('altAuditRange').textContent = rows.length ? copy.auditRange
        .replace('{start}', String(start + 1)).replace('{end}', String(Math.min(start + pageSize, rows.length)))
        .replace('{total}', String(rows.length)) : copy.auditNoMatches;
      previous.disabled = page === 0;
      next.disabled = start + pageSize >= rows.length;
      nextUnresolved.disabled = rows.length === 0;
      if (focusKey && !list.contains(document.activeElement)) filter.focus({ preventScroll: true });
    }

    filter.addEventListener('change', () => { page = 0; lastVisited = null; render(); });
    previous.addEventListener('click', () => { if (page > 0) { page--; render(); if (previous.disabled) next.focus(); } });
    next.addEventListener('click', () => { if (!next.disabled) { page++; render(); if (next.disabled) previous.focus(); } });
    nextUnresolved.addEventListener('click', () => {
      const rows = filtered();
      if (!rows.length) return;
      const index = (rows.findIndex((image) => key(image) === lastVisited) + 1) % rows.length;
      page = Math.floor(index / pageSize);
      render();
      visit(rows[index]);
    });

    function update(audit, published) {
      const locales = options.locales();
      const localeKey = locales.join(',');
      if (languages !== localeKey) {
        const selected = filter.value;
        filter.replaceChildren();
        for (const [value, label] of [['all', copy.auditAll], ...locales.map((locale) => [locale, locale === 'de' ? 'Deutsch' : 'English'])]) {
          const option = node('option', '', label);
          option.value = value;
          filter.appendChild(option);
        }
        filter.value = locales.includes(selected) ? selected : 'all';
        languages = localeKey;
      }
      images = ((audit && audit.images) || []).filter((image) => locales.includes(image.locale));
      byId('altAuditFeedback').hidden = true;
      if (!images.length) {
        if (box.contains(document.activeElement)) options.focusManuscript();
        box.hidden = true;
        box.open = false;
        byId('altAuditSummary').textContent = '';
        list.replaceChildren();
        page = 0;
        lastVisited = null;
        return;
      }
      box.hidden = false;
      byId('altAuditSummary').textContent = (images.length === 1 ? copy.auditOne : copy.auditOther).replace('{count}', String(images.length));
      byId('altAuditAdvisory').textContent = copy.auditAdvisory;
      const empty = images.filter((image) => image.reason === 'empty').length;
      byId('altAuditCounts').textContent = copy.auditCounts.replace('{empty}', String(empty)).replace('{review}', String(images.length - empty));
      byId('altAuditHelp').textContent = published ? copy.auditPublished : copy.auditHelp;
      box.classList.toggle('notice-warn', !!published);
      box.classList.toggle('notice-info', !published);
      render();
    }

    return { update };
  }

  return { create };
})();
