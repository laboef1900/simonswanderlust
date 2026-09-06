/*
 * Browser-side LM Studio helpers. The admin pages call LM Studio DIRECTLY from
 * the browser (the model runs on the same machine you author from), so the
 * server never needs to reach it. LM Studio sends `Access-Control-Allow-Origin: *`,
 * so cross-origin calls work; on an https admin page, browsers treat http://localhost
 * as a secure origin — any OTHER plain-http host is blocked as mixed content
 * (see mixedContentWarning).
 */
window.LLM = (function () {
  const base = (u) => String(u).replace(/\/+$/, '');

  // Mirrors src/caption.ts MAX_ALT / cleanAlt (enforced by test/llm-mirror.test.ts):
  // model output is untrusted input — one line, single-spaced, capped, never
  // ending on a lone high surrogate.
  const MAX_ALT = 300;
  function cleanAlt(v) {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ALT);
    return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
  }

  // Browsers treat these as potentially trustworthy origins even over http:
  // (Secure Contexts §3.1), so they escape the mixed-content block.
  function isLoopbackHost(hostname) {
    const h = hostname.toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(h);
  }

  /**
   * Why a fetch to `baseUrl` from a page served over `pageProtocol` is doomed
   * before it starts, or '' when it is not. A plain-http model URL on an https
   * admin page fails with a bare "Failed to fetch" that reads like LM Studio is
   * down; this names the actual cause so the author can fix the URL (#140).
   */
  function mixedContentWarning(baseUrl, pageProtocol) {
    if (pageProtocol !== 'https:') return '';
    let u;
    try { u = new URL(String(baseUrl)); } catch (_) { return ''; }
    if (u.protocol !== 'http:' || isLoopbackHost(u.hostname)) return '';
    return 'This admin page is served over https, but ' + u.origin + ' is plain http on a ' +
      'non-local host — the browser blocks that as mixed content before the request is ' +
      'sent. Use an https:// URL for LM Studio, or run it on localhost.';
  }

  // Index of the `}` balancing the `{` at `start`, or -1. String-aware so a `}`
  // inside a value doesn't end the object early. Mirrors src/caption.ts.
  function matchBrace(s, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = start; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return j;
    }
    return -1;
  }

  // Extract the first JSON object carrying non-empty altEn + altDe. Mirrors
  // src/caption.ts::parseCaption (kept in sync; enforced by test/llm-mirror.test.ts).
  function parseCaption(content) {
    const s = String(content);
    let sawJson = false;
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '{') continue;
      const end = matchBrace(s, i);
      if (end < 0) break;
      let o;
      try {
        o = JSON.parse(s.slice(i, end + 1));
      } catch (_) {
        continue;
      }
      sawJson = true;
      const altEn = cleanAlt(o.altEn);
      const altDe = cleanAlt(o.altDe);
      if (altEn && altDe) return { altEn, altDe };
    }
    throw new Error(sawJson ? 'model response missing fields' : 'no JSON object in model response');
  }

  async function listModels(baseUrl) {
    const res = await fetch(base(baseUrl) + '/models');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    return (body.data || []).map((m) => m.id).filter(Boolean);
  }

  /** Load a File, downscale its longest edge to maxEdge, return a JPEG data URL
   *  plus the ORIGINAL intrinsic dimensions. The original file is never re-encoded
   *  here — upload still sends the untouched file to /upload. */
  function prepImage(file, maxEdge) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const scale = Math.min(1, (maxEdge || 768) / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.8), width: w, height: h });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not a decodable image')); };
      img.src = url;
    });
  }

  async function caption(baseUrl, model, prompt, dataUrl, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
    try {
      const res = await fetch(base(baseUrl) + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 300,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      return parseCaption(body.choices && body.choices[0] && body.choices[0].message ? body.choices[0].message.content : '');
    } finally {
      clearTimeout(timer);
    }
  }

  return { parseCaption, listModels, prepImage, caption, mixedContentWarning };
})();
