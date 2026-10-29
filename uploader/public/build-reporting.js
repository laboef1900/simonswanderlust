// Build evidence is independent of the acknowledged CMS mutation and of story liveness.
window.BuildReporting = (function () {
  'use strict';
  const codes = ['build_timeout', 'build_failed', 'build_unavailable', 'no_space', 'release_write_failed', 'build_stopped', 'internal'];
  function text(key, values = {}) {
    const locale = document.documentElement?.lang === 'de' ? 'de' : 'en';
    return BuildCopy[locale][key].replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
  }
  function failure(code) { return text('failure.' + (codes.includes(code) ? code : 'internal')); }
  function live(value) {
    if (value === null) return text('noLive');
    if (!value) return text('liveUnavailable');
    const stamp = typeof value === 'string' ? Number(value.split('-')[0]) : Date.parse(value.stampedAt);
    return Number.isFinite(stamp) ? text('live', { stampedAt: new Date(stamp).toLocaleString() }) : text('liveUnavailable');
  }
  function describeOutcome(action, body = {}, values = {}) {
    const build = action === 'rebuild' ? body : body.build;
    const prefix = action === 'rebuild' ? '' : text(action === 'delete' && !build ? 'deleteDraft' : action, values);
    if (!build) return [prefix, text('noBuild')].filter(Boolean).join(' ');
    if (typeof build.ok !== 'boolean') return [prefix, text('unknown')].filter(Boolean).join(' ');
    return [prefix, build.ok ? text('promoted', { release: build.release })
      : text(action === 'rebuild' ? 'failedRebuild' : 'failedChange', { error: failure(build.code) }), live(build.liveRelease)].filter(Boolean).join(' ');
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
      parts.push(text('running', { startedAt: new Date(running.startedAt).toLocaleString() }));
      if (running.queued) parts.push(text('queued'));
      if (running.owner === 'unverified') parts.push(text('unverified'));
    }
    if (last) {
      parts.push(text(last.result, {
        startedAt: new Date(last.startedAt).toLocaleString(),
        finishedAt: new Date(last.finishedAt).toLocaleString(), error: failure(last.failure?.code),
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
