// Operational attempt evidence only: never an offline write queue or automatic replay.
window.WriteRecovery = (function () {
  'use strict';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  function create(options) {
    let owner = null;
    let paused = false;
    let busy = false;
    let needsProbe = false;
    let unsafeRestore = false;
    let createKey = crypto.randomUUID();
    let attempts = [];
    let comparison = null;
    let status = '';
    const copy = options.copy;
    const box = document.createElement('section');
    box.className = 'write-recovery';
    box.hidden = true;
    const message = document.createElement('p');
    message.setAttribute('role', 'status');
    const controls = document.createElement('div');
    controls.className = 'actions';
    const check = document.createElement('button');
    check.type = 'button'; check.className = 'btn-secondary'; check.textContent = copy.writeCheckAgain;
    const resume = document.createElement('button');
    resume.type = 'button'; resume.className = 'btn-secondary'; resume.textContent = copy.writeResume;
    const login = document.createElement('a');
    login.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    login.target = '_blank'; login.rel = 'noopener'; login.textContent = copy.uploadSignIn;
    const compare = document.createElement('details');
    const heading = document.createElement('summary'); heading.textContent = copy.writeCompare;
    const localHeading = document.createElement('h3'); localHeading.textContent = copy.writeLocal;
    const local = document.createElement('pre');
    const storedHeading = document.createElement('h3'); storedHeading.textContent = copy.writeStored;
    const stored = document.createElement('pre');
    const useStored = document.createElement('button');
    useStored.type = 'button'; useStored.className = 'btn-secondary'; useStored.textContent = copy.writeUseStored;
    const useMine = document.createElement('button');
    useMine.type = 'button'; useMine.className = 'btn-secondary'; useMine.textContent = copy.writeRebase;
    const keepEditing = document.createElement('button');
    keepEditing.type = 'button'; keepEditing.className = 'btn-secondary'; keepEditing.textContent = copy.writeKeepEditing;
    const latest = document.createElement('a');
    latest.target = '_blank'; latest.rel = 'noopener'; latest.textContent = copy.writeLatest;
    compare.append(heading, localHeading, local, storedHeading, stored, latest, useStored, useMine, keepEditing);
    controls.append(check, login, resume);
    box.append(message, controls, compare);
    document.querySelector('main').prepend(box);
    const offline = document.createElement('p');
    offline.className = 'write-connectivity';
    offline.setAttribute('role', 'status');
    offline.textContent = copy.writeOffline;
    document.querySelector('main').prepend(offline);
    function renderConnectivity() {
      offline.hidden = typeof navigator === 'undefined' || navigator.onLine !== false;
    }
    window.addEventListener('online', renderConnectivity);
    window.addEventListener('offline', renderConnectivity);
    renderConnectivity();
    function render() {
      box.hidden = !status && !paused && !comparison;
      message.textContent = paused ? copy.writeOwnerChanged : status;
      check.hidden = !owner || !resource(); check.disabled = busy || paused;
      login.hidden = !paused; resume.hidden = !paused; resume.disabled = busy;
      compare.hidden = !comparison;
      if (comparison) {
        latest.href = options.kind === 'pages'
          ? '/admin/about.html?key=' + encodeURIComponent(resource()) + '#revisionsCard'
          : '/admin/editor.html?tk=' + encodeURIComponent(resource()) + '#revisionsCard';
        local.textContent = JSON.stringify({ current: options.collect(), attempts }, null, 2);
        stored.textContent = JSON.stringify(comparison, null, 2);
      }
    }
    document.querySelector('main').addEventListener('input', () => { if (comparison) render(); });
    function initialize(userId) {
      if (!uuid.test(userId) || owner && owner !== userId) return false;
      owner = userId;
      return options.guard.initialize(userId);
    }
    function observeOwner(userId) {
      if (owner && userId !== owner) { paused = true; options.guard.stashNow(); render(); }
    }
    function canAdopt(userId) { return !!owner && userId === owner && !paused; }
    function resumeOwner(userId) {
      if (userId !== owner) { observeOwner(userId); return false; }
      paused = false; render(); return true;
    }
    function resource() { return options.resourceId() || createKey; }
    function exportState() {
      return { version: 1, expectedOwnerId: owner, kind: options.kind, resource: resource(), createKey,
        baseUpdatedAt: options.base(), attempts: structuredClone(attempts) };
    }
    function restore(state) {
      // A corrupt/missing base must never inherit the initial server load's token.
      unsafeRestore = true;
      options.restoreBase(undefined);
      if (!state || state.version !== 1 || state.expectedOwnerId !== owner || state.kind !== options.kind
        || !uuid.test(state.createKey) || typeof state.resource !== 'string' || !Array.isArray(state.attempts)
        || options.resourceId() && state.resource !== options.resourceId()
        || !options.resourceId() && state.resource !== state.createKey
        || state.baseUpdatedAt !== null && !validDate(state.baseUpdatedAt)) return false;
      const accepted = [];
      for (const attempt of state.attempts) {
        if (!attempt || !uuid.test(attempt.saveId) || attempt.expectedOwnerId !== owner || attempt.resource !== state.resource
          || !Number.isSafeInteger(attempt.generation) || attempt.generation < 0
          || !attempt.sentPayload || typeof attempt.sentPayload !== 'object'
          || attempt.baseUpdatedAt !== null && !validDate(attempt.baseUpdatedAt)) return false;
        accepted.push(structuredClone(attempt));
      }
      createKey = state.createKey; attempts = accepted;
      unsafeRestore = false;
      needsProbe = attempts.length > 0;
      // The caller restores the actual base, never the latest load's token.
      options.restoreBase(state.baseUpdatedAt);
      render();
      return true;
    }
    function content(body) { return options.kind === 'pages' && body.saved ? body.saved : body; }
    function validContent(body) {
      return body && typeof body === 'object' && body.de && body.en
        && (validDate(body.updatedAt) || options.kind === 'pages' && body.updatedAt === null)
        && (options.kind !== 'posts' || body.translationKey === resource())
        && (options.kind !== 'pages' || body.key === resource());
    }
    async function adopt(body, attempt, acknowledged) {
      if (!uuid.test(body?.ownerUserId)) return false;
      if (body.ownerUserId !== owner || attempt.expectedOwnerId !== owner) {
        observeOwner(body.ownerUserId); return false;
      }
      const saved = content(body);
      if (!validContent(saved)) return false;
      if (!canAdopt(body.ownerUserId)) {
        if (acknowledged) {
          attempt.acknowledgement = { ownerUserId: owner, saveId: attempt.saveId, saved: structuredClone(saved) };
          options.guard.stashNow();
        }
        return false;
      }
      await options.adopt(saved, attempt, acknowledged ? body : null);
      if (!canAdopt(body.ownerUserId)) return false;
      options.guard.markClean(attempt.generation);
      attempts = attempts.filter(item => item.saveId !== attempt.saveId);
      comparison = null;
      needsProbe = false;
      status = options.guard.isDirty() ? copy.saveNewer : copy.writeSaved;
      if (options.guard.isDirty() || attempts.length) options.guard.stashNow();
      render();
      return true;
    }
    async function probe() {
      if (!owner || paused) return false;
      needsProbe = true;
      status = copy.writeChecking; render();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch('/' + options.kind + '/' + encodeURIComponent(resource()), { cache: 'no-store', signal: controller.signal });
        if (response.status === 401) { paused = true; options.guard.stashNow(); render(); return false; }
        // "May still be running" is only true while an attempt for this resource is unresolved;
        // a restored draft with none has nothing pending to report.
        const pending = attempts.some(attempt => attempt.resource === resource());
        if (response.status === 404) { needsProbe = false; status = pending ? copy.writeNotVisible : ''; render(); return false; }
        if (!response.ok) throw new Error('unavailable');
        const body = await response.json();
        if (!uuid.test(body?.ownerUserId)) throw new Error('unsupported');
        if (!canAdopt(body.ownerUserId)) { observeOwner(body.ownerUserId); return false; }
        if (!validContent(body) || !(body.lastSaveId === null || typeof body.lastSaveId === 'string')) throw new Error('unsupported');
        const matched = attempts.find(attempt => attempt.saveId === body.lastSaveId && attempt.resource === resource());
        if (matched) return await adopt(body, matched, false);
        needsProbe = false;
        const base = options.base();
        if (!unsafeRestore && body.updatedAt === base) status = pending ? copy.writeNotVisible : '';
        else {
          options.guard.stashNow(); comparison = body; status = copy.writeChanged;
        }
        render();
        return false;
      } catch (_) { status = copy.writeUnknown; render(); return false; }
      finally { clearTimeout(timer); }
    }
    async function save(payload, generation) {
      if (busy || !owner || paused || comparison || needsProbe) { render(); return false; }
      if (unsafeRestore || options.resourceId() && !validDate(options.base()) && !(options.kind === 'pages' && options.base() === null)) {
        status = copy.writeUnsafeBase; render(); return false;
      }
      busy = true;
      const sentPayload = structuredClone(payload);
      if (options.kind === 'posts') sentPayload.translationKey = resource();
      if (options.resourceId()) sentPayload.updatedAt = options.base();
      const baseUpdatedAt = options.base();
      const prior = attempts.find(attempt => attempt.resource === resource() && attempt.baseUpdatedAt === baseUpdatedAt
        && attempt.generation === generation && JSON.stringify(attempt.sentPayload) === JSON.stringify(sentPayload));
      const attempt = prior || { saveId: crypto.randomUUID(), expectedOwnerId: owner, resource: resource(), baseUpdatedAt,
        generation, sentPayload };
      if (!prior) attempts.push(attempt);
      options.guard.stashNow(); render();
      try {
        let response, body;
        try {
          response = await fetch('/' + options.kind + (options.resourceId() ? '/' + encodeURIComponent(options.resourceId()) : ''), {
            method: options.resourceId() ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...sentPayload, saveId: attempt.saveId, expectedOwnerId: owner }),
          });
          if (response.status !== 401) body = await response.json();
        } catch (_) { return await probe(); }
        if (response.status === 401) { paused = true; options.guard.redirectToLogin(); return false; }
        if (response.status === 403 && body?.code === 'owner_changed') { paused = true; options.guard.stashNow(); render(); return false; }
        if (response.ok) {
          if (body?.saveId === attempt.saveId && await adopt(body, attempt, true)) return true;
          return await probe();
        }
        if (response.status >= 500 || response.status === 409 && ['conflict', 'already_exists'].includes(body?.code)) return await probe();
        // A refusal never resolves an earlier attempt with the same identity.
        if (!prior) attempts = attempts.filter(item => item !== attempt);
        options.error(body, response.status); return false;
      } finally { busy = false; render(); }
    }
    check.addEventListener('click', async () => {
      if (busy || paused) return;
      busy = true; render(); try { await probe(); } finally { busy = false; render(); }
    });
    resume.addEventListener('click', async () => {
      try {
        const response = await fetch('/auth/me', { cache: 'no-store' });
        if (!response.ok) return;
        const auth = await response.json();
        if (resumeOwner(auth.userId)) await probe();
      } catch (_) { /* stays paused, never a replay */ }
    });
    keepEditing.addEventListener('click', () => {
      compare.open = false;
      options.guard.stashNow();
    });
    useMine.addEventListener('click', async () => {
      if (!comparison || paused || busy) return;
      busy = true;
      const saved = comparison;
      try {
        // Keep the complete pre-rebase text, base and attempt history recoverable.
        // Rebase is an explicit local choice, never an automatic merge or write.
        options.guard.freshContext();
        await options.rebase(saved);
        if (!canAdopt(saved.ownerUserId)) return;
        attempts = []; comparison = null; needsProbe = false; unsafeRestore = false;
        options.guard.markDirty();
        options.guard.stashNow();
        status = copy.writeRebased;
      } catch (error) {
        options.guard.markDirty();
        status = error?.code === 'draft_recovery_unavailable' ? copy.writeStorageUnavailable : copy.writeUnknown;
        options.guard.stashNow();
      } finally { busy = false; render(); }
    });
    useStored.addEventListener('click', async () => {
      if (!comparison || paused || busy) return;
      busy = true;
      const saved = comparison;
      try {
        options.guard.freshContext();
        await options.useStored(saved);
        if (!canAdopt(saved.ownerUserId)) return;
        attempts = []; comparison = null; needsProbe = false; unsafeRestore = false; status = '';
      } catch (error) {
        options.guard.markDirty();
        status = error?.code === 'draft_recovery_unavailable' ? copy.writeStorageUnavailable : copy.writeUnknown;
        options.guard.stashNow();
      } finally { busy = false; render(); }
    });
    window.addEventListener('focus', async () => {
      if (!owner) return;
      try {
        const response = await fetch('/auth/me', { cache: 'no-store' });
        if (response.status === 401) observeOwner(null);
        else if (response.ok) observeOwner((await response.json()).userId);
      } catch (_) { /* a failed context read is not logout */ }
    });
    /** True while this editor's stored version is unconfirmed: a save outcome is being
     * checked or unknown, a changed stored version awaits comparison, or the session
     * belongs to another account. Writes that carry the version token must wait. */
    function unresolved() { return paused || needsProbe || !!comparison; }
    return { initialize, ownerId: () => owner, canAdopt, observeOwner, resumeOwner, exportState, restore, save, probe, unresolved, createKey: () => createKey };
  }
  return { create };
})();
