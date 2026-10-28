// Identity is saved independently of operational settings. Only the active locale
// projection is sent; canonical origin and assets belong to their own features.
window.SettingsIdentity = (function () {
  function init() {
    const $ = (id) => document.getElementById(id);
    const locale = document.documentElement.lang === 'de' ? 'de' : 'en';
    const copy = EditorCopy[locale];
    const fields = ['tagline', 'aboutRole', 'aboutGear', 'studioDescriptor'];
    const limits = { tagline: 160, aboutRole: 80, aboutGear: 200, studioDescriptor: 80 };
    const labels = {
      tagline: copy.identityTagline, aboutRole: copy.identityAboutRole,
      aboutGear: copy.identityAboutGear, studioDescriptor: copy.identityStudioDescriptor,
    };
    let revision = null;
    let locales = [];
    let links = [];
    let dirty = false;
    let busy = false;
    let conflicted = false;
    for (const [id, key] of Object.entries({
      identityHeading: 'identityTab', identityIntro: 'identityIntro', identityTiming: 'identityTiming',
      identityOptional: 'identityOptional', identitySiteNameLabel: 'identitySiteName',
      identityAuthorNameLabel: 'identityAuthorName', identitySocialHeading: 'identitySocialHeading',
      identitySocialHelp: 'identitySocialHelp', identitySocialEmpty: 'identitySocialEmpty',
      identityAddLink: 'identityAddLink', identitySave: 'identitySave', identityReload: 'identityReload',
      identityRebuild: 'identityRebuild',
    })) $(id).textContent = copy[key];

    function status(text, focus = false) {
      $('identityStatus').textContent = text;
      if (focus) $('identityStatus').focus();
    }
    function lock(value) {
      busy = value;
      $('identityFields').disabled = value || revision === null;
      $('identityReload').disabled = value;
      $('identityRebuild').disabled = value;
      $('identitySave').disabled = conflicted;
    }
    function input(parent, id, label, value, maxLength, type = 'text') {
      const group = document.createElement('div');
      const caption = document.createElement('label');
      caption.htmlFor = id;
      caption.textContent = label;
      const control = document.createElement('input');
      control.id = id;
      control.type = type;
      control.maxLength = maxLength;
      control.value = value || '';
      group.append(caption, control);
      parent.append(group);
      return control;
    }
    function paintLocalized(identity) {
      $('identityLocalized').replaceChildren();
      for (const field of fields) {
        const pair = document.createElement('div');
        pair.className = 'settings-field-pair';
        for (const language of locales) {
          const languageLabel = language === 'de' ? copy.identityGerman : copy.identityEnglish;
          input(pair, 'identity-' + field + '-' + language,
            labels[field] + ' · ' + languageLabel, identity[field]?.[language], limits[field]);
        }
        $('identityLocalized').append(pair);
      }
    }
    function paintLinks(focusIndex, focusAction = 'label') {
      const list = $('identitySocialLinks');
      list.replaceChildren();
      links.forEach((link, index) => {
        const row = document.createElement('li');
        const pair = document.createElement('div');
        pair.className = 'settings-field-pair';
        const label = input(pair, 'identity-link-label-' + index, copy.identitySocialLabel, link.label, 40);
        const url = input(pair, 'identity-link-url-' + index, copy.identitySocialUrl, link.url, 2048, 'url');
        label.required = url.required = true;
        url.pattern = 'https://.*';
        label.addEventListener('input', () => { link.label = label.value; });
        url.addEventListener('input', () => { link.url = url.value; });
        const actions = document.createElement('div');
        actions.className = 'form-actions';
        for (const [action, text] of [['up', copy.identityMoveUp], ['down', copy.identityMoveDown], ['remove', copy.identityRemoveLink]]) {
          const button = document.createElement('button');
          button.id = 'identity-link-' + action + '-' + index;
          button.type = 'button';
          button.className = action === 'remove' ? 'btn-remove' : 'btn-secondary';
          button.textContent = text;
          button.setAttribute('aria-label', text + ' · ' + (index + 1));
          button.disabled = (action === 'up' && index === 0) || (action === 'down' && index === links.length - 1);
          button.addEventListener('click', async () => {
            if (busy) return;
            if (action === 'remove') {
              if (!await AdminConfirm.ask({ title: copy.identityRemoveLink, body: copy.identityRemoveConfirm, confirmLabel: copy.identityRemoveLink, danger: true })) return;
              links.splice(index, 1);
              paintLinks(Math.min(index, links.length - 1));
              if (!links.length) $('identityAddLink').focus();
            } else {
              const next = index + (action === 'up' ? -1 : 1);
              [links[index], links[next]] = [links[next], links[index]];
              paintLinks(next, action === 'up' && next === 0 ? 'down' : action === 'down' && next === links.length - 1 ? 'up' : action);
            }
            dirty = true;
          });
          actions.append(button);
        }
        row.append(pair, actions);
        list.append(row);
      });
      $('identitySocialEmpty').hidden = links.length > 0;
      $('identityAddLink').disabled = links.length >= 6;
      if (focusIndex >= 0) $('identity-link-' + focusAction + '-' + focusIndex)?.focus();
    }
    async function load() {
      lock(true);
      status(copy.identityLoading);
      try {
        const response = await fetch('/settings/identity', { cache: 'no-store' });
        if (response.status === 401) { location.href = '/login'; return; }
        if (!response.ok) throw new Error('identity_load');
        const data = await response.json();
        revision = data.revision;
        locales = data.locales;
        $('identitySiteName').value = data.identity.siteName;
        $('identityAuthorName').value = data.identity.authorName;
        paintLocalized(data.identity);
        links = data.identity.socialLinks.map((link) => ({ ...link }));
        paintLinks();
        dirty = conflicted = false;
        status('');
      } catch {
        status(copy.identityLoadFailed, true);
      } finally { lock(false); }
    }
    $('identityForm').addEventListener('input', () => { dirty = true; });
    $('identityAddLink').addEventListener('click', () => {
      if (busy || links.length >= 6) return;
      links.push({ label: '', url: '' });
      dirty = true;
      paintLinks(links.length - 1);
    });
    $('identityReload').addEventListener('click', async () => {
      if (busy) return;
      if (dirty && !await AdminConfirm.ask({ title: copy.identityReload, body: copy.identityReloadConfirm, confirmLabel: copy.identityReload })) return;
      await load();
    });
    $('identityForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy || conflicted || revision === null || !$('identityForm').reportValidity()) return;
      const identity = { siteName: $('identitySiteName').value, authorName: $('identityAuthorName').value, socialLinks: links };
      for (const field of fields) {
        identity[field] = Object.fromEntries(locales.map((language) => [language, $('identity-' + field + '-' + language).value]));
      }
      lock(true);
      status(copy.identitySaving);
      try {
        const response = await fetch('/settings/identity', {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, identity }),
        });
        if (response.status === 401) { location.href = '/login'; return; }
        const result = await response.json();
        if (response.status === 409 && result.code === 'identity_conflict') {
          conflicted = true;
          status(copy.identityConflict, true);
        } else if (response.status === 400 && result.code === 'invalid_identity') {
          // Field paths come from the server's fixed validation contract, not its supplied value.
          status(copy.identityInvalid + ' ' + (result.field || ''), true);
        } else if (!response.ok) {
          status(copy.identityFailed, true);
        } else {
          revision = result.revision;
          dirty = false;
          status(copy.identitySaved);
        }
      } catch { status(copy.identityFailed, true); }
      finally { lock(false); }
    });
    $('identityRebuild').addEventListener('click', async () => {
      if (busy || !await AdminConfirm.ask({ title: copy.identityRebuild, body: copy.identityRebuildConfirm, confirmLabel: copy.identityRebuild })) return;
      lock(true);
      status(copy.identityRebuilding);
      try {
        const response = await fetch('/rebuild', { method: 'POST' });
        if (response.status === 401) { location.href = '/login'; return; }
        const result = await response.json();
        status(response.ok && result.ok ? copy.identityRebuilt : copy.identityRebuildFailed, !response.ok || !result.ok);
      } catch { status(copy.identityRebuildFailed, true); }
      finally { lock(false); }
    });
    return load();
  }
  return { init };
})();
