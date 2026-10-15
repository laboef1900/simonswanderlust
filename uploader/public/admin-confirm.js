// Designed confirm for high-stakes admin actions (Publish, Rebuild, Unpublish,
// Delete, Duplicate). Native <dialog> when the browser has it; window.confirm /
// prompt otherwise so vm tests and older browsers still get a real yes/no
// instead of a silent no-op.
window.AdminConfirm = (function () {
  function liveUrls(slugs) {
    const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
    const de = slugs && slugs.de ? origin + '/' + slugs.de + '/' : '';
    const en = slugs && slugs.en ? origin + '/en/' + slugs.en + '/' : '';
    return { de, en };
  }

  function urlsPlain(slugs) {
    const u = liveUrls(slugs);
    const lines = [];
    if (u.de) lines.push('DE  ' + u.de);
    if (u.en) lines.push('EN  ' + u.en);
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
        '<p id="adminConfirmBody" class="help" style="white-space:pre-wrap"></p>' +
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
    ok.className = o.danger ? 'btn-remove' : 'btn-publish';
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
      dlg.showModal();
      if (typedInput) typedInput.focus();
      else dlg.querySelector('#adminConfirmOk').focus();
    });
  }

  // Returns a map of field name → value, or null if cancelled.
  function askFields(opts) {
    const o = opts || {};
    const fields = o.fields || [];
    const dlg = ensureDialog();
    if (!dlg || typeof dlg.showModal !== 'function') {
      const values = {};
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const v = window.prompt((o.title || 'Confirm') + '\n' + (f.label || f.name), f.value || '');
        if (v === null) return Promise.resolve(null);
        values[f.name] = v;
      }
      return Promise.resolve(values);
    }
    const extra = fillChrome(dlg, o);
    const inputs = {};
    fields.forEach(function (f) {
      const lab = document.createElement('label');
      lab.setAttribute('for', 'adminConfirmField-' + f.name);
      lab.textContent = f.label || f.name;
      extra.appendChild(lab);
      if (f.prefix) {
        const row = document.createElement('div');
        row.className = 'slug-preview';
        const prefix = document.createElement('span');
        prefix.className = 'slug-base';
        prefix.textContent = f.prefix;
        const input = document.createElement('input');
        input.id = 'adminConfirmField-' + f.name;
        input.type = 'text';
        input.value = f.value || '';
        input.autocomplete = 'off';
        row.appendChild(prefix);
        row.appendChild(input);
        extra.appendChild(row);
        inputs[f.name] = input;
      } else {
        const input = document.createElement('input');
        input.id = 'adminConfirmField-' + f.name;
        input.type = 'text';
        input.value = f.value || '';
        input.autocomplete = 'off';
        extra.appendChild(input);
        inputs[f.name] = input;
      }
    });
    return new Promise(function (resolve) {
      function onClose() {
        dlg.removeEventListener('close', onClose);
        if (dlg.returnValue !== 'ok') { resolve(null); return; }
        const values = {};
        Object.keys(inputs).forEach(function (name) { values[name] = inputs[name].value; });
        resolve(values);
      }
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      const first = fields[0] && inputs[fields[0].name];
      if (first) first.focus();
      else dlg.querySelector('#adminConfirmOk').focus();
    });
  }

  return { ask, askFields, liveUrls, urlsPlain };
})();
