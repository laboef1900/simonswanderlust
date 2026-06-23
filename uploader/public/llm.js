/*
 * Browser-side LM Studio helpers. The admin pages call LM Studio DIRECTLY from
 * the browser (the model runs on the same machine you author from), so the
 * server never needs to reach it. LM Studio sends `Access-Control-Allow-Origin: *`,
 * so cross-origin calls work; on an https admin page, browsers treat http://localhost
 * as a secure origin (use Chrome if a browser blocks it).
 */
window.LLM = (function () {
  const base = (u) => String(u).replace(/\/+$/, '');

  function slugify(s) {
    return String(s)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function parseCaption(content) {
    const m = String(content).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON object in model response');
    const o = JSON.parse(m[0]);
    const altEn = String(o.altEn ?? '').trim();
    const altDe = String(o.altDe ?? '').trim();
    const slug = slugify(String(o.slug ?? ''));
    if (!altEn || !altDe || !slug) throw new Error('model response missing fields');
    return { altEn, altDe, slug };
  }

  async function listModels(baseUrl) {
    const res = await fetch(base(baseUrl) + '/models');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    return (body.data || []).map((m) => m.id).filter(Boolean);
  }

  /** Load a File, downscale its longest edge to maxEdge, return a JPEG data URL
   *  plus the ORIGINAL intrinsic dimensions (display only — the snippet uses the
   *  dimensions /upload returns). The original file is never re-encoded here. */
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

  return { slugify, parseCaption, listModels, prepImage, caption };
})();
