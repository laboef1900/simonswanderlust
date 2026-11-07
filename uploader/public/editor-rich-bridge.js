/* Two editable views, one Markdown draft. CodeMirror remains the source used by
 * saving, recovery, review and gallery guards; visual transactions reach it in
 * the same turn. Switching views never serializes or rewrites that draft. */
window.EditorRichBridge = (function () {
  function create({ mde, element, source, error, visualButton, markdownButton,
    galleryToggle, formatButtons, locale, imageOrigin, galleryLibrary, images, thumbnailUrl,
    copy, galleryCopy, onEditGallery, onModeChange }) {
    const cm = mde.codemirror;
    // CodeMirror's default universal-newline split rewrites CRLF on load.
    // LF-only splitting retains every source byte (including mixed endings).
    cm.setOption('lineSeparator', '\n');
    let rich = null;
    let mode = 'markdown';
    let writingSource = false;
    let writingRich = false;
    let destroyed = false;
    let sourceTransactionDepth = 0;

    function sourceSelection() {
      const range = cm.listSelections()[0];
      return { from: cm.indexFromPos(range.anchor), to: cm.indexFromPos(range.head) };
    }
    function writeSelection(selection) {
      const current = sourceSelection();
      if (current.from !== selection.from || current.to !== selection.to) {
        cm.setSelection(cm.posFromIndex(selection.from), cm.posFromIndex(selection.to));
      }
    }
    function refreshFormatting() {
      formatButtons.forEach((button) => {
        if (mode === 'visual' && rich) button.setAttribute('aria-pressed', String(rich.isActive(button.dataset.format)));
        else button.removeAttribute('aria-pressed');
      });
    }
    function renderMode() {
      element.hidden = mode !== 'visual';
      source.hidden = mode === 'visual';
      visualButton.setAttribute('aria-pressed', String(mode === 'visual'));
      markdownButton.setAttribute('aria-pressed', String(mode === 'markdown'));
      visualButton.disabled = typeof window.RichTextEditor?.create !== 'function';
      galleryToggle.hidden = mode === 'visual';
      refreshFormatting();
      onModeChange?.(mode);
    }
    function unavailable() {
      const previous = rich;
      rich = null;
      mode = 'markdown';
      error.textContent = copy.richTextUnavailable;
      error.hidden = false;
      // Never let disposal of a partially initialized view hide the source.
      try { previous?.destroy(); } catch (_) { /* The Markdown draft is intact. */ }
      element.replaceChildren();
      renderMode();
      cm.refresh();
    }
    function sourceChanged() {
      if (destroyed || sourceTransactionDepth || writingSource || !rich) return;
      writingRich = true;
      try {
        const markdown = cm.getValue();
        if (rich.getMarkdown() !== markdown) rich.setMarkdown(markdown);
        rich.setSelection(sourceSelection());
      } catch (_) { unavailable(); }
      finally { writingRich = false; }
      refreshFormatting();
    }
    function sourceSelectionChanged() {
      if (destroyed || sourceTransactionDepth || writingSource || writingRich || !rich) return;
      writingRich = true;
      try { rich.setSelection(sourceSelection()); }
      finally { writingRich = false; }
      refreshFormatting();
    }
    function richSelectionChanged() {
      if (destroyed || sourceTransactionDepth || writingRich || !rich || mode !== 'visual') return;
      writingSource = true;
      try { writeSelection(rich.getSelection()); }
      finally { writingSource = false; }
      refreshFormatting();
    }
    function richChanged(markdown) {
      if (destroyed || sourceTransactionDepth || writingRich || !rich) return;
      const before = cm.getValue();
      if (before === markdown) return;
      // Keep source markers and undo instead of replacing CodeMirror's document.
      let start = 0;
      const common = Math.min(before.length, markdown.length);
      while (start < common && before[start] === markdown[start]) start++;
      let oldEnd = before.length;
      let newEnd = markdown.length;
      while (oldEnd > start && newEnd > start && before[oldEnd - 1] === markdown[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }
      writingSource = true;
      try {
        cm.operation(() => {
          cm.replaceRange(markdown.slice(start, newEnd), cm.posFromIndex(start), cm.posFromIndex(oldEnd), '+rich-text');
          writeSelection(rich.getSelection());
        });
      } finally { writingSource = false; }
      refreshFormatting();
    }
    function setMode(next) {
      if (destroyed || (next !== 'visual' && next !== 'markdown') || next === mode) return;
      if (next === 'visual' && !rich) {
        try { mountRich(); error.hidden = true; }
        catch (_) { unavailable(); return; }
      }
      const selection = mode === 'visual' ? rich.getSelection() : sourceSelection();
      const hadFocus = element.contains(document.activeElement) || source.contains(document.activeElement);
      mode = next;
      writingRich = true;
      writingSource = true;
      try {
        if (mode === 'visual') rich.setSelection(selection);
        else writeSelection(selection);
      } finally { writingRich = false; writingSource = false; }
      renderMode();
      if (mode === 'markdown') cm.refresh();
      if (hadFocus) focus();
    }
    function focus() {
      if (mode === 'visual' && rich) rich.focus();
      else cm.focus();
    }
    function visualClick() { setMode('visual'); }
    function markdownClick() { setMode('markdown'); }
    function richShortcut(event) {
      // StarterKit owns formatting and history shortcuts. Link needs a URL prompt.
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== 'k' || !rich) return;
      event.preventDefault();
      rich.command('link');
    }
    function mountRich() {
      rich = window.RichTextEditor.create({
        element, markdown: cm.getValue(), locale, imageOrigin, galleryLibrary, images, thumbnailUrl,
        copy: {
          bodyLabel: copy.visualBodyLabel.replace('{locale}', locale.toUpperCase()),
          sourceLabel: copy.richSourceLabel, sourceHelp: copy.richSourceHelp, galleryLabel: copy.richGalleryLabel,
          editGallery: copy.richEditGallery, imageUnavailable: copy.richImageUnavailable,
          linkPrompt: copy.richLinkPrompt, linkInvalid: copy.richLinkInvalid,
          galleryChecking: galleryCopy.checking, galleryLookupFailed: galleryCopy.mediaFailed,
          galleryRetry: galleryCopy.retry,
        },
        onChange: richChanged, onSelection: richSelectionChanged, onEditGallery,
      });
      element.querySelector('[contenteditable="true"]')?.setAttribute('aria-label',
        copy.visualBodyLabel.replace('{locale}', locale.toUpperCase()));
    }
    function replaceDocument(markdown) {
      // Loading/restoring a whole form establishes a new undo baseline; gallery
      // and ordinary source edits instead use the silent, history-preserving sync.
      writingSource = true;
      try { mde.value(markdown); cm.clearHistory(); }
      finally { writingSource = false; }
      try {
        rich?.destroy();
        rich = null;
        mountRich();
        error.hidden = true;
        renderMode();
      } catch (_) { unavailable(); }
    }

    // A full-field commit must not enter ProseMirror until every field succeeds.
    // Restoring source/history/selection on failure is deliberately invisible to
    // the rich engine: replaying a rollback there would destroy its redo branch.
    function sourceTransaction(commit, rollback) {
      const before = cm.getValue();
      const history = structuredClone(cm.getHistory());
      const selections = structuredClone(cm.listSelections());
      let committed = false;
      sourceTransactionDepth++;
      try {
        cm.operation(commit);
        committed = true;
      } catch (failure) {
        cm.operation(() => {
          rollback();
          cm.setValue(before);
          cm.setHistory(history);
          cm.setSelections(selections);
        });
        throw failure;
      } finally {
        sourceTransactionDepth--;
        if (committed && !sourceTransactionDepth) sourceChanged();
      }
    }

    visualButton.textContent = copy.visualMode;
    markdownButton.textContent = copy.markdownMode;
    visualButton.title = copy.visualHelp;
    markdownButton.title = copy.markdownHelp;
    element.setAttribute('aria-label', copy.visualBodyLabel.replace('{locale}', locale.toUpperCase()));
    visualButton.addEventListener('click', visualClick);
    markdownButton.addEventListener('click', markdownClick);
    element.addEventListener('keydown', richShortcut);
    cm.on('change', sourceChanged);
    cm.on('cursorActivity', sourceSelectionChanged);
    try {
      mountRich();
      mode = 'visual';
      error.hidden = true;
      renderMode();
    } catch (_) { unavailable(); }

    return {
      setMode, focus, replaceDocument, sourceTransaction,
      isVisual: () => mode === 'visual',
      command(name) { if (rich && mode === 'visual') { rich.command(name); refreshFormatting(); } },
      undo() { if (rich && mode === 'visual') rich.undo(); else cm.undo(); },
      redo() { if (rich && mode === 'visual') rich.redo(); else cm.redo(); },
      getSelection: () => mode === 'visual' && rich ? rich.getSelection() : sourceSelection(),
      setSelection(selection) {
        writingSource = true;
        try { writeSelection(selection); }
        finally { writingSource = false; }
        sourceSelectionChanged();
      },
      destroy() {
        destroyed = true;
        cm.off('change', sourceChanged);
        cm.off('cursorActivity', sourceSelectionChanged);
        visualButton.removeEventListener('click', visualClick);
        markdownButton.removeEventListener('click', markdownClick);
        element.removeEventListener('keydown', richShortcut);
        rich?.destroy();
      },
    };
  }
  return { create };
})();
