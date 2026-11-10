// Designed confirm for admin decisions. Native <dialog> when the browser has
// it; window.confirm / prompt otherwise so vm tests and older browsers still
// get a real answer instead of a silent no-op.
//
// The action button follows the action, not the dialog:
//   danger: true      destructive — filled red, and focus opens on Cancel so
//                     Enter never deletes
//   tone: 'publish'   changes the live site (Publish, Rebuild, a save that
//                     rebuilds) — filled red
//   neither           everything else (Restore a draft, Reload, Discard form
//                     edits) — the navy primary
window.AdminConfirm = (function () {
  function liveUrls(slugs) {
    const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
    const lang = SiteLanguage.config();
    return Object.fromEntries(['de', 'en'].map((locale) => {
      const path = SiteLanguage.publicPath(lang, locale, 'story', slugs && slugs[locale]);
      return [locale, path ? origin + path : ''];
    }));
  }

  function urlsPlain(slugs) {
    const u = liveUrls(slugs);
    const lines = [];
    for (const locale of SiteLanguage.config().locales) {
      if (u[locale]) lines.push(locale.toUpperCase() + '  ' + u[locale]);
    }
    return lines.join('\n');
  }

  function ensureDialog() {
    let dlg = document.getElementById('adminConfirm');
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    if (!dlg || typeof dlg.showModal !== 'function') return null;
    dlg.id = 'adminConfirm';
    dlg.className = 'admin-modal';
    dlg.setAttribute('aria-labelledby', 'adminConfirmTitle');
    dlg.setAttribute('aria-describedby', 'adminConfirmBody');
    dlg.innerHTML =
      '<form method="dialog" id="adminConfirmForm">' +
        '<h2 id="adminConfirmTitle" class="card-heading"></h2>' +
        '<p id="adminConfirmBody" class="help admin-modal__body"></p>' +
        '<div id="adminConfirmExtra"></div>' +
        '<div class="admin-modal__foot">' +
          '<button type="submit" value="cancel" class="btn-secondary" id="adminConfirmCancel">Cancel</button>' +
          '<button type="submit" value="ok" id="adminConfirmOk">Confirm</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(dlg);
    return dlg;
  }

  function fillChrome(dlg, o) {
    dlg.querySelector('#adminConfirmTitle').textContent = o.title || 'Confirm';
    dlg.querySelector('#adminConfirmBody').textContent = o.body || '';
    const extra = dlg.querySelector('#adminConfirmExtra');
    extra.replaceChildren();
    const ok = dlg.querySelector('#adminConfirmOk');
    ok.textContent = o.confirmLabel || 'Confirm';
    ok.className = o.danger ? 'btn-remove' : o.tone === 'publish' ? 'btn-publish' : '';
    return extra;
  }

  function ask(opts) {
    const o = opts || {};
    const title = o.title || 'Confirm';
    const body = o.body || '';
    const typed = o.typed || '';
    const dlg = ensureDialog();
    if (!dlg || typeof dlg.showModal !== 'function') {
      if (typed) {
        const v = window.prompt(title + '\n\n' + body + '\n\nType ' + typed + ' to confirm:');
        return Promise.resolve(v === typed);
      }
      return Promise.resolve(window.confirm(title + '\n\n' + body));
    }
    const extra = fillChrome(dlg, o);
    let typedInput = null;
    if (typed) {
      const lab = document.createElement('label');
      lab.setAttribute('for', 'adminConfirmTyped');
      lab.textContent = 'Type ' + typed + ' to confirm';
      typedInput = document.createElement('input');
      typedInput.id = 'adminConfirmTyped';
      typedInput.type = 'text';
      typedInput.autocomplete = 'off';
      typedInput.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' || event.isComposing) return;
        // The form's first submit button is Cancel; never use its implicit submit.
        event.preventDefault();
        if (typedInput.value !== typed) return;
        dlg.returnValue = 'ok';
        dlg.close();
      });
      extra.appendChild(lab);
      extra.appendChild(typedInput);
    }
    return new Promise(function (resolve) {
      function onClose() {
        dlg.removeEventListener('close', onClose);
        if (dlg.returnValue !== 'ok') { resolve(false); return; }
        if (typed && (!typedInput || typedInput.value !== typed)) { resolve(false); return; }
        resolve(true);
      }
      dlg.addEventListener('close', onClose);
      // Escape and close() without a result preserve returnValue in Firefox
      // and Safari. Each ask must start cancelled, never reuse a prior consent.
      dlg.returnValue = '';
      dlg.showModal();
      if (typedInput) typedInput.focus();
      else if (o.danger) dlg.querySelector('#adminConfirmCancel').focus();
      else dlg.querySelector('#adminConfirmOk').focus();
    });
  }

  // One line of text in the same dialog (a folder name, a link address).
  // Resolves to the trimmed text, or null when cancelled. An empty answer is
  // refused with the `required` sentence — unless `required: false`, where ''
  // is a valid answer (clearing a link). `validate(text)` returns a sentence to
  // refuse a non-empty value, or '' to accept it; it shows under the field.
  function prompt(opts) {
    const o = opts || {};
    const refuse = (text) => !text
      ? (o.required === false ? '' : (o.required || 'Enter a name.'))
      : (o.validate ? o.validate(text) : '');
    const dlg = ensureDialog();
    if (!dlg || typeof dlg.showModal !== 'function') {
      const v = window.prompt((o.title || '') + (o.body ? '\n\n' + o.body : ''), o.value || '');
      const text = v == null ? null : String(v).trim();
      return Promise.resolve(text !== null && !refuse(text) ? text : null);
    }
    const extra = fillChrome(dlg, o);
    const label = document.createElement('label');
    label.setAttribute('for', 'adminConfirmText');
    label.textContent = o.label || o.title || '';
    const input = document.createElement('input');
    input.id = 'adminConfirmText';
    input.type = 'text';
    input.autocomplete = 'off';
    input.value = o.value || '';
    input.setAttribute('aria-describedby', 'adminConfirmTextError');
    const error = document.createElement('p');
    error.id = 'adminConfirmTextError';
    error.className = 'field-error';
    error.hidden = true;
    const refusal = () => refuse(input.value.trim());
    function accept() {
      const message = refusal();
      error.textContent = message;
      error.hidden = !message;
      if (message) { input.setAttribute('aria-invalid', 'true'); input.focus(); return false; }
      input.removeAttribute('aria-invalid');
      return true;
    }
    input.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.isComposing) return;
      // The form's first submit button is Cancel; never use its implicit submit.
      event.preventDefault();
      if (!accept()) return;
      dlg.returnValue = 'ok';
      dlg.close();
    });
    extra.appendChild(label);
    extra.appendChild(input);
    extra.appendChild(error);
    const ok = dlg.querySelector('#adminConfirmOk');
    function onOk(event) { if (!accept()) event.preventDefault(); }
    ok.addEventListener('click', onOk);
    return new Promise(function (resolve) {
      function onClose() {
        dlg.removeEventListener('close', onClose);
        ok.removeEventListener('click', onOk);
        resolve(dlg.returnValue === 'ok' && !refusal() ? input.value.trim() : null);
      }
      dlg.addEventListener('close', onClose);
      dlg.returnValue = '';
      dlg.showModal();
      input.focus();
      if (typeof input.select === 'function') input.select();
    });
  }

  return { ask, prompt, liveUrls, urlsPlain };
})();
