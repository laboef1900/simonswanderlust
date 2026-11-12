// A select-only combobox (WAI-ARIA APG) drawn over a native <select>, loaded by
// an admin page before its own script. The <select> stays in the DOM, hidden,
// as the single source of truth: the page keeps reading and assigning
// `select.value` and listening for its `input`/`change` events, and calls
// `menu.sync()` after a programmatic write (those fire no event, natively or
// here). Contract: docs/superpowers/specs/2026-11-11-issue-566-posts-bulk-bar-
// filters-design.md, sections 3 to 5.
(function (root) {
  'use strict';

  const TYPEAHEAD_MS = 500;
  const PAGE = 10;
  // Computed overflow values that clip a panel inside the element.
  const CLIPS = /^(?:auto|scroll|hidden|clip|overlay)$/;

  /**
   * The option a type-ahead `query` lands on, or -1 for no match: a
   * case-insensitive prefix match on `labels` over `enabled` options, searching
   * forward and wrapping. One character — or one character repeated ("nnn") —
   * starts after `start`, so repeated presses cycle through that initial; a
   * longer buffer starts at `start`, so "no" → "nor" stays on "Norway".
   */
  function typeahead(labels, enabled, start, query) {
    const text = String(query).toLowerCase();
    const chars = Array.from(text);
    if (!chars.length) return -1;
    const repeated = chars.every((char) => char === chars[0]);
    const prefix = repeated ? chars[0] : text;
    const from = Math.max(repeated ? start + 1 : start, 0);
    for (let step = 0; step < labels.length; step++) {
      const index = (from + step) % labels.length;
      if (enabled[index] && String(labels[index]).toLowerCase().startsWith(prefix)) return index;
    }
    return -1;
  }

  /**
   * Where an opening panel goes. `trigger` and `boundary` are viewport rects
   * ({ top, bottom, left, right }), `panelHeight`/`panelWidth` the panel's
   * natural size, everything in px.
   *
   * Below when min(panelHeight, cap) fits there; otherwise above when that side
   * has more room, else below. `maxHeight` is the chosen side's room — less the
   * `gap` to the trigger and a `margin` to the boundary, at most `cap`, never
   * under `minHeight` — and the panel scrolls inside it.
   *
   * The panel is at least as wide as the trigger and at most min(widthCap,
   * boundary width − 2 margins). It aligns to the trigger's start edge, and to
   * its end edge (`alignEnd`) when the start would cross the boundary's right
   * edge — unless the end would cross the left edge by as much or more.
   */
  function place({ trigger, boundary, panelHeight, panelWidth, cap = 320, gap = 4, margin = 8, minHeight = 0, widthCap = 352 }) {
    const below = boundary.bottom - trigger.bottom - gap - margin;
    const above = trigger.top - boundary.top - gap - margin;
    const flip = Math.min(panelHeight, cap) > below && above > below;
    const room = Math.max(0, boundary.right - boundary.left - 2 * margin);
    const minWidth = Math.min(trigger.right - trigger.left, room);
    const maxWidth = Math.max(minWidth, Math.min(widthCap, room));
    const width = Math.min(Math.max(panelWidth, minWidth), maxWidth);
    const pastRight = trigger.left + width - boundary.right;
    const pastLeft = boundary.left - (trigger.right - width);
    return {
      above: flip,
      maxHeight: Math.max(minHeight, Math.min(cap, flip ? above : below)),
      alignEnd: pastRight > 0 && pastLeft < pastRight,
      minWidth,
      maxWidth,
    };
  }

  function element(tag, className, attributes) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, value);
    return node;
  }
  // Writes that skip when nothing would change: sync() runs after every render
  // and every options refresh, and must leave an unchanged menu untouched.
  function attribute(node, name, value) {
    if (value === null) node.removeAttribute(name);
    else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }
  function flag(node, name, on) {
    if (node.classList.contains(name) !== on) node.classList.toggle(name, on);
  }
  function text(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  /**
   * Hides `select` and inserts directly after it a captioned box holding a
   * combobox, and a listbox built from the select's options. `opts.label`
   * names the control and defaults to the select's aria-label; one of them is
   * required, as is the select's id (every generated id derives from it and a
   * position, never from option text).
   * Returns { sync, close, trigger }; `trigger` is the combobox, for focus hand-offs.
   */
  function enhance(select, opts) {
    const id = select.id;
    const label = String(opts?.label ?? select.getAttribute('aria-label') ?? '').trim();
    if (!id) throw new Error('AdminSelect.enhance: the select needs an id');
    if (!label) throw new Error('AdminSelect.enhance: #' + id + ' needs a label (opts.label or aria-label)');

    const wrapper = element('div', 'admin-select');
    // The visible box holds the caption and, beside it, the combobox — which
    // contains nothing but the value, because a browser derives a combobox's
    // value from all of its text, aria-hidden or not. The caption names the
    // control from outside it, its colon outside the span that does the naming.
    const box = element('div', 'admin-select__trigger');
    const caption = element('span', 'admin-select__label', { 'aria-hidden': 'true' });
    const name = element('span', '', { id: id + '-label' });
    const colon = element('span', '');
    const control = element('div', 'admin-select__control', {
      role: 'combobox',
      tabindex: '0',
      id: id + '-combo',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-controls': id + '-listbox',
      'aria-labelledby': id + '-label',
    });
    const value = element('span', 'admin-select__value');
    const panel = element('ul', 'admin-select__panel', {
      role: 'listbox',
      id: id + '-listbox',
      'aria-labelledby': id + '-label',
      tabindex: '-1',
      hidden: '',
    });
    name.textContent = label;
    colon.textContent = ':';
    caption.append(name, colon);
    control.append(value);
    box.append(caption, control);
    wrapper.append(box, panel);

    let items = [];        // rendered options: { index, value, label, disabled, hidden, node }
    let signature = null;  // what `items` was built from
    let open = false;
    let active = -1;       // position in `items`; -1 while closed
    let typed = '';        // the type-ahead buffer
    let typedTimer = 0;

    // The positions a key or the pointer may land on: a disabled option is never active.
    const enabled = () => items.flatMap((item, at) => (item.disabled ? [] : [at]));
    // Where an opened or rebuilt list starts: the selected option, or the first
    // enabled one when the selected option is hidden or disabled.
    function resting(stops) {
      const at = items.findIndex((item) => item.index === select.selectedIndex);
      return stops.includes(at) ? at : stops[0];
    }

    // ---- rendering ---------------------------------------------------------
    // Reflects the select's current choice and disabled state.
    function update() {
      const chosen = select.options[select.selectedIndex];
      const first = select.options[0];
      text(value, chosen ? chosen.label : '');
      flag(wrapper, 'is-set', Boolean(first) && select.value !== first.value);
      attribute(control, 'aria-disabled', select.disabled ? 'true' : null);
      for (const item of items) {
        flag(item.node, 'is-selected', item.index === select.selectedIndex);
        attribute(item.node, 'aria-selected', String(item.index === select.selectedIndex));
      }
    }

    function rebuild(shown) {
      const kept = items[active] ? items[active].value : null;
      items = shown.map((option, at) => {
        const node = element('li', 'admin-select__option', { role: 'option', id: id + '-opt-' + at });
        node.textContent = option.label;
        if (option.disabled) node.setAttribute('aria-disabled', 'true');
        return { ...option, node };
      });
      panel.replaceChildren(...items.map((item) => item.node));
      active = -1;
      if (!open) return;
      // An open list keeps its active option by value, else moves to the selected one.
      const stops = enabled();
      if (!stops.length) close();
      else activate(stops.find((at) => items[at].value === kept) ?? resting(stops));
    }

    /** Re-reads options, value and disabled state from the select. */
    function sync() {
      const options = Array.from(select.options, (option, index) => ({
        index,
        value: option.value,
        label: option.label,
        disabled: option.disabled,
        hidden: Boolean(option.hidden),
      }));
      // The list is rebuilt only when what it shows changed: a page may rewrite
      // identical options on every refresh.
      const next = JSON.stringify(options);
      if (next !== signature) {
        signature = next;
        rebuild(options.filter((option) => !option.hidden));
      }
      update();
      if (select.disabled) close();
    }

    // ---- placement ---------------------------------------------------------
    // The viewport, cut down to the nearest ancestor that clips its content.
    function boundary() {
      const view = document.documentElement;
      const bounds = { top: 0, left: 0, bottom: view.clientHeight || root.innerHeight, right: view.clientWidth || root.innerWidth };
      for (let node = wrapper.parentElement; node && node !== document.body && node !== view; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (!CLIPS.test(style.overflowY) && !CLIPS.test(style.overflowX)) continue;
        const rect = node.getBoundingClientRect();
        const top = rect.top + node.clientTop;
        const left = rect.left + node.clientLeft;
        bounds.top = Math.max(bounds.top, top);
        bounds.left = Math.max(bounds.left, left);
        bounds.bottom = Math.min(bounds.bottom, top + node.clientHeight);
        bounds.right = Math.min(bounds.right, left + node.clientWidth);
        break;
      }
      return bounds;
    }

    // Measured once, on open, at the panel's natural size: close() clears what this sets.
    function position() {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const spot = place({
        trigger: box.getBoundingClientRect(),
        boundary: boundary(),
        panelHeight: panel.scrollHeight,
        panelWidth: panel.offsetWidth,
        cap: 20 * rem,
        widthCap: 22 * rem,
        minHeight: 2 * items[0].node.offsetHeight,
      });
      wrapper.classList.toggle('is-above', spot.above);
      wrapper.classList.toggle('is-end', spot.alignEnd);
      panel.style.maxHeight = spot.maxHeight + 'px';
      panel.style.minWidth = spot.minWidth + 'px';
      panel.style.maxWidth = spot.maxWidth + 'px';
    }

    // ---- state -------------------------------------------------------------
    // Makes `at` the active option. The pointer stops here: the list must not
    // move under it.
    function mark(at) {
      if (at === active) return;
      if (items[active]) items[active].node.classList.remove('is-active');
      active = at;
      items[at].node.classList.add('is-active');
      control.setAttribute('aria-activedescendant', items[at].node.id);
    }
    // … and keeps it in view by moving the panel's own scrollTop; scrollIntoView
    // could scroll the workspace as well.
    function activate(at) {
      mark(at);
      const top = panel.getBoundingClientRect().top + panel.clientTop;
      const rect = items[at].node.getBoundingClientRect();
      const past = rect.bottom - (top + panel.clientHeight);
      if (rect.top < top) panel.scrollTop += rect.top - top;
      else if (past > 0) panel.scrollTop += past;
    }

    function outside(event) {
      if (!wrapper.contains(event.target)) close();
    }

    // False when there is nothing to open: a disabled select, or no enabled option.
    function show() {
      const stops = enabled();
      if (open || select.disabled || !stops.length) return false;
      open = true;
      panel.hidden = false;
      wrapper.classList.add('is-open');
      control.setAttribute('aria-expanded', 'true');
      position();
      // Only while open, and in the capture phase: a handler that stops the
      // event must not keep the panel up.
      document.addEventListener('pointerdown', outside, true);
      activate(resting(stops));
      return true;
    }

    /** Closes without committing. */
    function close() {
      if (!open) return;
      open = false;
      document.removeEventListener('pointerdown', outside, true);
      clearTimeout(typedTimer);
      typed = '';
      if (items[active]) items[active].node.classList.remove('is-active');
      active = -1;
      control.removeAttribute('aria-activedescendant');
      control.setAttribute('aria-expanded', 'false');
      wrapper.classList.remove('is-open', 'is-above', 'is-end');
      panel.style.maxHeight = '';
      panel.style.minWidth = '';
      panel.style.maxWidth = '';
      panel.hidden = true;
    }

    // Picks the active option and closes. The select then fires `input` and
    // `change`, as a native one does, and only when its value changed.
    function commit() {
      const item = items[active];
      close();
      if (!item || item.index === select.selectedIndex) return;
      const before = select.value;
      select.value = item.value;
      update();
      if (select.value === before) return;
      select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // By `by` enabled options, stopping at either end.
    function move(by) {
      const stops = enabled();
      const at = stops.indexOf(active) + by;
      activate(stops[Math.min(Math.max(at, 0), stops.length - 1)]);
    }

    function type(char) {
      typed += char;
      clearTimeout(typedTimer);
      typedTimer = setTimeout(() => { typed = ''; }, TYPEAHEAD_MS);
      const at = typeahead(items.map((item) => item.label), items.map((item) => !item.disabled), active, typed);
      if (at >= 0) activate(at);
    }

    // ---- keyboard ----------------------------------------------------------
    control.addEventListener('keydown', (event) => {
      const key = event.key;
      const arrow = key === 'ArrowDown' || key === 'ArrowUp';
      if (select.disabled || event.isComposing || event.ctrlKey || event.metaKey || (event.altKey && !arrow)) return;
      const char = Array.from(key).length === 1;
      if (!open) {
        if (!arrow && !char && key !== 'Enter' && key !== 'Home' && key !== 'End') return;
        event.preventDefault();
        if (!show()) return;
        if (key === 'Home') move(-Infinity);
        else if (key === 'End') move(Infinity);
        else if (char && key !== ' ') type(key);
        return;
      }
      // Tab commits and is left alone, so focus moves on.
      if (key === 'Tab') { commit(); return; }
      if (key === 'Escape') {
        // Consumed: no outer Escape handler also runs.
        event.stopPropagation();
        close();
      } else if (key === 'Enter' || (key === ' ' && !typed) || (key === 'ArrowUp' && event.altKey)) commit();
      else if (key === 'ArrowDown') { if (!event.altKey) move(1); }
      else if (key === 'ArrowUp') move(-1);
      else if (key === 'PageDown') move(PAGE);
      else if (key === 'PageUp') move(-PAGE);
      else if (key === 'Home') move(-Infinity);
      else if (key === 'End') move(Infinity);
      else if (char) type(key);
      else return;
      event.preventDefault();
    });

    // ---- pointer and focus -------------------------------------------------
    // A press on the caption must not take focus from the control: the blur
    // would close an open panel just before the click opens it again.
    box.addEventListener('pointerdown', (event) => {
      if (!control.contains(event.target)) event.preventDefault();
    });
    box.addEventListener('click', () => {
      if (open) close();
      // The click may have landed on the caption, or come from a script or an
      // assistive tool: focus still ends on the control, where keys and blur work.
      else if (show() && document.activeElement !== control) control.focus({ preventScroll: true });
    });
    // The control keeps focus while the pointer works in the panel.
    panel.addEventListener('pointerdown', (event) => event.preventDefault());
    const pointed = (event) => {
      const node = event.target.closest('.admin-select__option');
      return enabled().find((at) => items[at].node === node) ?? -1;
    };
    // Hover moves the active option, so keyboard and pointer never diverge.
    panel.addEventListener('pointermove', (event) => {
      const at = pointed(event);
      if (at >= 0) mark(at);
    });
    panel.addEventListener('click', (event) => {
      const at = pointed(event);
      if (at < 0) return;
      mark(at);
      commit();
    });
    control.addEventListener('blur', (event) => {
      if (!wrapper.contains(event.relatedTarget)) close();
    });

    select.hidden = true;
    select.after(wrapper);
    sync();
    // Option changes arrive as one batch per microtask, however many nodes moved.
    new MutationObserver(() => sync()).observe(select, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'disabled', 'label', 'value', 'selected'],
    });

    return { sync, close, trigger: control };
  }

  root.AdminSelect = { enhance, typeahead, place };
})(window);
