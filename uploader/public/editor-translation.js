/* Explicit, browser-direct translation of one unsaved locale. The server owns
 * source planning/validation; this controller never accepts model-authored fields. */
window.EditorTranslation = (function () {
  'use strict';
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const fields = (draft) => ({ title: draft.title, excerpt: draft.excerpt, bodyMarkdown: draft.bodyMarkdown, images: structuredClone(draft.images) });
  const describe = (config) => {
    if (!config || typeof config.providerId !== 'string' || !config.providerId ||
        typeof config.providerName !== 'string' || !config.providerName ||
        !['lm-studio', 'openrouter', 'deepseek', 'anthropic', 'openai', 'custom'].includes(config.providerKind) || typeof config.model !== 'string' || !config.model.trim() ||
        !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || typeof config.baseUrl !== 'string' ||
        !window.LLM.isTranslationPrompt(config.prompt)) return null;
    let url;
    try { url = new URL(config.baseUrl); } catch (_) { return null; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return { providerId: config.providerId, providerName: config.providerName, providerKind: config.providerKind,
      baseUrl: config.baseUrl, model: config.model, timeoutMs: config.timeoutMs, prompt: config.prompt };
  };

  function create(options) {
    const $ = (id) => document.getElementById(id);
    const copy = options.copy;
    const dialog = $('articleTranslationDialog');
    const trigger = $('translateArticle');
    const run = $('translationRun');
    const apply = $('translationApply');
    const undo = $('translationUndo');
    const close = $('translationClose');
    const status = $('translationStatus');
    const result = $('translationResult');
    const consent = $('translationReplace');
    let epoch = 0;
    let active = null;
    let undoRecord = null;
    let applying = false;
    let queuedCloseEvents = 0;
    const text = (key, values = {}) => Object.entries(values).reduce((value, [name, replacement]) => value.replaceAll('{' + name + '}', replacement), copy[key]);
    const localeName = (locale) => copy[locale === 'de' ? 'translationGerman' : 'translationEnglish'];

    for (const [id, key] of Object.entries({ translateArticle: 'translationAction', translationUndo: 'translationUndo',
      translationClose: 'translationDiscard', translationData: 'translationData', translationLibrary: 'translationLibrary',
      translationTitleLabel: 'translationTitle', translationExcerptLabel: 'translationExcerpt',
      translationBodyLabel: 'translationBody', translationImagesLabel: 'translationImages', translationSettings: 'translationSettings' })) $(id).textContent = copy[key];

    function eligible(snapshot) {
      return !snapshot.blocked && snapshot.locales.length === 2 && snapshot.locales.includes(snapshot.sourceLocale) &&
        snapshot.locales.includes(snapshot.targetLocale) && !snapshot.omitted[snapshot.sourceLocale] && !snapshot.omitted[snapshot.targetLocale];
    }
    function current(request) {
      if (active !== request || request.epoch !== epoch || !dialog.open || request.controller.signal.aborted) return false;
      const snapshot = options.capture();
      if (!eligible(snapshot) || !same(request.snapshot, snapshot)) { invalidate(); return false; }
      return true;
    }
    function release() {
      epoch++;
      active?.controller.abort();
      active = null;
      dialog.setAttribute('aria-busy', 'false');
    }
    function say(message, state) {
      dialog.dataset.state = state;
      status.textContent = message;
      dialog.setAttribute('aria-busy', String(state === 'preparing' || state === 'translating'));
    }
    function clearResult() {
      result.hidden = true;
      for (const id of ['translationTitle', 'translationExcerpt', 'translationBody', 'translationImages']) $(id).value = '';
      consent.checked = false;
      $('translationReplaceRow').hidden = true;
      apply.hidden = true;
      apply.disabled = true;
    }
    function undoContext(snapshot) {
      return { identity: snapshot.identity, formVersion: snapshot.formVersion, base: snapshot.base,
        locales: snapshot.locales, omitted: snapshot.omitted, blocked: snapshot.blocked, recovery: snapshot.recovery };
    }
    function refresh() {
      const snapshot = undoRecord ? options.capture() : options.availability();
      trigger.hidden = snapshot.locales.length !== 2;
      trigger.disabled = snapshot.blocked;
      if (undoRecord && (!same(undoRecord.context, undoContext(snapshot)) ||
          !same(fields(snapshot.draft[undoRecord.locale]), undoRecord.after))) undoRecord = null;
      undo.hidden = !undoRecord;
    }
    function invalidate() {
      if (applying) return;
      const hadRequest = !!active;
      release();
      clearResult();
      run.disabled = false;
      run.hidden = false;
      run.textContent = copy.translationPrepare;
      if (dialog.open && hadRequest) say(copy.translationStale, 'stale');
      refresh();
    }
    function changed(galleryChange = false) {
      if (applying) return;
      // Only the known gallery-alt source transaction may advance a snapshot
      // during flushing. Ordinary typing, programmatic changes and context changes abort.
      if (active?.flushing && galleryChange) active.snapshot = options.capture();
      else invalidate();
    }
    function closeDialog() {
      release();
      clearResult();
      $('translationDestination').textContent = '';
      if (dialog.open) { queuedCloseEvents++; dialog.close(); }
      const target = trigger.hidden || trigger.disabled ? $('tabbtn-' + options.capture().sourceLocale) : trigger;
      target.focus({ preventScroll: true });
    }
    function disclose(request, prepared) {
      request.prepared = prepared;
      $('translationDestination').textContent = text('translationDestination', {
        provider: prepared.providerName, kind: prepared.providerKind,
        endpoint: prepared.baseUrl, model: prepared.model, timeout: String(prepared.timeoutMs / 1000),
      });
      run.textContent = text('translationStart', { target: localeName(request.snapshot.targetLocale) });
      run.disabled = false;
    }
    function errorMessage(error, stage) {
      if (error.name === 'TimeoutError') return copy.translationTimedOut;
      if (error.name === 'AbortError') return copy.translationCancelled;
      if (error.code === 'translation_input_limit') return copy.translationLimit;
      if (error.code === 'translation_unsupported_source') return copy.translationUnsupported;
      if (error.code === 'translation_structure_mismatch' || error.code === 'translation_invalid_output' ||
          /^(Invalid article translation response|Article translation response (was incomplete|was truncated|exceeded limit))$/.test(error.message)) return copy.translationIncomplete;
      if (/^Article translation HTTP (401|403)$/.test(error.message)) return copy.translationAuthentication;
      if (error.code === 'translation_missing_key') return copy.translationMissingKey;
      if (stage === 'config') return copy.translationConfigFailed;
      if (stage === 'prepare') return copy.translationSourceFailed;
      return copy.translationFailed;
    }
    async function json(url, request, body) {
      const response = await fetch(url, { cache: 'no-store', signal: request.controller.signal,
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      if (!current(request)) return null;
      if (response.status === 401) { invalidate(); options.on401(); return null; }
      const value = await response.json();
      if (!current(request)) { if (value && typeof value === 'object') value.apiKey = null; return null; }
      if (!response.ok) {
        const error = new Error('Article translation source request failed');
        error.code = typeof value?.code === 'string' ? value.code : value?.error;
        throw error;
      }
      return value;
    }
    async function begin(approved) {
      release();
      clearResult();
      run.hidden = false;
      $('translationDestination').textContent = '';
      $('translationWarnings').textContent = '';
      const snapshot = options.capture();
      $('translationHeading').textContent = text('translationDirection', { source: localeName(snapshot.sourceLocale), target: localeName(snapshot.targetLocale) });
      if (!dialog.open) dialog.showModal();
      run.disabled = true;
      if (!eligible(snapshot)) { say(copy.translationCoverage, 'unavailable'); return; }
      const request = { epoch, snapshot, controller: new AbortController(), prepared: null, output: null, flushing: true };
      active = request;
      let config = null;
      let apiKey = null;
      let stage = 'prepare';
      say(copy.translationPreparing, 'preparing');
      try {
        const flushed = await options.flush();
        if (!current(request)) return;
        request.flushing = false;
        if (!flushed) throw new Error('Article translation gallery flush failed');
        const input = { sourceLocale: request.snapshot.sourceLocale, targetLocale: request.snapshot.targetLocale,
          source: fields(request.snapshot.draft[request.snapshot.sourceLocale]) };
        const plan = await json('/translation/prepare', request, input);
        if (!current(request)) return;
        if (!plan || !Array.isArray(plan.slots) || !Array.isArray(plan.warnings)) throw new Error('Article translation source request failed');
        $('translationWarnings').textContent = plan.warnings.includes('opaque-source-retained') ? copy.translationRetained : '';
        if (plan.warnings.includes('headings-retained-for-fragments')) $('translationWarnings').textContent += ' ' + copy.translationHeadings;
        stage = 'config';
        config = await json('/ai-config?purpose=translation', request);
        if (!current(request)) return;
        const prepared = describe(config);
        if (!prepared) throw new Error('Article translation configuration unavailable');
        if (['openrouter', 'deepseek', 'anthropic', 'openai'].includes(prepared.providerKind) && (typeof config.apiKey !== 'string' || !config.apiKey.trim())) {
          const error = new Error('Article translation credential unavailable');
          error.code = 'translation_missing_key';
          throw error;
        }
        disclose(request, prepared);
        if (!approved || !same(approved, prepared)) { say(approved ? copy.translationConfigChanged : copy.translationReady, 'ready'); return; }
        apiKey = config.apiKey;
        config.apiKey = null;
        stage = 'inference';
        run.disabled = true;
        say(copy.translationRunning, 'translating');
        const output = await window.LLM.translateArticle({ baseUrl: prepared.baseUrl, model: prepared.model,
          timeoutMs: prepared.timeoutMs, apiKey, sourceLocale: input.sourceLocale, targetLocale: input.targetLocale,
          prompt: prepared.prompt, slots: plan.slots, signal: request.controller.signal });
        if (!current(request)) return;
        apiKey = null;
        const patch = await json('/translation/validate', request, { ...input, output });
        if (!current(request)) return;
        // Server validation is authoritative; still reject an accidental contract
        // drift rather than letting extra response keys reach the form.
        if (!patch || Object.keys(patch).sort().join(',') !== 'bodyMarkdown,excerpt,images,title' ||
            !['title', 'excerpt', 'bodyMarkdown'].every((key) => typeof patch[key] === 'string') ||
            !patch.images || typeof patch.images !== 'object' || Array.isArray(patch.images)) throw new Error('Invalid article translation response');
        request.output = fields(patch);
        const target = request.snapshot.draft[request.snapshot.targetLocale];
        request.replace = !!(target.title || target.excerpt || target.bodyMarkdown || Object.keys(target.images).length);
        $('translationTitle').value = patch.title;
        $('translationExcerpt').value = patch.excerpt;
        $('translationBody').value = patch.bodyMarkdown;
        $('translationImages').value = JSON.stringify(patch.images, null, 2);
        for (const id of ['translationTitle', 'translationExcerpt', 'translationBody', 'translationImages']) $(id).lang = input.targetLocale;
        result.hidden = false;
        $('translationReplaceRow').hidden = !request.replace;
        $('translationReplaceLabel').textContent = text('translationReplace', { target: localeName(input.targetLocale) });
        apply.textContent = text('translationApply', { target: localeName(input.targetLocale) });
        apply.hidden = false;
        apply.disabled = request.replace;
        run.hidden = true;
        say(copy.translationReview, 'review');
        $('translationTitle').focus({ preventScroll: true });
      } catch (error) {
        if (!current(request)) return;
        say(errorMessage(error, stage), 'error');
        run.disabled = false;
        run.textContent = copy.translationPrepare;
        request.prepared = null;
        run.focus({ preventScroll: true });
      } finally {
        if (config && typeof config === 'object') config.apiKey = null;
        apiKey = null;
        config = null;
      }
    }
    function finishCommit(locale, patch) {
      applying = true;
      let before;
      try { before = options.commit(locale, patch); }
      finally { applying = false; }
      release();
      let backedUp = false;
      try { backedUp = options.didCommit(locale); }
      catch (_) { /* The atomic in-memory patch already succeeded; recovery is separate. */ }
      refresh();
      return { before, backedUp };
    }
    function applyResult() {
      const request = active;
      if (!request || !current(request) || !request.output || (request.replace && !consent.checked)) return;
      const locale = request.snapshot.targetLocale;
      // No await between consent recheck and the atomic field transaction.
      const patch = { ...request.output, images: { ...request.snapshot.draft[locale].images, ...request.output.images } };
      try {
        const { before, backedUp } = finishCommit(locale, patch);
        undoRecord = { locale, before, after: fields(patch), context: undoContext(options.capture()) };
        closeDialog();
        refresh();
        options.notice(backedUp ? copy.translationApplied : copy.translationBackupFailed);
      } catch (_) {
        say(copy.translationApplyFailed, 'error');
        apply.focus({ preventScroll: true });
      }
    }
    function undoTranslation() {
      refresh();
      if (!undoRecord) return;
      const record = undoRecord;
      try {
        const { backedUp } = finishCommit(record.locale, record.before);
        undoRecord = null;
        refresh();
        options.notice(backedUp ? copy.translationUndone : copy.translationBackupFailed);
      } catch (_) { options.notice(copy.translationApplyFailed); }
    }
    trigger.addEventListener('click', () => { run.hidden = false; void begin(null); });
    run.addEventListener('click', () => { if (!run.disabled) { run.hidden = false; void begin(active?.prepared || null); } });
    consent.addEventListener('change', () => { if (active && current(active)) apply.disabled = active.replace && !consent.checked; });
    apply.addEventListener('click', applyResult);
    undo.addEventListener('click', undoTranslation);
    close.addEventListener('click', closeDialog);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
    dialog.addEventListener('close', () => {
      if (queuedCloseEvents) { queuedCloseEvents--; return; }
      if (!dialog.open) closeDialog();
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeDialog(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.querySelectorAll('button, a[href], input, textarea, [tabindex]'))
        .filter((node) => !node.disabled && node.tabIndex >= 0 && !node.closest('[hidden]'));
      const first = controls[0], last = controls[controls.length - 1];
      if (!controls.includes(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    });
    return { invalidate, changed, refresh };
  }
  return { create };
})();
