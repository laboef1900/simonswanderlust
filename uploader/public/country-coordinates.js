/* Offline country → approximate coordinates for the trip fields.
 *
 * @ai-note One invariant: this module only ever changes a value it wrote
 * itself in this page session and that still reads exactly as written. Loaded,
 * typed, restored or partial coordinates and ISO codes belong to the author and
 * change only through the explicit "use country centre" button. Stops are never
 * touched. Lookups use the bundled Natural Earth table (country-centers.js) and
 * Intl.DisplayNames — no request leaves the browser.
 * @ai-context scripts/build-country-centers.mjs (data), test/country-coordinates.test.ts
 */
(function (root) {
  'use strict';

  const LETTERS = { 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'ł': 'l', 'đ': 'd', 'ı': 'i', 'þ': 'th' };
  const UMLAUTS = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue' };

  // Case, diacritics, punctuation and a leading article do not distinguish
  // countries: "die Türkei", "Turkei" and "TÜRKEI" are one key; dots vanish so
  // "U.S.A." and "St. Lucia" read as "usa" and "st lucia".
  function normalize(text) {
    return String(text).toLowerCase()
      .replace(/[ßæœøłđıþ]/g, (c) => LETTERS[c])
      .normalize('NFD').replace(/\p{M}/gu, '')
      .replace(/[.'’]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/^(the|die|der|das) /, '');
  }

  let table;
  function data() {
    if (table) return table;
    const rows = root.CountryCenters || [];
    const centers = new Map();
    const index = new Map();
    const codes = new Set(rows.map((row) => row[0].toLowerCase()));
    const add = (key, iso) => {
      // A two-letter alias that spells another country's ISO code ("UK" is
      // fine, Intl's short "SK"-style forms would not be) is never trusted.
      if (!key || (key.length === 2 && codes.has(key) && key !== iso.toLowerCase())) return;
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(iso);
    };
    const displays = [];
    for (const lang of ['de', 'en']) {
      for (const style of ['long', 'short']) {
        try { displays.push(new Intl.DisplayNames([lang], { type: 'region', style })); } catch { /* no Intl region names */ }
      }
    }
    for (const [iso, lat, lng, ...names] of rows) {
      centers.set(iso, { lat, lng, name: names[0] || iso });
      for (const display of displays) {
        const name = display.of(iso);
        if (name && name !== iso) names.push(name);
      }
      for (const name of names) {
        add(normalize(name), iso);
        // German spelled without umlauts: "Oesterreich", "Tuerkei".
        add(normalize(String(name).toLowerCase().replace(/[äöü]/g, (c) => UMLAUTS[c])), iso);
      }
    }
    table = { centers, index };
    return table;
  }

  // { kind: 'empty' | 'unknown' | 'ambiguous' } or { kind: 'found', iso }.
  // A bare two-letter ISO code ("GR", "gr") names its country directly.
  function lookup(text) {
    const code = String(text || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code) && data().centers.has(code)) return { kind: 'found', iso: code };
    const key = normalize(text || '');
    if (!key) return { kind: 'empty' };
    const hits = data().index.get(key);
    if (!hits) return { kind: 'unknown' };
    if (hits.size > 1) return { kind: 'ambiguous' };
    return { kind: 'found', iso: [...hits][0] };
  }

  function center(iso) {
    const hit = data().centers.get(String(iso || '').trim().toUpperCase());
    return hit ? { lat: hit.lat, lng: hit.lng } : null;
  }

  function wire({ countries, codeInput, latInput, lngInput, status, useButton, copy, lang }) {
    let strings = copy || {};
    let locale = lang || 'en';
    let auto = null;      // { lat, lng } exactly as this module last wrote them
    let autoCode = null;  // ISO code exactly as this module last wrote it
    let writing = false;

    const blank = (input) => input.value.trim() === '';
    const codeText = () => codeInput.value.trim().toUpperCase();
    const ownsCoords = () => auto !== null && latInput.value === auto.lat && lngInput.value === auto.lng;
    const ownsCode = () => autoCode !== null && codeText() === autoCode;

    function displayName(iso) {
      try {
        const name = new Intl.DisplayNames([locale], { type: 'region' }).of(iso);
        if (name && name !== iso) return name;
      } catch { /* fall back to the dataset name */ }
      return data().centers.get(iso).name;
    }

    function format(key, values) {
      return String(strings[key] || '').replace(/\{(\w+)\}/g, (match, name) => (name in values ? values[name] : match));
    }

    // Names decide; an ISO code only speaks for itself when the author (not
    // this module) entered it and no country name contradicts it. A code this
    // module wrote describes the previous name and is never evidence.
    function resolve() {
      const results = countries
        .map((input) => input.value.trim())
        .filter(Boolean)
        .map((name) => ({ name, ...lookup(name) }));
      const found = new Set(results.filter((r) => r.kind === 'found').map((r) => r.iso));
      if (found.size > 1) return { kind: 'conflict' };
      const problem = results.find((r) => r.kind !== 'found');
      const code = blank(codeInput) || ownsCode() ? '' : codeText();
      if (!problem && found.size === 1) {
        const iso = [...found][0];
        return { kind: 'found', iso, via: 'name', mismatch: code && code !== iso ? code : '' };
      }
      if (code && center(code) && (found.size === 0 || found.has(code))) return { kind: 'found', iso: code, via: 'code', mismatch: '' };
      if (problem) return { kind: problem.kind, name: problem.name };
      if (code) return { kind: 'codeUnknown', code };
      return { kind: 'none' };
    }

    function write(changes) {
      writing = true;
      try {
        for (const [input, value] of changes) {
          if (input.value === value) continue;
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } finally { writing = false; }
    }

    function fill(resolution, force) {
      const changes = [];
      const iso = resolution.iso;
      if (resolution.via === 'name' && (blank(codeInput) || ownsCode())) {
        changes.push([codeInput, iso]);
        autoCode = iso;
      }
      if (force || ownsCoords() || (blank(latInput) && blank(lngInput))) {
        const point = center(iso);
        auto = { lat: String(point.lat), lng: String(point.lng) };
        changes.push([latInput, auto.lat], [lngInput, auto.lng]);
      }
      write(changes);
    }

    function release() {
      const changes = [];
      if (ownsCoords()) changes.push([latInput, ''], [lngInput, '']);
      if (ownsCode()) changes.push([codeInput, '']);
      auto = null;
      autoCode = null;
      write(changes);
    }

    function render(resolution) {
      let text = '';
      let offer = false;
      if (resolution.kind === 'found') {
        const point = center(resolution.iso);
        const values = { country: displayName(resolution.iso), code: resolution.via === 'code' ? resolution.iso : resolution.mismatch };
        const atCenter = !blank(latInput) && !blank(lngInput)
          && Number(latInput.value) === point.lat && Number(lngInput.value) === point.lng;
        if (ownsCoords() || atCenter) text = format(resolution.via === 'code' ? 'countryCenterFromCode' : 'countryCenterFilled', values);
        else if (blank(latInput) && blank(lngInput)) offer = true;
        else if (blank(latInput) || blank(lngInput)) { text = format('countryCoordsPartial', values); offer = true; }
        else { text = format('countryCoordsKept', values); offer = true; }
        if (resolution.mismatch) text = (text ? text + ' ' : '') + format('countryCodeMismatch', values);
      } else if (resolution.kind === 'unknown') text = format('countryUnknown', { name: resolution.name });
      else if (resolution.kind === 'ambiguous') text = format('countryAmbiguous', { name: resolution.name });
      else if (resolution.kind === 'conflict') text = format('countryConflict', {});
      else if (resolution.kind === 'codeUnknown') text = format('countryCodeUnknown', { code: resolution.code });
      status.textContent = text;
      if (useButton) {
        useButton.textContent = strings.countryUseCenter || '';
        useButton.hidden = !offer;
      }
    }

    // A committed edit to a country name or the ISO code.
    function onCommit() {
      const resolution = resolve();
      if (resolution.kind === 'found') fill(resolution, false);
      else release();
      render(resolve());
    }

    countries.forEach((input) => input.addEventListener('change', onCommit));
    codeInput.addEventListener('change', onCommit);
    codeInput.addEventListener('input', () => { if (!writing) autoCode = null; });
    [latInput, lngInput].forEach((input) => input.addEventListener('input', () => {
      if (writing) return;
      auto = null;
      render(resolve());
    }));
    if (useButton) {
      useButton.type = 'button';
      useButton.addEventListener('click', () => {
        const resolution = resolve();
        if (resolution.kind !== 'found') return;
        fill(resolution, true);
        render(resolve());
      });
    }

    // After populateForm (load or stash restore): every value on screen is
    // the author's. Forget ownership and describe the state; never write.
    function reset() {
      auto = null;
      autoCode = null;
      render(resolve());
    }

    function setCopy(nextCopy, nextLang) {
      strings = nextCopy || {};
      if (nextLang) locale = nextLang;
      render(resolve());
    }

    reset();
    return { reset, setCopy };
  }

  root.CountryCoordinates = { wire, lookup, center, normalize };
})(typeof window !== 'undefined' ? window : globalThis);
