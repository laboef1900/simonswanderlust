// The About Me editor's equipment line (#514). It is identity.aboutGear, not page
// content: the admin-only GET/PUT /settings/identity contract stays the only writer.
// A save reads nothing new — it sends the identity loaded with its revision, with one
// locale's line replaced, projected to the active locales (the server keeps retained
// disabled-locale text). A stale revision is a visible conflict that keeps the typed
// text until an explicit reload; it is never retried or overwritten silently.
window.AboutEquipment = (function () {
  const MAX = 200;
  const LOCALES = ['de', 'en'];
  const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const format = (text, values) => text.replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));

  // The same text rule as normalizeIdentity (site/src/lib/site-identity.ts): NFC, no
  // control/format characters, and the limit counts trimmed code points, not UTF-16.
  function measure(value) {
    const normalized = String(value).normalize('NFC');
    return { normalized: normalized.trim(), plain: !/\p{C}/u.test(normalized), count: [...normalized.trim()].length };
  }

  // The whole loaded identity, every locale map limited to the active locales, with
  // only aboutGear[locale] replaced. Pure, so the request shape is testable on its own.
  function payload(loaded, locale, value) {
    const identity = JSON.parse(JSON.stringify(loaded.identity));
    for (const [field, map] of Object.entries(identity)) {
      if (isRecord(map)) identity[field] = Object.fromEntries(Object.entries(map).filter(([key]) => loaded.locales.includes(key)));
    }
    identity.aboutGear = { ...identity.aboutGear, [locale]: value };
    return { revision: loaded.revision, identity };
  }

  function valid(data) {
    return isRecord(data) && Number.isInteger(data.revision) && data.revision >= 1
      && Array.isArray(data.locales) && data.locales.length > 0 && data.locales.every((locale) => LOCALES.includes(locale))
      && isRecord(data.identity) && isRecord(data.identity.aboutGear);
  }

  function init(options) {
    const $ = (id) => document.getElementById(id);
    const copy = EditorCopy[document.documentElement.lang === 'de' ? 'de' : 'en'];
    let loaded = null;
    let state = 'loading';
    let busy = false;
    let conflicted = false;
    let unloadGuarded = false;
    // Before the identity answers, the site's language mode decides which panels show.
    const shown = () => (loaded ? loaded.locales : options.locales).filter((locale) => $(locale + 'GearSection'));
    const saved = (locale) => loaded?.identity.aboutGear[locale] ?? '';
    const dirty = (locale) => !!loaded && $(locale + 'Gear').value !== saved(locale);

    for (const locale of LOCALES) {
      if (!$(locale + 'GearSection')) continue;
      const language = locale === 'de' ? copy.identityGerman : copy.identityEnglish;
      $(locale + 'GearHeading').textContent = copy.identityAboutGear;
      $(locale + 'GearHelp').textContent = copy.aboutGearHelp;
      $(locale + 'GearLabel').textContent = format(copy.aboutGearLabel, { language });
      $(locale + 'GearSave').textContent = copy.aboutGearSave;
      $(locale + 'GearTiming').textContent = copy.aboutGearTiming;
      $(locale + 'GearSettings').textContent = copy.aboutGearSettings;
      // The page's own draft guard listens on <main>; this line is not page content,
      // so its edits must neither dirty the page nor block its Preview/Publish.
      for (const type of ['input', 'change']) $(locale + 'GearSection').addEventListener(type, (event) => event.stopPropagation());
      $(locale + 'Gear').addEventListener('input', () => edited(locale));
      $(locale + 'GearSave').addEventListener('click', () => save(locale));
      $(locale + 'GearReload').addEventListener('click', () => reload(locale));
    }

    function status(locale, text) { $(locale + 'GearStatus').textContent = text; }
    // Only a problem with the typed text marks the field invalid; a conflict or an
    // unconfirmed save is about the request, not the input.
    function error(locale, text, field = false) {
      $(locale + 'GearError').textContent = text;
      $(locale + 'GearError').hidden = !text;
      if (text && field) $(locale + 'Gear').setAttribute('aria-invalid', 'true');
      else $(locale + 'Gear').removeAttribute('aria-invalid');
    }
    function count(locale) {
      const { count: length } = measure($(locale + 'Gear').value);
      $(locale + 'GearCount').textContent = length > MAX
        ? format(copy.aboutGearOver, { count: length, max: MAX, over: length - MAX })
        : format(copy.aboutGearCount, { count: length, max: MAX });
    }
    function paint() {
      for (const locale of LOCALES) {
        const section = $(locale + 'GearSection');
        if (!section) continue;
        section.hidden = !shown().includes(locale);
        $(locale + 'Gear').disabled = busy || state !== 'ready';
        $(locale + 'GearSave').disabled = busy || state !== 'ready' || conflicted;
        $(locale + 'GearReload').hidden = !conflicted && state !== 'unavailable';
        $(locale + 'GearReload').disabled = busy;
        $(locale + 'GearReload').textContent = state === 'unavailable' ? copy.aboutGearRetry : copy.aboutGearReload;
        count(locale);
      }
    }
    function every(callback) { for (const locale of LOCALES) if ($(locale + 'GearSection')) callback(locale); }

    function edited(locale) {
      count(locale);
      if (!conflicted) error(locale, '');
      status(locale, dirty(locale) ? copy.aboutGearUnsaved : '');
      // Installed on first edit only: an untouched line needs no unload prompt.
      if (!unloadGuarded) {
        unloadGuarded = true;
        window.addEventListener('beforeunload', (event) => {
          if (!shown().some(dirty)) return;
          event.preventDefault();
          event.returnValue = '';
        });
      }
    }

    async function load() {
      busy = true;
      state = 'loading';
      paint();
      every((locale) => { status(locale, copy.aboutGearLoading); error(locale, ''); });
      try {
        const response = await fetch('/settings/identity', { cache: 'no-store' });
        if (response.status === 401) { options.onUnauthed(); return; }
        if (response.status === 403) { state = 'forbidden'; return; }
        const data = response.ok ? await response.json() : null;
        if (!valid(data)) throw new Error('identity_unavailable');
        loaded = { revision: data.revision, locales: data.locales, identity: data.identity };
        conflicted = false;
        state = 'ready';
        for (const locale of shown()) $(locale + 'Gear').value = saved(locale);
      } catch {
        state = 'unavailable';
      } finally {
        busy = false;
        paint();
        every((locale) => {
          status(locale, '');
          if (state === 'unavailable') error(locale, copy.aboutGearLoadFailed);
          if (state === 'forbidden') error(locale, copy.aboutGearForbidden);
        });
      }
    }

    function invalid(value) {
      const result = measure(value);
      if (!result.plain) return copy.aboutGearPlain;
      if (result.count > MAX) return format(copy.aboutGearTooLong, { count: result.count, max: MAX, over: result.count - MAX });
      return '';
    }

    async function save(locale) {
      if (busy || conflicted || state !== 'ready') return;
      const input = $(locale + 'Gear');
      const value = input.value;
      const problem = invalid(value);
      if (problem) { error(locale, problem, true); status(locale, ''); input.focus(); return; }
      error(locale, '');
      busy = true;
      paint();
      status(locale, copy.aboutGearSaving);
      let focus = null;
      try {
        const response = await fetch('/settings/identity', {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(loaded, locale, value)),
        });
        if (response.status === 401) { options.onUnauthed(); return; }
        const result = await response.json().catch(() => null);
        status(locale, '');
        if (response.status === 409 && result?.code === 'identity_conflict') {
          conflicted = true;
          every((other) => error(other, copy.aboutGearConflict));
          focus = $(locale + 'GearReload');
        } else if (response.status === 400 && result?.code === 'invalid_identity') {
          // Field paths come from the server's fixed validation contract, never the submitted value.
          const field = typeof result.field === 'string' ? result.field : 'identity';
          const own = field === 'aboutGear.' + locale;
          error(locale, own ? invalid(value) || copy.aboutGearPlain : format(copy.aboutGearOtherInvalid, { field }), own);
          if (own) focus = input;
        } else if (response.status === 403) {
          error(locale, copy.aboutGearForbidden);
        } else if (!response.ok || !Number.isInteger(result?.revision)) {
          error(locale, copy.aboutGearFailed);
          focus = $(locale + 'GearSave');
        } else {
          const stored = measure(value).normalized;
          loaded.revision = result.revision;
          loaded.identity.aboutGear[locale] = stored;
          input.value = stored;
          status(locale, stored ? copy.aboutGearSaved : copy.aboutGearCleared);
        }
      } catch {
        status(locale, '');
        error(locale, copy.aboutGearFailed);
        focus = $(locale + 'GearSave');
      } finally {
        busy = false;
        paint();
        focus?.focus();
      }
    }

    async function reload(locale) {
      if (busy) return;
      if (shown().some(dirty) && !await AdminConfirm.ask({
        title: copy.aboutGearReload, body: copy.aboutGearReloadConfirm, confirmLabel: copy.aboutGearReload,
      })) return;
      await load();
      if (state === 'ready') $(locale + 'Gear').focus();
    }

    paint();
    return load();
  }

  return { init, payload };
})();
