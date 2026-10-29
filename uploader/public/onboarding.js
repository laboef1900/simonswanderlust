// Desk-only checklist. The caller supplies its already-resolved admin role;
// this module neither discovers authentication nor activates itself.
window.Onboarding = (function () {
  const ids = ['account', 'identity', 'photo', 'story', 'publish'];
  const names = ['Account', 'Identity', 'Photo', 'Story', 'Publish'];
  const modes = [
    { primary: 'de', locales: ['de'], label: 'languageModeDeOnly' },
    { primary: 'en', locales: ['en'], label: 'languageModeEnOnly' },
    { primary: 'de', locales: ['de', 'en'], label: 'languageModeDeBoth' },
    { primary: 'en', locales: ['en', 'de'], label: 'languageModeEnBoth' },
  ];
  function sameMode(a, b) {
    return a.primary === b.primary && a.locales.length === b.locales.length
      && a.locales.every(function (locale) { return b.locales.includes(locale); });
  }
  function languageFrom(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'locales,lockedAt,primary,updatedAt'
      || !Array.isArray(value.locales) || !modes.some(function (mode) { return sameMode(mode, value); })
      || new Set(value.locales).size !== value.locales.length
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
      || (value.lockedAt !== null && (typeof value.lockedAt !== 'string' || !Number.isFinite(Date.parse(value.lockedAt))))) {
      throw new Error('unavailable');
    }
    return value;
  }

  function editorLink(href) {
    if (typeof href !== 'string' || !href.startsWith('/admin/editor.html?tk=')) return false;
    const key = href.slice('/admin/editor.html?tk='.length);
    try { return key.length > 0 && encodeURIComponent(decodeURIComponent(key)) === key; }
    catch { return false; }
  }

  function validHref(id, href) {
    if (id === 'account') return href === null;
    if (id === 'identity') return href === '/admin/settings.html#identity';
    if (id === 'photo') return href === '/admin/media.html';
    if (id === 'story') return href === '/admin/editor.html' || editorLink(href);
    return href === '/admin/posts.html' || editorLink(href);
  }

  function viewFrom(value) {
    if (!value || typeof value !== 'object') throw new Error('unavailable');
    if (value.status === 'retired') {
      if (Object.keys(value).length !== 1) throw new Error('unavailable');
      return { status: 'retired' };
    }
    if (Object.keys(value).sort().join(',') !== 'complete,language,status,steps') throw new Error('unavailable');
    languageFrom(value.language);
    if (!['open', 'dismissed'].includes(value.status) || typeof value.complete !== 'boolean'
      || !Array.isArray(value.steps) || value.steps.length !== ids.length) throw new Error('unavailable');
    value.steps.forEach(function (step, index) {
      const states = index === 2 ? ['done', 'todo', 'in_progress', 'attention'] : ['done', 'todo'];
      if (!step || step.id !== ids[index] || !states.includes(step.state)
        || step.required !== (index >= 2) || !validHref(step.id, step.href)
        || (index === 0 && step.state !== 'done')) throw new Error('unavailable');
    });
    if (value.complete !== value.steps.slice(2).every(function (step) { return step.state === 'done'; })) {
      throw new Error('unavailable');
    }
    return value;
  }

  function init(options) {
    const root = options.root;
    const openerRoot = options.openerRoot;
    root.hidden = true;
    openerRoot.hidden = true;
    root.replaceChildren();
    openerRoot.replaceChildren();
    // Strict true prevents an unresolved context/promise or author object from
    // accidentally causing an admin-only request. The server still authorizes.
    if (options.isAdmin !== true) return { ready: Promise.resolve(), reload: function () { return Promise.resolve(); } };

    const copy = window.EditorCopy[document.documentElement.lang === 'de' ? 'de' : 'en'];
    let current = null;
    let busy = false;
    let uncertain = false;
    let restoreFocus = false;
    let selection = null;
    let selectionDirty = false;
    let languageNotice = '';
    let languageRecovery = false;
    let languageSettings = false;
    let languageFocus = false;
    const fallbackFocus = options.focusTarget || document.querySelector('.cms-page-title, h1');
    root.classList.add('onboarding');
    openerRoot.classList.add('onboarding-opener');
    root.setAttribute('aria-label', copy.onboardingTitle);

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function text(key, values = {}) {
      return copy[key].replace(/\{(\w+)\}/g, function (match, name) { return values[name] ?? match; });
    }
    function modeName(mode) {
      return copy[modes.find(function (item) { return sameMode(item, mode); }).label];
    }
    function consequences(mode) {
      return ['de', 'en'].map(function (locale) {
        const path = window.SiteLanguage.publicPath(mode, locale, 'home');
        const language = copy[locale === 'de' ? 'languageGerman' : 'languageEnglish'];
        return path === null ? text('onboardingLanguageAbsent', { language })
          : text(locale === mode.primary ? 'onboardingLanguagePrimary' : 'onboardingLanguageSecondary', { language, path });
      }).join(' ');
    }
    function languageScope(next) {
      const stored = current.language;
      let key = 'languageScopeSame';
      if (next.primary !== stored.primary) key = 'languageScopePrimary';
      else if (next.locales.length < stored.locales.length) key = 'languageScopeDisable';
      else if (next.locales.length > stored.locales.length) key = 'languageScopeAdd';
      return text(key, { locale: next.locales.find(function (locale) { return !stored.locales.includes(locale); }) })
        + (next.primary !== stored.primary && next.locales.length < stored.locales.length ? ' ' + copy.languageScopeDisable : '')
        + ' ' + consequences(next);
    }
    const heading = element('h2', 'desk-heading', copy.onboardingTitle);
    heading.tabIndex = -1;
    const status = element('p', 'onboarding-status muted');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    const body = element('div', 'onboarding-body');
    root.append(heading, status, body);

    function button(text, action, handler) {
      const node = element('button', 'btn-secondary', text);
      node.type = 'button';
      node.dataset.onboardingAction = action;
      node.addEventListener('click', handler);
      return node;
    }
    const show = button(copy.onboardingShow, 'resume', function () { change('resume'); });
    openerRoot.appendChild(show);

    function focus(node) {
      if (!restoreFocus || !node) return;
      if (node === fallbackFocus) node.tabIndex = -1;
      node.focus();
      restoreFocus = false;
    }
    function captureFocus() {
      restoreFocus ||= root.contains(document.activeElement) || openerRoot.contains(document.activeElement);
    }
    function setBusy(value) {
      busy = value;
      root.setAttribute('aria-busy', String(value));
      openerRoot.setAttribute('aria-busy', String(value));
      root.querySelectorAll('button').forEach(function (node) { node.disabled = value; });
      show.disabled = value;
      root.querySelectorAll('fieldset').forEach(function (node) {
        node.disabled = value || !current || current.status !== 'open' || current.language.lockedAt !== null;
      });
    }
    function languageSection(view) {
      const row = element('li', 'onboarding-step onboarding-language');
      const detail = element('div', 'onboarding-detail');
      const title = element('h3', 'onboarding-step-label', copy.languageHeading);
      title.id = 'onboardingLanguageHeading';
      title.tabIndex = -1;
      detail.append(title, element('span', 'onboarding-optional', copy.onboardingOptional));
      detail.appendChild(element('p', 'onboarding-language-current', text('onboardingLanguageCurrent', {
        mode: modeName(view.language), consequences: consequences(view.language),
      })));
      const message = element('p', 'onboarding-language-status muted', languageNotice);
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');
      message.setAttribute('aria-atomic', 'true');
      if (view.language.lockedAt !== null) {
        detail.appendChild(element('p', 'muted', text('languageLocked', { date: new Date(view.language.lockedAt).toLocaleString() })));
        const settings = element('a', '', copy.onboardingLanguageSettings);
        settings.href = '/admin/settings.html#language';
        detail.appendChild(settings);
      } else {
        if (!selectionDirty) selection = view.language;
        const form = element('form', 'onboarding-language-form');
        const fields = element('fieldset');
        fields.appendChild(element('legend', '', copy.languageMode));
        modes.forEach(function (mode, index) {
          const label = element('label', 'onboarding-language-choice');
          const radio = element('input');
          radio.type = 'radio';
          radio.setAttribute('name', 'onboarding-language');
          radio.value = String(index);
          radio.checked = sameMode(selection, mode);
          const descriptionId = 'onboardingLanguageDescription' + index;
          radio.setAttribute('aria-describedby', descriptionId);
          radio.addEventListener('change', function () {
            if (!busy && radio.checked) { selection = mode; selectionDirty = true; }
          });
          const words = element('span');
          words.appendChild(element('span', '', copy[mode.label]));
          const description = element('span', 'muted', consequences(mode));
          description.id = descriptionId;
          words.appendChild(description);
          label.append(radio, words);
          fields.appendChild(label);
        });
        const actions = element('div', 'form-actions');
        const save = button(copy.onboardingLanguageSave, 'language-save', function () { saveLanguage(); });
        save.className = '';
        actions.appendChild(save);
        fields.appendChild(actions);
        form.appendChild(fields);
        form.addEventListener('submit', function (event) { event.preventDefault(); saveLanguage(); });
        detail.appendChild(form);
      }
      detail.appendChild(message);
      if (languageSettings && view.language.lockedAt === null) {
        const settings = element('a', '', copy.languageBack);
        settings.href = '/admin/settings.html#language';
        detail.appendChild(settings);
      }
      if (languageRecovery) {
        const recovery = element('a', '', copy.languageRebuildLink);
        recovery.href = '/admin/settings.html#site';
        detail.appendChild(recovery);
      }
      row.appendChild(detail);
      return row;
    }
    function render(view) {
      current = view;
      uncertain = false;
      setBusy(false);
      root.hidden = view.status !== 'open';
      openerRoot.hidden = view.status !== 'dismissed';
      body.replaceChildren();
      status.textContent = '';
      if (view.status === 'retired') { languageFocus = false; focus(fallbackFocus); return; }
      if (view.status === 'dismissed') { languageFocus = false; focus(show); return; }
      status.textContent = copy.onboardingProgress.replace('{done}', String(view.steps.slice(2).filter(function (step) {
        return step.state === 'done';
      }).length));
      body.appendChild(element('p', 'onboarding-intro', copy.onboardingIntro));
      const list = element('ol', 'onboarding-steps');
      const stateCopy = { done: copy.onboardingDone, todo: copy.onboardingTodo,
        in_progress: copy.onboardingProcessing, attention: copy.onboardingAttention };
      view.steps.forEach(function (step, index) {
        const row = element('li', 'onboarding-step');
        row.dataset.step = step.id;
        row.dataset.state = step.state;
        // Static authored geometry only; API data never reaches HTML.
        const icon = element('span', 'onboarding-icon');
        icon.setAttribute('aria-hidden', 'true');
        const paths = {
          done: '<path d="m5 12 4 4L19 6"/>',
          todo: '<circle cx="12" cy="12" r="8"/>',
          in_progress: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
          attention: '<path d="m12 3 10 18H2Z M12 9v5 M12 17v1"/>',
        };
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + paths[step.state] + '</svg>';
        const detail = element('div', 'onboarding-detail');
        const label = element(step.href === null ? 'span' : 'a', 'onboarding-step-label', copy['onboarding' + names[index]]);
        if (step.href !== null) label.href = step.href;
        detail.appendChild(label);
        if (step.id === 'identity') detail.appendChild(element('span', 'onboarding-optional', copy.onboardingOptional));
        detail.appendChild(element('p', 'onboarding-step-status muted', stateCopy[step.state]));
        row.append(icon, detail);
        list.appendChild(row);
        if (step.id === 'account') list.appendChild(languageSection(view));
      });
      body.appendChild(list);
      if (view.complete) body.appendChild(element('p', 'onboarding-complete', copy.onboardingComplete));
      const actions = element('div', 'onboarding-actions');
      if (view.complete) {
        const finish = button(copy.onboardingFinish, 'finish', function () { change('finish'); });
        finish.className = 'btn-publish';
        actions.appendChild(finish);
      }
      actions.appendChild(button(copy.onboardingHide, 'dismiss', function () { change('dismiss'); }));
      actions.appendChild(button(copy.onboardingRefresh, 'refresh', reload));
      body.append(actions, element('p', 'onboarding-help muted', copy.onboardingHideHelp));
      if (languageFocus) {
        focus(root.querySelector('[data-onboarding-action="language-save"]') || root.querySelector('#onboardingLanguageHeading'));
        languageFocus = false;
      } else focus(heading);
    }

    function unavailable() {
      current = null;
      setBusy(false);
      root.hidden = false;
      openerRoot.hidden = true;
      body.replaceChildren();
      status.textContent = uncertain ? copy.onboardingUncertain : copy.onboardingUnavailable;
      const retry = button(copy.onboardingRetry, 'retry', reload);
      body.appendChild(retry);
      focus(retry);
    }

    const load = window.Desk.resilientLoader(async function () {
      const response = await fetch('/onboarding', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      return viewFrom(await response.json());
    }, {
      loading: function () {
        captureFocus();
        setBusy(true);
        root.hidden = false;
        openerRoot.hidden = true;
        body.replaceChildren();
        status.textContent = copy.onboardingLoading;
      },
      ready: render,
      unavailable,
    });

    function reload() {
      if (busy) return Promise.resolve();
      return load();
    }

    async function saveLanguage() {
      if (busy || !current || current.status !== 'open' || current.language.lockedAt !== null || !selection) return;
      const next = { primary: selection.primary, locales: [...selection.locales] };
      captureFocus();
      setBusy(true);
      let sent = false;
      try {
        if (!(await window.AdminConfirm.ask({
          title: copy.languageChangeTitle, body: languageScope(next), confirmLabel: copy.onboardingLanguageSave,
        }))) return;
        languageNotice = copy.saveSaving;
        root.querySelector('.onboarding-language-status').textContent = languageNotice;
        sent = true;
        selectionDirty = true;
        languageSettings = false;
        const response = await fetch('/language', {
          method: 'PUT', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        });
        const result = await response.json();
        if (response.ok || (response.status === 502 && result.code === 'language_build_failed' && result.persisted === true)) {
          const saved = languageFrom(response.ok ? result : result.language);
          if (!sameMode(saved, next)) throw new Error('unavailable');
          selection = saved;
          selectionDirty = false;
          languageRecovery = !response.ok;
          languageNotice = response.ok
            ? (sameMode(current.language, next) ? copy.onboardingLanguageAccepted : copy.onboardingLanguageSaved)
            : copy.languageBuildFailed;
        } else {
          const key = (response.status === 400 || response.status === 409) && {
            language_primary_locked: 'languagePrimaryLocked', language_locale_published: 'languageLocaleLocked',
            language_pages_incomplete: 'languagePagesIncomplete', invalid_language: 'onboardingLanguageInvalid',
            reserved_slug: 'onboardingLanguageReserved',
          }[result.code];
          languageSettings = result.code === 'language_pages_incomplete' || result.code === 'reserved_slug';
          languageNotice = key ? copy[key] : copy.onboardingLanguageUncertain;
        }
      } catch {
        languageNotice = copy.onboardingLanguageUncertain;
      } finally {
        setBusy(false);
        if (sent) {
          // Reconcile eligibility, publication history and current configuration in
          // one authoritative read. Retain the candidate; never replay PUT.
          languageFocus = true;
          await load();
        } else focus(root.querySelector('[data-onboarding-action="language-save"]'));
      }
    }
    async function change(action) {
      if (busy || !current || current.status === 'retired'
        || (action === 'finish' && !current.complete)) return;
      captureFocus();
      setBusy(true);
      try {
        if (action === 'finish') {
          const confirmed = await window.AdminConfirm.ask({
            title: copy.onboardingFinishTitle, body: copy.onboardingFinishBody,
            confirmLabel: copy.onboardingFinishConfirm,
          });
          if (!confirmed) {
            setBusy(false);
            focus(root.querySelector('[data-onboarding-action="finish"]'));
            return;
          }
        }
        status.textContent = copy.onboardingSaving;
        // A failed/unknown acknowledgement never replays the mutation. Retry
        // uses GET so a committed dismiss/finish is reconciled, not guessed.
        uncertain = true;
        const response = await fetch('/onboarding', {
          method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (!response.ok) throw new Error('unavailable');
        const view = viewFrom(await response.json());
        const expected = { dismiss: 'dismissed', resume: 'open', finish: 'retired' };
        if (view.status !== expected[action]) throw new Error('unavailable');
        render(view);
      } catch {
        unavailable();
      }
    }

    return { ready: load(), reload };
  }
  return { init };
})();
