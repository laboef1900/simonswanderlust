window.SettingsNavigation = (function () {
  function init(publication) {
    const $ = (id) => document.getElementById(id);
    const copy = EditorCopy[document.documentElement.lang === 'de' ? 'de' : 'en'];
    const slots = { header: 5, footer: 8, legal: 4 };
    const names = { header: copy.navigationHeader, footer: copy.navigationFooter, legal: copy.navigationLegal };
    const types = { builtin: copy.navigationBuiltin, page: copy.navigationPage, path: copy.navigationPath, external: copy.navigationExternal };
    const targets = { home: copy.navigationHome, stories: copy.navigationStories, map: copy.navigationMap, regions: copy.navigationRegions,
      about: copy.navigationAbout, contact: copy.navigationContact, privacy: copy.navigationPrivacy, legal: copy.navigationLegalPage };
    let config, updatedAt, locales = [], pages = [], dirty = false, busy = false, conflicted = false;
    const draft = SettingsDrafts.watch('navigation', $('navigationForm'), copy.navigationTab);
    const expanded = new WeakSet();
    const targetKeys = { home: 'navigationHome', stories: 'navigationStories', map: 'navigationMap', regions: 'navigationRegions',
      about: 'navigationAbout', contact: 'navigationContact', privacy: 'navigationPrivacy', legal: 'navigationLegalPage' };
    for (const [id, text] of Object.entries({ navigationHeading: copy.navigationTab, navigationIntro: copy.navigationIntro,
      navigationHelp: copy.navigationLabelHelp, navigationSave: copy.navigationSave, navigationReload: copy.navigationReload,
      navigationRebuild: copy.identityRebuild, navigationSocialHelp: copy.navigationSocial, navigationSocialLink: copy.navigationSocialLink })) $(id).textContent = text;
    function status(text, focus = false) { $('navigationStatus').textContent = text; if (focus) $('navigationStatus').focus(); }
    function lock(value) {
      busy = value;
      $('navigationFields').disabled = value || !config;
      $('navigationSave').disabled = value || !config || conflicted;
      $('navigationReload').disabled = value;
      $('navigationRebuild').disabled = value;
    }
    function element(tag, text, className) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    /** A label that names a language appends its code: "Label (DE)". */
    const localized = (label, locale) => label + ' (' + locale.toUpperCase() + ')';
    function control(parent, id, label, value, choices) {
      const group = element('div');
      const caption = element('label', label); caption.setAttribute('for', id);
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
        const list = element('ol', undefined, 'navigation-links');
        section.append(heading);
        if (!config[slot].length) section.append(element('p', copy.navigationEmpty, 'muted'));
        config[slot].forEach((item, index) => {
          const id = 'nav-' + slot + '-' + index;
          const row = element('li');
          // The row header is text; the one disclosure control is the Edit link
          // button in the action group, which owns the editor's expanded state.
          const link = element('div', undefined, 'navigation-link');
          link.id = id + '-link';
          const head = element('div', undefined, 'navigation-link-head');
          const title = element('span', undefined, 'navigation-link-title');
          const labels = element('span', undefined, 'navigation-link-labels');
          head.append(title, labels);
          const editor = element('div', undefined, 'navigation-fields');
          editor.id = id + '-editor';
          // Focus headed into one of the editor's fields opens it; focus on a row action does not.
          const inEditor = Boolean(focusId && focusId.startsWith(id + '-') && !['edit', 'up', 'down', 'remove'].includes(focusId.slice(id.length + 1)));
          const open = expanded.has(item) || inEditor;
          editor.hidden = !open;
          link.classList.toggle('is-open', open);
          link.append(head, editor);
          const refreshSummary = () => {
            title.textContent = targets[item.target] || item.href?.[locales[0]] || copy.settingsNavigationNew;
            labels.textContent = locales.map((locale) => {
              const fallback = EditorCopy[locale][targetKeys[item.target]] || copy.navigationMissing;
              return locale.toUpperCase() + ': ' + (item.label?.[locale] || fallback);
            }).join(' · ');
          };
          refreshSummary();
          const pair = element('div', undefined, 'settings-field-pair');
          const kind = control(pair, id + '-kind', copy.navigationKind, item.kind, types);
          kind.addEventListener('change', () => {
            config[slot][index] = kind.value === 'builtin' || kind.value === 'page'
              ? { kind: kind.value, target: kind.value === 'page' ? 'about' : 'home', label: item.label || {} }
              : { kind: kind.value, href: item.href || {}, label: item.label || {} };
            expanded.add(config[slot][index]);
            dirty = true; draft.mark(); paint(id + '-kind');
          });
          if (item.kind === 'builtin' || item.kind === 'page') {
            const allowed = item.kind === 'builtin' ? ['home', 'stories', 'map', 'regions'] : ['about', 'contact', 'privacy', 'legal'];
            const target = control(pair, id + '-target', copy.navigationTarget, item.target, Object.fromEntries(allowed.map((key) => [key, targets[key]])));
            target.addEventListener('change', () => { item.target = target.value; dirty = true; draft.mark(); paint(id + '-target'); });
          }
          editor.append(pair);
          for (const locale of locales) {
            const localeLabel = locale === 'de' ? copy.identityGerman : copy.identityEnglish;
            const fields = element('div', undefined, 'settings-field-pair');
            const label = control(fields, id + '-label-' + locale, localized(copy.navigationLabel, locale), item.label?.[locale]);
            label.addEventListener('input', () => {
              item.label ||= {}; if (label.value) item.label[locale] = label.value; else delete item.label[locale]; dirty = true; refreshNotice(); refreshSummary();
            });
            if (item.kind === 'path' || item.kind === 'external') {
              const href = control(fields, id + '-href-' + locale, localized(copy.navigationHref, locale), item.href[locale]);
              href.addEventListener('input', () => { if (href.value) item.href[locale] = href.value; else delete item.href[locale]; dirty = true; refreshNotice(); refreshSummary(); });
            }
            editor.append(fields);
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
          row.append(link);
          const actions = element('div', undefined, 'form-actions');
          const edit = element('button', copy.settingsNavigationEdit, 'btn-secondary');
          edit.type = 'button'; edit.id = id + '-edit';
          edit.setAttribute('aria-expanded', open ? 'true' : 'false');
          edit.setAttribute('aria-controls', editor.id);
          edit.setAttribute('aria-label', copy.settingsNavigationEdit + ' · ' + names[slot] + ' · ' + (index + 1));
          edit.addEventListener('click', () => {
            const show = editor.hidden;
            editor.hidden = !show;
            link.classList.toggle('is-open', show);
            edit.setAttribute('aria-expanded', show ? 'true' : 'false');
            if (show) expanded.add(item); else expanded.delete(item);
          });
          actions.append(edit);
          for (const [action, text] of [['up', copy.identityMoveUp], ['down', copy.identityMoveDown], ['remove', copy.identityRemoveLink]]) {
            const button = element('button', text, action === 'remove' ? 'btn-remove' : 'btn-secondary');
            button.type = 'button'; button.id = id + '-' + action;
            button.setAttribute('aria-label', text + ' · ' + names[slot] + ' · ' + (index + 1));
            button.disabled = action === 'up' && index === 0 || action === 'down' && index === config[slot].length - 1;
            button.addEventListener('click', async () => {
              if (busy) return;
              if (action === 'remove') {
                if (!await AdminConfirm.ask({ title: text, body: names[slot] + ' · ' + (item.label?.[locales[0]] || targets[item.target] || item.href?.[locales[0]] || (index + 1)) + '\n' + copy.navigationRemoveConfirm, confirmLabel: text, danger: true })) return;
                config[slot].splice(index, 1); dirty = true; draft.mark(); paint('nav-add-' + slot);
              } else {
                const next = index + (action === 'up' ? -1 : 1);
                [config[slot][index], config[slot][next]] = [config[slot][next], config[slot][index]];
                // The moved row keeps its expanded editor and the pressed control's focus.
                const edge = action === 'up' && next === 0 ? 'down' : action === 'down' && next === config[slot].length - 1 ? 'up' : action;
                dirty = true; draft.mark(); paint('nav-' + slot + '-' + next + '-' + edge);
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
          const item = { kind: 'builtin', target: 'home' };
          config[slot].push(item); expanded.add(item); dirty = true; draft.mark();
          paint('nav-' + slot + '-' + (config[slot].length - 1) + '-kind');
        });
        section.append(list, add); root.append(section);
      }
      if (focusId) $(focusId)?.focus();
    }
    async function load() {
      const restore = AdminFocus.hold($('navigationReload'));
      lock(true); status(copy.navigationLoading);
      try {
        const responses = await Promise.all([fetch('/settings/navigation', { cache: 'no-store' }), fetch('/pages', { cache: 'no-store' })]);
        if (responses.some((response) => response.status === 401)) { location.href = '/login'; return; }
        if (responses.some((response) => !response.ok)) throw new Error('load');
        const [data, catalogue] = await Promise.all(responses.map((response) => response.json()));
        config = data.config; updatedAt = data.updatedAt; locales = data.language.locales; pages = catalogue.pages;
        const social = $('navigationSocial'); social.replaceChildren();
        for (const link of data.socialLinks) social.append(element('li', link.label + ' — ' + link.url));
        dirty = conflicted = false; paint(); draft.clean(); status('');
      } catch { status(copy.navigationLoadFailed, true); }
      finally { lock(false); restore(); }
    }
    $('navigationReload').addEventListener('click', async () => {
      if (busy || dirty && !await AdminConfirm.ask({ title: copy.navigationReload, body: copy.navigationReloadConfirm, confirmLabel: copy.navigationReload })) return;
      await load(); $('navigationReload').focus();
    });
    $('navigationForm').addEventListener('submit', async (event) => {
      event.preventDefault(); if (busy || conflicted || !config) return;
      const restore = AdminFocus.hold($('navigationSave'));
      lock(true); publication.beginAction(); status(copy.navigationSaving);
      try {
        const response = await fetch('/settings/navigation', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config, updatedAt }) });
        if (response.status === 401) { location.href = '/login'; return; }
        const result = await response.json();
        if (response.ok) {
          config = result.saved.config; updatedAt = result.saved.updatedAt; locales = result.saved.language.locales;
          dirty = false; paint(); draft.clean(); BuildReporting.renderOutcome($('navigationStatus'), 'navigation', result); $('navigationStatus').focus();
        } else if (response.status === 409) { conflicted = true; status(copy.navigationConflict, true); }
        else if (response.status === 400) status(copy.navigationInvalid, true);
        else { conflicted = true; status(BuildReporting.text('unknown'), true); }
      } catch { conflicted = true; status(BuildReporting.text('unknown'), true); }
      finally { lock(false); publication.endAction(); restore($('navigationStatus')); }
    });
    $('navigationRebuild').addEventListener('click', async () => {
      if (busy || !await AdminConfirm.ask({ title: copy.identityRebuild, body: copy.navigationRebuildConfirm, confirmLabel: copy.identityRebuild, tone: 'publish' })) return;
      const restore = AdminFocus.hold($('navigationRebuild'));
      lock(true); publication.beginAction(); status(copy.identityRebuilding);
      try {
        const response = await fetch('/rebuild', { method: 'POST' });
        if (response.status === 401) { location.href = '/login'; return; }
        const result = await response.json();
        if (response.ok) { BuildReporting.renderOutcome($('navigationStatus'), 'rebuild', result); $('navigationStatus').focus(); }
        else status(BuildReporting.text('unknown'), true);
      } catch { status(BuildReporting.text('unknown'), true); }
      finally { lock(false); publication.endAction(); restore($('navigationStatus')); }
    });
    return load();
  }
  return { init };
})();
