/*
 * Wires "Suggest alt text" to browser-direct vision captioning.
 * Fetches caption-only config and its request-local key for remote providers.
 * The selected provider receives a resized JPEG; local LM Studio receives no key.
 * Fill only the matching language and never save automatically.
 * Failures leave the manual alt field usable.
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
    const config = await res.json();
    if ((config.captionProvider === 'openrouter' || config.captionProvider === 'deepseek') && !config.captionApiKey) {
      throw new Error('Configure the shared API key in Settings first.');
    }
    return config;
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
      say('Asking the selected alt-text model…');
      try {
        const prep = await LLM.prepImage(file, cfg.captionMaxEdge);
        const c = await LLM.caption(cfg.captionBaseUrl, cfg.lmModel, cfg.captionPrompt, prep.dataUrl, cfg.captionTimeoutMs, undefined, cfg.captionApiKey);
        altInput.value = lang === 'de' ? c.altDe : c.altEn;
        // Programmatic .value assignment fires no input event — dispatch one so
        // the editor's DraftGuard marks the form dirty.
        altInput.dispatchEvent(new Event('input', { bubbles: true }));
        if (hintEl) hintEl.textContent = lang === 'de' ? 'EN: ' + c.altEn : 'DE: ' + c.altDe;
        say('Suggested — review and edit as needed.');
      } catch (e) {
        const why = LLM.mixedContentWarning(cfg.captionBaseUrl, location.protocol);
        say('Could not generate alt text. ' + (why || 'Check the provider, shared key, vision model and browser CORS access.') +
          ' Fill in the alt text manually.');
      } finally {
        cfg.captionApiKey = null;
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
    try {
      const caption = await LLM.caption(cfg.captionBaseUrl, cfg.lmModel, cfg.captionPrompt,
        prep.dataUrl, cfg.captionTimeoutMs, signal, cfg.captionApiKey);
      signal.throwIfAborted();
      return lang === 'de' ? caption.altDe : caption.altEn;
    } finally {
      cfg.captionApiKey = null;
    }
  }

  return { wire, suggestHosted };
})();
