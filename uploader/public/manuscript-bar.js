// The manuscript toolbar shared by the story editor and the page editor: a
// roving role="toolbar" (one Tab stop; arrow keys, Home and End move inside
// it), the phone Format tray, and the formatting buttons, which act on whichever
// view — Visual or Markdown — is showing. The host owns the editors, the Photo
// tray and the gallery tools; this owns only the bar's own behaviour.
window.ManuscriptBar = (function () {
  // Formatting name → the EasyMDE action used in Markdown mode.
  const MARKDOWN_ACTION = {
    bold: 'toggleBold', italic: 'toggleItalic', heading: 'toggleHeadingSmaller',
    quote: 'toggleBlockquote', bullets: 'toggleUnorderedList', numbers: 'toggleOrderedList',
    link: 'drawLink', code: 'toggleCodeBlock',
  };
  const SHORTCUT = { bold: 'B', italic: 'I', link: 'K' };

  /**
   * @param {object} o
   * @param {Element} o.bar            the role="toolbar" element
   * @param {Element} o.formatToggle   the phone-only "Format" button
   * @param {Element} o.formatPanel    the group the toggle opens
   * @param {MediaQueryList} o.compact matches when the tray replaces the inline group
   * @param {string} o.formatLabel     the toggle's text
   * @param {string} o.codeLabel       accessible name of the code-block button
   * @param {(key: string) => string} o.shortcutLabel  "⌘B" / "Ctrl+B"
   * @param {() => void} [o.onOpenFormat]   close whatever else the bar has open
   * @param {() => boolean} o.isVisual      true while the Visual view is showing
   * @param {(name: string) => void} o.command   run a formatting command in the Visual view
   * @param {(action: string) => void} o.markdown  run an EasyMDE action in the Markdown view
   */
  function wire(o) {
    const { bar, formatToggle, formatPanel, compact } = o;
    formatToggle.textContent = o.formatLabel;
    const all = () => Array.from(bar.querySelectorAll('button'));
    const usable = () => all().filter((button) => !button.hidden && !button.disabled
      && (!formatPanel.hidden || !formatPanel.contains(button)));
    const rove = (target) => all().forEach((button) => { button.tabIndex = button === target ? 0 : -1; });
    function closeFormat(restoreFocus = false) {
      if (!compact.matches) return;
      formatPanel.hidden = true;
      formatToggle.setAttribute('aria-expanded', 'false');
      if (formatPanel.querySelector('[tabindex="0"]') || restoreFocus) rove(formatToggle);
      if (restoreFocus) formatToggle.focus({ preventScroll: true });
    }
    function adaptFormat() {
      const focused = document.activeElement;
      formatToggle.hidden = !compact.matches;
      formatPanel.hidden = compact.matches;
      formatToggle.setAttribute('aria-expanded', 'false');
      const target = usable().includes(focused) ? focused : usable()[0];
      rove(target);
      if (bar.contains(focused)) target?.focus({ preventScroll: true });
    }
    compact.addEventListener('change', adaptFormat);
    adaptFormat();
    formatToggle.addEventListener('click', () => {
      if (!formatPanel.hidden) { closeFormat(true); return; }
      o.onOpenFormat?.();
      formatPanel.hidden = false;
      formatToggle.setAttribute('aria-expanded', 'true');
      formatPanel.querySelector('button').focus({ preventScroll: true });
    });
    bar.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && compact.matches && !formatPanel.hidden) {
        event.preventDefault();
        closeFormat(true);
      }
    });
    bar.addEventListener('focusout', (event) => {
      if (!bar.contains(event.relatedTarget)) closeFormat();
    });
    document.addEventListener('click', (event) => {
      if (!bar.contains(event.target)) closeFormat();
    });
    bar.addEventListener('focusin', (event) => {
      const button = event.target.closest('button');
      if (button) rove(button);
    });
    bar.addEventListener('keydown', (event) => {
      const list = usable();
      const index = list.indexOf(document.activeElement);
      const step = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: list.length - 1 }[event.key];
      if (index < 0 || step === undefined) return;
      event.preventDefault();
      const target = list[(step + list.length) % list.length];
      rove(target);
      target.focus();
    });
    bar.querySelectorAll('[data-format]').forEach((button) => {
      const name = button.dataset.format;
      if (name === 'code') button.setAttribute('aria-label', o.codeLabel);
      const label = button.getAttribute('aria-label');
      const key = SHORTCUT[name];
      button.title = key ? label + ' (' + o.shortcutLabel(key) + ')' : label;
      if (key) button.setAttribute('aria-keyshortcuts', 'Meta+' + key + ' Control+' + key);
      button.addEventListener('click', () => {
        if (o.isVisual()) o.command(name);
        else o.markdown(MARKDOWN_ACTION[name]);
        closeFormat();
      });
    });
    /** Re-seats the roving Tab stop after buttons appear or disappear (a mode switch). */
    function settle() {
      const list = usable();
      rove(list.includes(document.activeElement) ? document.activeElement : list.find((button) => button.tabIndex === 0) || list[0]);
    }
    return { closeFormat, settle };
  }

  return { wire };
})();
