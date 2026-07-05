// Shared draft-safety helpers for the admin editors: dirty tracking with a
// beforeunload warning, a debounced localStorage stash of the FULL form (not
// EasyMDE's body-only autosave), and a stash-then-redirect path for expired
// sessions so typed work survives a re-login round-trip.
//
// @ai-note The stash holds form text and image URLs only (no credentials), but
// it lives in localStorage, so on a shared machine an unsaved draft outlives
// logout — acceptable for this single-author admin.
window.DraftGuard = (function () {
  // Validates a post-login return target (?next=…). Accepts only same-origin
  // admin paths; rejects absolute URLs, protocol-relative '//' and backslashes
  // (browsers normalize '\' to '/', enabling open redirects). Falls back to /admin/.
  function safeNextPath(raw) {
    if (typeof raw !== 'string') return '/admin/';
    if (!raw.startsWith('/admin/')) return '/admin/';
    if (raw.includes('//') || raw.includes('\\')) return '/admin/';
    return raw;
  }

  // opts: { storageKey, collect, debounceMs? } — collect() returns the full
  // form payload to stash; debounceMs is the idle time before an auto-stash.
  function createDraftGuard(opts) {
    let key = opts.storageKey;
    const collect = opts.collect;
    const debounceMs = opts.debounceMs || 5000;
    let dirty = false;
    let timer = null;
    let generation = 0; // bumped on every edit; lets markClean detect mid-save edits

    // All localStorage access is best-effort: quota errors / private mode
    // degrade to warning-only behavior (the beforeunload prompt still works).
    function stashNow() {
      try {
        localStorage.setItem(key, JSON.stringify({ savedAt: new Date().toISOString(), payload: collect() }));
      } catch (e) { /* stash is best-effort */ }
    }

    function cancelTimer() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
    }

    function markDirty() {
      dirty = true;
      generation += 1;
      cancelTimer();
      timer = setTimeout(() => { timer = null; stashNow(); }, debounceMs);
    }

    // Capture immediately before building a save payload; pass the token to
    // markClean so edits typed while the request was in flight stay protected.
    function snapshot() { return generation; }

    // Saved to the server (or restore declined): drop the stash, disarm the
    // warning. With a token from snapshot(), this is a no-op when edits landed
    // after the snapshot — the save persisted an older payload, so the newer
    // on-screen text must stay dirty (warning armed, debounced stash pending).
    function markClean(token) {
      if (token !== undefined && token !== generation) return;
      dirty = false;
      cancelTimer();
      try { localStorage.removeItem(key); } catch (e) { /* best-effort */ }
    }

    // Returns { savedAt, payload } if a plausible stash exists, else null
    // (absent, corrupt JSON, or an unexpected shape all degrade to null).
    function tryRestore() {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof parsed.savedAt !== 'string') return null;
        if (!parsed.payload || typeof parsed.payload !== 'object') return null;
        return parsed;
      } catch (e) {
        return null;
      }
    }

    // Re-keys the stash once a new post gains its real translationKey.
    function setKey(newKey) {
      try {
        const v = localStorage.getItem(key);
        if (v !== null) { localStorage.setItem(newKey, v); localStorage.removeItem(key); }
      } catch (e) { /* best-effort */ }
      key = newKey;
    }

    // Session expired mid-edit (401): stash typed work (only if any — a 401 on
    // initial load has nothing worth restoring), suppress the beforeunload
    // prompt for this intentional navigation, and round-trip through the login
    // page back to the current URL (login.html honors ?next= via safeNextPath).
    function redirectToLogin() {
      if (dirty) stashNow();
      dirty = false;
      cancelTimer();
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    }

    window.addEventListener('beforeunload', (e) => {
      if (!dirty) return;
      stashNow(); // last-chance stash even if the user leaves anyway
      e.preventDefault();
      e.returnValue = ''; // legacy Chrome needs returnValue set to show the dialog
    });

    return { markDirty, markClean, snapshot, stashNow, tryRestore, setKey, redirectToLogin };
  }

  return { safeNextPath, createDraftGuard };
})();
