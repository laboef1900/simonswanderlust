// Draft with AI (#579): turns the author's trip events into a first draft of one
// EMPTY story language, browser-direct to the Story drafting provider from
// GET /ai-config?purpose=drafting. The editor owns the fields, the snapshot and
// the atomic commit; this controller owns the dialog, the per-opening consent
// for story details, the request lifetime and the explicit Apply.
// @ai-warning The provider key lives only in generate()'s locals for one
// request: never on `request`, the controller, the DOM or browser storage.
// @ai-warning I6/I10: coordinates are used inside routeSummary() only and never
// returned; every string the dialog shows is written with textContent/.value.
window.EditorDraft = (function () {
  'use strict';

  const LOCALES = ['de', 'en'];
  const PROVIDERS = ['lm-studio', 'openrouter', 'deepseek', 'anthropic', 'openai', 'custom'];
  const KEYED_PROVIDERS = ['openrouter', 'deepseek', 'anthropic', 'openai'];
  const CONFIG_PATH = '/ai-config?purpose=drafting';
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const limits = () => window.LLM.DRAFT_LIMITS;

  /**
   * One event per line, trimmed; empty lines are ignored. Over-limit input is
   * reported, never truncated. `problem`: null | 'empty' | 'tooMany' |
   * { tooLong: <1-based event number> } (the cap counts UTF-16 units after trim).
   */
  function parseEvents(text) {
    const events = String(text ?? '').split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean);
    const max = limits();
    if (!events.length) return { events, problem: 'empty' };
    if (events.length > max.events) return { events, problem: 'tooMany' };
    const long = events.findIndex((event) => event.length > max.eventLength);
    return { events, problem: long === -1 ? null : { tooLong: long + 1 } };
  }

  // gpx-geometry.js's great-circle distance (R = 6371.0088 km), in metres.
  function distanceMetres(a, b) {
    const rad = Math.PI / 180;
    const sinLat = Math.sin((b.lat - a.lat) * rad / 2);
    const sinLng = Math.sin((b.lng - a.lng) * rad / 2);
    const h = sinLat * sinLat + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * sinLng * sinLng;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  }

  /**
   * The coarse route: first and last stop name and the whole-km straight-line
   * distance between consecutive stops, or null with fewer than two complete
   * stops. The coordinates stay here; the result never carries them.
   */
  function routeSummary(stops) {
    const complete = (Array.isArray(stops) ? stops : []).filter((stop) => stop && typeof stop.name === 'string' &&
      stop.name.trim() && Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
    if (complete.length < 2) return null;
    let metres = 0;
    for (let i = 1; i < complete.length; i++) metres += distanceMetres(complete[i - 1], complete[i]);
    return { start: complete[0].name.trim(), end: complete[complete.length - 1].name.trim(), straightLineKm: Math.round(metres / 1000) };
  }

  /**
   * The transport `context` from the dialog's derived candidates: checked and
   * sendable items only, strings and the three route fields copied out, so
   * nothing else a candidate holds can reach the provider.
   */
  function buildContext(items) {
    const context = {};
    const photoCaptions = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || item.checked !== true || item.sendable === false) continue;
      const value = item.value;
      if (['date', 'country', 'region', 'heroCaption'].includes(item.key) && typeof value === 'string') context[item.key] = value;
      else if (item.key === 'photoCaption' && typeof value === 'string') photoCaptions.push(value);
      else if (item.key === 'route' && value && typeof value.start === 'string' && typeof value.end === 'string' &&
        Number.isInteger(value.straightLineKm)) context.route = { start: value.start, end: value.end, straightLineKm: value.straightLineKm };
    }
    if (photoCaptions.length) context.photoCaptions = photoCaptions;
    return context;
  }

  // The disclosed destination: the drafting slot's exact shape, minus the key.
  function describe(config) {
    if (!config || typeof config !== 'object' || typeof config.providerId !== 'string' || !config.providerId ||
        typeof config.providerName !== 'string' || !config.providerName || !PROVIDERS.includes(config.providerKind) ||
        typeof config.model !== 'string' || !config.model.trim() || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 ||
        typeof config.baseUrl !== 'string' || !window.LLM.isDraftingPrompt(config.prompt)) return null;
    let url;
    try { url = new URL(config.baseUrl); } catch (_) { return null; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return { providerId: config.providerId, providerName: config.providerName, providerKind: config.providerKind,
      baseUrl: config.baseUrl, model: config.model, timeoutMs: config.timeoutMs, prompt: config.prompt };
  }

  function failure(code) {
    const error = new Error('Story draft configuration unavailable');
    error.code = code;
    return error;
  }

  /**
   * options: copy (editor chrome strings), snapshot() → { identity, formVersion,
   * base, generation, locale, locales, blocked, title, excerpt, body, slug,
   * neverPublished, slugAuto }, details() → { date: {value,label}|null, country,
   * region, route: routeSummary|null } (never coordinates), heroCaption(locale)
   * → Promise<string>, pickPhotos({ preselect, onPick }), commit(locale, patch)
   * → { chooseSlug }, didCommit(locale) → backedUp, notice(text), on401(),
   * isAdmin(). Returns { refresh, changed }.
   */
  function create(options) {
    const $ = (id) => document.getElementById(id);
    const copy = options.copy;
    const dialog = $('storyDraftDialog');
    const events = $('draftEvents');
    const status = $('draftStatus');
    const spinner = $('draftSpinner');
    const generateButton = $('draftGenerate');
    const againButton = $('draftAgain');
    const cancelButton = $('draftCancel');
    const applyButton = $('draftApply');
    const pickButton = $('draftPickPhotos');
    const result = $('draftResult');
    const triggers = Object.fromEntries(LOCALES.map((locale) => [locale, $(locale + 'DraftAction')]));
    let epoch = 0;          // request generation: any release() orphans a pending request
    let opening = null;     // { token, locale, prepared, candidates, picked }
    let openings = 0;       // async candidates carry the opening token they were asked for
    let active = null;      // the in-flight request
    let shown = null;       // the reviewed result { snapshot, output }
    let photos = [];        // picked photos kept with the events: { src, width, height, title, caption: { de, en } }
    let identity = null;
    let applying = false;
    let queuedCloseEvents = 0;
    // One pass, so a provider name or model that contains `{model}` is shown verbatim.
    const text = (key, values = {}) => copy[key].replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(values, name) ? String(values[name]) : match));
    const localeName = (locale) => copy[locale === 'de' ? 'translationGerman' : 'translationEnglish'];
    const isEmpty = (snapshot) => !snapshot.title.trim() && !snapshot.excerpt.trim() && !snapshot.body.trim();
    const eligible = (snapshot, locale) => snapshot.locale === locale && snapshot.locales.includes(locale) && !snapshot.blocked && isEmpty(snapshot);

    for (const [id, key] of Object.entries({ draftClose: 'draftClose', draftEventsLabel: 'draftEventsLabel',
      draftEventsHelp: 'draftEventsHelp', draftContextLegend: 'draftContextLegend', draftPickPhotos: 'draftPickPhotos',
      draftPrivacy: 'draftPrivacy', draftResultTitleLabel: 'draftResultTitle', draftResultExcerptLabel: 'draftResultExcerpt',
      draftResultBodyLabel: 'draftResultBody', draftResultNote: 'draftResultNote', draftGenerate: 'draftGenerate',
      draftAgain: 'draftGenerateAgain', draftCancel: 'draftCancel', draftApply: 'draftApply', draftSettings: 'draftSettingsLink',
      draftAskAdmin: 'draftAskAdmin' })) $(id).textContent = copy[key];
    for (const locale of LOCALES) {
      // The visible word leads the accessible name (WCAG 2.5.3); the icon is decoration.
      const label = document.createElement('span');
      label.className = 'btn-icon__label';
      label.textContent = copy.draftAction;
      triggers[locale].replaceChildren(window.AdminIcons.ai(), label);
      triggers[locale].setAttribute('aria-label', text('draftActionName', { code: locale.toUpperCase() }));
      $(locale + 'DraftHelp').textContent = copy.draftStartHelp;
    }

    function element(tag, className, value) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (value !== undefined) node.textContent = value;
      return node;
    }
    // A copy template filled with text nodes; measurements go in a mono span.
    function fill(node, template, values, mono = []) {
      let last = 0;
      for (const match of template.matchAll(/\{(\w+)\}/g)) {
        if (match.index > last) node.append(template.slice(last, match.index));
        const value = String(values[match[1]] ?? match[0]);
        node.append(mono.includes(match[1]) ? element('span', 'story-draft__mono', value) : value);
        last = match.index + match[0].length;
      }
      if (last < template.length) node.append(template.slice(last));
      return node;
    }

    // `reveal`: focus usually lands in the fixed footer, so an outcome sentence is
    // scrolled into view. Routine opening/ready messages never move the body: the
    // destination and the events field must stay at the top when the dialog opens.
    function say(message, state, settings = false, reveal = state !== 'opening' && state !== 'ready') {
      dialog.dataset.state = state;
      status.textContent = message;
      if (message && reveal && dialog.open) status.scrollIntoView({ block: 'nearest' });
      $('draftSettingsRow').hidden = !settings;
      const admin = !!(options.isAdmin && options.isAdmin());
      $('draftSettings').hidden = !admin;
      $('draftAskAdmin').hidden = admin;
    }
    function setBusy(busy) {
      dialog.setAttribute('aria-busy', String(busy));
      spinner.hidden = !busy;
      events.disabled = busy;
      pickButton.disabled = busy;
      for (const list of ['draftContextItems', 'draftPhotoItems']) for (const box of $(list).querySelectorAll('input')) box.disabled = busy;
      if (busy) {
        cancelButton.hidden = false;
        cancelButton.focus({ preventScroll: true });
        generateButton.hidden = true;
        againButton.hidden = true;
        applyButton.hidden = true;
      } else {
        const hadFocus = document.activeElement === cancelButton;
        cancelButton.hidden = true;
        if (hadFocus) focusGenerate();
      }
    }
    // Controls for a state without a request: Generate when nothing is shown,
    // Apply + Generate again while a result is under review.
    function showControls() {
      const reviewing = !!shown;
      generateButton.hidden = reviewing || !opening || !opening.available;
      generateButton.disabled = !opening || !opening.prepared;
      againButton.hidden = !reviewing;
      againButton.disabled = false;
      applyButton.hidden = !reviewing;
      applyButton.disabled = !reviewing;
    }
    function focusGenerate() {
      showControls();
      (generateButton.hidden || generateButton.disabled ? events : generateButton).focus({ preventScroll: true });
    }
    function release() {
      epoch++;
      active?.controller.abort();
      active = null;
      setBusy(false);
    }
    function clearResult() {
      shown = null;
      result.hidden = true;
      for (const id of ['draftResultTitle', 'draftResultExcerpt', 'draftResultBody']) $(id).value = '';
    }
    function countEvents() {
      const { events: list } = parseEvents(events.value);
      const max = limits();
      $('draftEventsCount').textContent = text(list.length === 1 ? 'draftEventsCountOne' : 'draftEventsCount',
        { count: list.length, max: max.events, length: max.eventLength });
    }
    function forgetIdentity(snapshot) {
      // Another post replaces the list; a first save of this one (null → key) does not.
      if (identity !== null && snapshot.identity !== identity) {
        events.value = '';
        photos = [];
        window.AdminField.valid(events);
        countEvents();
      }
      identity = snapshot.identity;
    }

    // ---- per-opening consent: candidates re-derived from the form, all unchecked ----
    function candidate(key, value, template, values, cap, mono) {
      const tooLong = cap.find(([length, max]) => length > max);
      return { key, value, template, values, mono, sendable: !tooLong, max: tooLong ? tooLong[1] : 0, checked: false };
    }
    function derive(locale) {
      const max = limits();
      const details = options.details(locale) || {};
      const list = [];
      const date = details.date;
      if (date && typeof date.value === 'string' && DATE.test(date.value) && typeof date.label === 'string' && date.label) {
        list.push(candidate('date', date.value, 'draftContextDate', { value: date.label }, [], ['value']));
      }
      const country = typeof details.country === 'string' ? details.country.trim() : '';
      if (country) list.push(candidate('country', country, 'draftContextCountry', { value: country }, [[country.length, max.country]]));
      const region = typeof details.region === 'string' ? details.region.trim() : '';
      if (region) list.push(candidate('region', region, 'draftContextRegion', { value: region }, [[region.length, max.region]]));
      const route = details.route;
      // A straight-line sum beyond the cap is not a coarse route worth sending.
      if (route && typeof route.start === 'string' && typeof route.end === 'string' && Number.isInteger(route.straightLineKm) &&
          route.straightLineKm >= 0 && route.straightLineKm <= max.routeKm) {
        const value = { start: route.start, end: route.end, straightLineKm: route.straightLineKm };
        list.push(candidate('route', value, 'draftContextRoute', { start: value.start, end: value.end, km: value.straightLineKm },
          [[value.start.length, max.place], [value.end.length, max.place]], ['km']));
      }
      return list;
    }
    function photoCandidates(locale) {
      const max = limits();
      return photos.map((photo) => {
        const caption = (photo.caption[locale] || '').trim();
        const item = caption
          ? candidate('photoCaption', caption, 'draftContextPhoto', { title: photo.title, value: caption }, [[caption.length, max.caption]])
          : { key: 'photoCaption', value: null, template: 'draftContextPhotoEmpty', values: { title: photo.title, code: locale.toUpperCase() }, sendable: false, max: 0, checked: false };
        item.checked = item.sendable && opening.picked.has(photo.src);
        return item;
      });
    }
    function lookupHero(op) {
      // The token this derivation was asked for: changed() re-derives the same
      // opening under a new token, and an older lookup must then be dropped.
      const token = op.token;
      Promise.resolve().then(() => options.heroCaption(op.locale)).then((caption) => {
        if (op !== opening || token !== op.token || token !== openings || typeof caption !== 'string' || !caption.trim()) return;
        const value = caption.trim();
        const hero = candidate('heroCaption', value, 'draftContextHero', { value }, [[value.length, limits().caption]]);
        // One hero row at most; after date/country/region, before the route: the dialog's fixed order.
        op.candidates = op.candidates.filter((item) => item.key !== 'heroCaption');
        const at = op.candidates.findIndex((item) => item.key === 'route');
        op.candidates.splice(at === -1 ? op.candidates.length : at, 0, hero);
        renderCandidates();
      }, () => { /* No caption is offered; nothing else changes. */ });
    }
    function rederive() {
      if (!opening) return;
      opening.token = ++openings;
      opening.picked = new Set();
      opening.candidates = derive(opening.locale);
      opening.photoItems = photoCandidates(opening.locale);
      renderCandidates();
      lookupHero(opening);
    }
    function row(item, index, group) {
      if (!item.sendable) {
        const line = element('p', 'story-draft__item story-draft__item--muted');
        fill(line, copy[item.template], item.values, item.mono);
        if (item.max) line.appendChild(element('span', 'story-draft__reason', text('draftContextTooLong', { max: item.max })));
        return line;
      }
      const label = element('label', 'check-field story-draft__item');
      const box = element('input');
      box.type = 'checkbox';
      // Detail ids follow the item, not its position: the hero caption arrives
      // later and is inserted before the route, which must keep its id.
      box.id = 'draftContext-' + group + '-' + (group === 'detail' ? item.key : index);
      box.checked = item.checked;
      box.disabled = !!active;
      box.addEventListener('change', () => { item.checked = box.checked; });
      label.setAttribute('for', box.id);
      label.append(box, fill(element('span'), copy[item.template], item.values, item.mono));
      return label;
    }
    function renderCandidates() {
      const items = opening ? opening.candidates : [];
      const photoItems = opening ? opening.photoItems : [];
      // Re-rendering replaces the rows; a focused checkbox must not drop focus to the page.
      const focused = document.activeElement;
      const lists = [$('draftContextItems'), $('draftPhotoItems')];
      const refocus = focused && focused.id && lists.some((list) => list.contains(focused)) ? focused.id : '';
      lists[0].replaceChildren(...items.map((item, index) => row(item, index, 'detail')));
      lists[1].replaceChildren(...photoItems.map((item, index) => row(item, index, 'photo')));
      $('draftContextEmpty').textContent = items.length || photoItems.length ? '' : copy.draftContextEmpty;
      if (refocus && dialog.open) {
        const again = $(refocus);
        (again && !again.disabled ? again : pickButton).focus({ preventScroll: true });
      }
    }
    function copyPhoto(item) {
      const prior = photos.find((photo) => photo.src === item.src);
      // A preselected photo the picker could not resolve comes back as a bare
      // placeholder; keep what was copied from its Media row before.
      if (!item.caption || typeof item.caption !== 'object') return prior || null;
      const library = window.GalleryLibrary;
      const title = library.describe(item, 'de').title || item.src.split('/').pop() || item.src;
      return {
        src: item.src,
        width: Number.isFinite(item.width) ? item.width : 0,
        height: Number.isFinite(item.height) ? item.height : 0,
        title,
        caption: { de: library.describe(item, 'de').caption, en: library.describe(item, 'en').caption },
      };
    }
    function pickPhotos() {
      if (!opening || active) return;
      const op = opening;
      const token = op.token;
      options.pickPhotos({
        preselect: photos.map((photo) => ({ src: photo.src, width: photo.width, height: photo.height })),
        onPick: (items) => {
          if (op !== opening || token !== openings || !dialog.open) {
            if (dialog.open && opening) say(copy.draftStale, 'stale');
            return;
          }
          if (!Array.isArray(items)) return;
          if (items.length > limits().photos) { say(text('draftPhotosTooMany', { max: limits().photos }), 'error'); return; }
          photos = items.filter((item) => item && typeof item.src === 'string' && item.src).map(copyPhoto).filter(Boolean);
          // Picking is this opening's opt-in: the picked captions start checked.
          op.picked = new Set(photos.map((photo) => photo.src));
          op.photoItems = photoCandidates(op.locale);
          renderCandidates();
          pickButton.focus({ preventScroll: true });
        },
      });
    }

    // ---- configuration: read for disclosure (key dropped at once) and again at Generate ----
    async function readConfig(signal, isCurrent) {
      let config = null;
      try {
        const loaded = await window.LLM.readAiConfig(CONFIG_PATH, signal);
        config = loaded.config;
        if (!isCurrent()) return null;
        if (loaded.status === 401) return { unauthorized: true };
        if (!config || typeof config !== 'object') throw failure('draft_config');
        let apiKey = config.apiKey;
        config.apiKey = null;
        const prepared = describe(config);
        if (!prepared) throw failure('draft_config');
        if (prepared.providerKind === 'lm-studio' || typeof apiKey !== 'string' || !apiKey.trim()) apiKey = null;
        if (KEYED_PROVIDERS.includes(prepared.providerKind) && !apiKey) throw failure('draft_missing_key');
        return { prepared, apiKey };
      } catch (error) {
        if (error && (error.code === 'draft_config' || error.code === 'draft_missing_key')) throw error;
        throw failure('draft_config');
      } finally {
        if (config && typeof config === 'object') config.apiKey = null;
        config = null;
      }
    }
    function disclose(prepared) {
      opening.prepared = prepared;
      $('draftDestination').textContent = text('draftDestination', {
        provider: prepared.providerName, kind: prepared.providerKind, endpoint: prepared.baseUrl,
        model: prepared.model, timeout: prepared.timeoutMs / 1000,
      });
    }
    function errorMessage(error) {
      const message = error && typeof error.message === 'string' ? error.message : '';
      if (error && error.code === 'draft_missing_key') return [copy.draftMissingKey, true];
      if (error && error.code === 'draft_config') return [copy.draftConfigFailed, true];
      if (error && error.name === 'TimeoutError') return [copy.draftTimedOut, false];
      if (error && error.name === 'AbortError') return [copy.draftCancelled, false];
      if (/^Story draft HTTP (401|403)$/.test(message)) return [copy.draftAuthentication, true];
      if (message === 'Invalid story draft response' || /^Story draft response (was incomplete|was truncated|exceeded limit)$/.test(message)) {
        return [copy.draftInvalidOutput, false];
      }
      if (/^Invalid story draft (request|endpoint|timeout)$/.test(message)) return [copy.draftConfigFailed, true];
      return [copy.draftProviderFailed, false];
    }
    async function loadDisclosure(op) {
      const controller = new AbortController();
      op.configController = controller;
      say(copy.draftLoadingSettings, 'opening');
      try {
        const loaded = await readConfig(controller.signal, () => op === opening && dialog.open);
        if (!loaded || op !== opening) return;
        if (loaded.unauthorized) { closeDialog(); options.on401(); return; }
        loaded.apiKey = null;
        disclose(loaded.prepared);
        if (!shown && !active && op.available) {
          say(copy.draftReady, 'ready');
          showControls();
        }
      } catch (error) {
        if (op !== opening || !dialog.open) return;
        const [message, settings] = errorMessage(error);
        say(message, 'config', settings);
        showControls();
      }
    }

    // ---- open / close ----
    function open(locale) {
      if (dialog.open) return;
      const snapshot = options.snapshot();
      forgetIdentity(snapshot);
      release();
      clearResult();
      opening = { token: 0, locale, prepared: null, available: false, candidates: [], photoItems: [], picked: new Set(), configController: null };
      $('draftHeading').textContent = text('draftHeading', { language: localeName(locale) });
      $('draftDestination').textContent = '';
      for (const field of ['draftResultTitle', 'draftResultExcerpt', 'draftResultBody']) $(field).setAttribute('lang', locale);
      window.AdminField.valid(events);
      countEvents();
      rederive();
      dialog.showModal();
      events.focus({ preventScroll: true });
      if (!eligible(snapshot, locale)) {
        say(isEmpty(snapshot) ? copy.draftUnavailable : copy.draftNotEmpty, 'unavailable');
        showControls();
        return;
      }
      opening.available = true;
      showControls();
      void loadDisclosure(opening);
    }
    function closeDialog() {
      const locale = opening ? opening.locale : null;
      release();
      clearResult();
      if (opening) opening.configController?.abort();
      opening = null;
      openings++;
      renderCandidates();
      $('draftDestination').textContent = '';
      window.AdminField.valid(events);
      if (dialog.open) { queuedCloseEvents++; dialog.close(); }
      return locale;
    }
    function dismiss() {
      const locale = closeDialog();
      refresh();
      const trigger = locale && triggers[locale];
      // The row, not the button, carries `hidden` when the language is no longer empty.
      const target = trigger && !trigger.closest('[hidden]') && !trigger.disabled ? trigger : locale ? $(locale + 'Title') : null;
      target?.focus({ preventScroll: true });
    }

    // ---- generate / cancel / apply ----
    function current(request) {
      if (active !== request || request.epoch !== epoch || !dialog.open || request.controller.signal.aborted) return false;
      if (!same(request.snapshot, options.snapshot())) { stale(); return false; }
      return true;
    }
    function stale() {
      const had = !!active || !!shown;
      release();
      clearResult();
      if (dialog.open && opening && had) say(copy.draftStale, 'stale');
      if (dialog.open) focusGenerate();
    }
    async function generate() {
      if (!opening || !opening.prepared || active) return;
      // Synchronously, so a double click cannot start a second request.
      generateButton.disabled = true;
      againButton.disabled = true;
      const op = opening;
      const parsed = parseEvents(events.value);
      if (parsed.problem) {
        const max = limits();
        const message = parsed.problem === 'empty' ? copy.draftEventsRequired
          : parsed.problem === 'tooMany' ? text('draftEventsTooMany', { max: max.events, count: parsed.events.length })
            : text('draftEventTooLong', { line: parsed.problem.tooLong, count: parsed.events[parsed.problem.tooLong - 1].length, max: max.eventLength });
        // The inline error explains this refusal; an earlier provider message must not linger beside it.
        // A result still under review keeps its status; otherwise nothing else needs saying.
        if (shown) say(copy.draftReview, 'review');
        else say('', 'ready');
        window.AdminField.invalid(events, message);
        showControls();
        return;
      }
      window.AdminField.valid(events);
      const snapshot = options.snapshot();
      if (!eligible(snapshot, op.locale)) {
        clearResult();
        say(isEmpty(snapshot) ? copy.draftUnavailable : copy.draftNotEmpty, 'unavailable');
        op.available = false;
        focusGenerate();
        return;
      }
      // What is sent is what the dialog shows: the derived candidates, never a re-read form.
      const context = buildContext([...op.candidates, ...op.photoItems]);
      release();
      clearResult();
      const request = { epoch, snapshot, controller: new AbortController() };
      active = request;
      setBusy(true);
      say(copy.draftGenerating, 'generating');
      let apiKey = null;
      try {
        const loaded = await readConfig(request.controller.signal, () => current(request));
        if (!loaded || !current(request)) return;
        if (loaded.unauthorized) { closeDialog(); options.on401(); return; }
        apiKey = loaded.apiKey;
        loaded.apiKey = null;
        if (!same(loaded.prepared, op.prepared)) {
          apiKey = null;
          release();
          disclose(loaded.prepared);
          // Revealed although its state is 'ready': the sentence says what changed and to
          // check the destination line at the top of the dialog before generating again.
          say(copy.draftConfigChanged, 'ready', false, true);
          focusGenerate();
          return;
        }
        const output = await window.LLM.draftArticle({
          baseUrl: op.prepared.baseUrl, model: op.prepared.model, apiKey, timeoutMs: op.prepared.timeoutMs,
          locale: op.locale, prompt: op.prepared.prompt, events: parsed.events, context, signal: request.controller.signal,
        });
        apiKey = null;
        if (!current(request)) return;
        if (!output || typeof output.title !== 'string' || typeof output.excerpt !== 'string' || typeof output.bodyMarkdown !== 'string') {
          throw new Error('Invalid story draft response');
        }
        active = null;
        setBusy(false);
        shown = { snapshot: request.snapshot, output: { title: output.title, excerpt: output.excerpt, bodyMarkdown: output.bodyMarkdown } };
        $('draftResultTitle').value = shown.output.title;
        $('draftResultExcerpt').value = shown.output.excerpt;
        $('draftResultBody').value = shown.output.bodyMarkdown;
        result.hidden = false;
        say(copy.draftReview, 'review');
        showControls();
        // Without preventScroll: the generated draft must come into view, not only Apply in the footer.
        $('draftResultTitle').focus();
      } catch (error) {
        if (!current(request)) return;
        release();
        const [message, settings] = errorMessage(error);
        say(message, 'error', settings);
        focusGenerate();
      } finally {
        apiKey = null;
      }
    }
    function cancel() {
      if (!active) return;
      release();
      say(copy.draftCancelled, 'cancelled');
      focusGenerate();
    }
    function apply() {
      const reviewed = shown;
      if (!reviewed || !opening || !dialog.open || active) return;
      const locale = opening.locale;
      // No await between this check and the commit.
      const snapshot = options.snapshot();
      if (!same(reviewed.snapshot, snapshot) || !eligible(snapshot, locale)) {
        clearResult();
        say(copy.draftStale, 'stale');
        focusGenerate();
        return;
      }
      let outcome;
      applying = true;
      try { outcome = options.commit(locale, { ...reviewed.output }); }
      catch (_) {
        say(copy.draftApplyFailed, 'error');
        applyButton.focus({ preventScroll: true });
        return;
      } finally { applying = false; }
      events.value = '';
      photos = [];
      countEvents();
      // Release before didCommit: its markDirty() must not report this draft as stale.
      closeDialog();
      let backedUp = false;
      try { backedUp = options.didCommit(locale) === true; }
      catch (_) { /* The fields are applied; the local backup is reported below. */ }
      refresh();
      $(locale + 'Title').focus({ preventScroll: true });
      const notice = backedUp ? text('draftApplied', { language: localeName(locale) }) : copy.draftBackupFailed;
      options.notice(outcome && outcome.chooseSlug ? notice + ' ' + copy.draftAppliedChooseSlug : notice);
    }

    /** Entry rows: shown only for the active, enabled, empty language; disabled while blocked. */
    function refresh() {
      const snapshot = options.snapshot();
      forgetIdentity(snapshot);
      for (const locale of LOCALES) {
        $(locale + 'DraftStart').hidden = !(snapshot.locale === locale && snapshot.locales.includes(locale) && isEmpty(snapshot));
        triggers[locale].disabled = snapshot.blocked;
      }
    }
    /**
     * Call wherever the editor invalidates translation/review: an in-flight
     * request is aborted, a shown result discarded (draftStale), the events
     * kept and every story detail re-derived unchecked.
     */
    function changed() {
      if (applying) return;
      const snapshot = options.snapshot();
      forgetIdentity(snapshot);
      if (!dialog.open || !opening) { refresh(); return; }
      if (snapshot.locale !== opening.locale) { dismiss(); return; }
      const had = !!active || !!shown;
      const wasAvailable = opening.available;
      release();
      clearResult();
      rederive();
      opening.available = eligible(snapshot, opening.locale);
      if (!opening.available) say(isEmpty(snapshot) ? copy.draftUnavailable : copy.draftNotEmpty, 'unavailable');
      else if (had) say(copy.draftStale, 'stale');
      else if (!wasAvailable && opening.prepared) say(copy.draftReady, 'ready');
      else if (!wasAvailable && !opening.configController) void loadDisclosure(opening);
      showControls();
      const focused = document.activeElement;
      if (!focused || !dialog.contains(focused) || focused.disabled || focused.closest('[hidden]')) focusGenerate();
      refresh();
    }

    for (const locale of LOCALES) triggers[locale].addEventListener('click', () => open(locale));
    events.addEventListener('input', () => {
      countEvents();
      if (events.hasAttribute('aria-invalid')) window.AdminField.valid(events);
    });
    generateButton.addEventListener('click', () => { void generate(); });
    againButton.addEventListener('click', () => { void generate(); });
    cancelButton.addEventListener('click', cancel);
    applyButton.addEventListener('click', apply);
    pickButton.addEventListener('click', pickPhotos);
    $('draftClose').addEventListener('click', dismiss);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); dismiss(); });
    dialog.addEventListener('close', () => {
      if (queuedCloseEvents) { queuedCloseEvents--; return; }
      if (!dialog.open) dismiss();
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); dismiss(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.querySelectorAll('button, a[href], input, textarea, [tabindex]'))
        .filter((node) => !node.disabled && node.tabIndex >= 0 && !node.closest('[hidden]'));
      const first = controls[0], last = controls[controls.length - 1];
      if (!controls.includes(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    });
    countEvents();
    return { refresh, changed };
  }

  return { create, parseEvents, routeSummary, buildContext };
})();
