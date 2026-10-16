/* Optional story-only image. Copy comes from the shared DE/EN UI dictionary. */
(function (root) {
  'use strict';

  function create(options) {
    const { locale, mount, copy, onChange, onUnauthed, getSlug } = options;
    const prefix = locale + 'TitleImage';
    // Only fixed markup and the application's own locale are interpolated.
    mount.innerHTML = `
      <h3 class="editor-card-title" id="${prefix}Heading" data-copy="heading"></h3>
      <p class="muted" data-copy="help"></p>
      <div class="hero-picker hero-banner-zone">
        <div class="hero-compact-preview" id="${prefix}Preview" hidden>
          <img id="${prefix}Img" alt="" />
        </div>
        <div class="hero-actions-row">
          <button type="button" class="btn-secondary" id="${prefix}Library" data-copy="library"></button>
          <button type="button" class="btn-secondary" id="${prefix}Remove" data-copy="remove" hidden></button>
        </div>
        <label for="${prefix}File" data-copy="file"></label>
        <input type="file" id="${prefix}File" accept="image/*" />
        <button type="button" class="btn-secondary" id="${prefix}Upload" data-copy="upload"></button>
        <div id="${prefix}Fields" hidden>
          <label for="${prefix}Alt" data-copy="alt"></label>
          <input type="text" id="${prefix}Alt" maxlength="1000" />
          <details class="editor-disclosure">
            <summary data-copy="framing"></summary>
            <p class="muted" data-copy="framingHelp"></p>
            <label for="${prefix}X"><span data-copy="horizontal"></span> <output id="${prefix}XOut" for="${prefix}X">50%</output></label>
            <input type="range" id="${prefix}X" min="0" max="100" step="1" value="50" />
            <label for="${prefix}Y"><span data-copy="vertical"></span> <output id="${prefix}YOut" for="${prefix}Y">50%</output></label>
            <input type="range" id="${prefix}Y" min="0" max="100" step="1" value="50" />
            <button type="button" class="btn-secondary" id="${prefix}Reset" data-copy="reset"></button>
          </details>
        </div>
        <p class="muted" id="${prefix}Status" role="status"></p>
      </div>`;
    mount.setAttribute('aria-labelledby', prefix + 'Heading');
    mount.setAttribute('lang', locale);
    mount.querySelectorAll('[data-copy]').forEach((el) => { el.textContent = copy[el.dataset.copy]; });
    const el = (name) => document.getElementById(prefix + name);
    let image;
    let busy = false;

    function paintFocus() {
      const x = Number(el('X').value);
      const y = Number(el('Y').value);
      el('XOut').textContent = x + '%';
      el('YOut').textContent = y + '%';
      el('Img').style.objectPosition = x + '% ' + y + '%';
    }

    function set(value) {
      image = value ? { ...value } : undefined;
      el('Alt').value = image?.alt || '';
      el('X').value = image?.focus?.x ?? 50;
      el('Y').value = image?.focus?.y ?? 50;
      el('Fields').hidden = !image;
      el('Remove').hidden = !image;
      el('Preview').hidden = !image;
      const img = el('Img');
      if (image) {
        img.src = PostsFilter.thumbUrl({ heroSrc: image.src, heroWidth: image.width, heroFormat: image.format });
        img.onerror = () => { el('Preview').hidden = true; };
        img.onload = () => { el('Preview').hidden = false; };
      } else {
        img.removeAttribute('src');
      }
      el('File').value = '';
      el('Status').textContent = image ? '' : copy.fallback;
      paintFocus();
    }

    function get() {
      if (!image) return undefined;
      const x = Number(el('X').value), y = Number(el('Y').value);
      return {
        src: image.src, width: image.width, height: image.height,
        alt: el('Alt').value.trim(),
        ...(image.format === 'jpeg' ? { format: 'jpeg' } : {}),
        ...(x !== 50 || y !== 50 ? { focus: { x, y } } : {}),
      };
    }

    el('Library').addEventListener('click', () => {
      MediaPicker.open({
        onUnauthed,
        onPick(item) {
          set({ src: item.src, width: item.width, height: item.height,
            alt: item.alt?.[locale] || '', ...(item.format ? { format: item.format } : {}) });
          el('Status').textContent = copy.selected;
          onChange();
        },
      });
    });
    el('Remove').addEventListener('click', () => {
      set(undefined);
      el('Library').focus();
      onChange();
    });
    ['X', 'Y'].forEach((axis) => el(axis).addEventListener('input', paintFocus));
    el('Reset').addEventListener('click', () => {
      el('X').value = 50;
      el('Y').value = 50;
      paintFocus();
      onChange();
    });
    el('Upload').addEventListener('click', async () => {
      if (busy) return;
      const slug = getSlug();
      if (!slug) { el('Status').textContent = copy.slugRequired; return; }
      const file = el('File').files[0];
      if (!file) { el('Status').textContent = copy.pickFile; return; }
      busy = true;
      ['Upload', 'Library', 'Remove', 'File'].forEach((name) => { el(name).disabled = true; });
      el('Status').textContent = copy.uploading;
      const data = new FormData();
      data.append('key', 'trips/' + slug + '/title');
      data.append('file', file);
      try {
        const response = await fetch('/upload', { method: 'POST', body: data });
        if (response.status === 401) { onUnauthed(); return; }
        if (!response.ok) throw new Error('upload');
        const result = await response.json();
        set({ src: result.src, width: result.width, height: result.height,
          alt: '', ...(result.format ? { format: result.format } : {}) });
        el('Status').textContent = result.status === 'processing' ? copy.processing : copy.selected;
        onChange();
      } catch {
        el('Status').textContent = copy.uploadFailed;
      } finally {
        busy = false;
        ['Upload', 'Library', 'Remove', 'File'].forEach((name) => { el(name).disabled = false; });
      }
    });
    set(undefined);
    return { get, set };
  }

  root.EditorTitleImage = { create };
})(typeof window !== 'undefined' ? window : globalThis);
