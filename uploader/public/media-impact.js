// Read-only Media projection. This module never receives a save client or a content base token.
window.MediaImpact = (function () {
  'use strict';
  const locales = ['de', 'en'];
  function affected(stories, changed) {
    return [...new Set(stories.filter((story) => locales.some((locale) =>
      changed[locale].alt && story.locales[locale].gallery > 0
      || changed[locale].caption && story.locales[locale].galleryCaptionFollowsLibrary > 0))
      .map((story) => story.translationKey))];
  }
  function render(box, observation, changed, isAdmin, copy, refresh) {
    const focusKey = box.contains(document.activeElement) ? document.activeElement.dataset.impactFocus : undefined;
    let focusTarget;
    box.innerHTML = '';
    const text = (tag, value, parent = box) => {
      const node = document.createElement(tag); node.textContent = value; parent.appendChild(node); return node;
    };
    const format = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
    text('h3', copy.mediaImpactHeading);
    text('p', copy.mediaImpactScope);
    const impact = observation?.impact;
    if (changed) {
      if (!locales.some((locale) => changed[locale].alt || changed[locale].caption)) text('p', copy.mediaImpactUnchanged);
      else locales.forEach((locale) => {
        if (!changed[locale].alt && !changed[locale].caption) text('p', format(copy.mediaImpactLocaleUnchanged, { locale: locale.toUpperCase() }));
        else text('p', format(copy.mediaImpactChanged, {
          locale: locale.toUpperCase(), alt: changed[locale].alt ? copy.mediaImpactYes : copy.mediaImpactNo,
          caption: changed[locale].caption ? copy.mediaImpactYes : copy.mediaImpactNo,
        }));
      });
    }
    if (impact?.availability !== 'available') text('p', copy.mediaImpactUnavailable);
    else {
      const scopes = ['published', 'drafts', 'newerDrafts'];
      if (!scopes.some((scope) => impact[scope].length)) text('p', copy.mediaImpactEmpty);
      if (changed && locales.some((locale) => changed[locale].alt || changed[locale].caption)
        && !scopes.some((scope) => affected(impact[scope], changed).length)) text('p', copy.mediaImpactNoGallery);
      scopes.forEach((scope) => {
        const stories = impact[scope];
        if (!stories.length) return;
        const changedKeys = changed ? new Set(affected(stories, changed)) : null;
        text('h4', copy['mediaImpact' + { published: 'Published', drafts: 'Drafts', newerDrafts: 'NewerDrafts' }[scope]]);
        text('p', format(changed ? copy.mediaImpactAffected : copy.mediaImpactUsage,
          { count: changedKeys ? changedKeys.size : new Set(stories.map((story) => story.translationKey)).size }));
        const list = document.createElement('ul'); box.appendChild(list);
        stories.forEach((story) => {
          const item = document.createElement('li'); list.appendChild(item);
          // Link only the story titles this user's existing deletion-guard projection authorizes.
          const authorized = (observation.usedIn || []).find((use) => use.kind === 'post' && use.key === story.translationKey);
          if (authorized) {
            const link = text('a', authorized.title, item);
            link.href = '/admin/editor.html?tk=' + encodeURIComponent(story.translationKey);
            link.dataset.impactFocus = scope + ':' + story.translationKey;
            if (link.dataset.impactFocus === focusKey) focusTarget = link;
          } else text('span', copy.mediaImpactReferenceUnavailable, item);
          if (changedKeys) text('p', changedKeys.has(story.translationKey)
            ? copy.mediaImpactStoryAffected : copy.mediaImpactStoryUnaffected, item);
          locales.forEach((locale) => {
            const use = story.locales[locale];
            text('p', format(copy.mediaImpactLocale, { locale: locale.toUpperCase(), gallery: use.gallery,
              captions: use.galleryCaptionFollowsLibrary, hero: use.heroTitle ? copy.mediaImpactYes : copy.mediaImpactNo,
              inline: use.inline }), item);
          });
        });
        if (scope === 'newerDrafts') text('p', copy.mediaImpactRemoved);
      });
      text('p', copy.mediaImpactObserved);
    }
    if (isAdmin) {
      if (!observation?.livePending) text('p', copy.mediaImpactPendingUnknown);
      else locales.forEach((locale) => text('p', format(copy.mediaImpactPending, {
        locale: locale.toUpperCase(), alt: observation.livePending[locale].alt ? copy.mediaImpactYes : copy.mediaImpactNo,
        caption: observation.livePending[locale].caption ? copy.mediaImpactYes : copy.mediaImpactNo,
      })));
    }
    const button = text('button', copy.publicationRefresh);
    button.type = 'button'; button.className = 'btn-link'; button.addEventListener('click', refresh);
    button.dataset.impactFocus = 'refresh';
    if (focusKey) (focusTarget || button).focus({ preventScroll: true });
  }
  return { affected, render };
})();
