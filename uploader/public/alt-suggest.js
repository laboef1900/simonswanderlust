/*
 * Wires a "Suggest alt text" button to browser-direct LM Studio captioning.
 * On click: read the picked file, fetch read-only LM config from GET /ai-config,
 * caption locally via LLM (llm.js), and fill the alt input with the matching
 * language ('de' → altDe, 'en' → altEn). The model is reached from THIS browser
 * (see llm.js); nothing hits the server. Failures degrade to an inline message —
 * the manual alt field always stays usable.
 */
window.AltSuggest = (function () {
  async function loadConfig() {
    const res = await fetch('/ai-config');
    if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function wire(opts) {
    const { button, fileInput, altInput, statusEl, lang, hintEl } = opts;
    if (!button) return;
    if (!fileInput || !altInput) return;
    const say = (msg) => { if (statusEl) statusEl.textContent = msg; };
    button.addEventListener('click', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) { say('Pick a photo first.'); return; }
      let cfg;
      try {
        cfg = await loadConfig();
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
        say('Couldn\'t reach LM Studio at ' + cfg.lmBaseUrl + ' (' + e.message +
          '). Is it running? Fill in the alt text manually.');
      }
    });
  }

  return { wire };
})();
