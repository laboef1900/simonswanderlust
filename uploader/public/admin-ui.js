// Shared admin presentation helpers, loaded by every admin page before its own
// script. One date format, one count format, one inline-error pattern and one
// way to keep keyboard focus after an action — see DESIGN.md, "Dates and
// counts" and "Errors".
(function (root) {
  'use strict';

  const DATE = { day: 'numeric', month: 'short', year: 'numeric' };
  const TIME = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

  function parse(value) {
    if (value === null || value === undefined || value === '') return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  // A bare calendar date ("2026-10-01") names a day, not an instant: formatting
  // it in the viewer's zone would move it across midnight west of UTC.
  function zone(value, options) {
    const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
    return dateOnly || (options && options.utc) ? { timeZone: 'UTC' } : {};
  }

  /** "10 Nov 2026"; '' for a missing or unparseable value. */
  function date(value, options) {
    const d = parse(value);
    return d ? d.toLocaleDateString('en-GB', { ...DATE, ...zone(value, options) }) : '';
  }
  /** "10 Nov 2026, 08:43" in the viewer's zone (`{ utc: true }` for camera clock times). */
  function dateTime(value, options) {
    const d = parse(value);
    return d ? date(value, options) + ', ' + d.toLocaleTimeString('en-GB', { ...TIME, ...zone(value, options) }) : '';
  }
  /** "08:43". */
  function time(value, options) {
    const d = parse(value);
    return d ? d.toLocaleTimeString('en-GB', { ...TIME, ...zone(value, options) }) : '';
  }
  /** count(1, 'photo') → "1 photo"; count(3, 'photo') → "3 photos"; count(2, 'story', 'stories'). */
  function count(n, singular, plural) {
    const value = Number(n) || 0;
    return value.toLocaleString('en-GB') + ' ' + (value === 1 ? singular : (plural || singular + 's'));
  }

  const REGIONS = {
    europe: 'Europe', asia: 'Asia', africa: 'Africa', 'north-america': 'North America',
    'south-america': 'South America', oceania: 'Oceania', antarctica: 'Antarctica',
  };
  /** The region's display name for its stored slug; the slug itself when unknown. */
  function region(slug) {
    return Object.prototype.hasOwnProperty.call(REGIONS, slug) ? REGIONS[slug] : (slug || '');
  }

  // ---- inline field errors -------------------------------------------------
  function errorFor(field) {
    const id = field.id + 'Error';
    let line = document.getElementById(id);
    if (!line) {
      line = document.createElement('p');
      line.id = id;
      line.className = 'field-error';
      line.hidden = true;
      field.after(line);
    }
    return line;
  }
  function describedBy(field, id, add) {
    const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter((part) => part && part !== id);
    if (add) ids.push(id);
    if (ids.length) field.setAttribute('aria-describedby', ids.join(' '));
    else field.removeAttribute('aria-describedby');
  }
  /**
   * Marks `field` invalid with `message` in a `.field-error` line directly
   * under it and moves focus to the field. The field needs an id.
   */
  function invalid(field, message, options) {
    const line = errorFor(field);
    line.textContent = message;
    line.hidden = false;
    field.setAttribute('aria-invalid', 'true');
    describedBy(field, line.id, true);
    if (!options || options.focus !== false) field.focus();
    return line;
  }
  /** Clears what `invalid` set. */
  function valid(field) {
    const line = document.getElementById(field.id + 'Error');
    if (line && line.classList.contains('field-error')) { line.textContent = ''; line.hidden = true; }
    field.removeAttribute('aria-invalid');
    if (line) describedBy(field, line.id, false);
  }

  // ---- focus ---------------------------------------------------------------
  function lost() {
    const active = document.activeElement;
    return !active || active === document.body;
  }
  /**
   * A control that is disabled while its action runs, or removed by its result,
   * drops focus to <body>. Call `hold(control)` before the action and the
   * returned function after it: focus returns to the control, or to the first
   * usable fallback, only if it was on the control and has since been lost.
   */
  function hold(control) {
    const held = document.activeElement === control;
    return function restore() {
      if (!held || !lost()) return;
      for (const target of [control].concat(Array.prototype.slice.call(arguments))) {
        if (target && target.isConnected !== false && !target.disabled && !target.hidden) {
          target.focus({ preventScroll: true });
          if (document.activeElement === target) return;
        }
      }
    };
  }
  /**
   * The first usable candidate whose box lies fully inside `container`'s
   * visible rect (and the viewport), or null. A focus hand-off that must not
   * scroll the list picks its target with this, then focuses it with
   * `preventScroll: true`.
   */
  function firstInView(candidates, container) {
    if (!container) return null;
    const view = container.getBoundingClientRect();
    const top = Math.max(view.top, 0);
    const bottom = Math.min(view.bottom, root.innerHeight || view.bottom);
    for (const candidate of candidates) {
      if (!candidate || candidate.disabled || candidate.isConnected === false) continue;
      const box = candidate.getBoundingClientRect();
      if (box.height > 0 && box.top >= top && box.bottom <= bottom) return candidate;
    }
    return null;
  }

  // ---- one message carried across a navigation -----------------------------
  // An editor that has just deleted its own story, journey or page returns to
  // the list; the list shows what happened in its status line and clears it.
  const FLASH = 'admin.flash';
  function setFlash(message) {
    try { sessionStorage.setItem(FLASH, String(message)); } catch { /* storage unavailable: the message is lost, the action is not */ }
  }
  function takeFlash() {
    try {
      const message = sessionStorage.getItem(FLASH) || '';
      sessionStorage.removeItem(FLASH);
      return message;
    } catch { return ''; }
  }

  root.AdminFormat = { date, dateTime, time, count, region };
  root.AdminField = { invalid, valid };
  root.AdminFocus = { hold, firstInView };
  root.AdminFlash = { set: setFlash, take: takeFlash };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AdminFormat: root.AdminFormat, AdminField: root.AdminField, AdminFocus: root.AdminFocus, AdminFlash: root.AdminFlash };
  }
})(typeof window === 'undefined' ? globalThis : window);
