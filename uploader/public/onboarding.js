// Desk-only checklist. The caller supplies its already-resolved admin role;
// this module neither discovers authentication nor activates itself.
window.Onboarding = (function () {
  const ids = ['account', 'identity', 'photo', 'story', 'publish'];
  const names = ['Account', 'Identity', 'Photo', 'Story', 'Publish'];

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
    if (value.status === 'retired') return { status: 'retired' };
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
      restoreFocus = root.contains(document.activeElement) || openerRoot.contains(document.activeElement);
    }
    function setBusy(value) {
      busy = value;
      root.setAttribute('aria-busy', String(value));
      openerRoot.setAttribute('aria-busy', String(value));
      root.querySelectorAll('button').forEach(function (node) { node.disabled = value; });
      show.disabled = value;
    }
    function render(view) {
      current = view;
      uncertain = false;
      setBusy(false);
      root.hidden = view.status !== 'open';
      openerRoot.hidden = view.status !== 'dismissed';
      body.replaceChildren();
      status.textContent = '';
      if (view.status === 'retired') { focus(fallbackFocus); return; }
      if (view.status === 'dismissed') { focus(show); return; }
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
      focus(heading);
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
