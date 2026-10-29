// Read-only observation lifecycle. No save, content adoption, token storage or write retry.
window.PublicationRefresh = (function () {
  'use strict';
  async function json(url, signal) {
    const response = await fetch(url, { cache: 'no-store', signal });
    if (!response.ok) { const error = new Error('publication_read_failed'); error.status = response.status; throw error; }
    return response.json();
  }
  function create(options) {
    let generation = 0, active = null, timer = null, started = false, actions = 0;
    let lastTrigger = -Infinity, settledRefresh = false, actionRefresh = false;
    const resource = () => options.resource ? options.resource() : '';
    function invalidate() { generation += 1; active?.controller.abort(); }
    function schedule() {
      clearTimeout(timer);
      timer = null;
      if (started && !document.hidden) timer = setTimeout(() => { refresh(); schedule(); }, 30000);
    }
    function refresh(trigger = 'manual') {
      if (!started || document.hidden || actions || !resource() && options.resource) return Promise.resolve();
      if (active) return active.promise;
      if (trigger === 'focus' && Date.now() - lastTrigger < 5000) return Promise.resolve();
      lastTrigger = Date.now();
      const version = generation, key = resource(), controller = new AbortController();
      let deadline, received = false;
      const current = () => started && generation === version && key === resource() && !actions && !controller.signal.aborted;
      const operation = { controller, promise: null };
      active = operation;
      const { promise: bounded, resolve, reject } = Promise.withResolvers();
      const publish = (value) => {
        if (!current()) return;
        received = true;
        options.apply(value);
      };
      controller.signal.addEventListener('abort', () => reject(new Error('publication_read_aborted')), { once: true });
      deadline = setTimeout(() => controller.abort(), 10000);
      Promise.resolve().then(() => options.read(controller.signal, publish)).then(resolve, reject);
      operation.promise = bounded.then((value) => { if (current()) options.apply(value); })
        .catch((error) => {
          if (!started || generation !== version || key !== resource() || actions) return;
          // Fresh post facts do not become unavailable because independent optional
          // build history stalled. Progress already cleared its old qualifiers.
          if (!received || error.status === 401) options.unavailable(error);
          if (error.status === 401) { stop(); options.unauthorized?.(); }
        }).finally(() => {
          clearTimeout(deadline);
          if (active === operation) active = null;
          if (settledRefresh && !actions && started) { settledRefresh = false; refresh(); }
        });
      return operation.promise;
    }
    function focus() { if (!document.hidden) refresh('focus'); }
    function visibility() {
      schedule();
      if (document.hidden) invalidate();
      else focus();
    }
    function start(initial = true) {
      if (started) return;
      started = true;
      window.addEventListener('focus', focus);
      document.addEventListener('visibilitychange', visibility);
      window.addEventListener('pagehide', stop);
      schedule();
      if (initial) refresh();
    }
    function stop() {
      started = false; invalidate(); clearTimeout(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', stop);
    }
    function beginAction() {
      if (!actions) actionRefresh = false;
      actions += 1; invalidate(); return generation;
    }
    function accept(value, version = generation) {
      if (version !== generation) return;
      invalidate(); options.apply(value);
    }
    // Item acknowledgements/recovery reads already carry a fresh projection. Their
    // callers can settle without a duplicate GET; scheduled/manual reads stay enabled.
    function endAction(refreshAfter = true) {
      invalidate(); actions = Math.max(0, actions - 1);
      actionRefresh = actionRefresh || refreshAfter;
      if (!actions) {
        settledRefresh = actionRefresh && !!active;
        if (actionRefresh && !active) refresh();
      }
    }
    return { start, stop, refresh, invalidate, beginAction, endAction, accept };
  }
  return { create, json };
})();
