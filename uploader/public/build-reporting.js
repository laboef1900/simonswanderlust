// Build evidence is independent of the acknowledged CMS mutation and of story liveness.
window.BuildReporting = (function () {
  'use strict';
  const codes = ['build_timeout', 'build_failed', 'build_unavailable', 'no_space', 'release_write_failed', 'build_stopped', 'internal'];
  function text(key, values = {}) {
    const locale = document.documentElement?.lang === 'de' ? 'de' : 'en';
    return BuildCopy[locale][key].replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
  }
  function failure(code) { return text('failure.' + (codes.includes(code) ? code : 'internal')); }
  // A release id is "<ms>-<pid>-<seq>", a live observation { release, stampedAt }:
  // either names the moment the version was built, which is all the author
  // needs to read about it.
  function builtAt(value) {
    const stamp = typeof value === 'string' ? (value ? Number(value.split('-')[0]) : NaN) : Date.parse(value?.stampedAt);
    return Number.isFinite(stamp) ? AdminFormat.dateTime(stamp) : '';
  }
  function live(value) {
    if (value === null) return text('noLive');
    const at = value ? builtAt(value) : '';
    return at ? text('live', { stampedAt: at }) : text('liveUnavailable');
  }
  function describeOutcome(action, body = {}, values = {}) {
    const build = action === 'rebuild' ? body : body.build;
    const prefix = action === 'rebuild' ? '' : text(action === 'delete' && !build ? 'deleteDraft' : action, values);
    if (!build) return [prefix, text('noBuild')].filter(Boolean).join(' ');
    if (typeof build.ok !== 'boolean') return [prefix, text('unknown')].filter(Boolean).join(' ');
    if (!build.ok) {
      return [prefix, text(action === 'rebuild' ? 'failedRebuild' : 'failedChange', { error: failure(build.code) }), live(build.liveRelease)].filter(Boolean).join(' ');
    }
    // The usual case: the version just built is the one the live site serves.
    const at = builtAt(build.release);
    const serving = at && build.liveRelease === build.release
      ? text(action === 'unpublish' || action === 'delete' ? 'liveWithout' : 'liveThis', { builtAt: at })
      : text('built') + ' ' + live(build.liveRelease);
    return [prefix, serving].filter(Boolean).join(' ');
  }
  function recovery(root, code) {
    const link = document.createElement('a');
    link.href = '/admin/settings.html#site';
    link.className = 'action-link';
    link.textContent = text(code === 'build_stopped' ? 'stoppedRecovery' : 'retry');
    root.appendChild(document.createTextNode(' '));
    root.appendChild(link);
  }
  function renderOutcome(root, action, body, values) {
    root.textContent = describeOutcome(action, body, values);
    const build = action === 'rebuild' ? body : body.build;
    if (build && build.ok === false) recovery(root, build.code);
  }
  function renderStatus(root, status) {
    const parts = [];
    const running = status.running, last = status.last;
    if (running) {
      parts.push(text('running', { startedAt: AdminFormat.dateTime(running.startedAt) }));
      if (running.queued) parts.push(text('queued'));
      if (running.owner === 'unverified') parts.push(text('unverified'));
    }
    if (last) {
      parts.push(text(last.result, {
        startedAt: AdminFormat.dateTime(last.startedAt),
        finishedAt: AdminFormat.dateTime(last.finishedAt), error: failure(last.failure?.code),
      }));
      if (last.beforeBoot) parts.push(text('beforeBoot'));
    }
    if (status.record === 'unreadable') parts.push(text('unreadable'));
    else if (!running && !last) parts.push(text('missing'));
    if (status.record === 'not_persisted') parts.push(text('notPersisted'));
    parts.push(live(status.live));
    root.textContent = parts.join(' ');
    if (last && (last.result === 'failed' || last.result === 'interrupted')) recovery(root, last.failure?.code);
  }
  async function fetchStatus() {
    const response = await fetch('/rebuild/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('build_status_unavailable');
    const status = await response.json();
    if (!status || !['ok', 'missing', 'unreadable', 'not_persisted'].includes(status.record)) throw new Error('build_status_invalid');
    return status;
  }
  async function loadStatus(root) {
    try { renderStatus(root, await fetchStatus()); }
    catch {
      root.textContent = text('unavailable');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn-secondary';
      retry.textContent = text('retryStatus');
      retry.addEventListener('click', () => loadStatus(root));
      root.appendChild(retry);
    }
  }
  return { text, failure, describeOutcome, renderOutcome, renderStatus, fetchStatus, loadStatus, recovery };
})();
