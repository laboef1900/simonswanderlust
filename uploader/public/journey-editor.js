(function () {
  'use strict';
  const { text, el, request } = JourneysUI;
  const $ = id => document.getElementById(id);
  let id = new URLSearchParams(location.search).get('id');
  let saved = null, language, session, stories = [], draft, busy = false;
  const automatic = { de: false, en: false };
  const controls = {};
  const guard = DraftGuard.createDraftGuard({ resource: id ? 'journey:' + id : 'journey:new',
    collect: () => ({ ...collect(), baseUpdatedAt: saved?.updatedAt }), onChange: () => { if (guard.isDirty()) $('journeyStatus').textContent = text('Dirty'); } });
  function collect() {
    const value = structuredClone(draft);
    for (const locale of language.locales) {
      const c = controls[locale]; if (!c) continue;
      Object.assign(value[locale], { title: c.title.value, slug: c.slug.value, intro: c.intro.value, omitted: c.omitted.checked });
      if (value[locale].heroImage) {
        value[locale].heroImage.alt = c.alt.value;
        // Preserve absent focus exactly until the author changes a focus control.
        if (c.focusEdited || value[locale].heroImage.focus) value[locale].heroImage.focus = { x: Number(c.x.value), y: Number(c.y.value) };
      }
    }
    return value;
  }
  function showError(error) { $('journeyError').hidden = false; $('journeyError').textContent = error.outcomeUnknown ? BuildReporting.text('unknown') : error.message || text('Failed'); $('journeyError').focus(); }
  function dirty() { guard.markDirty(); }
  function field(parent, locale, name, copy, kind = 'input') {
    const label = el('label', text(copy)); const input = el(kind); input.id = 'journey-' + locale + '-' + name; label.htmlFor = input.id; parent.append(label, input); return input;
  }
  function heroPreview(locale) {
    const hero = draft[locale].heroImage, c = controls[locale];
    c.preview.hidden = !hero; c.alt.disabled = c.x.disabled = c.y.disabled = c.remove.disabled = !hero;
    if (!hero) { c.preview.removeAttribute('src'); return; }
    const width = [640, 1280, 1920, 2560].filter(width => width <= hero.width)[0] || hero.width;
    c.preview.src = hero.src + '-' + width + '.' + (hero.format || 'webp'); c.preview.alt = hero.alt;
    c.preview.style.objectPosition = c.x.value + '% ' + c.y.value + '%';
  }
  function renderLocales() {
    $('journeyLocales').replaceChildren();
    for (const locale of language.locales) {
      const value = draft[locale]; const section = el('section', undefined, 'card journey-locale');
      section.append(el('h2', SiteLanguage.names[locale], 'card-heading'));
      const c = controls[locale] = {};
      c.omitted = el('input'); c.omitted.type = 'checkbox'; c.omitted.id = 'journey-' + locale + '-omitted'; c.omitted.checked = value.omitted;
      c.omitted.disabled = locale === language.primary || !!saved?.[locale].publishedAt;
      const omit = el('label', undefined, 'check-field'); omit.append(c.omitted, document.createTextNode(text('Omit'))); section.append(omit);
      c.title = field(section, locale, 'title', 'Name'); c.title.maxLength = 200; c.title.value = value.title;
      c.slug = field(section, locale, 'slug', 'Slug'); c.slug.maxLength = 100; c.slug.value = value.slug; c.slug.readOnly = !!saved?.[locale].publishedAt;
      section.append(el('p', text('Locked'), 'help'));
      c.title.addEventListener('input', () => { if (automatic[locale] && !c.slug.readOnly) c.slug.value = c.title.value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100); });
      c.slug.addEventListener('input', () => { automatic[locale] = c.slug.value === ''; });
      c.intro = field(section, locale, 'intro', 'Intro', 'textarea'); c.intro.maxLength = 2000; c.intro.value = value.intro;
      section.append(el('h3', text('Hero'))); c.preview = el('img', undefined, 'journey-hero'); section.append(c.preview);
      const actions = el('div', undefined, 'form-actions'); const choose = el('button', text('Choose'), 'btn-secondary'); choose.type = 'button';
      c.remove = el('button', text('Remove'), 'btn-remove'); c.remove.type = 'button'; actions.append(choose, c.remove); section.append(actions);
      c.alt = field(section, locale, 'alt', 'Alt'); c.alt.value = value.heroImage?.alt || '';
      const focus = el('div', undefined, 'journey-focus'); section.append(focus);
      for (const axis of ['x', 'y']) { const box = el('div'); focus.append(box); c[axis] = field(box, locale, axis, axis === 'x' ? 'FocusX' : 'FocusY'); c[axis].type = 'number'; c[axis].min = '0'; c[axis].max = '100'; c[axis].step = 'any'; c[axis].value = value.heroImage?.focus?.[axis] ?? 50; c[axis].addEventListener('input', () => { c.focusEdited = true; heroPreview(locale); }); }
      choose.addEventListener('click', () => MediaPicker.open({ onUnauthed: () => guard.redirectToLogin(), onPick(item) {
        draft = collect(); draft[locale].heroImage = { src: item.src, width: item.width, height: item.height, alt: item.alt?.[locale] || '', ...(item.format ? { format: item.format } : {}) };
        c.alt.value = draft[locale].heroImage.alt; c.x.value = c.y.value = 50; c.focusEdited = false; heroPreview(locale); dirty();
      } }));
      c.remove.addEventListener('click', () => { draft = collect(); draft[locale].heroImage = null; heroPreview(locale); dirty(); });
      $('journeyLocales').append(section); heroPreview(locale);
    }
  }
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
    for (const locale of language.locales) { controls[locale].slug.readOnly = !!saved?.[locale].publishedAt; controls[locale].omitted.disabled = locale === language.primary || !!saved?.[locale].publishedAt; }
  }
  async function save() {
    const base = id && typeof saved?.updatedAt === 'string' ? new Date(saved.updatedAt) : null;
    if (id && (!base || !Number.isFinite(base.getTime()) || base.toISOString() !== saved.updatedAt)) throw new Error(text('RecoveryBaseMissing'));
    let confirmSlugChange = false; const payload = collect();
    const changed = language.locales.filter(locale => saved?.[locale].slug && saved[locale].slug !== payload[locale].slug);
    if (changed.length) {
      const paths = changed.map(locale => location.origin + JourneysUI.path(language, locale, saved[locale].slug) + '\n' + location.origin + JourneysUI.path(language, locale, payload[locale].slug)).join('\n\n');
      confirmSlugChange = await AdminConfirm.ask({ title: text('Rename'), body: text('RenameScope', { paths }), confirmLabel: text('Save') }); if (!confirmSlugChange) return;
    }
    const generation = guard.snapshot();
    const result = await request(id ? '/' + id : '', { method: id ? 'PUT' : 'POST', body: JSON.stringify({ ...payload, ...(id ? { baseUpdatedAt: saved.updatedAt, confirmSlugChange } : {}) }) }, guard);
    saved = result; draft = payload; id = result.id; history.replaceState(null, '', '/admin/journey-editor.html?id=' + encodeURIComponent(id)); guard.setResource('journey:' + id); guard.markClean(generation); syncActions(); $('journeyStatus').textContent = text('Saved');
    for (const locale of ['de', 'en']) automatic[locale] = !saved[locale].slug;
  }
  async function lifecycle(action) {
    if (guard.isDirty()) throw new Error(text('SaveFirst'));
    const title = saved[language.primary].title || text('New');
    if (!await AdminConfirm.ask({ title: text(action), body: text(action + 'Scope', { title, count: saved.members.length }), confirmLabel: text(action), danger: action !== 'Publish' })) return;
    const deleting = action === 'Delete';
    const result = await request('/' + id + (deleting ? '' : '/' + action.toLowerCase()), { method: deleting ? 'DELETE' : 'POST', ...(action === 'Publish' ? { body: JSON.stringify({ baseUpdatedAt: saved.updatedAt }) } : {}) }, guard);
    if (deleting) id = null;
    else { saved = result.saved; syncActions(); }
    BuildReporting.renderOutcome($('journeyStatus'), action.toLowerCase(), result, { title });
  }
  async function operate(fn) {
    if (busy) return;
    const opener = document.activeElement;
    busy = true; $('journeyFields').disabled = true; $('journeyError').hidden = true; $('journeyStatus').textContent = text('Busy');
    try { await fn(); } catch (error) { $('journeyStatus').textContent = guard.isDirty() ? text('Dirty') : ''; showError(error); }
    finally {
      busy = false; $('journeyFields').disabled = !draft || (!id && !!saved);
      if ($('journeyError').hidden) {
        if ($('journeyStatus').textContent === text('Busy')) $('journeyStatus').textContent = text(guard.isDirty() ? 'Dirty' : saved?.status === 'published' ? 'Published' : 'Draft');
        if ((!id && saved) || !opener || opener.disabled) $('journeyStatus').focus();
        else opener.focus();
      }
    }
  }
  $('journeyForm').addEventListener('input', dirty); $('journeyForm').addEventListener('change', dirty);
  $('journeyForm').addEventListener('submit', event => { event.preventDefault(); void operate(save); });
  for (const action of ['Publish', 'Unpublish', 'Delete']) $('journey' + action).addEventListener('click', () => operate(() => lifecycle(action)));
  $('journeyAdd').addEventListener('click', () => { const key = $('journeyStory').value; if (!key || draft.members.includes(key) || draft.members.length >= 50) return; draft.members.push(key); renderMembers(key, 'Remove'); dirty(); });
  (async () => {
    JourneysUI.localize(document); Auth.setPageTitle(text(id ? 'Edit' : 'New'));
    try {
      session = await Auth.ensureAuthed(); if (!session) return; guard.initialize(session.userId); Auth.renderHeader(session); language = await SiteLanguage.get();
      const response = await fetch('/posts', { cache: 'no-store' }); if (!response.ok) throw new Error(text('Failed')); stories = await response.json();
      if (id) saved = await request('/' + id, {}, guard);
      const empty = locale => ({ title: '', slug: '', intro: '', heroImage: null, omitted: !language.locales.includes(locale) });
      const working = row => ({ title: row.title, slug: row.slug, intro: row.intro, heroImage: row.heroImage, omitted: row.omitted });
      draft = saved ? { de: working(saved.de), en: working(saved.en), members: [...saved.members] } : { de: empty('de'), en: empty('en'), members: [] };
      for (const locale of ['de', 'en']) automatic[locale] = !draft[locale].slug;
      renderLocales(); renderMembers(); syncActions(); $('journeyFields').disabled = false;
      $('journeyStatus').textContent = text(saved?.status === 'published' ? 'Published' : 'Draft') + (saved?.hasUnpublishedChanges ? ' · ' + text('Changes') : '');
      const stash = guard.tryRestore();
      if (stash && !guard.wasDismissed(stash)) {
        if (await AdminConfirm.ask({ title: text('Restore'), body: text('RestoreScope'), confirmLabel: text('Restore') })) {
          const p = stash.payload;
          if (p.de && p.en && Array.isArray(p.members)) { draft = { de: p.de, en: p.en, members: p.members }; if (saved) saved.updatedAt = p.baseUpdatedAt; guard.adopt(stash); renderLocales(); renderMembers(); syncActions(); dirty(); }
        } else guard.dismissRestore(stash);
      }
    } catch (error) { $('journeyStatus').textContent = ''; showError(error); }
  })();
})();
