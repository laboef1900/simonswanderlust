// The media page's bulk "Generate details with AI" dialog (#aiDialog in
// media.html). DOM glue only: which photos need a request, what gets written
// and when a run stops are MediaAi's rules (media-ai.js, unit-tested).
//
// Like media-browser.js, every string is set with textContent — photo keys and
// failure reasons are rendered here — and innerHTML is only ever cleared.
//
// One `session` per opening. It owns an AbortController that cancels the
// settings read, the photo listing and the run, and the caption config whose
// request-local key is dropped when the run ends or the dialog closes.
window.MediaAiDialog = (function () {
  /** Failures listed by name after a run; the rest are counted. */
  const MAX_LISTED_FAILURES = 20;

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function message(error) { return error && error.message ? String(error.message) : String(error); }

  /**
   * opts: { client, imageOrigin, view() → { selectedItems, total, description, query },
   *         onFinished(message) }
   * Returns { open(scope) } where scope is 'selected' or 'all'.
   */
  function attach(opts) {
    const $ = (id) => document.getElementById(id);
    const ai = window.MediaAi;
    const copy = window.EditorCopy[document.documentElement.lang === 'de' ? 'de' : 'en'];
    const dialog = $('aiDialog');
    let session = null;

    const fields = () => ({
      title: $('aiFieldTitle').checked, alt: $('aiFieldAlt').checked,
      caption: $('aiFieldCaption').checked, tags: $('aiFieldTags').checked,
    });
    const replace = () => $('aiReplace').checked;
    const scopeItems = (s) => ($('aiScopeAll').checked ? s.all : s.selected);
    const usable = (items) => items.filter((item) => ai.photoUrl(item, opts.imageOrigin, location.origin));

    // Pre-run summary, Generate's label and whether it may be pressed.
    function update() {
      const s = session;
      if (!s || s.running || s.done) return;
      const start = $('aiStart');
      const overwrite = replace();
      start.textContent = overwrite ? 'Generate and overwrite' : 'Generate';
      start.className = overwrite ? 'btn-remove' : '';
      start.disabled = true;
      const all = $('aiScopeAll').checked;
      const items = scopeItems(s);
      const summary = $('aiSummary');
      if (s.configError) { summary.textContent = s.configError; return; }
      if (all && s.listError) { summary.textContent = s.listError; return; }
      if (!items) { summary.textContent = 'Counting the photos in this view…'; return; }
      if (!s.config) { summary.textContent = 'Loading the photo-description settings…'; return; }
      const chosen = fields();
      if (!chosen.title && !chosen.alt && !chosen.caption && !chosen.tags) {
        summary.textContent = 'Choose at least one field.';
        return;
      }
      const ready = usable(items);
      const work = ai.countWork(ready, chosen, overwrite);
      const left = items.length - ready.length;
      let text = overwrite
        ? plural(work, 'photo') + ' will be sent to the model, one request each. Their chosen fields are overwritten.'
        : work + ' of ' + plural(ready.length, 'photo') + ' have empty fields to fill, one model request each.';
      if (left) text += ' ' + plural(left, 'photo') + ' still encoding, failed or missing ' + (left === 1 ? 'is' : 'are') + ' left out.';
      summary.textContent = text;
      start.disabled = work === 0;
    }

    async function loadConfig(s) {
      try {
        const config = await window.AltSuggest.loadConfig(null,
          AbortSignal.any([s.controller.signal, AbortSignal.timeout(15000)]));
        if (session !== s) { config.captionApiKey = null; return; }
        s.config = config;
        const why = window.LLM.mixedContentWarning(config.captionBaseUrl, location.protocol);
        $('aiDestination').textContent = 'Photos are sent to ' + config.captionBaseUrl + ' (model ' + config.lmModel + ').'
          + (config.captionProvider === 'lm-studio' ? '' : ' The provider may charge per photo.')
          + (why ? ' ' + why : '');
      } catch (error) {
        if (session !== s) return;
        s.configError = 'Could not load the photo-description settings: ' + message(error);
      }
      update();
    }

    async function collect(s) {
      if (s.all || s.collecting) return;
      s.collecting = true;
      // A retry starts clean: update() shows a stale listError before any count.
      s.listError = '';
      update();
      try {
        const all = await ai.collectAll(
          (page, pageSize) => opts.client.list({ ...s.query, page, pageSize }), s.controller.signal);
        if (session === s) s.all = all;
      } catch (error) {
        if (session === s) {
          s.listError = 'Could not list the photos in this view: ' + message(error)
            + '. Close the dialog and open it again to retry.';
        }
      } finally {
        s.collecting = false;
      }
      update();
    }

    function open(scope) {
      if (!dialog || typeof dialog.showModal !== 'function' || session) return;
      const view = opts.view();
      const s = {
        controller: new AbortController(), config: null, configError: '', listError: '',
        selected: view.selectedItems, all: null, collecting: false, query: view.query,
        running: false, done: false,
      };
      session = s;
      const hasSelection = view.selectedItems.length > 0;
      const useAll = scope === 'all' || !hasSelection;
      $('aiScopeSelected').disabled = !hasSelection;
      $('aiScopeSelected').checked = !useAll;
      $('aiScopeAll').checked = useAll;
      $('aiScopeSelectedLabel').textContent = hasSelection
        ? 'The ' + plural(view.selectedItems.length, 'selected photo')
        : 'Selected photos (none selected)';
      $('aiScopeAllLabel').textContent = 'All ' + plural(view.total, 'photo') + ' in this view (' + view.description + ')';
      // Overwriting is never carried over from an earlier run.
      $('aiReplace').checked = false;
      $('aiOptions').disabled = false;
      $('aiDestination').textContent = '';
      $('aiProgress').hidden = true;
      $('aiFailures').hidden = true;
      $('aiFailures').innerHTML = '';
      $('aiStart').hidden = false;
      $('aiCancel').textContent = 'Cancel';
      $('aiCancel').disabled = false;
      update();
      dialog.showModal();
      loadConfig(s);
      if (useAll) collect(s);
    }

    function progress(report) {
      $('aiBar').max = Math.max(1, report.total);
      $('aiBar').value = report.processed;
      $('aiCount').textContent = (report.current
        ? 'Photo ' + (report.processed + 1) + ' of ' + report.total
        : report.processed + ' of ' + report.total + ' processed')
        + ' · ' + report.saved + ' saved · ' + report.skipped + ' skipped · ' + report.failed.length + ' failed';
    }

    function finish(report) {
      const head = report.stopped === 'session' ? copy.uploadNeedsAuth
        : report.stopped === 'cancelled' ? 'Stopped.'
        : report.stopped === 'failures'
          ? 'Stopped after ' + ai.MAX_CONSECUTIVE_FAILURES + ' failures in a row. Check the photo-description settings and the provider.'
          : 'Done.';
      const rest = report.total - report.processed;
      $('aiSummary').textContent = head + ' Saved ' + report.saved + ', skipped ' + report.skipped
        + ', failed ' + report.failed.length + (rest ? ', not processed ' + rest : '') + '.';
      const list = $('aiFailures');
      list.innerHTML = '';
      report.failed.slice(0, MAX_LISTED_FAILURES).forEach((failure) => {
        const li = document.createElement('li');
        const key = document.createElement('span');
        key.className = 'media-key';
        key.textContent = failure.key;
        li.appendChild(key);
        const reason = failure.unsupported ? copy.mediaConditionalUnsupported
          : failure.unknown ? copy.mediaConditionalUnknown
          : failure.conflict ? copy.mediaConditionalConflict : failure.reason;
        li.appendChild(document.createTextNode(' — ' + reason));
        (failure.fields || []).forEach((field) => {
          const comparison = document.createElement('p');
          comparison.textContent = field.field + ': ' + copy['mediaConditional' + {
            achieved: 'Achieved', expected: 'Expected', other: 'Other',
          }[field.outcome]] + ' — ' + copy.mediaConditionalMine + ': ' + JSON.stringify(field.intended)
            + '; ' + copy.mediaConditionalStored + ': ' + JSON.stringify(field.stored);
          li.appendChild(comparison);
        });
        list.appendChild(li);
      });
      if (report.failed.length > MAX_LISTED_FAILURES) {
        const more = document.createElement('li');
        more.textContent = '… and ' + (report.failed.length - MAX_LISTED_FAILURES) + ' more';
        list.appendChild(more);
      }
      list.hidden = report.failed.length === 0;
      closable();
    }

    function closable() {
      $('aiCancel').textContent = 'Close';
      $('aiCancel').disabled = false;
      $('aiCancel').focus();
    }

    async function start() {
      const s = session;
      if (!s || s.running || s.done || !s.config) return;
      const chosen = fields();
      const overwrite = replace();
      const items = usable(scopeItems(s) || []).filter((item) => ai.needsWork(item, chosen, overwrite));
      if (!items.length) return;
      s.running = true;
      $('aiOptions').disabled = true;
      $('aiStart').hidden = true;
      $('aiCancel').textContent = 'Stop';
      $('aiProgress').hidden = false;
      $('aiSummary').textContent = 'Generating. Keep this page open; Stop cancels the current photo, and photos already saved keep their details.';
      let report = null;
      let crash = null;
      try {
        report = await ai.runBulk({
          items, fields: chosen, replace: overwrite, config: s.config, client: opts.client,
          imageOrigin: opts.imageOrigin, pageOrigin: location.origin, signal: s.controller.signal,
          onProgress: progress,
        });
      } catch (error) {
        // runBulk records per-photo failures itself, so this is a defect, not a
        // photo. The dialog must still end closable and the grid show the saves.
        crash = error;
      } finally {
        s.config.captionApiKey = null;
        s.running = false;
        s.done = true;
      }
      if (!report) {
        $('aiSummary').textContent = 'The run stopped unexpectedly: ' + message(crash)
          + '. Photos already saved keep their details.';
        closable();
        opts.onFinished('AI details: the run stopped unexpectedly.');
        return;
      }
      finish(report);
      opts.onFinished('AI details: saved ' + report.saved + ', skipped ' + report.skipped
        + ', failed ' + report.failed.length + (report.stopped ? ' (stopped)' : '') + '.');
    }

    function stop() {
      session.controller.abort();
      $('aiCancel').textContent = 'Stopping…';
      $('aiCancel').disabled = true;
    }

    if (dialog) {
      $('aiStart').addEventListener('click', start);
      $('aiCancel').addEventListener('click', () => {
        if (session && session.running) stop();
        else dialog.close();
      });
      // Esc during a run stops it but keeps the dialog for the result.
      dialog.addEventListener('cancel', (ev) => {
        if (session && session.running) { ev.preventDefault(); stop(); }
      });
      dialog.addEventListener('close', () => {
        if (!session) return;
        session.controller.abort();
        if (session.config) session.config.captionApiKey = null;
        session = null;
      });
      $('aiScopeAll').addEventListener('change', () => { if (session) collect(session); });
      for (const id of ['aiScopeSelected', 'aiFieldTitle', 'aiFieldAlt', 'aiFieldCaption', 'aiFieldTags', 'aiReplace']) {
        $(id).addEventListener('change', update);
      }
    }

    return { open };
  }

  return { attach };
})();
