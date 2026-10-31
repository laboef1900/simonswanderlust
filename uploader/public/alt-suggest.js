/*
 * Wires "Suggest alt text" to browser-direct vision captioning.
 * Fetches caption-only config and its request-local key for remote providers.
 * The selected provider receives a resized JPEG; local LM Studio receives no key.
 * Fill only the matching language and never save automatically.
 * Failures leave the manual alt field usable.
 * loadConfig/prepHosted are shared with the media library's photo details (media-ai.js).
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

  // truncatedText: the caller's localized token-limit hint (EditorCopy
  // `altSuggestTruncated`), shown when the reply was cut off at the limit (#351).
  function wire(opts) {
    const { button, fileInput, altInput, statusEl, lang, hintEl, on401, truncatedText } = opts;
    if (!button) return;
    if (!fileInput || !altInput) return;
    const say = (msg) => { if (statusEl) statusEl.textContent = msg; };
    // The request object is the per-wire ownership token. A new click replaces
    // it without disabling the button; cancellation alone cannot stop a reply
    // which has already settled (or a programmatic file clear after Insert).
    let active;
    const cancel = () => {
      if (!active) return;
      active.controller.abort();
      if (active.config) active.config.captionApiKey = null;
      active = undefined;
      say('');
    };
    fileInput.addEventListener('change', cancel);
    altInput.addEventListener('input', cancel);
    button.addEventListener('click', async () => {
      cancel();
      const file = fileInput.files && fileInput.files[0];
      if (!file) { say('Pick a photo first.'); return; }
      const valueAtClick = altInput.value;
      const request = { controller: new AbortController(), config: null };
      const signal = request.controller.signal;
      active = request;
      const current = () => active === request && !signal.aborted &&
        fileInput.files[0] === file && altInput.value === valueAtClick;
      let cfg;
      try {
        cfg = await loadConfig(() => {
          if (!current()) return;
          if (on401) on401(); else location.href = '/login';
        }, signal);
        request.config = cfg;
        if (!current()) return;
        say('Asking the selected alt-text model…');
        const prep = await LLM.prepImage(file, cfg.captionMaxEdge, signal);
        if (!current()) return;
        const c = await LLM.caption(cfg.captionBaseUrl, cfg.lmModel, cfg.captionPrompt, prep.dataUrl,
          cfg.captionTimeoutMs, cfg.captionMaxTokens, signal, cfg.captionApiKey);
        if (!current()) return;
        altInput.value = lang === 'de' ? c.altDe : c.altEn;
        if (hintEl) hintEl.textContent = lang === 'de' ? 'EN: ' + c.altEn : 'DE: ' + c.altDe;
        say('Suggested — review and edit as needed.');
        // Release ownership before input: this is our accepted result, not a
        // manual edit cancelling the request. Listeners may start another one.
        active = undefined;
        // Programmatic .value assignment fires no input event — dispatch one so
        // the editor's DraftGuard marks the form dirty.
        altInput.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {
        if (!current()) return;
        if (!cfg) {
          say('Could not load AI settings: ' + e.message);
          return;
        }
        // A truncated reply is a token-limit problem, not a connection one (#351).
        if (e && e.message === 'Caption response was truncated') {
          say(truncatedText);
          return;
        }
        const why = LLM.mixedContentWarning(cfg.captionBaseUrl, location.protocol);
        say('Could not generate alt text. ' + (why || 'Check the provider, shared key, vision model and browser CORS access.') +
          ' Fill in the alt text manually.');
      } finally {
        if (cfg) cfg.captionApiKey = null;
        if (active === request) active = undefined;
      }
    });
  }

  /**
   * Download a hosted display variant and downscale it for a vision model.
   * Callers validate the URL's origin first; cookies, referrer and redirects
   * are refused, so the read can never carry the session elsewhere.
   *
   * @ai-warning `cache: 'reload'` is load-bearing. Variants are served
   * `immutable` for a year, and the image host only sends
   * `Access-Control-Allow-Origin` since ad062a9 (v0.10.0). A browser that
   * cached a variant before then (any <img> in the media grid) keeps reusing
   * that header-less copy, and this cross-origin read fails with "Failed to
   * fetch" / "Load failed". Reload fetches fresh and replaces the stale entry.
   */
  async function prepHosted(url, maxEdge, signal) {
    const response = await fetch(url, {
      signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'reload',
    });
    if (!response.ok) throw new Error('Image unavailable');
    const blob = await response.blob();
    signal.throwIfAborted();
    const prep = await LLM.prepImage(blob, maxEdge, signal);
    signal.throwIfAborted();
    return prep;
  }

  /** Caption a hosted display variant; callers validate its origin before use. */
  async function suggestHosted({ url, lang, signal, on401 }) {
    const preparation = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const cfg = await loadConfig(on401, preparation);
    try {
      preparation.throwIfAborted();
      const prep = await prepHosted(url, cfg.captionMaxEdge, preparation);
      const caption = await LLM.caption(cfg.captionBaseUrl, cfg.lmModel, cfg.captionPrompt,
        prep.dataUrl, cfg.captionTimeoutMs, cfg.captionMaxTokens, signal, cfg.captionApiKey);
      signal.throwIfAborted();
      return lang === 'de' ? caption.altDe : caption.altEn;
    } finally {
      cfg.captionApiKey = null;
    }
  }

  return { wire, suggestHosted, loadConfig, prepHosted };
})();
