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

  // A key unique to THIS page load, so two "new post" tabs never share a stash
  // (#138): before, both auto-stashed under `swl:draft:new`, the first save
  // re-keyed and then deleted whatever was there, and the other tab's work was
  // gone. Deliberately NOT persisted in sessionStorage: a tab opened from the
  // admin (ctrl/middle-click, target=_blank, duplicate) gets a COPY of its
  // opener's sessionStorage, which is exactly the two-tab case this must
  // separate. A reload or a restored tab instead finds its previous stash
  // through the orphan scan in tryRestore(), as the newest `new:*` entry.
  function tabScopedKey(prefix) {
    const nonce = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    return prefix + ':' + nonce;
  }

  // opts: { storageKey, collect, debounceMs?, orphanPrefix? } — collect() returns
  // the full form payload to stash; debounceMs is the idle time before an
  // auto-stash. With orphanPrefix, tryRestore() falls back to the newest stash
  // under that prefix (another tab's — closed, crashed, or still open) when this
  // tab has none of its own, so a stash keyed to a tab that no longer exists is
  // still offered somewhere.
  function createDraftGuard(opts) {
    let key = opts.storageKey;
    const collect = opts.collect;
    const debounceMs = opts.debounceMs || 5000;
    const orphanPrefix = opts.orphanPrefix || '';
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

    function parseStash(raw) {
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.savedAt !== 'string') return null;
      if (!parsed.payload || typeof parsed.payload !== 'object') return null;
      return parsed;
    }

    // Returns { savedAt, payload, key } if a plausible stash exists, else null
    // (absent, corrupt JSON, or an unexpected shape all degrade to null). This
    // tab's own key wins; otherwise the newest orphan under orphanPrefix. The
    // returned `key` names where it came from — pass the stash to adopt() on
    // restore, or to dismissRestore() on decline.
    function tryRestore() {
      try {
        const own = parseStash(localStorage.getItem(key));
        if (own) return { ...own, key };
        if (!orphanPrefix) return null;
        let best = null;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || k.indexOf(orphanPrefix) !== 0) continue;
          let s;
          try { s = parseStash(localStorage.getItem(k)); } catch (e) { continue; }
          if (s && (best === null || s.savedAt > best.savedAt)) best = { ...s, key: k };
        }
        return best;
      } catch (e) {
        return null;
      }
    }

    // The author chose to restore `stash`: move it under THIS tab's key, so it
    // is not offered to yet another tab and this tab's later stash/markClean
    // touch only its own entry. If the stash belonged to a tab that is still
    // open, that tab simply re-stashes on its next edit — nothing is lost.
    // Only on acceptance: moving on decline would hide it from the tab it
    // belongs to.
    function adopt(stash) {
      if (!stash || typeof stash.key !== 'string' || stash.key === key) return;
      try {
        const v = localStorage.getItem(stash.key);
        if (v !== null) { localStorage.setItem(key, v); localStorage.removeItem(stash.key); }
      } catch (e) { /* best-effort */ }
    }

    // Decline restoring a stash WITHOUT destroying it: disarm dirty tracking so
    // the beforeunload prompt goes silent, but keep the stash in localStorage so
    // a misclicked "Cancel" on the restore prompt can't lose unsaved work. Record
    // the dismissal (by the stash's savedAt) in sessionStorage so the SAME stash
    // isn't re-offered on every reload this session; a fresh session (new tab)
    // offers it again, and a newer stash (different savedAt) is offered normally.
    function dismissRestore(stash) {
      dirty = false;
      cancelTimer();
      try {
        const at = stash && typeof stash.savedAt === 'string' ? stash.savedAt : '';
        if (at) sessionStorage.setItem((stash.key || key) + ':dismissed', at);
      } catch (e) { /* best-effort: sessionStorage may be unavailable */ }
    }

    // True when this exact stash (same savedAt) was already dismissed this
    // session, so the caller can skip re-prompting to restore it.
    function wasDismissed(stash) {
      try {
        return !!stash && typeof stash.savedAt === 'string'
          && sessionStorage.getItem((stash.key || key) + ':dismissed') === stash.savedAt;
      } catch (e) {
        return false;
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

    return { markDirty, markClean, snapshot, stashNow, tryRestore, adopt, dismissRestore, wasDismissed, setKey, redirectToLogin };
  }

  return { safeNextPath, tabScopedKey, createDraftGuard };
})();
