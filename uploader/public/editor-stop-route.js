// Stop routing in the editor (#513): per-row via/profile controls, the
// "Route along stops" panel, staleness and the explicit Calculate action.
// Vanilla, no build step, like editor-gpx.js. Every author- or provider-
// derived string reaches the DOM through textContent only.
// @ai-context docs/superpowers/specs/2026-11-03-issue-513-stop-routing-design.md
(function (root) {
  'use strict';

  const PROFILES = ['car', 'bike', 'foot', 'straight'];
  const ROUTED = ['car', 'bike', 'foot'];
  const MAX_STOPS = 25;
  let noteIds = 0;

  /**
   * @param {{
   *   copy: Record<string, string>,
   *   list: HTMLElement,
   *   getTk: () => string | null,
   *   collectStops: () => {name: string, lat: number, lng: number, via?: boolean, profile?: string}[] | undefined,
   *   markDirty: () => void,
   *   on401: () => void,
   *   fetch?: typeof fetch,
   *   now?: () => Date,
   * }} host
   */
  function wire(host) {
    const copy = host.copy;
    const doc = root.document;
    const $ = (id) => doc.getElementById(id);
    const els = {
      status: $('stopRouteStatus'), legs: $('stopRouteLegs'), calculate: $('stopRouteCalculate'),
      providers: $('stopRouteProviders'), publish: $('stopRoutePublishNotice'),
    };
    const request = host.fetch || ((...args) => root.fetch(...args));
    let contractPromise;
    // Relative to this classic script's URL (/admin/), so DOM harnesses that run
    // it from public/ resolve the same shared contract the server uses.
    const contract = () => (contractPromise ||= import('./stop-route.js'));

    /** @type {{car: boolean, bike: boolean, foot: boolean} | null} null = not loaded yet */
    let profiles = null;
    let route = null;
    let busy = false;
    let failure = '';
    let generation = 0;

    $('stopRouteHeading').textContent = copy.heading;
    $('stopRouteHelp').textContent = copy.help;
    $('stopRoutePrecedence').textContent = copy.gpxPrecedence;
    $('stopRoutePrivacy').textContent = copy.privacy;
    $('stopRouteViaHelp').textContent = copy.viaHelp;
    $('stopRouteAttribution').textContent = copy.attribution;
    els.calculate.textContent = copy.calculate;

    const profileLabel = (profile) => copy['profile.' + profile];
    const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));

    function decorateRow(row, { via = false, profile = 'car' } = {}) {
      const box = doc.createElement('div');
      box.className = 'stop-routing';

      const viaLabel = doc.createElement('label');
      viaLabel.className = 'check-field stop-via-field';
      const viaInput = doc.createElement('input');
      viaInput.type = 'checkbox';
      viaInput.className = 'stop-via';
      viaInput.checked = via === true;
      viaInput.setAttribute('aria-describedby', 'stopRouteViaHelp');
      viaLabel.append(viaInput, doc.createTextNode(copy.via));

      const legLabel = doc.createElement('label');
      legLabel.className = 'stop-leg-field';
      const legText = doc.createElement('span');
      legText.textContent = copy.legProfile;
      const select = doc.createElement('select');
      select.className = 'stop-profile';
      for (const value of PROFILES) {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = profileLabel(value);
        select.appendChild(option);
      }
      select.value = PROFILES.includes(profile) ? profile : 'car';
      legLabel.append(legText, select);

      const last = doc.createElement('span');
      last.className = 'muted stop-last';
      last.textContent = copy.lastStop;
      last.hidden = true;

      const note = doc.createElement('p');
      note.className = 'muted stop-profile-note';
      note.id = 'stopProfileNote' + (++noteIds);
      note.hidden = true;
      select.setAttribute('aria-describedby', note.id);

      const changed = () => { host.markDirty(); update(); };
      viaInput.addEventListener('change', changed);
      select.addEventListener('change', changed);
      box.append(viaLabel, legLabel, last, note);
      row.appendChild(box);
    }

    /** Canonical routing fields of one row; the last row never carries a profile. */
    function rowValues(row, isLast) {
      const via = row.querySelector('.stop-via')?.checked === true;
      const profile = row.querySelector('.stop-profile')?.value || 'car';
      return { ...(via ? { via: true } : {}), ...(!isLast && profile !== 'car' ? { profile } : {}) };
    }

    function syncRows() {
      const rows = [...host.list.querySelectorAll('.stop-row')];
      rows.forEach((row, index) => {
        const isLast = index === rows.length - 1;
        const legField = row.querySelector('.stop-leg-field');
        const last = row.querySelector('.stop-last');
        const select = row.querySelector('.stop-profile');
        const note = row.querySelector('.stop-profile-note');
        if (!legField || !select) return;
        legField.hidden = isLast;
        last.hidden = !isLast;
        for (const option of select.querySelectorAll('option')) {
          option.disabled = profiles !== null && ROUTED.includes(option.value) && !profiles[option.value] && option.value !== select.value;
        }
        const unavailable = !isLast && profiles !== null && ROUTED.includes(select.value) && !profiles[select.value];
        note.hidden = !unavailable;
        note.textContent = unavailable ? fill(copy.profileUnavailable, { profile: profileLabel(select.value) }) : '';
        select.setAttribute('aria-invalid', unavailable ? 'true' : 'false');
      });
    }

    function legsFor(stops) {
      const legs = [];
      for (let i = 0; i < stops.length - 1; i++) legs.push(stops[i].profile || 'car');
      return legs;
    }

    function renderLegs(stops) {
      els.legs.replaceChildren();
      els.legs.hidden = true;
      if (!route || route.legs.length !== stops.length - 1) return;
      route.legs.forEach((leg, index) => {
        const item = doc.createElement('li');
        const values = { number: index + 1, from: stops[index].name, to: stops[index + 1].name, profile: profileLabel(leg.profile) };
        const template = leg.kind === 'road' ? copy.legRoad
          : leg.fallback === 'no_route' ? copy.legNoRoute
            : leg.fallback === 'provider_error' ? copy.legProviderError : copy.legStraight;
        item.className = 'stop-route__leg stop-route__leg--' + (leg.kind === 'road' ? 'road' : 'straight') + (leg.fallback ? ' is-fallback' : '');
        item.textContent = fill(template, values);
        els.legs.appendChild(item);
      });
      els.legs.hidden = false;
    }

    function setStatus(text) {
      if (els.status.textContent !== text) els.status.textContent = text;
    }

    /** Recompute availability, freshness and the panel from the current form. */
    async function update() {
      const mine = ++generation;
      syncRows();
      const stops = host.collectStops() || [];
      const tk = host.getTk();
      const legs = legsFor(stops);
      const missing = profiles === null ? [] : [...new Set(legs)].filter((profile) => ROUTED.includes(profile) && !profiles[profile]);
      const allOff = profiles !== null && ROUTED.every((profile) => !profiles[profile]);
      els.providers.hidden = !allOff;
      els.providers.textContent = allOff ? copy.disabled : '';
      let fresh = false;
      if (route && stops.length >= 2) {
        try { fresh = (await (await contract()).stopRouteFingerprint(stops)) === route.fingerprint; }
        catch { fresh = false; }
      }
      if (mine !== generation) return;
      els.calculate.disabled = busy || !tk || stops.length < 2 || stops.length > MAX_STOPS || missing.length > 0;
      els.calculate.setAttribute('aria-busy', busy ? 'true' : 'false');
      renderLegs(fresh ? stops : []);
      if (busy) return setStatus(copy.calculating);
      if (failure) return setStatus(failure);
      if (!tk) return setStatus(copy.saveFirst);
      if (stops.length < 2) return setStatus(copy.stateTooFew);
      if (stops.length > MAX_STOPS) return setStatus(fill(copy.tooMany, { max: MAX_STOPS }));
      if (missing.length) return setStatus(copy.profileMissing);
      if (!route) return setStatus(copy.stateNone);
      setStatus(fresh
        ? fill(copy.stateFresh, { time: new Date(route.computedAt).toLocaleString() })
        : copy.stateStale);
    }

    /** Reload stored route and profile availability (load, reload, after save of a new post). */
    async function refresh() {
      const tk = host.getTk();
      failure = '';
      if (!tk) { route = null; return update(); }
      try {
        const res = await request('/posts/' + encodeURIComponent(tk) + '/stop-route', { cache: 'no-store' });
        if (res.status === 401) { host.on401(); return; }
        if (res.ok) {
          const body = await res.json();
          profiles = body.profiles;
          route = body.route;
        }
      } catch { /* keep the last known state; Calculate reports its own errors */ }
      return update();
    }

    function errorFor(status, body) {
      const code = body && body.code;
      if (status === 400) return code === 'stop_route_too_many' ? fill(copy.tooMany, { max: MAX_STOPS }) : copy.invalidStops;
      if (status === 404) return copy.saveFirst;
      if (status === 409) return copy.profileMissing;
      if (status === 422) return code === 'stop_route_too_complex' ? copy.tooComplex : copy.empty;
      if (status === 429) return code === 'stop_route_rate_limited' ? copy.rateLimited : copy.busy;
      return copy.failed;
    }

    async function calculate() {
      const tk = host.getTk();
      const stops = host.collectStops() || [];
      if (busy || !tk || stops.length < 2) return update();
      busy = true;
      failure = '';
      els.publish.hidden = true;
      await update();
      try {
        const res = await request('/posts/' + encodeURIComponent(tk) + '/stop-route', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stops }),
        });
        if (res.status === 401) { host.on401(); return; }
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          profiles = body.profiles;
          route = body.route;
        } else {
          failure = errorFor(res.status, body);
          if (res.status === 409 && Array.isArray(body.profiles) && profiles) {
            for (const profile of body.profiles) if (ROUTED.includes(profile)) profiles[profile] = false;
          }
        }
      } catch {
        failure = copy.failed;
      } finally {
        busy = false;
      }
      return update();
    }

    /** After Publish: say so when a stale route was left out (Publish is never blocked). */
    function publishOutcome(outcome) {
      els.publish.hidden = outcome !== 'stale';
      els.publish.textContent = outcome === 'stale' ? copy.publishOmittedStale : '';
      return outcome === 'stale' ? copy.publishOmittedStale : '';
    }

    els.calculate.addEventListener('click', () => { calculate(); });
    host.list.addEventListener('input', () => { failure = ''; update(); });

    return { decorateRow, rowValues, refresh, update, calculate, publishOutcome };
  }

  root.StopRouteEditor = { wire };
})(typeof window !== 'undefined' ? window : globalThis);
