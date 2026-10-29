/* Shared inline file transport. Files and receipt identities live only in this page. */
(function (root) {
  'use strict';
  const active = new Set();
  root.addEventListener('beforeunload', (event) => {
    if (!active.size) return;
    event.preventDefault();
    event.returnValue = '';
  });

  function run(options) {
    const { file, fields, ownerId, recovery, status, button, onUnauthed } = options;
    const copy = options.copy || root.EditorCopy[document.documentElement.lang === 'de' ? 'de' : 'en'];
    if (!ownerId || !recovery.canAdopt(ownerId)) {
      status.textContent = copy.uploadOwnerChanged;
      return Promise.resolve(null);
    }
    button.disabled = true;
    const controls = document.createElement('div');
    controls.className = 'form-actions';
    const check = document.createElement('button');
    check.type = 'button'; check.className = 'btn-secondary'; check.hidden = true;
    const note = document.createElement('p');
    note.className = 'muted'; note.textContent = copy.uploadLimit;
    status.after(controls, note);
    controls.append(check);
    let finish;
    let ended = false;
    let checkingOwner = false;
    const promise = new Promise((resolve) => { finish = resolve; });
    const client = root.MediaApi.makeClient({ onUnauthed });
    const attempt = root.MediaApi.createUploadAttempt(client, file, fields, ownerId, {
      canAdopt: (id) => recovery.canAdopt(id),
      onPause: () => recovery.observeOwner(null),
      onChange: paint,
    });
    active.add(attempt);
    function end(result) {
      if (ended) return;
      ended = true;
      active.delete(attempt);
      root.removeEventListener('focus', observe);
      controls.remove(); note.remove(); button.disabled = false;
      finish(result);
    }
    function paint(item) {
      check.hidden = true;
      check.disabled = checkingOwner || item.state === 'checking' || item.state === 'uploading';
      if (item.state === 'done') { end(item.result); return; }
      if (item.state === 'gone') { status.textContent = copy.uploadGone; end(null); return; }
      if (item.state === 'failed' || item.state === 'needs-auth') {
        status.textContent = item.state === 'needs-auth' ? copy.uploadNeedsAuth : item.error;
        end(null); return;
      }
      status.textContent = item.state === 'uploading' ? copy.uploadSending
        : item.state === 'checking' ? copy.uploadChecking
        : item.state === 'retryable' ? copy.uploadRetryable : copy.uploadUnknown;
      if (item.originalRetained) status.textContent += ' ' + copy.uploadRetained;
      if (item.reason === 'recovery_required' || item.reason === 'queue_full') status.textContent += ' ' + copy.uploadRecoveryRequired;
      if (item.state === 'unknown' || item.state === 'retryable') {
        check.hidden = false;
        check.textContent = item.state === 'retryable' ? copy.uploadRetry : copy.uploadCheckAgain;
      }
    }
    async function observe() {
      try { recovery.observeOwner((await client.me()).userId); }
      catch (error) { if (error.status === 401) recovery.observeOwner(null); }
    }
    root.addEventListener('focus', observe);
    check.addEventListener('click', async () => {
      if (checkingOwner) return;
      checkingOwner = true; check.disabled = true;
      try {
        const me = await client.me();
        if (!recovery.resumeOwner(me.userId)) { status.textContent = copy.uploadOwnerChanged; return; }
        if (attempt.snapshot().state === 'retryable') await attempt.send();
        else await attempt.check();
      } catch (_) { status.textContent = copy.uploadUnknown; }
      finally { checkingOwner = false; check.disabled = false; }
    });
    void attempt.send();
    return promise;
  }
  root.UploadRecovery = { run };
})(window);
