(function () {
  'use strict';
  const { text, el, request } = JourneysUI;
  const $ = id => document.getElementById(id);
  let id = new URLSearchParams(location.search).get('id');
  let saved = null, language, session, stories = [], draft, busy = false, activeLocale = null, tabs = null, storySelect = null;
  const automatic = { de: false, en: false };
  const controls = {};
  const guard = DraftGuard.createDraftGuard({ resource: id ? 'journey:' + id : 'journey:new',
    collect: () => ({ ...collect(), baseUpdatedAt: saved?.updatedAt }), onChange: () => { if (guard.isDirty()) $('journeyStatus').textContent = text('Dirty'); } });
  function collect() {
    const value = structuredClone(draft);
    for (const locale of language.locales) {
      const c = controls[locale]; if (!c) continue;
      // The stored field stays `omitted`; the author's checkbox says the opposite: publish in this language.
      Object.assign(value[locale], { title: c.title.value, slug: c.slug.value, intro: c.intro.value });
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
      const state = draft[locale].omitted ? 'omitted' : !c.title.value.trim() ? 'missing' : 'available';
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
          if (!delta) { draft.members.splice(index, 1); renderMembers(draft.members[Math.min(index, draft.members.length - 1)], 'Remove'); if (!draft.members.length) (storySelect?.trigger || $('journeyStory')).focus(); }
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
    storySelect?.sync();
    $('journeyAdd').disabled = !stories.some(story => !draft.members.includes(story.translationKey)) || draft.members.length >= 50;
    if (focusKey) {
      const buttons = [...$('journeyMembers').querySelectorAll('button')];
      (buttons.find(button => button.dataset.member === focusKey && button.dataset.action === action && !button.disabled) || buttons.find(button => button.dataset.member === focusKey && !button.disabled))?.focus();
    }
  }
  function syncActions() {
    $('journeyPublish').hidden = !session?.isAdmin; $('journeyDelete').hidden = !session?.isAdmin || !id;
    $('journeyUnpublish').hidden = !session?.isAdmin || saved?.status !== 'published';
    for (const locale of language.locales) { controls[locale].slug.readOnly = !!saved?.[locale].publishedAt; }
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
  const editorCopy = EditorCopy[document.documentElement?.lang === 'de' ? 'de' : 'en'];
  const publishDialog = $('publishDialog');
  const publishDialogStatus = $('publishDialogStatus');
  const publishDialogConfirm = $('publishDialogConfirm');
  $('publishDialogTitle').textContent = editorCopy.publishDialogTitle;
  $('publishDialogIntro').textContent = editorCopy.publishDialogIntro;
  publishDialog.querySelector('legend').textContent = editorCopy.publishDialogLanguages;
  $('publishDialogRebuild').textContent = editorCopy.publishDialogRebuild;
  $('publishDialogCancel').textContent = editorCopy.publishDialogCancel;
  publishDialogConfirm.textContent = editorCopy.publishDialogConfirm;
  let publishOpening = null;

  function syncPublishDialog(opening) {
    const incomplete = [];
    for (const row of opening.rows) {
      const selected = row.input ? row.input.checked : true;
      const hasTitle = !!controls[row.locale]?.title.value.trim();
      row.state.className = 'publish-lang__state';
      if (row.fix) { row.fix.remove(); row.fix = null; }
      if (!selected) {
        row.state.textContent = editorCopy.publishDialogPrivate;
      } else if (hasTitle) {
        row.state.textContent = editorCopy.publishDialogReady;
      } else {
        const fieldName = text('Name', { code: row.locale.toUpperCase() });
        incomplete.push(row.name);
        row.state.textContent = editorCopy.publishDialogMissing.replace('{fields}', () => fieldName);
        row.fix = document.createElement('button');
        row.fix.type = 'button';
        row.fix.className = 'publish-lang__fix';
        row.fix.textContent = editorCopy.publishDialogFix.replace('{field}', () => fieldName);
        row.fix.setAttribute('aria-label', editorCopy.publishDialogFixName.replace('{field}', () => fieldName).replace('{language}', () => row.name));
        row.fix.addEventListener('click', () => {
          if (publishOpening !== opening) return;
          cancelPublishDialog();
          showLocale(row.locale);
          controls[row.locale].title.focus();
        });
        row.item.append(row.fix);
      }
    }
    publishDialogStatus.textContent = incomplete.length
      ? editorCopy.publishDialogBlocked.replace('{languages}', () => incomplete.join(', '))
      : '';
    publishDialogConfirm.disabled = incomplete.length > 0;
  }

  function cancelPublishDialog() {
    if (!publishOpening) return;
    publishOpening = null;
    if (publishDialog.open) publishDialog.close();
  }

  function openPublishDialog() {
    if (!session?.isAdmin || busy || !draft || !requireTitle()) return;
    const opening = { rows: [] };
    const choice = language.locales.length > 1;
    opening.rows = language.locales.map((locale) => {
      const forced = locale === language.primary || !!saved?.[locale]?.publishedAt;
      const row = { locale, name: SiteLanguage.names[locale], forced, input: null, fix: null,
        item: document.createElement('li'), state: el('p', '', 'publish-lang__state') };
      row.item.className = 'publish-lang';
      row.state.id = 'publishDialogState-' + locale;
      if (choice) {
        const label = document.createElement('label');
        label.className = 'check-field publish-lang__choice';
        row.input = document.createElement('input');
        row.input.type = 'checkbox';
        row.input.checked = forced || !draft[locale].omitted;
        row.input.disabled = forced;
        const note = el('p', locale === language.primary
          ? editorCopy.publishDialogPrimary
          : SiteLanguage.text(forced ? 'CoverageLocked' : 'CoverageHelp'), 'help publish-lang__note');
        note.id = 'publishDialogNote-' + locale;
        row.input.setAttribute('aria-describedby', note.id + ' ' + row.state.id);
        row.input.addEventListener('change', () => { if (publishOpening === opening) syncPublishDialog(opening); });
        label.append(row.input, row.name);
        row.item.append(label, note);
      } else {
        row.item.append(el('p', row.name, 'publish-lang__name'));
      }
      const slug = controls[locale]?.slug.value.trim();
      if (slug) row.item.append(el('p', location.origin + JourneysUI.path(language, locale, slug), 'publish-lang__url'));
      row.item.append(row.state);
      return row;
    });
    publishDialog.querySelector('.publish-languages__list').replaceChildren(...opening.rows.map((row) => row.item));
    syncPublishDialog(opening);
    const toggleable = opening.rows.some((row) => row.input && !row.forced);
    $('publishDialogIntro').hidden = !toggleable;
    publishDialog.setAttribute('aria-describedby', toggleable ? 'publishDialogIntro' : 'publishDialogRebuild');
    publishOpening = opening;
    publishDialog.showModal();
  }

  $('publishDialogCancel').addEventListener('click', () => cancelPublishDialog());
  publishDialog.addEventListener('cancel', (event) => { event.preventDefault(); cancelPublishDialog(); });
  publishDialog.addEventListener('close', () => { if (!publishDialog.open) cancelPublishDialog(); });
  publishDialogConfirm.addEventListener('click', () => {
    const opening = publishOpening;
    if (!opening || !publishDialog.open) return;
    for (const row of opening.rows) {
      const omitted = row.input ? !row.input.checked : false;
      if (draft[row.locale].omitted !== omitted) {
        draft[row.locale].omitted = omitted;
        dirty();
      }
    }
    syncTabStates();
    cancelPublishDialog();
    void operate(() => publishNow());
  });

  async function publishNow() {
    if (!id || guard.isDirty()) {
      await save();
      if (!id) return;
    }
    const generation = guard.snapshot(), baseUpdatedAt = saved.updatedAt;
    const title = saved[language.primary].title || text('New');
    const result = await request('/' + id + '/publish', { method: 'POST', body: JSON.stringify({ baseUpdatedAt: saved.updatedAt }) }, guard);
    saved = result.saved;
    if (guard.snapshot() === generation) {
      draft = workingCopy(saved);
      for (const locale of ['de', 'en']) automatic[locale] = !draft[locale].slug;
      renderLocales(); renderMembers();
    } else {
      saved.updatedAt = baseUpdatedAt;
    }
    syncActions();
    BuildReporting.renderOutcome($('journeyStatus'), 'publish', result, { title });
  }

  async function lifecycle(action) {
    if (guard.isDirty()) throw new Error(text('SaveFirst'));
    const generation = guard.snapshot(), baseUpdatedAt = saved.updatedAt;
    const title = saved[language.primary].title || text('New');
    if (!await AdminConfirm.ask({ title: text(action), body: text(action + 'Scope', { title, count: saved.members.length }), confirmLabel: text(action), danger: true, tone: 'publish' })) return;
    const deleting = action === 'Delete';
    const result = await request('/' + id + (deleting ? '' : '/' + action.toLowerCase()), { method: deleting ? 'DELETE' : 'POST' }, guard);
    if (deleting) {
      id = null;
      AdminFlash.set(BuildReporting.describeOutcome('delete', result, { title }));
      location.href = '/admin/journeys.html';
      return;
    }
    saved = result.saved;
    if (guard.snapshot() === generation) {
      draft = workingCopy(saved);
      for (const locale of ['de', 'en']) automatic[locale] = !draft[locale].slug;
      renderLocales(); renderMembers();
    } else {
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
        if ($('journeyStatus').textContent === text('Busy')) $('journeyStatus').textContent = !id && saved ? '' : !saved ? '' : text(guard.isDirty() ? 'Dirty' : saved.status === 'published' ? 'Published' : 'Draft');
        if ((!id && saved) || !opener || opener.disabled) $('journeyStatus').focus();
        else opener.focus();
      }
    }
  }
  $('journeyForm').addEventListener('input', () => { dirty(); syncTabStates(); }); $('journeyForm').addEventListener('change', () => { dirty(); syncTabStates(); });
  $('journeyForm').addEventListener('submit', event => { event.preventDefault(); if (busy || !draft || !requireTitle()) return; void operate(save); });
  $('journeyPublish').addEventListener('click', () => openPublishDialog());
  for (const action of ['Unpublish', 'Delete']) $('journey' + action).addEventListener('click', () => operate(() => lifecycle(action)));
  $('journeyAdd').addEventListener('click', () => { const key = $('journeyStory').value; if (!key || draft.members.includes(key) || draft.members.length >= 50) return; draft.members.push(key); renderMembers(key, 'Remove'); dirty(); });
  (async () => {
    JourneysUI.localize(document); showHeading();
    storySelect = window.AdminSelect ? AdminSelect.enhance($('journeyStory'), { label: text('Select') }) : null;
    try {
      session = await Auth.ensureAuthed(); if (!session) return; guard.initialize(session.userId); Auth.renderHeader(session); language = await SiteLanguage.get();
      const response = await fetch('/posts', { cache: 'no-store' }); if (!response.ok) throw new Error(text('Failed')); stories = await response.json();
      if (id) saved = await request('/' + id, {}, guard);
      const empty = locale => ({ title: '', slug: '', intro: '', heroImage: null, omitted: !language.locales.includes(locale) });
      draft = saved ? workingCopy(saved) : { de: empty('de'), en: empty('en'), members: [] };
      for (const locale of ['de', 'en']) automatic[locale] = !draft[locale].slug;
      renderLocales(); renderMembers(); syncActions(); $('journeyFields').disabled = false;
      $('journeyStatus').textContent = saved ? text(saved.status === 'published' ? 'Published' : 'Draft') + (saved.hasUnpublishedChanges ? ' · ' + text('Changes') : '') : '';
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
