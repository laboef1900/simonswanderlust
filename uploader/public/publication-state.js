// Release observations and CMS status are independent of local save state and build history.
window.PublicationState = (function () {
  'use strict';
  const locales = ['de', 'en'];
  const observations = ['live', 'older-version-live', 'not-live', 'unknown'];
  const proven = (value) => value === 'live' || value === 'older-version-live';
  function publicationState(p) {
    if (p?.availability === 'missing') return 'missing';
    if (p?.availability !== 'available' || !['draft', 'published'].includes(p.status)
      || typeof p.draftDiffers !== 'boolean' || !Array.isArray(p.requestedLocales)
      || !Array.isArray(p.committedLocales) || !locales.every((l) => observations.includes(p.live?.[l]))
      || [p.requestedLocales, p.committedLocales].some((set) => set.some((l) => !locales.includes(l)) || new Set(set).size !== set.length)
      || (p.status === 'published' && !p.committedLocales.length)) return 'unavailable';
    const values = locales.map((l) => p.live[l]);
    if (p.status === 'draft') {
      if (values.some(proven)) return 'draftStillLive';
      return values.includes('unknown') ? 'draftUnknown' : 'draft';
    }
    if (values.includes('unknown')) return 'publishedUnknown';
    if (p.committedLocales.some((l) => p.live[l] === 'not-live')) return 'notLive';
    if (p.committedLocales.some((l) => p.live[l] === 'older-version-live')
      || locales.some((l) => !p.committedLocales.includes(l) && proven(p.live[l]))) return 'differs';
    return p.draftDiffers ? 'newerDraft' : 'live';
  }
  function text(key, values = {}, locale) {
    const copy = EditorCopy[locale || (document.documentElement.lang === 'de' ? 'de' : 'en')];
    return copy['publication' + key[0].toUpperCase() + key.slice(1)].replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
  }
  function attention(p) { return ['draftStillLive', 'draftUnknown', 'publishedUnknown', 'notLive', 'differs'].includes(publicationState(p)); }
  function newer(p) { return ['publishedUnknown', 'notLive', 'differs', 'newerDraft'].includes(publicationState(p)) && p.draftDiffers; }
  function qualifiers(p, status) {
    if (!attention(p) || !status) return '';
    const parts = [];
    if (status.running) parts.push(text(status.running.owner === 'this_process' ? 'running' : 'unverified'));
    if (status.last?.result === 'failed') parts.push(text('failed', { time: new Date(status.last.finishedAt).toLocaleString() }));
    if (status.last?.result === 'interrupted') parts.push(text('interrupted'));
    return parts.join(' ');
  }
  function label(p, admin = false) {
    const state = publicationState(p);
    let result = text(state);
    if (['publishedUnknown', 'notLive', 'differs'].includes(state) && p.draftDiffers) result += text('newerSuffix');
    if (p?.availability === 'available' && state !== 'unavailable' && p.live.de !== p.live.en) {
      result += ' · ' + locales.map((l) => text('localeFact', { locale: l.toUpperCase(), fact: text('fact' + ({ live: 'Live', 'older-version-live': 'Older', 'not-live': 'Absent', unknown: 'Unknown' })[p.live[l]]) })).join('; ');
    }
    if (!admin && ['notLive', 'differs'].includes(state)) result += text('requiresRebuild');
    return result;
  }
  function summary(value) {
    if (value?.availability !== 'available') return text('summaryUnavailable');
    if (value.release !== 'known' || !value.posts || !value.galleryDescriptions) return text(value.release === 'none' ? 'releaseNone' : 'releaseUnknown');
    return text('summaryPosts', value.posts) + ' ' + text('summaryGallery', value.galleryDescriptions);
  }
  return { publicationState, label, text, attention, newer, qualifiers, summary };
})();
