// Inline excerpt suggestion for one unsaved locale, browser-direct to the Story
// Review provider from GET /ai-config. The editor owns the fields and calls
// invalidate() on every edit, locale switch and populate; this controller owns
// the request lifetime and the explicit Apply / Dismiss choice.
// @ai-note Generation never writes the excerpt. Only Apply does, and only while
// the draft still equals the snapshot the suggestion was written from, so a
// late reply can never overwrite an excerpt the author typed meanwhile.
// @ai-warning The provider key lives only in run()'s locals for one request:
// never on `request`, the controller, the DOM, or browser storage.
window.EditorExcerpt = (function () {
  'use strict';

  const COPY_KEYS = [
    'excerptSuggest', 'excerptCancel', 'excerptApply', 'excerptReplace', 'excerptDismiss', 'excerptCount',
    'excerptLoadingSettings', 'excerptGenerating', 'excerptReady', 'excerptApplied', 'excerptCancelled',
    'excerptStale', 'excerptNeedsBody', 'excerptConfigUnavailable', 'excerptConfigInvalid', 'excerptKeyMissing',
    'excerptTimeout', 'excerptRefused', 'excerptInvalidOutput', 'excerptFailed', 'excerptSettingsLink',
    'excerptAskAdmin',
  ];
  const PROVIDERS = ['lm-studio', 'openrouter', 'deepseek', 'custom'];
  const KEYED_PROVIDERS = ['openrouter', 'deepseek'];
  const LOCALES = ['de', 'en'];
  const DRAFT_FIELDS = ['locale', 'identity', 'title', 'markdown', 'excerpt'];
  const CONFIG_TIMEOUT_MS = 15000;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, action, text) {
    const node = element('button', className, text);
    node.type = 'button';
    node.dataset.excerptAction = action;
    return node;
  }

  function sameDraft(a, b) {
    return !!b && DRAFT_FIELDS.every((key) => a[key] === b[key]);
  }

  function validConfig(config) {
    return !!config && typeof config === 'object' && PROVIDERS.includes(config.aiProvider) &&
      typeof config.aiBaseUrl === 'string' && !!config.aiBaseUrl.trim() &&
      typeof config.aiModel === 'string' && !!config.aiModel.trim() && typeof config.reviewPrompt === 'string';
  }

  // GET /ai-config with its own deadline over the headers AND the body read;
  // `signal` cancels it together with the request it belongs to.
  async function readConfig(signal) {
    const ctrl = new AbortController();
    const follow = () => ctrl.abort();
    const timer = setTimeout(follow, CONFIG_TIMEOUT_MS);
    const { promise: aborted, reject } = Promise.withResolvers();
    const rejectAbort = () => reject(new Error('AI settings request aborted'));
    ctrl.signal.addEventListener('abort', rejectAbort, { once: true });
    signal.addEventListener('abort', follow, { once: true });
    if (signal.aborted) follow();
    try {
      return await Promise.race([(async () => {
        const response = await fetch('/ai-config', { cache: 'no-store', signal: ctrl.signal });
        return { status: response.status, config: response.ok ? await response.json() : null };
      })(), aborted]);
    } finally {
      clearTimeout(timer);
      ctrl.signal.removeEventListener('abort', rejectAbort);
      signal.removeEventListener('abort', follow);
    }
  }

  /**
   * options: containers { de, en } (empty elements the controls are appended to),
   * capture(locale) → { identity, locale, title, markdown, excerpt },
   * isCurrent(snapshot), apply(locale, value), on401(), optional isAdmin(),
   * copy (the excerpt* chrome strings). Returns { invalidate }.
   */
  function create(options) {
    const copy = options.copy || {};
    const missing = COPY_KEYS.filter((key) => typeof copy[key] !== 'string');
    if (missing.length) throw new Error('EditorExcerpt copy is missing: ' + missing.join(', '));
    const views = {};
    let active = null;
    let presented = null;
    let applying = false;

    // A private copy, so a later edit cannot mutate what a request compares.
    function capture(locale) {
      let snapshot;
      try { snapshot = options.capture(locale); } catch (_) { return null; }
      if (!snapshot || typeof snapshot !== 'object' || snapshot.locale !== locale ||
          ['title', 'markdown', 'excerpt'].some((key) => typeof snapshot[key] !== 'string')) return null;
      return {
        identity: snapshot.identity, locale, title: snapshot.title, markdown: snapshot.markdown, excerpt: snapshot.excerpt,
      };
    }

    // Both the editor's own rule and a field-by-field re-capture must agree.
    function current(snapshot) {
      return !!options.isCurrent(snapshot) && sameDraft(snapshot, capture(snapshot.locale));
    }

    function owns(request) {
      return active === request && !request.controller.signal.aborted && current(request.snapshot);
    }

    function show(locale, state, message, warn, settings) {
      const view = views[locale];
      if (!view) return;
      const busy = state === 'busy';
      view.root.dataset.excerptState = state;
      view.suggestion.setAttribute('aria-busy', busy ? 'true' : 'false');
      view.status.replaceChildren();
      view.status.className = 'excerpt-assist__status' + (warn ? ' notice-warn' : '');
      if (busy) {
        const spinner = element('span', 'review-spinner');
        spinner.setAttribute('aria-hidden', 'true');
        view.status.appendChild(spinner);
      }
      if (message) view.status.appendChild(element('p', '', message));
      if (settings) {
        if (options.isAdmin && options.isAdmin()) {
          const link = element('a', 'excerpt-assist__settings', copy.excerptSettingsLink);
          link.href = '/admin/settings.html';
          view.status.appendChild(link);
        } else {
          view.status.appendChild(element('p', '', copy.excerptAskAdmin));
        }
      }
      // Never strand keyboard focus on a control that is about to disappear.
      if (busy) {
        view.cancel.hidden = false;
        if (document.activeElement === view.generate) view.cancel.focus();
        view.generate.disabled = true;
      } else {
        view.generate.disabled = false;
        if (document.activeElement === view.cancel) view.generate.focus();
        view.cancel.hidden = true;
      }
    }

    function hideSuggestion(locale) {
      const view = views[locale];
      if (!view) return;
      const hadFocus = view.suggestion.contains(document.activeElement);
      view.suggestion.hidden = true;
      view.text.textContent = '';
      view.count.textContent = '';
      if (hadFocus) view.generate.focus();
    }

    // Drop the pending request and the presented suggestion; return their locales.
    function discard() {
      const locales = [];
      if (active) {
        active.controller.abort();
        locales.push(active.locale);
        active = null;
      }
      if (presented) {
        hideSuggestion(presented.snapshot.locale);
        locales.push(presented.snapshot.locale);
        presented = null;
      }
      return locales;
    }

    // The request is no longer ours. If it is still active the draft moved on
    // without an invalidate(): discard it here rather than leave a spinner.
    function stale(request) {
      if (owns(request)) return false;
      if (active === request) {
        request.controller.abort();
        active = null;
        show(request.locale, 'stale', copy.excerptStale);
      }
      return true;
    }

    function present(snapshot, value) {
      const view = views[snapshot.locale];
      presented = { snapshot, value };
      view.text.textContent = value;
      view.count.textContent = copy.excerptCount.replace('{count}', String(value.length));
      view.apply.textContent = snapshot.excerpt.trim() ? copy.excerptReplace : copy.excerptApply;
      view.suggestion.hidden = false;
      show(snapshot.locale, 'presented', copy.excerptReady);
    }

    async function run(request) {
      const locale = request.locale;
      let config = null;
      let apiKey = null;
      let configured = false;
      try {
        const loaded = await readConfig(request.controller.signal);
        config = loaded.config;
        if (stale(request)) return;
        if (loaded.status === 401) {
          active = null;
          show(locale, 'idle', '');
          options.on401();
          return;
        }
        if (!config) {
          active = null;
          show(locale, 'config', copy.excerptConfigUnavailable, true, true);
          return;
        }
        // Detach the key from the response object before any further check.
        apiKey = config.aiApiKey;
        config.aiApiKey = null;
        if (!validConfig(config)) {
          active = null;
          show(locale, 'config', copy.excerptConfigInvalid, true, true);
          return;
        }
        // Local inference never receives a key, whatever the response carried.
        if (config.aiProvider === 'lm-studio' || typeof apiKey !== 'string' || !apiKey.trim()) apiKey = null;
        if (KEYED_PROVIDERS.includes(config.aiProvider) && !apiKey) {
          active = null;
          show(locale, 'config', copy.excerptKeyMissing, true, true);
          return;
        }
        configured = true;
        show(locale, 'busy', copy.excerptGenerating);
        const value = await window.LLM.suggestExcerpt(config.aiBaseUrl, config.aiModel, config.reviewPrompt,
          { locale, title: request.snapshot.title, markdown: request.snapshot.markdown },
          apiKey, config.reviewTimeoutMs, request.controller.signal);
        apiKey = null;
        if (stale(request)) return;
        active = null;
        present(request.snapshot, value);
      } catch (error) {
        if (stale(request)) return;
        active = null;
        // Fixed categories only: provider and config errors can echo drafts or keys.
        const message = error && typeof error.message === 'string' ? error.message : '';
        if (!configured) show(locale, 'config', copy.excerptConfigUnavailable, true, true);
        else if (error && error.name === 'TimeoutError') show(locale, 'error', copy.excerptTimeout, true, false);
        else if (message === 'Excerpt suggestion HTTP 401' || message === 'Excerpt suggestion HTTP 403') {
          show(locale, 'error', copy.excerptRefused, true, true);
        } else if (message === 'Invalid excerpt suggestion response' || message === 'Excerpt suggestion response was truncated') {
          show(locale, 'error', copy.excerptInvalidOutput, true, true);
        } else if (message.startsWith('Invalid excerpt')) show(locale, 'config', copy.excerptConfigInvalid, true, true);
        else show(locale, 'error', copy.excerptFailed, true, true);
      } finally {
        if (config && typeof config === 'object') config.aiApiKey = null;
        apiKey = null;
        config = null;
      }
    }

    function start(locale) {
      discard();
      const snapshot = capture(locale);
      if (!snapshot) {
        show(locale, 'error', copy.excerptFailed, true, false);
        return;
      }
      if (!snapshot.markdown.trim()) {
        show(locale, 'empty', copy.excerptNeedsBody, true, false);
        return;
      }
      const request = { locale, snapshot, controller: new AbortController() };
      active = request;
      show(locale, 'busy', copy.excerptLoadingSettings);
      void run(request);
    }

    function cancel(locale) {
      if (!active || active.locale !== locale) return;
      active.controller.abort();
      active = null;
      show(locale, 'idle', copy.excerptCancelled);
    }

    function applySuggestion(locale) {
      const shown = presented;
      if (!shown || shown.snapshot.locale !== locale) return;
      presented = null;
      if (!current(shown.snapshot)) {
        hideSuggestion(locale);
        show(locale, 'stale', copy.excerptStale);
        return;
      }
      // apply() fires the field's input event, which reaches invalidate().
      applying = true;
      try {
        options.apply(locale, shown.value);
      } finally {
        applying = false;
      }
      hideSuggestion(locale);
      show(locale, 'applied', copy.excerptApplied);
    }

    function dismiss(locale) {
      if (!presented || presented.snapshot.locale !== locale) return;
      presented = null;
      hideSuggestion(locale);
      show(locale, 'idle', '');
    }

    function build(locale, container) {
      const root = element('div', 'excerpt-assist');
      root.dataset.excerptLocale = locale;
      root.dataset.excerptState = 'idle';
      const actions = element('div', 'excerpt-assist__actions');
      const generate = button('btn-secondary excerpt-assist__generate', 'generate', copy.excerptSuggest);
      const stop = button('btn-link excerpt-assist__cancel', 'cancel', copy.excerptCancel);
      stop.hidden = true;
      actions.append(generate, stop);
      const status = element('div', 'excerpt-assist__status');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      const suggestion = element('div', 'excerpt-assist__suggestion');
      suggestion.hidden = true;
      const text = element('p', 'excerpt-assist__text');
      text.id = 'excerpt-suggestion-' + locale;
      text.setAttribute('lang', locale);
      const count = element('p', 'excerpt-assist__count');
      const choices = element('div', 'excerpt-assist__choices');
      const apply = button('btn-secondary', 'apply', copy.excerptApply);
      apply.setAttribute('aria-describedby', text.id);
      const drop = button('btn-link', 'dismiss', copy.excerptDismiss);
      choices.append(apply, drop);
      suggestion.append(text, count, choices);
      root.append(actions, status, suggestion);
      container.appendChild(root);
      generate.addEventListener('click', () => start(locale));
      stop.addEventListener('click', () => cancel(locale));
      apply.addEventListener('click', () => applySuggestion(locale));
      drop.addEventListener('click', () => dismiss(locale));
      return { root, generate, cancel: stop, status, suggestion, text, count, apply };
    }

    for (const locale of LOCALES) {
      const container = options.containers && options.containers[locale];
      if (container) views[locale] = build(locale, container);
    }

    /**
     * Call on every title/body/excerpt edit, locale switch and populate. Drops
     * a pending request and a presented suggestion (saying so in that locale)
     * and clears a past "applied" note. Ignored while Apply writes the field.
     */
    function invalidate() {
      if (applying) return;
      const discarded = discard();
      for (const locale of Object.keys(views)) {
        if (discarded.includes(locale)) show(locale, 'stale', copy.excerptStale);
        else if (views[locale].root.dataset.excerptState === 'applied') show(locale, 'idle', '');
      }
    }

    return { invalidate };
  }

  return { create };
})();
