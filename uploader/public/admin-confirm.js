// Designed confirm for high-stakes admin actions (Publish, Rebuild, Unpublish).
// Native <dialog> when the browser has it; window.confirm otherwise so vm tests
// and older browsers still get a real yes/no instead of a silent no-op.
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
      '<form method="dialog">' +
        '<h2 id="adminConfirmTitle" class="card-heading"></h2>' +
        '<p id="adminConfirmBody" class="help" style="white-space:pre-wrap"></p>' +
        '<div class="admin-modal__foot">' +
          '<button type="submit" value="cancel" class="btn-secondary" id="adminConfirmCancel">Cancel</button>' +
          '<button type="submit" value="ok" id="adminConfirmOk">Confirm</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(dlg);
    return dlg;
  }

  function ask(opts) {
    const o = opts || {};
    const title = o.title || 'Confirm';
    const body = o.body || '';
    const confirmLabel = o.confirmLabel || 'Confirm';
    const dlg = ensureDialog();
    if (!dlg || typeof dlg.showModal !== 'function') {
      return Promise.resolve(window.confirm(title + '\n\n' + body));
    }
    const heading = dlg.querySelector('#adminConfirmTitle');
    const text = dlg.querySelector('#adminConfirmBody');
    const ok = dlg.querySelector('#adminConfirmOk');
    heading.textContent = title;
    text.textContent = body;
    ok.textContent = confirmLabel;
    ok.className = o.danger ? 'btn-remove' : 'btn-publish';
    return new Promise(function (resolve) {
      function onClose() {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok');
      }
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      ok.focus();
    });
  }

  return { ask, liveUrls, urlsPlain };
})();
