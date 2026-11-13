/* Optional story-only image. Copy comes from the shared DE/EN UI dictionary. */
(function (root) {
  'use strict';

  function create(options) {
    const { locale, mount, copy, onChange, onUnauthed } = options;
    const prefix = locale + 'TitleImage';
    // Only fixed markup and the application's own locale are interpolated.
    // The structure mirrors the hero section in editor.html so both image
    // sections read as one pattern: preview, alt text, status, the library
    // action, then the Adjust framing disclosure. Library only (#569).
    mount.innerHTML = `
      <summary class="editor-card-title" id="${prefix}Heading">
        <span class="editor-image-section__title" data-copy="heading"></span>
        <span class="editor-image-section__thumb" id="${prefix}Thumb" hidden><img id="${prefix}ThumbImg" alt="" hidden /></span>
      </summary>
      <div class="hero-picker hero-banner-zone">
        <p class="muted" data-copy="help"></p>
        <div class="hero-compact-preview" id="${prefix}Preview" hidden>
          <img id="${prefix}Img" alt="" hidden />
        </div>
        <div class="hero-fields" id="${prefix}Fields" hidden>
          <label for="${prefix}Alt" data-copy="alt"></label>
          <input type="text" id="${prefix}Alt" maxlength="1000" />
        </div>
        <p class="muted" id="${prefix}Status" role="status"></p>
        <div class="hero-actions-row">
          <button type="button" class="btn-secondary" id="${prefix}Library" data-copy="library" aria-describedby="${prefix}Heading"></button>
          <button type="button" class="btn-secondary" id="${prefix}Remove" data-copy="remove" hidden></button>
        </div>
        <details class="editor-disclosure hero-focus" id="${prefix}Focus" hidden>
          <summary data-copy="framing"></summary>
          <p class="muted" data-copy="framingHelp"></p>
          <label for="${prefix}X"><span data-copy="horizontal"></span> <output id="${prefix}XOut" for="${prefix}X">50%</output></label>
          <input type="range" id="${prefix}X" min="0" max="100" step="1" value="50" />
          <label for="${prefix}Y"><span data-copy="vertical"></span> <output id="${prefix}YOut" for="${prefix}Y">50%</output></label>
          <input type="range" id="${prefix}Y" min="0" max="100" step="1" value="50" />
          <div class="hero-actions-row">
            <button type="button" class="btn-secondary" id="${prefix}Reset" data-copy="reset"></button>
          </div>
        </details>
      </div>`;
    mount.querySelectorAll('[data-copy]').forEach((el) => { el.textContent = copy[el.dataset.copy]; });
    const el = (name) => document.getElementById(prefix + name);
    // English chrome; the alt text itself is locale content.
    el('Alt')?.setAttribute('lang', locale);
    let image;

    function paintFocus() {
      const x = Number(el('X').value);
      const y = Number(el('Y').value);
      el('XOut').textContent = x + '%';
      el('YOut').textContent = y + '%';
      el('Img').style.objectPosition = x + '% ' + y + '%';
      el('ThumbImg').style.objectPosition = x + '% ' + y + '%';
    }

    function set(value) {
      image = value ? { ...value } : undefined;
      el('Alt').value = image?.alt || '';
      el('X').value = image?.focus?.x ?? 50;
      el('Y').value = image?.focus?.y ?? 50;
      el('Fields').hidden = !image;
      el('Focus').hidden = !image;
      el('Remove').hidden = !image;
      el('Preview').hidden = !image;
      el('Thumb').hidden = !image;
      const img = el('Img');
      const thumb = el('ThumbImg');
      if (image) {
        const url = PostsFilter.thumbUrl({ heroSrc: image.src, heroWidth: image.width, heroFormat: image.format });
        img.hidden = false;
        thumb.hidden = false;
        img.src = url;
        thumb.src = url;
        img.onerror = () => { el('Preview').hidden = true; el('Thumb').hidden = true; };
        img.onload = () => { el('Preview').hidden = false; el('Thumb').hidden = false; };
      } else {
        img.hidden = true;
        thumb.hidden = true;
        img.removeAttribute('src');
        thumb.removeAttribute('src');
      }
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
    set(undefined);
    return { get, set };
  }

  root.EditorTitleImage = { create };
})(typeof window !== 'undefined' ? window : globalThis);
