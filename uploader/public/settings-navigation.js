window.SettingsNavigation = (function () {
  function init() {
    const $ = (id) => document.getElementById(id);
    const copy = EditorCopy[document.documentElement.lang === 'de' ? 'de' : 'en'];
    const slots = { header: 5, footer: 8, legal: 4 };
    const names = { header: copy.navigationHeader, footer: copy.navigationFooter, legal: copy.navigationLegal };
    const types = { builtin: copy.navigationBuiltin, page: copy.navigationPage, path: copy.navigationPath, external: copy.navigationExternal };
    const targets = { home: copy.navigationHome, stories: copy.navigationStories, map: copy.navigationMap, regions: copy.navigationRegions,
      about: copy.navigationAbout, contact: copy.navigationContact, privacy: copy.navigationPrivacy, legal: copy.navigationLegalPage };
    let config, updatedAt, locales = [], pages = [], dirty = false, busy = false, conflicted = false;
    for (const [id, text] of Object.entries({ navigationHeading: copy.navigationTab, navigationIntro: copy.navigationIntro,
      navigationHelp: copy.navigationLabelHelp, navigationSave: copy.navigationSave, navigationReload: copy.navigationReload,
      navigationRebuild: copy.identityRebuild, navigationSocialHelp: copy.navigationSocial, navigationSocialLink: copy.navigationSocialLink })) $(id).textContent = text;
    function status(text, focus = false) { $('navigationStatus').textContent = text; if (focus) $('navigationStatus').focus(); }
    function lock(value) {
      busy = value;
      $('navigationFields').disabled = value || !config;
      $('navigationSave').disabled = conflicted;
      $('navigationReload').disabled = value;
      $('navigationRebuild').disabled = value;
    }
    function element(tag, text, className) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function control(parent, id, label, value, choices) {
      const group = element('div');
      const caption = element('label', label); caption.htmlFor = id;
      const field = element(choices ? 'select' : 'input'); field.id = id;
      if (choices) for (const [key, text] of Object.entries(choices)) {
        const option = element('option', text); option.value = key; field.append(option);
      }
      else field.type = 'text';
      field.value = value || '';
      group.append(caption, field); parent.append(group);
      return field;
    }
    function paint(focusId) {
      const root = $('navigationSlots'); root.replaceChildren();
      for (const [slot, max] of Object.entries(slots)) {
        const section = element('section', undefined, 'navigation-slot');
        const heading = element('h3', names[slot] + ' (' + config[slot].length + '/' + max + ')', 'section-label');
        const list = element('ol', undefined, 'identity-social-links');
        section.append(heading);
        if (!config[slot].length) section.append(element('p', copy.navigationEmpty, 'muted'));
        config[slot].forEach((item, index) => {
          const id = 'nav-' + slot + '-' + index;
          const row = element('li');
          const pair = element('div', undefined, 'settings-field-pair');
          const kind = control(pair, id + '-kind', copy.navigationKind, item.kind, types);
          kind.addEventListener('change', () => {
            config[slot][index] = kind.value === 'builtin' || kind.value === 'page'
              ? { kind: kind.value, target: kind.value === 'page' ? 'about' : 'home', label: item.label || {} }
              : { kind: kind.value, href: item.href || {}, label: item.label || {} };
            dirty = true; paint(id + '-kind');
          });
          if (item.kind === 'builtin' || item.kind === 'page') {
            const allowed = item.kind === 'builtin' ? ['home', 'stories', 'map', 'regions'] : ['about', 'contact', 'privacy', 'legal'];
            const target = control(pair, id + '-target', copy.navigationTarget, item.target, Object.fromEntries(allowed.map((key) => [key, targets[key]])));
            target.addEventListener('change', () => { item.target = target.value; dirty = true; paint(id + '-target'); });
          }
          row.append(pair);
          for (const locale of locales) {
            const localeLabel = locale === 'de' ? copy.identityGerman : copy.identityEnglish;
            const fields = element('div', undefined, 'settings-field-pair');
            const label = control(fields, id + '-label-' + locale, copy.navigationLabel + ' · ' + localeLabel, item.label?.[locale]);
            label.addEventListener('input', () => {
              item.label ||= {}; if (label.value) item.label[locale] = label.value; else delete item.label[locale]; dirty = true; refreshNotice();
            });
            if (item.kind === 'path' || item.kind === 'external') {
              const href = control(fields, id + '-href-' + locale, copy.navigationHref + ' · ' + localeLabel, item.href[locale]);
              href.addEventListener('input', () => { if (href.value) item.href[locale] = href.value; else delete item.href[locale]; dirty = true; refreshNotice(); });
            }
            row.append(fields);
            const notice = element('p', undefined, 'muted'); notice.id = id + '-notice-' + locale;
            row.append(notice);
            function refreshNotice() {
              if (item.kind === 'page') {
                const page = pages.find((page) => page.key === item.target);
                notice.textContent = item.target === 'about' || (page?.status === 'published' && page.locales?.[locale]?.slug)
                  ? '' : localeLabel + ': ' + copy.navigationUnavailable;
              } else if (item.kind === 'path' || item.kind === 'external') {
                notice.textContent = (!item.href[locale] || !item.label?.[locale] ? localeLabel + ': ' + copy.navigationMissing + ' ' : '')
                  + (item.kind === 'path' ? copy.navigationPathCheck : copy.navigationExternalHelp);
              }
            }
            refreshNotice();
          }
          const actions = element('div', undefined, 'form-actions');
          for (const [action, text] of [['up', copy.identityMoveUp], ['down', copy.identityMoveDown], ['remove', copy.identityRemoveLink]]) {
            const button = element('button', text, action === 'remove' ? 'btn-remove' : 'btn-secondary');
            button.type = 'button'; button.id = id + '-' + action;
            button.setAttribute('aria-label', text + ' · ' + names[slot] + ' · ' + (index + 1));
            button.disabled = action === 'up' && index === 0 || action === 'down' && index === config[slot].length - 1;
            button.addEventListener('click', async () => {
              if (busy) return;
              if (action === 'remove') {
                if (!await AdminConfirm.ask({ title: text, body: names[slot] + ' · ' + (item.label?.[locales[0]] || targets[item.target] || item.href?.[locales[0]] || (index + 1)) + '\n' + copy.navigationRemoveConfirm, confirmLabel: text, danger: true })) return;
                config[slot].splice(index, 1); dirty = true; paint('nav-add-' + slot);
              } else {
                const next = index + (action === 'up' ? -1 : 1);
                [config[slot][index], config[slot][next]] = [config[slot][next], config[slot][index]];
                dirty = true; paint('nav-' + slot + '-' + next + '-kind');
              }
            });
            actions.append(button);
          }
          row.append(actions); list.append(row);
        });
        const add = element('button', copy.navigationAdd, 'btn-secondary');
        add.type = 'button'; add.id = 'nav-add-' + slot; add.disabled = config[slot].length >= max;
        add.setAttribute('aria-label', copy.navigationAdd + ' · ' + names[slot]);
        add.addEventListener('click', () => {
          if (busy || config[slot].length >= max) return;
          config[slot].push({ kind: 'builtin', target: 'home' }); dirty = true;
          paint('nav-' + slot + '-' + (config[slot].length - 1) + '-kind');
        });
        section.append(list, add); root.append(section);
      }
      if (focusId) $(focusId)?.focus();
    }
    async function load() {
      lock(true); status(copy.navigationLoading);
      try {
        const responses = await Promise.all([fetch('/settings/navigation', { cache: 'no-store' }), fetch('/pages', { cache: 'no-store' })]);
        if (responses.some((response) => response.status === 401)) { location.href = '/login'; return; }
        if (responses.some((response) => !response.ok)) throw new Error('load');
        const [data, catalogue] = await Promise.all(responses.map((response) => response.json()));
        config = data.config; updatedAt = data.updatedAt; locales = data.language.locales; pages = catalogue.pages;
        const social = $('navigationSocial'); social.replaceChildren();
        for (const link of data.socialLinks) social.append(element('li', link.label + ' — ' + link.url));
        dirty = conflicted = false; paint(); status('');
      } catch { status(copy.navigationLoadFailed, true); }
      finally { lock(false); }
    }
    $('navigationReload').addEventListener('click', async () => {
      if (busy || dirty && !await AdminConfirm.ask({ title: copy.navigationReload, body: copy.navigationReloadConfirm, confirmLabel: copy.navigationReload })) return;
      await load(); $('navigationReload').focus();
    });
    $('navigationForm').addEventListener('submit', async (event) => {
      event.preventDefault(); if (busy || conflicted || !config) return;
      lock(true); status(copy.navigationSaving);
      try {
        const response = await fetch('/settings/navigation', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config, updatedAt }) });
        if (response.status === 401) { location.href = '/login'; return; }
        const result = await response.json();
        if (response.ok) {
          config = result.saved.config; updatedAt = result.saved.updatedAt; locales = result.saved.language.locales;
          // The save is acknowledged either way; a failed rebuild names its cause (#297).
          const failed = result.build && result.build.ok === false;
          dirty = false; paint(); status(failed ? copy.navigationBuildFailed + ' ' + BuildReporting.failure(result.build.code) : copy.navigationSaved, true);
        } else if (response.status === 409) { conflicted = true; status(copy.navigationConflict, true); }
        else if (response.status === 400) status(copy.navigationInvalid, true);
        else { conflicted = true; status(copy.navigationFailed, true); }
      } catch { conflicted = true; status(copy.navigationFailed, true); }
      finally { lock(false); }
    });
    $('navigationRebuild').addEventListener('click', async () => {
      if (busy || !await AdminConfirm.ask({ title: copy.identityRebuild, body: copy.navigationRebuildConfirm, confirmLabel: copy.identityRebuild })) return;
      lock(true); status(copy.identityRebuilding);
      try {
        const response = await fetch('/rebuild', { method: 'POST' });
        if (response.status === 401) { location.href = '/login'; return; }
        const result = await response.json();
        status(response.ok && result.ok ? copy.identityRebuilt : copy.navigationRebuildFailed, true);
      } catch { status(copy.navigationRebuildFailed, true); }
      finally { lock(false); }
    });
    return load();
  }
  return { init };
})();
