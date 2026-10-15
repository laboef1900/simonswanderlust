/*
 * Compose a Markdown image from an alt field and an upload's URL.
 *
 * Mirrors src/body-content.ts `escapeAltText` / `imageMarkdown` — the label's
 * `\`, `[` and `]` are escaped so it ends where the author's (or the model's)
 * text does. `'![' + alt + '](' + src + ')'` turned an alt of
 * `Blick vom Gipfel [Norwegen]` into a broken image that rendered literally
 * (#140). test/image-markdown-mirror.test.ts runs both over one corpus.
 */
window.ImageMarkdown = (function () {
  function escapeAlt(alt) {
    return String(alt == null ? '' : alt).replace(/[\\[\]]/g, '\\$&');
  }

  function image(alt, src) {
    return '![' + escapeAlt(alt) + '](' + src + ')';
  }

  return { escapeAlt, image };
})();
