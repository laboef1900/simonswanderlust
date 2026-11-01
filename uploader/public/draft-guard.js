// @ai-note Multi-account recovery is private to the immutable authenticated owner.
// Logout keeps drafts; even an administrator cannot recover unknown-owner legacy text.
// Local recovery is best-effort, owner-scoped and never an executable write queue.
// Unknown-owner legacy records are deliberately neither read nor removed.
window.DraftGuard = (function () {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  function safeNextPath(raw) {
    return typeof raw === 'string' && raw.startsWith('/admin/') && !raw.includes('//') && !raw.includes('\\') ? raw : '/admin/';
  }
  function createDraftGuard(opts) {
    let owner = null;
    let resource = opts.resource;
    let context = crypto.randomUUID();
    let generation = 0;
    let dirty = false;
    let redirecting = false;
    let timer = null;
    let own = null;
    let adopted = null;
    const prefix = () => owner ? 'swl:draft:u:' + owner + ':' + resource + ':' : null;
    function cancelTimer() { if (timer !== null) clearTimeout(timer); timer = null; }
    function removeExact(record) {
      if (record && localStorage.getItem(record.key) === record.raw) localStorage.removeItem(record.key);
    }
    function stashNow() {
      if (!owner || !resource) return false;
      try {
        const recordId = crypto.randomUUID();
        const key = prefix() + context + ':record:' + recordId;
        const raw = JSON.stringify({ version: 1, ownerUserId: owner, resource, context, recordId, generation,
          savedAt: new Date().toISOString(), payload: opts.collect(), recovery: opts.recovery?.() || null });
        localStorage.setItem(key, raw); // Destination first; a quota failure never destroys recovery.
        const previous = own;
        own = { key, raw, generation };
        removeExact(previous);
        return true;
      } catch (_) { return false; }
    }
    function initialize(userId) {
      if (!uuid.test(userId) || (owner && owner !== userId)) return false;
      owner = userId;
      return true;
    }
    function markDirty() {
      dirty = true; redirecting = false; generation += 1; cancelTimer();
      timer = setTimeout(() => { timer = null; stashNow(); }, opts.debounceMs || 5000);
      opts.onChange?.(dirty);
    }
    function markClean(token) {
      if (token !== undefined && token !== generation) return;
      dirty = false; cancelTimer();
      try { removeExact(own); removeExact(adopted); } catch (_) { /* best effort */ }
      own = null; adopted = null;
      opts.onChange?.(dirty);
    }
    function parse(key, raw) {
      if (!owner || !key.startsWith(prefix()) || !raw) return null;
      const s = JSON.parse(raw);
      if (s?.version !== 1 || s.ownerUserId !== owner || s.resource !== resource
        || !uuid.test(s.context) || !uuid.test(s.recordId) || !Number.isSafeInteger(s.generation) || s.generation < 0
        || key !== prefix() + s.context + ':record:' + s.recordId
        || typeof s.savedAt !== 'string' || !Number.isFinite(Date.parse(s.savedAt))
        || !s.payload || typeof s.payload !== 'object'
        || (s.recovery && s.recovery.expectedOwnerId !== owner)) return null;
      return { ...s, key, raw };
    }
    function tryRestore() {
      if (!owner) return null;
      try {
        let best = null;
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key?.startsWith(prefix())) continue;
          try {
            const s = parse(key, localStorage.getItem(key));
            if (s && (!best || s.savedAt > best.savedAt)) best = s;
          } catch (_) { /* corrupt records stay quarantined */ }
        }
        return best;
      } catch (_) { return null; }
    }
    function adopt(stash) {
      if (!owner) return false;
      try {
        const s = parse(stash.key, localStorage.getItem(stash.key));
        if (!s || s.raw !== stash.raw) return false;
        adopted = { key: s.key, raw: s.raw, generation: s.generation };
        generation = s.generation;
        dirty = true;
        return true;
      } catch (_) { return false; }
    }
    function dismissRestore(stash) {
      if (!owner) return;
      dirty = false; cancelTimer();
      try { if (stash) sessionStorage.setItem(stash.key + ':dismissed', stash.recordId); } catch (_) { /* best effort */ }
      opts.onChange?.(dirty);
    }
    function wasDismissed(stash) {
      if (!owner) return false;
      try { return !!stash && sessionStorage.getItem(stash.key + ':dismissed') === stash.recordId; }
      catch (_) { return false; }
    }
    function setResource(next) {
      if (next === resource) return;
      const previous = own;
      resource = next; own = null;
      if (stashNow()) { try { removeExact(previous); } catch (_) { /* best effort */ } }
      else own = previous;
    }
    function freshContext() {
      if (!stashNow()) {
        const error = new Error('draft_recovery_unavailable');
        error.code = 'draft_recovery_unavailable';
        throw error;
      }
      context = crypto.randomUUID(); own = null; adopted = null;
      generation = 0; dirty = false; cancelTimer();
    }
    function redirectToLogin() {
      if (dirty) stashNow();
      // Navigation consent is not a successful save: consumers still need
      // to distinguish the unsaved form from persisted content.
      redirecting = true; cancelTimer();
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    }
    window.addEventListener('beforeunload', (e) => {
      if (!dirty || redirecting) return;
      stashNow(); e.preventDefault(); e.returnValue = '';
    });
    window.addEventListener('pagehide', () => { if (dirty) stashNow(); });
    // A phone can discard a backgrounded tab without ever firing pagehide; being
    // hidden is the last moment that reliably runs. Same stash, same key (#138)
    // and generation (#22) as the debounce: it only takes it early (#302).
    window.addEventListener('visibilitychange', () => {
      if (dirty && typeof document !== 'undefined' && document.visibilityState === 'hidden') stashNow();
    });
    return { initialize, ownerId: () => owner, markDirty, markClean, snapshot: () => generation,
      restoreGeneration: (value) => { generation = value; dirty = true; },
      isDirty: () => dirty, stashNow, tryRestore, adopt, dismissRestore, wasDismissed,
      setResource, freshContext, redirectToLogin };
  }
  return { safeNextPath, createDraftGuard };
})();
