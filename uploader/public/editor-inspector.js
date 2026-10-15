// Responsive editor inspector: collapsible beside the canvas on desktop and a
// focus-managed, dialog-like drawer on compact screens.
window.EditorInspector = (function () {
  'use strict';

  var FOCUSABLE = 'a[href], button:not([disabled]), summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function wire(options) {
    var body = options.body;
    var inspector = options.inspector;
    var toggle = options.toggle;
    var closeButton = options.closeButton;
    var scrim = options.scrim;
    var writingSurface = options.writingSurface;
    var commandbar = options.commandbar;
    var media = options.media || window.matchMedia('(max-width: 74rem)');
    var desktopCollapsed = false;
    var restoreFocus = null;

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

    function applyDesktop() {
      body.classList.remove('editor-inspector-open');
      body.classList.toggle('editor-inspector-collapsed', desktopCollapsed);
      scrim.hidden = true;
      setBackgroundInert(false);
      inspector.removeAttribute('role');
      inspector.removeAttribute('aria-modal');
      inspector.setAttribute('aria-hidden', desktopCollapsed ? 'true' : 'false');
      if (desktopCollapsed) inspector.setAttribute('inert', '');
      else inspector.removeAttribute('inert');
      toggle.setAttribute('aria-expanded', desktopCollapsed ? 'false' : 'true');
      toggle.textContent = desktopCollapsed ? 'Show story details' : 'Hide story details';
      restoreFocus = null;
    }

    function openMobile(target) {
      restoreFocus = target ? toggle : document.activeElement;
      body.classList.remove('editor-inspector-collapsed');
      body.classList.add('editor-inspector-open');
      scrim.hidden = false;
      inspector.removeAttribute('inert');
      inspector.setAttribute('role', 'dialog');
      inspector.setAttribute('aria-modal', 'true');
      inspector.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.textContent = 'Close story details';
      setBackgroundInert(true);
      if (target) {
        openDetailsFor(target);
        target.focus();
      } else {
        closeButton.focus();
      }
    }

    function closeMobile(shouldRestore) {
      var wasOpen = body.classList.contains('editor-inspector-open');
      body.classList.remove('editor-inspector-open');
      scrim.hidden = true;
      setBackgroundInert(false);
      inspector.removeAttribute('role');
      inspector.removeAttribute('aria-modal');
      inspector.setAttribute('aria-hidden', 'true');
      inspector.setAttribute('inert', '');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = 'Story details';
      if (shouldRestore && (wasOpen || inspector.contains(document.activeElement))) (restoreFocus || toggle).focus();
      restoreFocus = null;
    }

    function syncMode() {
      if (isMobile()) {
        var moveFocus = inspector.contains(document.activeElement);
        closeMobile(false);
        if (moveFocus) toggle.focus();
      } else {
        applyDesktop();
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
      if (isMobile()) {
        if (body.classList.contains('editor-inspector-open')) closeMobile(true);
        else openMobile();
        return;
      }
      desktopCollapsed = !desktopCollapsed;
      if (desktopCollapsed && inspector.contains(document.activeElement)) toggle.focus();
      applyDesktop();
    });
    closeButton.addEventListener('click', function () { closeMobile(true); });
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
                && !inspector.contains(document.activeElement)) closeButton.focus();
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
