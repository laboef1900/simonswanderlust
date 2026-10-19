// Responsive editor inspector. On desktop it is a column beside the canvas
// that collapses into a slim rail keeping only its header toggle; on compact
// screens it is a focus-managed, dialog-like drawer opened from the command
// bar. The header button is the one panel control in both modes.
window.EditorInspector = (function () {
  'use strict';

  var FOCUSABLE = 'a[href], button:not([disabled]), summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var LABEL = {
    collapse: 'Collapse story details',
    expand: 'Expand story details',
    close: 'Close story details',
  };

  function wire(options) {
    var body = options.body;
    var inspector = options.inspector;
    var content = options.content;
    var toggle = options.toggle;
    var headerButton = options.headerButton;
    var scrim = options.scrim;
    var writingSurface = options.writingSurface;
    var commandbar = options.commandbar;
    var media = options.media || window.matchMedia('(max-width: 74rem)');
    var desktopCollapsed = false;
    var restoreFocus = null;

    // The action bar can wrap at narrow widths or zoom. Measure its actual
    // height so the pinned inspector never sits underneath its controls.
    if (window.ResizeObserver && commandbar) {
      var barObserver = new window.ResizeObserver(function () {
        body.style.setProperty('--editor-commandbar-height', commandbar.getBoundingClientRect().height + 'px');
      });
      barObserver.observe(commandbar);
    }

    function isMobile() { return media.matches; }

    function focusables() {
      return Array.prototype.slice.call(inspector.querySelectorAll(FOCUSABLE)).filter(function (node) {
        var closed = node.closest('details:not([open])');
        // Chromium reports layout rects for controls inside a closed <details>,
        // even though focus() refuses them. Only its summary belongs in the trap.
        if (closed && node !== closed.querySelector('summary')) return false;
        return !node.disabled && node.tabIndex >= 0 && node.getClientRects().length > 0;
      });
    }

    function openDetailsFor(target) {
      var node = target && target.parentElement;
      while (node && node !== inspector) {
        if (node.tagName === 'DETAILS') node.open = true;
        node = node.parentElement;
      }
    }

    function setBackgroundInert(on) {
      [writingSurface, commandbar].forEach(function (node) {
        if (!node) return;
        if (on) node.setAttribute('inert', '');
        else node.removeAttribute('inert');
      });
    }

    // The collapsed rail keeps its toggle operable, so only the content after
    // the header leaves the focus order and the accessibility tree.
    function setContentHidden(on) {
      if (on) {
        content.setAttribute('inert', '');
        content.setAttribute('aria-hidden', 'true');
      } else {
        content.removeAttribute('inert');
        content.removeAttribute('aria-hidden');
      }
    }

    function setHeaderButton(expanded, label) {
      headerButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      headerButton.setAttribute('aria-label', label);
      headerButton.title = label;
    }

    function applyDesktop() {
      body.classList.remove('editor-inspector-open');
      body.classList.toggle('editor-inspector-collapsed', desktopCollapsed);
      scrim.hidden = true;
      setBackgroundInert(false);
      inspector.removeAttribute('role');
      inspector.removeAttribute('aria-modal');
      inspector.removeAttribute('aria-hidden');
      inspector.removeAttribute('inert');
      setContentHidden(desktopCollapsed);
      setHeaderButton(!desktopCollapsed, desktopCollapsed ? LABEL.expand : LABEL.collapse);
      // The rail toggle is the desktop control; the drawer opener never shows.
      toggle.hidden = true;
      restoreFocus = null;
    }

    function openMobile(target) {
      restoreFocus = target ? toggle : document.activeElement;
      body.classList.remove('editor-inspector-collapsed');
      body.classList.add('editor-inspector-open');
      scrim.hidden = false;
      inspector.removeAttribute('inert');
      setContentHidden(false);
      inspector.setAttribute('role', 'dialog');
      inspector.setAttribute('aria-modal', 'true');
      inspector.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true');
      setHeaderButton(true, LABEL.close);
      setBackgroundInert(true);
      if (target) {
        openDetailsFor(target);
        target.focus();
      } else {
        headerButton.focus();
      }
    }

    function closeMobile(shouldRestore) {
      var wasOpen = body.classList.contains('editor-inspector-open');
      body.classList.remove('editor-inspector-open', 'editor-inspector-collapsed');
      scrim.hidden = true;
      setBackgroundInert(false);
      inspector.removeAttribute('role');
      inspector.removeAttribute('aria-modal');
      inspector.setAttribute('aria-hidden', 'true');
      inspector.setAttribute('inert', '');
      setContentHidden(false);
      toggle.setAttribute('aria-expanded', 'false');
      toggle.hidden = false;
      setHeaderButton(false, LABEL.close);
      if (shouldRestore && (wasOpen || inspector.contains(document.activeElement))) (restoreFocus || toggle).focus();
      restoreFocus = null;
    }

    function syncMode() {
      if (isMobile()) {
        var moveFocus = inspector.contains(document.activeElement);
        closeMobile(false);
        if (moveFocus) toggle.focus();
      } else {
        var toggleFocused = document.activeElement === toggle;
        var contentFocused = content.contains(document.activeElement);
        applyDesktop();
        // The opener is hidden on desktop and collapsed content is inert; the
        // rail toggle is what remains to hold focus.
        if (toggleFocused || (desktopCollapsed && contentFocused)) headerButton.focus();
      }
    }

    function reveal(target) {
      openDetailsFor(target);
      if (isMobile()) openMobile(target);
      else {
        desktopCollapsed = false;
        applyDesktop();
        if (target) target.focus();
      }
    }

    toggle.addEventListener('click', function () {
      if (isMobile()) openMobile();
    });
    headerButton.addEventListener('click', function () {
      if (isMobile()) {
        closeMobile(true);
        return;
      }
      desktopCollapsed = !desktopCollapsed;
      applyDesktop();
      headerButton.focus();
    });
    scrim.addEventListener('click', function () { closeMobile(true); });
    document.addEventListener('keydown', function (event) {
      if (!isMobile() || !body.classList.contains('editor-inspector-open')) return;
      // A modal opened from inside the drawer (for example MediaPicker) owns
      // its keyboard interaction. Do not consume its Escape or trap its Tab
      // inside the background inspector. MediaPicker removes its dialog during
      // cancel, before the browser can restore focus, so recover to the drawer.
      var foreignDialog = !inspector.contains(event.target) && document.querySelector('dialog[open]');
      if (foreignDialog) {
        if (event.key === 'Escape') {
          setTimeout(function () {
            if (body.classList.contains('editor-inspector-open')
                && !inspector.contains(document.activeElement)) headerButton.focus();
          }, 0);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMobile(true);
        return;
      }
      if (event.key !== 'Tab') return;
      var controls = focusables();
      if (!controls.length) return;
      var first = controls[0];
      var last = controls[controls.length - 1];
      if (!inspector.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    if (media.addEventListener) media.addEventListener('change', syncMode);
    else if (media.addListener) media.addListener(syncMode);
    syncMode();

    return { reveal: reveal, close: function () { if (isMobile()) closeMobile(true); } };
  }

  return { wire: wire };
})();
