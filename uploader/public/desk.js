// Publishing desk — small, testable selectors and request coordination for the
// home page. Each section owns its own failure state so one auxiliary endpoint
// cannot erase useful post data.
window.Desk = (function () {
  function byUpdated(a, b) {
    const ta = Date.parse(a && a.updatedAt) || 0;
    const tb = Date.parse(b && b.updatedAt) || 0;
    return tb - ta;
  }

  function nextDraft(posts) {
    return (posts || []).filter(function (p) { return p && p.status === 'draft'; }).sort(byUpdated)[0] || null;
  }

  function unpublished(posts) {
    return (posts || []).filter(function (p) { return p && p.hasUnpublishedChanges; }).sort(byUpdated);
  }

  function encodeCount(stats) {
    if (!stats || !Number.isInteger(stats.pending) || stats.pending < 0
      || !Number.isInteger(stats.running) || stats.running < 0) return null;
    return stats.pending + stats.running;
  }

  function releaseState(health) {
    return health && typeof health.release === 'boolean' ? health.release : null;
  }

  async function releaseFromResponse(response) {
    // A 503 means the DB probe failed; /health still carries an authoritative
    // release boolean in that response body.
    if (response.status !== 200 && response.status !== 503) throw new Error('unavailable');
    const release = releaseState(await response.json());
    if (release === null) throw new Error('unavailable');
    return release;
  }

  function englishBodyLabel(hasEnBody) {
    return hasEnBody ? 'English body started' : 'English body not started';
  }

  function formatUpdatedAt(value, locales) {
    if (value === null || value === undefined || value === '') return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(locales, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
    } catch {
      return '';
    }
  }

  // Coalescing the whole load/render cycle prevents a double-clicked retry
  // from starting a second request or letting an older result overwrite it.
  function resilientLoader(load, view) {
    let active = null;
    return function () {
      if (active) return active;
      view.loading();
      active = Promise.resolve()
        .then(load)
        .then(function (value) { view.ready(value); })
        .catch(function () { view.unavailable(); })
        .finally(function () { active = null; });
      return active;
    };
  }

  return {
    nextDraft,
    unpublished,
    encodeCount,
    releaseState,
    releaseFromResponse,
    formatUpdatedAt,
    englishBodyLabel,
    resilientLoader,
    byUpdated,
  };
})();
