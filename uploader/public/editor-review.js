// Advisory review of one unsaved locale. The editor owns fields/slug rules;
// this controller owns the dialog, request lifetime, and explicit review actions.
window.EditorReview = (function () {
  'use strict';

  const quickChecks = [
    ['title', 'Title length'], ['excerpt', 'Excerpt length'],
    ['headings', 'Heading hierarchy'], ['altText', 'Alt text'],
    ['internalLinks', 'Internal links'],
  ];
  const semanticChecks = [
    ['title', 'Title'], ['excerpt', 'Excerpt'], ['headings', 'Headings'],
    ['practicalDetails', 'Practical details'], ['internalLinks', 'Internal links'],
  ];
  const statusLabels = { pass: 'Pass', warn: 'Warning', info: 'Suggestion' };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function card(criterion, title, status) {
    const node = element('article', 'review-card');
    node.dataset.reviewCriterion = criterion;
    const head = element('div', 'review-card__head');
    head.appendChild(element('h4', '', title));
    head.appendChild(element('span', 'status-badge review-badge review-badge--' + status, statusLabels[status]));
    node.appendChild(head);
    return node;
  }

  function create(options) {
    const byId = (id) => document.getElementById(id);
    const dialog = byId('storyReviewDialog');
    const trigger = byId('reviewStory');
    const closeButton = byId('closeReview');
    const runButton = byId('runReview');
    const instant = byId('reviewInstant');
    const semantic = byId('reviewSemantic');
    const status = byId('reviewStatus');
    let epoch = 0;
    let active = null;
    let applying = false;
    let queuedCloseEvents = 0;

    function owns(request) {
      return active === request && request.epoch === epoch && dialog.open &&
        !request.controller.signal.aborted && options.isCurrent(request.snapshot);
    }

    function release() {
      epoch = (epoch + 1) % Number.MAX_SAFE_INTEGER;
      if (active) active.controller.abort();
      active = null;
      semantic.setAttribute('aria-busy', 'false');
    }

    function clearResults() {
      instant.replaceChildren();
      semantic.replaceChildren();
      status.replaceChildren();
      status.className = 'review-status';
      byId('reviewLocale').textContent = '';
    }

    function close(restoreFocus) {
      release();
      clearResults();
      if (dialog.open) {
        // Native close events are queued. Consume THIS event even if another
        // review opens first; a late close must not cancel it or steal jump focus.
        queuedCloseEvents++;
        dialog.close();
      }
      if (restoreFocus) trigger.focus();
    }

    function invalidate() {
      // input still reaches DraftGuard and slugAuto during our explicit apply.
      // Only this synchronous action keeps the other suggestions usable.
      if (!applying && (active || dialog.open)) close(false);
    }

    function say(message, loading) {
      status.replaceChildren();
      status.className = 'review-status';
      semantic.setAttribute('aria-busy', loading ? 'true' : 'false');
      if (loading) {
        const spinner = element('span', 'review-spinner');
        spinner.setAttribute('aria-hidden', 'true');
        status.appendChild(spinner);
      }
      status.appendChild(element('p', '', message));
    }

    function unavailable(message, settings) {
      say(message, false);
      status.className = 'review-status notice-warn';
      status.appendChild(element('span', 'status-badge review-badge review-badge--warn', 'Warning'));
      if (settings) {
        if (options.isAdmin()) {
          const link = element('a', 'review-settings-link', 'Open AI settings');
          link.href = '/admin/settings.html';
          status.appendChild(link);
        } else {
          status.appendChild(element('p', '', 'Ask an administrator to check AI settings, then choose Review again.'));
        }
      }
    }

    function jumpButton(request, finding) {
      if (finding.target !== 'hero' && (!Number.isInteger(finding.line) || finding.line < 1)) return null;
      const button = element('button', 'btn-link review-jump', finding.target === 'hero' ? 'Go to hero alt text' : 'Go to line ' + finding.line);
      button.type = 'button';
      button.dataset.reviewAction = 'jump';
      if (finding.target === 'hero') button.dataset.target = 'hero';
      else button.dataset.line = String(finding.line);
      button.addEventListener('click', () => {
        if (!owns(request)) return;
        const locale = request.snapshot.story.locale;
        close(false);
        options.jump(locale, finding);
      });
      return button;
    }

    function renderInstant(request) {
      const result = window.EditorLinter.lintStory(request.snapshot.story);
      instant.replaceChildren();
      for (const [key, title] of quickChecks) {
        const check = result[key];
        const node = card(key, title, check.status);
        if (key === 'title' || key === 'excerpt') {
          const range = key === 'title' ? '20–70' : '100–160';
          node.appendChild(element('p', 'review-count', check.count + ' characters · aim for ' + range));
          if (check.message) node.appendChild(element('p', '', check.message));
        } else {
          if (key === 'internalLinks') {
            node.appendChild(element('p', 'review-count', check.count + (check.count === 1 ? ' relative link found' : ' relative links found')));
          }
          if (check.findings.length) {
            const list = element('ul', 'review-findings');
            for (const finding of check.findings) {
              const item = element('li');
              item.appendChild(element('p', '', finding.message));
              const jump = jumpButton(request, finding);
              if (jump) item.appendChild(jump);
              list.appendChild(item);
            }
            node.appendChild(list);
          } else if (key !== 'internalLinks') {
            node.appendChild(element('p', '', key === 'headings'
              ? 'No skipped levels or body H1 headings found.'
              : 'No missing alt text found in the checked images.'));
          }
        }
        instant.appendChild(node);
      }
    }

    function suggestion(request, node, field, value, index) {
      if (!value.trim()) return;
      const group = element('div', 'review-suggestion');
      const text = element('p', 'review-suggestion__text', value);
      text.id = 'review-suggestion-' + request.epoch + '-' + field + '-' + index;
      text.lang = request.snapshot.story.locale;
      group.appendChild(text);
      const label = 'Apply suggested ' + field;
      const button = element('button', 'btn-secondary', label);
      button.type = 'button';
      button.dataset.reviewAction = field;
      button.setAttribute('aria-describedby', text.id);
      button.addEventListener('click', () => {
        if (!owns(request)) return;
        applying = true;
        try {
          options.apply(request.snapshot.story.locale, field, value);
        } finally {
          applying = false;
        }
        if (!owns(request)) return;
        // If a different title is chosen, only the current choice says Applied.
        for (const other of semantic.querySelectorAll('[data-review-action="' + field + '"]')) {
          other.disabled = false;
          other.textContent = label;
        }
        button.disabled = true;
        button.textContent = 'Applied ' + field;
        say('Suggested ' + field + ' applied to this draft. Nothing has been saved; other suggestions still refer to the reviewed snapshot.', false);
      });
      group.appendChild(button);
      node.appendChild(group);
    }

    function renderSemantic(request, result) {
      semantic.replaceChildren();
      for (const [key, title] of semanticChecks) {
        const check = result[key];
        const node = card(key, title, check.status);
        if (check.critique) {
          const critique = element('p', '', check.critique);
          critique.lang = request.snapshot.story.locale;
          node.appendChild(critique);
        }
        const items = key === 'practicalDetails' ? check.missingAspects : key === 'internalLinks' ? check.linkOpportunities : [];
        if (items.length) {
          const list = element('ul', 'review-findings');
          list.lang = request.snapshot.story.locale;
          for (const item of items) list.appendChild(element('li', '', item));
          node.appendChild(list);
        } else if (key === 'internalLinks') {
          node.appendChild(element('p', '', 'No additional link opportunities suggested.'));
        }
        if (key === 'title') (check.suggestions || []).forEach((value, index) => suggestion(request, node, key, value, index));
        if (key === 'excerpt' && check.suggestedExcerpt) suggestion(request, node, key, check.suggestedExcerpt, 0);
        semantic.appendChild(node);
      }
    }

    async function review(request) {
      let config = null;
      let apiKey = null;
      let configured = false;
      try {
        const response = await fetch('/ai-config', { cache: 'no-store', signal: request.controller.signal });
        if (!owns(request)) return;
        if (response.status === 401) {
          invalidate();
          options.on401();
          return;
        }
        if (!response.ok) {
          unavailable('AI review settings could not be loaded. Quick checks are still available. Check the configuration and choose Review again.', true);
          return;
        }
        config = await response.json();
        if (!owns(request)) return;
        if (!config || !['lm-studio', 'openrouter', 'deepseek', 'custom'].includes(config.aiProvider) ||
            typeof config.aiBaseUrl !== 'string' || !config.aiBaseUrl.trim() ||
            typeof config.aiModel !== 'string' || !config.aiModel.trim() || typeof config.reviewPrompt !== 'string') {
          unavailable('AI review needs a valid provider, endpoint and model in AI settings. Quick checks are still available.', true);
          return;
        }
        apiKey = config.aiApiKey;
        config.aiApiKey = null;
        if (['openrouter', 'deepseek'].includes(config.aiProvider) && (typeof apiKey !== 'string' || !apiKey.trim())) {
          unavailable('AI review needs an API key for the selected provider. Configure the key in AI settings, then choose Review again. Quick checks are still available.', true);
          return;
        }
        configured = true;
        say('Reviewing this draft with the configured model… Quick checks are ready below their headings.', true);
        const result = await window.LLM.reviewStory(config.aiBaseUrl, config.aiModel, config.reviewPrompt,
          request.snapshot.story, apiKey, config.reviewTimeoutMs, request.controller.signal);
        if (!owns(request)) return;
        renderSemantic(request, result);
        say('Editorial review complete. Apply only the suggestions you want; nothing has been saved.', false);
      } catch (error) {
        if (!owns(request)) return;
        // Never display arbitrary provider/config errors: they can echo a draft
        // or a credential. The client exposes these fixed failure categories.
        if (!configured) {
          unavailable('AI review settings are unavailable. Check your connection and AI settings, then choose Review again. Quick checks are still available.', true);
        } else if (error.name === 'TimeoutError') {
          unavailable('AI review timed out. Check that the model is running, then choose Review again. Quick checks are still available.', false);
        } else if (error.message === 'Editorial review HTTP 401' || error.message === 'Editorial review HTTP 403') {
          unavailable('The AI provider refused access. Check the API key and model permissions in AI settings, then choose Review again. Quick checks are still available.', true);
        } else if (error.message === 'Invalid editorial review response' || error.message === 'Editorial review response was truncated') {
          unavailable('The model did not return a complete structured review. Choose Review again or check the model in AI settings. Quick checks are still available.', true);
        } else {
          unavailable('AI review could not connect or complete. Check the endpoint, model and browser CORS access in AI settings, then choose Review again. Quick checks are still available.', true);
        }
      } finally {
        if (config && typeof config === 'object') config.aiApiKey = null;
        apiKey = null;
        config = null;
      }
    }

    function open() {
      release();
      clearResults();
      const request = { epoch, controller: new AbortController(), snapshot: options.capture() };
      active = request;
      byId('reviewLocale').textContent = request.snapshot.story.locale === 'de' ? 'Deutsch · DE' : 'English · EN';
      if (!dialog.open) dialog.showModal();
      renderInstant(request);
      dialog.querySelector('.story-review__body').scrollTop = 0;
      say('Loading AI review settings… Quick checks are ready.', true);
      closeButton.focus();
      void review(request);
    }

    trigger.addEventListener('click', open);
    runButton.addEventListener('click', open);
    closeButton.addEventListener('click', () => close(true));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(true); });
    dialog.addEventListener('close', () => {
      if (queuedCloseEvents) { queuedCloseEvents--; return; }
      if (!dialog.open) { release(); clearResults(); trigger.focus(); }
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
      if (event.key !== 'Tab') return;
      // Recompute on each Tab: suggestions and settings links arrive async.
      const controls = Array.from(dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]'))
        .filter((node) => !node.disabled && node.tabIndex >= 0 && !node.closest('[hidden]'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (!controls.includes(document.activeElement) || (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    });

    return { open, invalidate };
  }

  return { create };
})();
