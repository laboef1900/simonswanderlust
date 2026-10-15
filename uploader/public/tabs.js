// ARIA tabs for the admin's DE/EN locale switchers (editor.html, about.html).
// WAI-ARIA APG "Tabs" with automatic activation: Left/Right/Home/End move
// focus AND select, Tab leaves the tablist for the active panel. The markup
// declares the roles; this only keeps aria-selected, the roving tabindex and
// the panels' `hidden` in step, so an assistive-tech user hears "Deutsch,
// tab, selected, 1 of 2" instead of "Deutsch, button".
//
// Expected markup:
//   <div role="tablist" aria-label="…">
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

    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () {
        select(tab, false);
        if (o.onChange) o.onChange(tab.dataset.tab);
      });
      tab.addEventListener('keydown', function (ev) {
        var next = null;
        if (ev.key === 'ArrowRight') next = (i + 1) % tabs.length;
        else if (ev.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = tabs.length - 1;
        if (next === null) return;
        ev.preventDefault();
        select(tabs[next], true);
        if (o.onChange) o.onChange(tabs[next].dataset.tab);
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
