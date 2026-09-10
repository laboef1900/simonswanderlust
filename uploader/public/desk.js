// Publishing desk — pure selectors over GET /posts and /media/queue.
// The home page is a desk, not a second uploader: next draft, unpublished
// edits, encode backlog, whether a live release exists.
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
    if (!stats) return 0;
    return (Number(stats.pending) || 0) + (Number(stats.running) || 0);
  }

  return { nextDraft, unpublished, encodeCount, byUpdated };
})();
