/* Gallery widgets are a view of Markdown, never a second draft or image store. */
window.EditorGalleries = (function () {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function attach({ cm, locale, images, imageOrigin, toggle, copy, onEdit, onUnauthed }) {
    let previews = true;
    let editing = false;
    let controllers = [];

    function previewUrl(photo) {
      const thumbnail = PostsFilter.thumbUrl({ heroSrc: photo.src, heroWidth: photo.width, heroFormat: photo.format });
      if (!thumbnail) return null;
      try {
        const url = new URL(thumbnail, location.href);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        return url.origin === imageOrigin || url.origin === location.origin ? url.href : null;
      } catch { return null; }
    }

    function cancel() { controllers.forEach((controller) => controller.cancel()); }
    function dispose(controller) {
      controller.alive = false;
      controller.cancel();
      controller.observer?.disconnect();
      controller.widget.clear();
      controller.marker.clear();
    }

    function writeAlt(src, value) {
      // The existing images map is keyed by URL, not occurrence. Keep every
      // gallery use in this locale consistent without mutating that map outside undo.
      editing = true;
      try {
        cm.operation(() => {
          for (const controller of controllers) {
            const range = controller.marker.find();
            if (!range) continue;
            const old = cm.getRange(range.from, range.to);
            const next = GalleryFence.withAlt(old, src, value);
            if (next !== old) {
              // Keep the opener/closer intact: replacing the entire collapsed
              // range would clear its marker, detach the focused input and lose caret.
              const start = cm.indexFromPos(range.from);
              cm.replaceRange(next.slice(next.indexOf('\n') + 1, next.lastIndexOf('\n') + 1),
                cm.posFromIndex(start + old.indexOf('\n') + 1),
                cm.posFromIndex(start + old.lastIndexOf('\n') + 1), '+gallery-alt');
              controller.text = next;
            }
            controller.fields.forEach((field) => {
              if (field.src !== src) return;
              field.cancel();
              if (field.input.value !== value) field.input.value = value;
              field.image.alt = value;
            });
          }
        });
      } finally { editing = false; }
    }

    function create(block, text, number) {
      const parsed = GalleryFence.parse(text);
      const root = el('section', 'editor-gallery');
      root.setAttribute('lang', locale);
      root.setAttribute('aria-label', copy.gallery + ' ' + number);
      const controller = { text, root, alive: true, fields: [], marker: null, widget: null, observer: null,
        cancel() { this.fields.forEach((field) => field.cancel()); } };
      const head = el('div', 'editor-gallery__head');
      const title = el('h3', null, copy.gallery + ' ' + number);
      const mode = GalleryFence.layoutOf(parsed.directives);
      head.appendChild(title);
      head.appendChild(el('span', 'muted', copy[mode]));
      const edit = el('button', 'btn-secondary', copy.edit);
      edit.type = 'button';
      edit.addEventListener('click', () => {
        const range = controller.marker.find();
        if (range) onEdit(cm.indexFromPos(range.from));
      });
      head.appendChild(edit);
      root.appendChild(head);
      root.appendChild(el('p', 'muted editor-gallery__help', copy.help));
      const list = el('ol', 'editor-gallery__photos');
      root.appendChild(list);
      if (!parsed.lines.length) list.appendChild(el('li', 'muted', copy.empty));

      parsed.lines.forEach((line, index) => {
        const stored = images()[line.src] || {};
        const photo = { ...stored, ...line };
        const card = el('li', 'editor-gallery__photo');
        const image = el('img', 'editor-gallery__image');
        image.alt = photo.alt || '';
        image.loading = 'lazy';
        image.decoding = 'async';
        const url = previewUrl(photo);
        const unavailable = el('p', 'muted editor-gallery__unavailable', copy.unavailable);
        unavailable.hidden = !!url;
        image.hidden = !url;
        if (url) image.src = url;
        image.addEventListener('error', () => {
          image.hidden = true;
          unavailable.hidden = false;
          controller.widget?.changed();
        });
        image.addEventListener('load', () => controller.widget?.changed());
        card.appendChild(image);
        card.appendChild(unavailable);
        const label = el('label', null, copy.photo + ' ' + (index + 1) + ' · ' + copy.alt);
        const input = el('textarea', 'editor-gallery__alt');
        input.rows = 3;
        input.maxLength = 1000;
        input.value = typeof photo.alt === 'string' ? photo.alt : '';
        card.appendChild(label);
        // CodeMirror clones widgets while measuring them. Implicit labels avoid
        // duplicate IDs targeting an invisible measurement copy.
        label.appendChild(input);
        if (photo.caption) card.appendChild(el('p', 'editor-gallery__caption', String(photo.caption)));
        const suggest = el('button', 'btn-secondary editor-gallery__suggest', copy.suggest);
        suggest.type = 'button';
        suggest.disabled = !url;
        const status = el('p', 'muted editor-gallery__status');
        status.setAttribute('role', 'status');
        const suggestion = el('div', 'editor-gallery__suggestion');
        suggestion.hidden = true;
        const suggestedText = el('p', 'editor-gallery__suggested-text');
        const use = el('button', 'btn-secondary', copy.use);
        const dismiss = el('button', 'btn-secondary', copy.dismiss);
        use.type = dismiss.type = 'button';
        suggestion.appendChild(suggestedText);
        suggestion.appendChild(use);
        suggestion.appendChild(dismiss);
        card.appendChild(suggest);
        card.appendChild(status);
        card.appendChild(suggestion);
        list.appendChild(card);
        let request;
        let version = 0;
        const field = { src: line.src, input, image,
          cancel() {
            version += 1;
            request?.abort();
            request = undefined;
            suggestion.hidden = true;
            suggestedText.textContent = '';
            status.textContent = '';
            suggest.disabled = !url;
            suggest.textContent = copy.suggest;
            controller.widget?.changed();
          } };
        controller.fields.push(field);
        input.addEventListener('input', () => writeAlt(line.src, input.value));
        dismiss.addEventListener('click', () => { field.cancel(); suggest.focus(); });
        use.addEventListener('click', () => {
          if (!controller.alive || suggestion.hidden) return;
          writeAlt(line.src, suggestedText.textContent);
          input.focus();
        });
        suggest.addEventListener('click', async () => {
          if (!url || request) return;
          field.cancel();
          const current = version;
          request = new AbortController();
          const signal = request.signal;
          suggest.disabled = true;
          suggest.textContent = copy.asking;
          status.textContent = copy.asking;
          controller.widget?.changed();
          try {
            const text = await AltSuggest.suggestHosted({ url, lang: locale, signal,
              on401: () => { if (controller.alive && version === current) onUnauthed(); } });
            if (!controller.alive || version !== current || signal.aborted) return;
            suggestedText.textContent = text;
            suggestion.hidden = false;
            status.textContent = copy.review;
          } catch {
            if (controller.alive && version === current && !signal.aborted) status.textContent = copy.failed;
          } finally {
            if (controller.alive && version === current) {
              request = undefined;
              suggest.disabled = !url;
              suggest.textContent = copy.suggest;
              controller.widget?.changed();
            }
          }
        });
      });

      controller.marker = cm.markText(cm.posFromIndex(block.start), cm.posFromIndex(block.end), {
        collapsed: true, inclusiveLeft: false, inclusiveRight: false, clearOnEnter: false,
      });
      controller.widget = cm.addLineWidget(cm.posFromIndex(block.start).line, root);
      if (typeof ResizeObserver !== 'undefined') {
        controller.observer = new ResizeObserver(() => controller.widget.changed());
        controller.observer.observe(root);
      }
      return controller;
    }

    function refresh(reset = false) {
      if (editing) return;
      cm.operation(() => {
        if (reset || !previews) {
          controllers.forEach(dispose);
          controllers = [];
        }
        if (!previews) return;
        const body = cm.getValue();
        const blocks = GalleryFence.scanFences(body).filter((block) => block.isGallery && !block.unterminated);
        const old = controllers;
        const next = [];
        blocks.forEach((block, index) => {
          const text = body.slice(block.start, block.end);
          const existing = old.find((controller) => {
            const range = controller.marker.find();
            return range && controller.text === text && cm.indexFromPos(range.from) === block.start
              && cm.indexFromPos(range.to) === block.end;
          });
          if (existing) {
            const label = copy.gallery + ' ' + (index + 1);
            existing.root.setAttribute('aria-label', label);
            existing.root.querySelector('h3').textContent = label;
            next.push(existing);
            return;
          }
          // Clear stale markers before adding a replacement at the same range.
          old.forEach((controller) => {
            const range = controller.marker.find();
            if (controller.alive && range && cm.indexFromPos(range.from) < block.end
              && cm.indexFromPos(range.to) > block.start) dispose(controller);
          });
          next.push(create(block, text, index + 1));
        });
        old.forEach((controller) => { if (controller.alive && !next.includes(controller)) dispose(controller); });
        controllers = next;
      });
    }

    toggle.textContent = copy.showMarkdown;
    toggle.setAttribute('aria-pressed', 'false');
    toggle.addEventListener('click', () => {
      previews = !previews;
      toggle.textContent = previews ? copy.showMarkdown : copy.showPreview;
      toggle.setAttribute('aria-pressed', String(!previews));
      refresh();
    });
    cm.on('changes', () => refresh());
    refresh();
    return {
      refresh: () => refresh(true), cancel,
      focusPhoto(src) {
        if (!previews) toggle.click();
        for (const controller of controllers) {
          const field = controller.fields.find((entry) => entry.src === src);
          const range = controller.marker.find();
          if (!field || !range) continue;
          // CodeMirror mounts offscreen widgets lazily. Reveal the line before
          // focusing its real control, never a measurement clone.
          cm.scrollIntoView(range.from);
          cm.refresh();
          field.input.focus({ preventScroll: true });
          field.input.scrollIntoView({ block: 'center' });
          return true;
        }
        return false;
      },
      revealLine(line) {
        if (controllers.some((controller) => {
          const range = controller.marker.find();
          return range && line >= range.from.line && line <= range.to.line;
        })) toggle.click();
      },
    };
  }
  return { attach };
})();
