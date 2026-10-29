// ARIA tabs for the admin's DE/EN locale switchers (editor.html, about.html)
// and the Settings index (settings.html).
// WAI-ARIA APG "Tabs" with automatic activation: arrow keys, Home and End move
// focus AND select, Tab leaves the tablist for the active panel. A horizontal
// list uses Left/Right; a list with aria-orientation="vertical" uses Up/Down.
// The orientation is read on every key press, so a page may flip it at a
// breakpoint (Settings' index becomes a horizontal strip on narrow screens).
// The markup declares the roles; this only keeps aria-selected, the roving
// tabindex and the panels' `hidden` in step, so an assistive-tech user hears
// "Deutsch, tab, selected, 1 of 2" instead of "Deutsch, button".
//
// Expected markup:
//   <div role="tablist" aria-label="…" [aria-orientation="vertical"]>
//     <button role="tab" id="tabbtn-de" aria-controls="tab-de" aria-selected="true" data-tab="de">…
//     <button role="tab" id="tabbtn-en" aria-controls="tab-en" aria-selected="false" tabindex="-1" data-tab="en">…
//   <section id="tab-de" role="tabpanel" aria-labelledby="tabbtn-de">…
//   <section id="tab-en" role="tabpanel" aria-labelledby="tabbtn-en" hidden>…
window.Tabs = (function () {
  /**
   * Wires one tablist. `onChange(name)` fires after a user-driven switch with
   * the new tab's `data-tab`; it does not fire for the initial state, which
   * comes from the markup's aria-selected.
   */
  function wire(list, opts) {
    var o = opts || {};
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));

    function select(tab, focus) {
      if (tab.disabled || tab.hidden) return;
      tabs.forEach(function (t) {
        var on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
    }

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        if (tab.disabled || tab.hidden) return;
        select(tab, false);
        if (o.onChange) o.onChange(tab.dataset.tab);
      });
      tab.addEventListener('keydown', function (ev) {
        var vertical = list.getAttribute('aria-orientation') === 'vertical';
        var available = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]')).filter(function (t) { return !t.disabled && !t.hidden; });
        var i = available.indexOf(tab);
        if (i < 0) return;
        var next = null;
        if (ev.key === (vertical ? 'ArrowDown' : 'ArrowRight')) next = (i + 1) % available.length;
        else if (ev.key === (vertical ? 'ArrowUp' : 'ArrowLeft')) next = (i - 1 + available.length) % available.length;
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = available.length - 1;
        if (next === null) return;
        ev.preventDefault();
        select(available[next], true);
        if (o.onChange) o.onChange(available[next].dataset.tab);
      });
    });

    var initial = tabs.filter(function (t) { return t.getAttribute('aria-selected') === 'true'; })[0] || tabs[0];
    if (initial) select(initial, false);

    return {
      /** The selected tab's `data-tab`. */
      active: function () {
        var on = tabs.filter(function (t) { return t.getAttribute('aria-selected') === 'true'; })[0];
        return on ? on.dataset.tab : null;
      },
      select: function (name) {
        var tab = tabs.filter(function (t) { return t.dataset.tab === name; })[0];
        if (tab) select(tab, false);
      },
    };
  }

  return { wire: wire };
})();
