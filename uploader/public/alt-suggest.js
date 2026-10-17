/*
 * Wires a "Suggest alt text" button to browser-direct LM Studio captioning.
 * On click: fetch caption-only config (never remote credentials) from GET /ai-config?purpose=caption,
 * caption locally via LLM (llm.js), and fill the alt input with the matching
 * language ('de' → altDe, 'en' → altEn). The model is reached from THIS browser
 * (see llm.js); nothing hits the server. Failures degrade to an inline message —
 * the manual alt field always stays usable.
 */
window.AltSuggest = (function () {
  // on401: called instead of a raw redirect when the session has expired, so a
  // host page with a DraftGuard (editor.html) can stash the draft, clear its
  // dirty flag (no surprise beforeunload prompt), and carry a ?next= back here.
  async function loadConfig(on401, signal) {
    const res = await fetch('/ai-config?purpose=caption', { signal, cache: 'no-store' });
    if (res.status === 401) {
      if (on401) on401(); else location.href = '/login';
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function wire(opts) {
    const { button, fileInput, altInput, statusEl, lang, hintEl, on401 } = opts;
    if (!button) return;
    if (!fileInput || !altInput) return;
    const say = (msg) => { if (statusEl) statusEl.textContent = msg; };
    button.addEventListener('click', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) { say('Pick a photo first.'); return; }
      let cfg;
      try {
        cfg = await loadConfig(on401);
      } catch (e) {
        say('Could not load AI settings: ' + e.message);
        return;
      }
      say('Asking the local model…');
      try {
        const prep = await LLM.prepImage(file, cfg.captionMaxEdge);
        const c = await LLM.caption(cfg.lmBaseUrl, cfg.lmModel, cfg.captionPrompt, prep.dataUrl, cfg.captionTimeoutMs);
        altInput.value = lang === 'de' ? c.altDe : c.altEn;
        // Programmatic .value assignment fires no input event — dispatch one so
        // the editor's DraftGuard marks the form dirty.
        altInput.dispatchEvent(new Event('input', { bubbles: true }));
        if (hintEl) hintEl.textContent = lang === 'de' ? 'EN: ' + c.altEn : 'DE: ' + c.altDe;
        say('Suggested — review and edit as needed.');
      } catch (e) {
        const why = LLM.mixedContentWarning(cfg.lmBaseUrl, location.protocol);
        say('Couldn\'t reach LM Studio at ' + cfg.lmBaseUrl + ' (' + e.message +
          '). ' + (why || 'Is it running?') + ' Fill in the alt text manually.');
      }
    });
  }

  /** Caption a hosted display variant; callers validate its origin before use. */
  async function suggestHosted({ url, lang, signal, on401 }) {
    const preparation = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const cfg = await loadConfig(on401, preparation);
    preparation.throwIfAborted();
    const response = await fetch(url, {
      signal: preparation, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error('Image unavailable');
    const blob = await response.blob();
    preparation.throwIfAborted();
    const prep = await LLM.prepImage(blob, cfg.captionMaxEdge, preparation);
    preparation.throwIfAborted();
    const caption = await LLM.caption(cfg.lmBaseUrl, cfg.lmModel, cfg.captionPrompt,
      prep.dataUrl, cfg.captionTimeoutMs, signal);
    signal.throwIfAborted();
    return lang === 'de' ? caption.altDe : caption.altEn;
  }

  return { wire, suggestHosted };
})();
