// Text and assets save independently but share one revision. Asset writes must
// never repaint the text form or discard its unsaved inputs.
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
    let assets = { logo: false, favicon: false };
    const roles = ['logo', 'favicon'];
    for (const [id, key] of Object.entries({
      identityHeading: 'identityTab', identityIntro: 'identityIntro', identityTiming: 'identityTiming',
      identityOptional: 'identityOptional', identitySiteNameLabel: 'identitySiteName',
      identityAuthorNameLabel: 'identityAuthorName', identitySocialHeading: 'identitySocialHeading',
      identitySocialHelp: 'identitySocialHelp', identitySocialEmpty: 'identitySocialEmpty',
      identityAddLink: 'identityAddLink', identitySave: 'identitySave', identityReload: 'identityReload',
      identityRebuild: 'identityRebuild', identityAssetsHeading: 'identityAssetsHeading',
      identityAssetsHelp: 'identityAssetsHelp',
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
      for (const role of roles) {
        $('identity-' + role + '-fields').disabled = value || revision === null;
        $('identity-' + role + '-upload').disabled = value || conflicted || revision === null || !$('identity-' + role + '-file').files?.length;
        $('identity-' + role + '-remove').disabled = value || conflicted || revision === null || !assets[role];
      }
    }
    function paintAssets() {
      for (const role of roles) {
        $('identity-' + role + '-state').textContent = assets[role]
          ? copy.identityAssetCustom : role === 'logo' ? copy.identityLogoDefault : copy.identityFaviconDefault;
      }
    }
    function assetError(response, result, role) {
      if (response.status === 403) return copy.identityAssetForbidden;
      if (response.status === 507) return copy.identityAssetSpace;
      const messages = {
        too_many_files: copy.identityAssetOneFile,
        asset_too_large: response.status === 413 ? copy.identityAssetInputLarge : copy.identityAssetOutputLarge,
        unsupported_image_type: copy.identityAssetUnsupported,
        animated_image: copy.identityAssetAnimated,
        image_too_large: copy.identityAssetPixels,
        image_invalid: copy.identityAssetInvalid,
        image_too_small: role === 'logo' ? copy.identityLogoHelp : copy.identityFaviconHelp,
        invalid_identity: copy.identityAssetRequestInvalid,
      };
      return messages[result.code] || copy.identityAssetFailed;
    }
    async function saveAsset(role, remove) {
      if (busy || conflicted || revision === null || (remove && !assets[role])) return;
      const control = $('identity-' + role + '-file');
      if (!remove && control.files?.length !== 1) { status(copy.identityAssetOneFile, true); return; }
      if (!remove && control.files[0].size > 2 * 1024 * 1024) { status(copy.identityAssetInputLarge, true); return; }
      // Lock before confirmation too: no text/other-asset save can race its revision.
      lock(true);
      try {
        if (remove && !await AdminConfirm.ask({
          title: copy.identityAssetRemove + ' · ' + (role === 'logo' ? copy.identityLogo : copy.identityFavicon),
          body: role === 'logo' ? copy.identityLogoRemoveConfirm : copy.identityFaviconRemoveConfirm,
          confirmLabel: copy.identityAssetRemove, danger: true,
        })) return;
        status(remove ? copy.identityAssetRemoving : copy.identityAssetUploading);
        let body;
        if (remove) body = JSON.stringify({ revision });
        else {
          body = new FormData();
          body.append('revision', String(revision));
          body.append('file', control.files[0]);
        }
        const response = await fetch('/settings/identity/assets/' + role, {
          method: remove ? 'DELETE' : 'PUT',
          ...(remove ? { headers: { 'content-type': 'application/json' } } : {}),
          body,
        });
        if (response.status === 401) { location.href = '/login'; return; }
        const result = await response.json();
        if (response.status === 409 && result.code === 'identity_conflict') {
          conflicted = true;
          status(copy.identityConflict, true);
        } else if (!response.ok) {
          status(assetError(response, result, role), true);
        } else {
          revision = result.revision;
          assets = result.assets;
          // No reload: local text, link order and the other chosen file stay intact.
          if (!remove) control.value = '';
          paintAssets();
          status(remove ? copy.identityAssetRemoved : copy.identityAssetSaved);
        }
      } catch { status(copy.identityAssetFailed, true); }
      finally { lock(false); }
    }
    for (const role of roles) {
      const label = role === 'logo' ? copy.identityLogo : copy.identityFavicon;
      $('identity-' + role + '-label').textContent = label;
      $('identity-' + role + '-file-label').textContent = copy.identityAssetChoose;
      $('identity-' + role + '-help').textContent = role === 'logo' ? copy.identityLogoHelp : copy.identityFaviconHelp;
      for (const action of ['upload', 'remove']) {
        const button = $('identity-' + role + '-' + action);
        button.textContent = action === 'upload' ? copy.identityAssetUpload : copy.identityAssetRemove;
        button.setAttribute('aria-label', button.textContent + ' · ' + label);
        button.addEventListener('click', () => saveAsset(role, action === 'remove'));
      }
      $('identity-' + role + '-file').addEventListener('change', () => lock(busy));
    }
    function input(parent, id, label, value, maxLength, type = 'text') {
      const group = document.createElement('div');
      const caption = document.createElement('label');
      caption.htmlFor = id;
      caption.textContent = label;
      const control = document.createElement('input');
      control.id = id;
      control.type = type;
      if (type === 'url') control.maxLength = maxLength;
      else control.dataset.identityMaxLength = String(maxLength);
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
        assets = data.assets;
        paintAssets();
        for (const role of roles) $('identity-' + role + '-file').value = '';
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
      if ((dirty || roles.some((role) => $('identity-' + role + '-file').files?.length)) &&
          !await AdminConfirm.ask({ title: copy.identityReload, body: copy.identityReloadConfirm, confirmLabel: copy.identityReload })) return;
      await load();
    });
    $('identityForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy || conflicted || revision === null || !$('identityForm').reportValidity()) return;
      // HTML maxlength counts UTF-16 units, not the contract's NFC code points.
      // Never truncate typed identity text; reject excess with its input intact.
      for (const control of $('identityForm').querySelectorAll('input')) {
        const limit = Number(control.dataset.identityMaxLength);
        if (Number.isFinite(limit) && [...control.value.normalize('NFC').trim()].length > limit) {
          const label = document.querySelector('label[for="' + control.id + '"]');
          status(copy.identityInvalid + ' ' + (label?.textContent || ''));
          control.focus();
          return;
        }
      }
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
