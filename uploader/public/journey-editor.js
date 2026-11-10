(function () {
  'use strict';
  const { text, el, request } = JourneysUI;
  const $ = id => document.getElementById(id);
  let id = new URLSearchParams(location.search).get('id');
  let saved = null, language, session, stories = [], draft, busy = false, activeLocale = null, tabs = null;
  const automatic = { de: false, en: false };
  const controls = {};
  const guard = DraftGuard.createDraftGuard({ resource: id ? 'journey:' + id : 'journey:new',
    collect: () => ({ ...collect(), baseUpdatedAt: saved?.updatedAt }), onChange: () => { if (guard.isDirty()) $('journeyStatus').textContent = text('Dirty'); } });
  function collect() {
    const value = structuredClone(draft);
    for (const locale of language.locales) {
      const c = controls[locale]; if (!c) continue;
      // The stored field stays `omitted`; the author's checkbox says the opposite: publish in this language.
      Object.assign(value[locale], { title: c.title.value, slug: c.slug.value, intro: c.intro.value, omitted: !c.included.checked });
      if (value[locale].heroImage) {
        value[locale].heroImage.alt = c.alt.value;
        // Preserve absent focus exactly until the author changes a focus control.
        if (c.focusEdited || value[locale].heroImage.focus) value[locale].heroImage.focus = { x: Number(c.x.value), y: Number(c.y.value) };
      }
    }
    return value;
  }
  function workingCopy(row) {
    const working = locale => ({ title: locale.title, slug: locale.slug, intro: locale.intro, heroImage: locale.heroImage, omitted: locale.omitted });
    return { de: working(row.de), en: working(row.en), members: [...row.members] };
  }
  function showError(error) { $('journeyError').hidden = false; $('journeyError').textContent = error.outcomeUnknown ? BuildReporting.text('unknown') : error.message || text('Failed'); $('journeyError').focus(); }
  function dirty() { guard.markDirty(); }
  function field(parent, locale, name, copy, kind = 'input') {
    // A per-locale field names its locale by code, as in the story and page editors.
    const label = el('label', text(copy, { code: locale.toUpperCase() })); const input = el(kind); input.id = 'journey-' + locale + '-' + name; label.setAttribute('for', input.id); parent.append(label, input); return input;
  }
  function heroPreview(locale) {
    const hero = draft[locale].heroImage, c = controls[locale];
    c.preview.hidden = !hero; c.alt.disabled = c.x.disabled = c.y.disabled = c.remove.disabled = !hero;
    // Alt text and framing describe a photo; without one they are not shown as dead fields.
    c.heroFields.hidden = !hero; c.remove.hidden = !hero;
    if (!hero) { c.preview.removeAttribute('src'); return; }
    const width = [640, 1280, 1920, 2560].filter(width => width <= hero.width)[0] || hero.width;
    c.preview.src = hero.src + '-' + width + '.' + (hero.format || 'webp'); c.preview.alt = hero.alt;
    c.preview.style.objectPosition = c.x.value + '% ' + c.y.value + '%';
  }
  // One DE/EN segmented control above one panel at a time, like the story editor:
  // the two languages never sit side by side at different heights.
  function renderTabs() {
    const list = $('journeyTabs'); list.replaceChildren();
    if (!language.locales.includes(activeLocale)) activeLocale = language.locales[0];
    for (const locale of language.locales) {
      const tab = el('button', undefined, 'tab-btn' + (locale === activeLocale ? ' active' : ''));
      tab.type = 'button'; tab.id = 'journey-tab-' + locale; tab.dataset.tab = locale;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'journey-panel-' + locale);
      tab.setAttribute('aria-selected', locale === activeLocale ? 'true' : 'false'); tab.tabIndex = locale === activeLocale ? 0 : -1;
      // The story editor's labels: each language in its own name.
      tab.append(document.createTextNode({ de: 'Deutsch', en: 'English' }[locale] + ' '), el('span', locale.toUpperCase(), 'lang-code'));
      list.append(tab);
    }
    list.hidden = language.locales.length === 1;
    tabs = Tabs.wire(list, { onChange(name) { activeLocale = name; } });
  }
  function showLocale(locale) { tabs.select(locale); activeLocale = locale; }
  // The chip inside each tab carries that locale's state (DESIGN.md, "Locale tabs"):
  // not requested for publication, no title yet, or available.
  function syncTabStates() {
    for (const locale of language.locales) {
      const c = controls[locale], tab = $('journey-tab-' + locale); if (!c || !tab) continue;
      const state = !c.included.checked ? 'omitted' : !c.title.value.trim() ? 'missing' : 'available';
      SiteLanguage.tabState(tab, state, state === 'available' ? ''
        : SiteLanguage.text(state === 'omitted' ? 'OmittedLabel' : 'TitleEmpty', { language: SiteLanguage.names[locale] }));
    }
  }
  function renderLocales() {
    $('journeyLocales').replaceChildren();
    renderTabs();
    for (const locale of language.locales) {
      const value = draft[locale]; const section = el('section', undefined, 'journey-locale');
      section.id = 'journey-panel-' + locale; section.setAttribute('role', 'tabpanel');
      section.setAttribute('aria-labelledby', 'journey-tab-' + locale); section.hidden = locale !== activeLocale;
      const words = el('div', undefined, 'journey-locale__text'), picture = el('div', undefined, 'journey-locale__hero');
      section.append(words, picture);
      const c = controls[locale] = {};
      // One polarity in every editor: checked means this language is published (the story editor's wording).
      c.included = el('input'); c.included.type = 'checkbox'; c.included.id = 'journey-' + locale + '-included'; c.included.checked = !value.omitted;
      c.included.disabled = locale === language.primary || !!saved?.[locale].publishedAt;
      const include = el('label', undefined, 'check-field'); include.append(c.included, document.createTextNode(text('Include', { language: SiteLanguage.names[locale] }))); words.append(include);
      c.title = field(words, locale, 'title', 'Name'); c.title.maxLength = 200; c.title.value = value.title;
      c.slug = field(words, locale, 'slug', 'Slug'); c.slug.maxLength = 100; c.slug.value = value.slug; c.slug.readOnly = !!saved?.[locale].publishedAt;
      words.append(el('p', text('Locked'), 'muted'));
      c.title.addEventListener('input', () => {
        AdminField.valid(c.title);
        if (automatic[locale] && !c.slug.readOnly) c.slug.value = c.title.value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
      });
      c.slug.addEventListener('input', () => { automatic[locale] = c.slug.value === ''; });
      c.intro = field(words, locale, 'intro', 'Intro', 'textarea'); c.intro.maxLength = 2000; c.intro.value = value.intro;
      picture.append(el('h3', text('Hero', { code: locale.toUpperCase() }), 'section-label')); c.preview = el('img', undefined, 'journey-hero'); picture.append(c.preview);
      const actions = el('div', undefined, 'form-actions'); const choose = el('button', text('Choose'), 'btn-secondary'); choose.type = 'button';
      c.remove = el('button', text('Remove'), 'btn-remove'); c.remove.type = 'button'; actions.append(choose, c.remove); picture.append(actions);
      c.heroFields = el('div', undefined, 'journey-hero-fields'); picture.append(c.heroFields);
      c.alt = field(c.heroFields, locale, 'alt', 'Alt'); c.alt.value = value.heroImage?.alt || '';
      const focus = el('div', undefined, 'journey-focus'); c.heroFields.append(focus);
      for (const axis of ['x', 'y']) { const box = el('div'); focus.append(box); c[axis] = field(box, locale, axis, axis === 'x' ? 'FocusX' : 'FocusY'); c[axis].type = 'number'; c[axis].min = '0'; c[axis].max = '100'; c[axis].step = 'any'; c[axis].value = value.heroImage?.focus?.[axis] ?? 50; c[axis].addEventListener('input', () => { c.focusEdited = true; heroPreview(locale); }); }
      choose.addEventListener('click', () => MediaPicker.open({ onUnauthed: () => guard.redirectToLogin(), onPick(item) {
        draft = collect(); draft[locale].heroImage = { src: item.src, width: item.width, height: item.height, alt: item.alt?.[locale] || '', ...(item.format ? { format: item.format } : {}) };
        c.alt.value = draft[locale].heroImage.alt; c.x.value = c.y.value = 50; c.focusEdited = false; heroPreview(locale); dirty();
      } }));
      c.remove.addEventListener('click', () => { draft = collect(); draft[locale].heroImage = null; heroPreview(locale); dirty(); choose.focus(); });
      $('journeyLocales').append(section); heroPreview(locale);
    }
    syncTabStates();
  }
  function showHeading() { $('journeyHeading').textContent = text(id ? 'Edit' : 'New'); Auth.setPageTitle(text(id ? 'Edit' : 'New')); }
  function storyTitle(key) { return stories.find(story => story.translationKey === key)?.title || key; }
  function renderMembers(focusKey, action) {
    $('journeyMembers').replaceChildren(); $('journeyMembersEmpty').hidden = draft.members.length > 0;
    draft.members.forEach((key, index) => {
      const story = stories.find(story => story.translationKey === key); const item = el('li');
      item.append(el('strong', storyTitle(key)), el('p', text(story?.status === 'published' ? 'Published' : 'Draft'), 'muted'));
      const actions = el('div', undefined, 'form-actions');
      for (const [name, delta] of [['Up', -1], ['Down', 1], ['Remove', 0]]) {
        const button = el('button', text(name), name === 'Remove' ? 'btn-remove' : 'btn-secondary'); button.type = 'button'; button.dataset.member = key; button.dataset.action = name;
        button.setAttribute('aria-label', text(name) + ': ' + storyTitle(key)); button.disabled = name === 'Up' && index === 0 || name === 'Down' && index === draft.members.length - 1;
        button.addEventListener('click', () => {
          if (!delta) { draft.members.splice(index, 1); renderMembers(draft.members[Math.min(index, draft.members.length - 1)], 'Remove'); if (!draft.members.length) $('journeyStory').focus(); }
          else {
            [draft.members[index], draft.members[index + delta]] = [draft.members[index + delta], draft.members[index]];
            renderMembers(key, name); $('journeyOrderAnnouncement').textContent = text('Moved', { title: storyTitle(key), position: index + delta + 1, count: draft.members.length });
          }
          dirty();
        }); actions.append(button);
      }
      item.append(actions); $('journeyMembers').append(item);
    });
    $('journeyStory').replaceChildren();
    for (const story of stories) if (!draft.members.includes(story.translationKey)) { const option = el('option', story.title + ' · ' + text(story.status === 'published' ? 'Published' : 'Draft')); option.value = story.translationKey; $('journeyStory').append(option); }
    $('journeyAdd').disabled = !stories.some(story => !draft.members.includes(story.translationKey)) || draft.members.length >= 50;
    if (focusKey) {
      const buttons = [...$('journeyMembers').querySelectorAll('button')];
      (buttons.find(button => button.dataset.member === focusKey && button.dataset.action === action && !button.disabled) || buttons.find(button => button.dataset.member === focusKey && !button.disabled))?.focus();
    }
  }
  function syncActions() {
    $('journeyPublish').hidden = !session?.isAdmin || !id; $('journeyDelete').hidden = !session?.isAdmin || !id;
    $('journeyUnpublish').hidden = !session?.isAdmin || saved?.status !== 'published';
    for (const locale of language.locales) { controls[locale].slug.readOnly = !!saved?.[locale].publishedAt; controls[locale].included.disabled = locale === language.primary || !!saved?.[locale].publishedAt; }
  }
  // No untitled journeys: the primary language's title is the journey's name everywhere.
  // Checked before the form is disabled for the request, so the field can take focus.
  function requireTitle() {
    const primary = language.primary, field = controls[primary]?.title;
    if (!field) return true;
    if (field.value.trim()) { AdminField.valid(field); return true; }
    showLocale(primary);
    AdminField.invalid(field, text('TitleRequired', { language: SiteLanguage.names[primary] }));
    return false;
  }
  async function save() {
    const base = id && typeof saved?.updatedAt === 'string' ? new Date(saved.updatedAt) : null;
    if (id && (!base || !Number.isFinite(base.getTime()) || base.toISOString() !== saved.updatedAt)) throw new Error(text('RecoveryBaseMissing'));
    let confirmSlugChange = false; const payload = collect();
    const changed = language.locales.filter(locale => saved?.[locale].slug && saved[locale].slug !== payload[locale].slug);
    if (changed.length) {
      const paths = changed.map(locale => location.origin + JourneysUI.path(language, locale, saved[locale].slug) + '\n' + location.origin + JourneysUI.path(language, locale, payload[locale].slug)).join('\n\n');
      // A changed URL is a loss (the old address stops working), so the confirmation is the destructive kind.
      confirmSlugChange = await AdminConfirm.ask({ title: text('Rename'), body: text('RenameScope', { paths }), confirmLabel: text('Save'), danger: true }); if (!confirmSlugChange) return;
    }
    const generation = guard.snapshot();
    const result = await request(id ? '/' + id : '', { method: id ? 'PUT' : 'POST', body: JSON.stringify({ ...payload, ...(id ? { baseUpdatedAt: saved.updatedAt, confirmSlugChange } : {}) }) }, guard);
    saved = result; draft = payload; id = result.id; history.replaceState(null, '', '/admin/journey-editor.html?id=' + encodeURIComponent(id)); guard.setResource('journey:' + id); guard.markClean(generation); syncActions(); showHeading(); $('journeyStatus').textContent = text('Saved');
    for (const locale of ['de', 'en']) automatic[locale] = !saved[locale].slug;
  }
  async function lifecycle(action) {
    if (guard.isDirty()) throw new Error(text('SaveFirst'));
    const generation = guard.snapshot(), baseUpdatedAt = saved.updatedAt;
    const title = saved[language.primary].title || text('New');
    if (!await AdminConfirm.ask({ title: text(action), body: text(action + 'Scope', { title, count: saved.members.length }), confirmLabel: text(action), danger: action !== 'Publish', tone: 'publish' })) return;
    const deleting = action === 'Delete';
    const result = await request('/' + id + (deleting ? '' : '/' + action.toLowerCase()), { method: deleting ? 'DELETE' : 'POST', ...(action === 'Publish' ? { body: JSON.stringify({ baseUpdatedAt: saved.updatedAt }) } : {}) }, guard);
    if (deleting) {
      // The journey is gone: its outcome is shown by the list this editor returns to.
      // Nothing is dirty here (a lifecycle action requires a saved form), so the unload guard stays quiet.
      id = null;
      AdminFlash.set(BuildReporting.describeOutcome('delete', result, { title }));
      location.href = '/admin/journeys.html';
      return;
    }
    saved = result.saved;
    if (guard.snapshot() === generation) {
      // The concurrency token and the working copy must describe the same version.
      draft = workingCopy(saved);
      for (const locale of ['de', 'en']) automatic[locale] = !draft[locale].slug;
      renderLocales(); renderMembers();
    } else {
      // Keep newer local inputs on their old base; saving must conflict until reload.
      saved.updatedAt = baseUpdatedAt;
    }
    syncActions();
    BuildReporting.renderOutcome($('journeyStatus'), action.toLowerCase(), result, { title });
  }
  async function operate(fn) {
    if (busy || !draft || (!id && saved)) return;
    const opener = document.activeElement;
    busy = true; $('journeyFields').disabled = true; $('journeyError').hidden = true; $('journeyStatus').textContent = text('Busy');
    try { await fn(); } catch (error) { $('journeyStatus').textContent = guard.isDirty() ? text('Dirty') : ''; showError(error); }
    finally {
      busy = false; $('journeyFields').disabled = !draft || (!id && !!saved);
      if ($('journeyError').hidden) {
        if ($('journeyStatus').textContent === text('Busy')) $('journeyStatus').textContent = !id && saved ? '' : text(guard.isDirty() ? 'Dirty' : saved?.status === 'published' ? 'Published' : 'Draft');
        if ((!id && saved) || !opener || opener.disabled) $('journeyStatus').focus();
        else opener.focus();
      }
    }
  }
  $('journeyForm').addEventListener('input', () => { dirty(); syncTabStates(); }); $('journeyForm').addEventListener('change', () => { dirty(); syncTabStates(); });
  $('journeyForm').addEventListener('submit', event => { event.preventDefault(); if (busy || !draft || !requireTitle()) return; void operate(save); });
  for (const action of ['Publish', 'Unpublish', 'Delete']) $('journey' + action).addEventListener('click', () => operate(() => lifecycle(action)));
  $('journeyAdd').addEventListener('click', () => { const key = $('journeyStory').value; if (!key || draft.members.includes(key) || draft.members.length >= 50) return; draft.members.push(key); renderMembers(key, 'Remove'); dirty(); });
  (async () => {
    JourneysUI.localize(document); showHeading();
    try {
      session = await Auth.ensureAuthed(); if (!session) return; guard.initialize(session.userId); Auth.renderHeader(session); language = await SiteLanguage.get();
      const response = await fetch('/posts', { cache: 'no-store' }); if (!response.ok) throw new Error(text('Failed')); stories = await response.json();
      if (id) saved = await request('/' + id, {}, guard);
      const empty = locale => ({ title: '', slug: '', intro: '', heroImage: null, omitted: !language.locales.includes(locale) });
      draft = saved ? workingCopy(saved) : { de: empty('de'), en: empty('en'), members: [] };
      for (const locale of ['de', 'en']) automatic[locale] = !draft[locale].slug;
      renderLocales(); renderMembers(); syncActions(); $('journeyFields').disabled = false;
      $('journeyStatus').textContent = text(saved?.status === 'published' ? 'Published' : 'Draft') + (saved?.hasUnpublishedChanges ? ' · ' + text('Changes') : '');
      const stash = guard.tryRestore();
      if (stash && !guard.wasDismissed(stash)) {
        if (await AdminConfirm.ask({ title: text('Restore'), body: text('RestoreScope'), confirmLabel: text('Restore') })) {
          const p = stash.payload;
          if (p.de && p.en && Array.isArray(p.members)) {
            draft = { de: p.de, en: p.en, members: p.members };
            for (const locale of ['de', 'en']) automatic[locale] = !draft[locale].slug;
            if (saved) saved.updatedAt = p.baseUpdatedAt;
            guard.adopt(stash); renderLocales(); renderMembers(); syncActions(); dirty();
          }
        } else guard.dismissRestore(stash);
      }
    } catch (error) { $('journeyStatus').textContent = ''; showError(error); }
  })();
})();
