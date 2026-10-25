(function (root) {
  'use strict';

  function wire(host) {
    const dialog = document.getElementById('gpxDialog');
    const $ = (id) => document.getElementById(id);
    const status = $('gpxStatus');
    const error = $('gpxError');
    const feedback = $('gpxRouteFeedback');
    const file = $('gpxFile');
    const attach = $('gpxAttach');
    const copy = host.copy;
    let geometryApi;
    let publicApi;
    function applyCopy() {
      const labels = {
        gpxDialogHeading: 'editorTitle', gpxClose: 'close', gpxImportOpen: 'import',
        gpxReimport: 'reimport', gpxDownload: 'download',
        gpxDetach: 'detach', gpxFileLabel: 'importFile', gpxEmpty: 'emptyPreview',
        gpxPrivacy: 'privacy', gpxStartLabel: 'startPoints', gpxEndLabel: 'endPoints',
        gpxStartDistanceLabel: 'startMetres', gpxEndDistanceLabel: 'endMetres',
        gpxTrimMethodLabel: 'trimMethod', gpxTrimMethodHelp: 'trimMethodHelp',
        gpxTrimPointsOption: 'trimPoints', gpxTrimDistanceOption: 'trimDistance',
        gpxReset: 'reset', gpxSegmentsLegend: 'segments', gpxWaypointsHeading: 'waypoints',
        gpxWaypointWarning: 'waypointWarning', gpxAdopt: 'adoptSelected',
        gpxAdoptionNote: 'adoptionIndependent',
        gpxPublicationNotice: 'publicationNotice',
        gpxCandidateHelp: 'candidateHelp',
        gpxDiscard: 'discardPreview', gpxAttach: 'attach', gpxReplaceScope: 'replaceBody',
      };
      Object.entries(labels).forEach(([id, key]) => {
        const element = document.getElementById(id);
        if (element && copy[key]) element.textContent = copy[key];
      });
      const replaceLabel = document.querySelector('#gpxReplaceConfirmLabel span');
      const adoptLabel = document.querySelector('#gpxAdoptConfirmLabel span');
      if (replaceLabel) replaceLabel.textContent = copy.replaceScope || '';
      if (adoptLabel) adoptLabel.textContent = copy.adoptConfirm || '';
      const heading = document.getElementById('gpxRouteHeading');
      if (heading) heading.textContent = copy.sectionTitle || '';
    }
    let preview = null;
    let route = { version: null, geometry: null, originalAvailable: false };
    let selection = { startPoints: 0, endPoints: 0, removedSegments: [] };
    let epoch = 0;
    let controller = null;
    let map = null;
    let opener = null;
    let inspectorWasOpen = false;
    let busy = false;
    let mutationPending = false;
    let errorCode = null;
    let metresMode = false;
    let outcomeUnknown = false;
    let cleanupUnconfirmed = false;
    let routeLoaded = !host.getPost().tk;
    let routeTk = null;
    let routeEpoch = 0;
    let candidate = null;
    let candidateWorker = null;
    let candidateTimer = null;
    let candidateEpoch = 0;
    applyCopy();
    const msg = (key) => copy[key] || key;
    function say(key) {
      const text = key ? msg(key) : '';
      if (dialog.open) status.textContent = text;
      else {
        feedback.textContent = [text, cleanupUnconfirmed ? msg('cancelPending') : ''].filter(Boolean).join(' ');
        feedback.hidden = !feedback.textContent;
        feedback.className = cleanupUnconfirmed ? 'notice-warn' : 'muted';
        feedback.setAttribute('role', 'status');
      }
    }
    function clearError() {
      errorCode = null;
      error.hidden = true; error.textContent = '';
      feedback.hidden = true; feedback.textContent = '';
    }
    function fail(key, moveFocus = true, detail = '') {
      errorCode = key;
      const target = dialog.open ? error : feedback;
      target.textContent = [msg(key), detail].filter(Boolean).join(' '); target.hidden = false;
      target.className = 'err'; target.setAttribute('role', 'alert');
      status.textContent = '';
      if (moveFocus) target.focus();
    }
    function unknownOutcome() { return Object.assign(new Error('gpx_outcome_unknown'), { code: 'gpx_outcome_unknown' }); }
    async function geometry() {
      if (!geometryApi) geometryApi = host.loadGeometry ? await host.loadGeometry() : await import('/admin/gpx-geometry.js');
      return geometryApi;
    }
    async function publicTrack() {
      if (!publicApi) publicApi = host.loadPublicTrack ? await host.loadPublicTrack() : await import('/admin/gpx-public-track.js');
      return publicApi;
    }
    const postUrl = (suffix) => '/posts/' + encodeURIComponent(host.getPost().tk) + '/route' + suffix;
    async function request(url, options, mutation = false) {
      let response;
      try { response = await fetch(url, options); }
      catch (e) { if (mutation) throw unknownOutcome(); throw e; }
      if (response.status === 401) { host.on401(); throw Object.assign(new Error('unauthorized'), { handled: true }); }
      let body = {};
      if (response.status !== 204) {
        try { body = await response.json(); }
        catch (e) { if (mutation) throw unknownOutcome(); throw e; }
      }
      if (mutation && response.status >= 500) throw unknownOutcome();
      if (!response.ok) throw Object.assign(new Error(body.error || 'gpx_request_failed'), { code: body.error, status: response.status, invalidPoints: body.invalidPoints });
      if (mutation && (!body || typeof body.updatedAt !== 'string' || !Number.isFinite(Date.parse(body.updatedAt)) || typeof body.version !== 'string' || !body.version)) throw unknownOutcome();
      return body;
    }
    function errorKey(e) {
      if (e?.code === 'track_public_limit') return 'publicLimit';
      if (e?.code === 'track_empty_after_rounding') return 'publicEmpty';
      const table = { gpx_conflict: 'conflict', gpx_outcome_unknown: 'unknown', gpx_import_unavailable: 'previewExpired', gpx_busy: 'busy', gpx_quota: 'quota', gpx_timeout: 'timeout', gpx_too_large: 'fileTooLarge', gpx_invalid_xml: 'invalidFile', gpx_invalid_points: 'invalidFile', gpx_invalid_encoding: 'invalidFile', gpx_invalid_request: 'invalidFile', gpx_limit: 'limitExceeded', gpx_invalid_geometry: 'invalidFile', gpx_invalid_selection: 'invalidFile', gpx_empty_selection: 'allTrimmed', gpx_empty: 'invalidEmpty', gpx_unavailable: 'unavailable', gpx_worker_failed: 'workerFailed', gpx_forbidden_origin: 'failed', gpx_aborted: 'failed', gpx_original_unavailable: 'unavailable', gpx_route_not_found: 'missingRoute', gpx_post_not_found: 'missingPost', gpx_invalid_source: 'invalidFile', gpx_replace_unconfirmed: 'replaceUnconfirmed', gpx_detach_unconfirmed: 'failed', gpx_cleanup_pending: 'cleanupPending', storage_read_only: 'storageReadOnly' };
      return table[e && e.code] || 'failed';
    }
    function setBusy(value) {
      busy = value;
      dialog.querySelectorAll('button,input,select').forEach((el) => { el.disabled = el === $('gpxClose') ? mutationPending : value; });
      ['gpxImportOpen', 'gpxReimport', 'gpxDetach'].forEach((id) => { $(id).disabled = value || outcomeUnknown; });
      $('gpxDetach').disabled = value || outcomeUnknown || !routeLoaded;
      $('gpxDownload').disabled = value;
      attach.textContent = msg(host.getPost().tk ? 'attach' : 'newPostSaveFirst');
      attach.disabled = value || outcomeUnknown || !routeLoaded || !candidate || !preview || !preview.geometry.segments.length || !renderStats().valid || (route.version !== null && !$('gpxReplaceConfirm').checked);
      syncTrimControls();
      updateAdopt();
    }
    function cleanupMap() { if (map) map.destroy(); map = null; }
    function cancelCandidate() {
      candidateEpoch++;
      clearTimeout(candidateTimer);
      candidateTimer = null;
      if (candidateWorker) candidateWorker.terminate();
      candidateWorker = null;
      candidate = null;
    }
    function generateCandidate(kept) {
      cancelCandidate();
      const myEpoch = candidateEpoch;
      $('gpxCandidateStatus').textContent = msg('candidatePending');
      const finish = (result, failure) => {
        if (myEpoch !== candidateEpoch || !preview) return;
        candidateEpoch++;
        clearTimeout(candidateTimer);
        candidateTimer = null;
        if (candidateWorker) candidateWorker.terminate();
        candidateWorker = null;
        if (failure) {
          $('gpxCandidateStatus').textContent = '';
          fail(failure, false);
        } else {
          candidate = result;
          $('gpxCandidateStatus').textContent = result.collapsedRuns
            ? msg('candidateCollapsed').replace('{count}', String(result.collapsedRuns))
            : msg('candidateReady');
        }
        updatePreview(false);
      };
      try {
        candidateWorker = new Worker('/admin/gpx-candidate-worker.js', { type: 'module' });
        candidateWorker.onmessage = ({ data }) => {
          if (myEpoch !== candidateEpoch) return;
          if (!data?.ok) { finish(null, errorKey(data)); return; }
          try {
            publicApi.validatePublicTrack(data.result.track);
            if (!Number.isSafeInteger(data.result.collapsedRuns) || data.result.collapsedRuns < 0 || data.result.collapsedRuns > 100) throw new Error('invalid result');
            finish(data.result);
          } catch (_) { finish(null, 'candidateFailed'); }
        };
        candidateWorker.onerror = candidateWorker.onmessageerror = () => finish(null, 'candidateFailed');
        candidateTimer = setTimeout(() => finish(null, 'candidateTimeout'), 2000);
        candidateWorker.postMessage({ geometry: kept });
      } catch (_) { finish(null, 'candidateFailed'); }
    }
    function cancelImport(importId) {
      void request('/gpx/imports/' + encodeURIComponent(importId), { method: 'DELETE' }).catch((e) => {
        if (e.handled || e.status === 404) return;
        cleanupUnconfirmed = true;
        const notice = $('gpxCleanupNotice');
        notice.textContent = msg('cancelPending'); notice.hidden = false;
        if (!dialog.open && !outcomeUnknown && !errorCode) say('');
      });
    }
    function teardownPreview() {
      epoch++;
      if (controller) controller.abort();
      controller = null;
      cancelCandidate();
      if (preview && preview.importId) cancelImport(preview.importId);
      preview = null;
      selection = { startPoints: 0, endPoints: 0, removedSegments: [] };
      cleanupMap();
      $('gpxPreview').hidden = true;
      $('gpxEmpty').hidden = false;
      file.value = '';
      $('gpxSegments').replaceChildren();
      $('gpxWaypoints').replaceChildren();
      $('gpxCounts').textContent = '';
      $('gpxKept').textContent = '';
      $('gpxRemoved').textContent = '';
      $('gpxCandidateStatus').textContent = '';
      $('gpxAdopt').hidden = true;
      metresMode = false;
      setBusy(false);
    }
    function renderStats() {
      if (!preview || !preview.geometry) return { valid: false };
      try {
        const result = geometryApi.trimGeometry(preview.geometry, selection);
        const stats = geometryApi.geometryStats(result.geometry);
        $('gpxKept').textContent = msg('kept').replace('{count}', String(stats.points));
        $('gpxRemoved').textContent = msg('removed').replace('{count}', String(Math.max(0, preview.counts.points - stats.points)));
        return { valid: result.geometry.segments.length > 0, result, stats };
      } catch (_) {
        $('gpxKept').textContent = msg('kept').replace('{count}', '0');
        $('gpxRemoved').textContent = msg('removed').replace('{count}', String(preview.counts.points));
        return { valid: false };
      }
    }
    function syncTrimControls() {
      $('gpxTrimMethod').value = metresMode ? 'distance' : 'points';
      $('gpxPointTrim').hidden = metresMode;
      $('gpxDistanceTrim').hidden = !metresMode;
      $('gpxStart').disabled = $('gpxEnd').disabled = busy || metresMode;
      $('gpxStartDistance').disabled = $('gpxEndDistance').disabled = busy || !metresMode;
    }
    function updatePreview(recompute = true) {
      syncTrimControls();
      if (!preview) return;
      const stats = renderStats();
      if (recompute) {
        if (['allTrimmed', 'publicLimit', 'publicEmpty', 'candidateFailed', 'candidateTimeout'].includes(errorCode)) clearError();
        if (stats.valid) generateCandidate(stats.result.geometry);
        else {
          cancelCandidate();
          $('gpxCandidateStatus').textContent = '';
          if (preview.geometry.segments.length && !busy && !outcomeUnknown && !errorCode) fail('allTrimmed', false);
        }
      }
      attach.disabled = busy || outcomeUnknown || !routeLoaded || !candidate || !stats.valid || (route.version !== null && !$('gpxReplaceConfirm').checked);
      if (map) map.render({ geometry: preview.geometry, rawKept: stats.valid ? stats.result.geometry : { version: 1, segments: [] }, selection, track: candidate?.track || null, waypoints: preview.waypoints, selectedWaypointIndices: selectedWaypoints() });
      updateAdopt();
    }
    function selectedWaypoints() { return [...$('gpxWaypoints').querySelectorAll('input[type=checkbox]:checked')].map((el) => Number(el.value)); }
    function updateAdopt() {
      $('gpxAdopt').disabled = busy || outcomeUnknown || !selectedWaypoints().length || !$('gpxAdoptConfirm').checked;
    }
    function recalculate() {
      if (!preview || busy) return;
      try {
        selection = metresMode
          ? geometryApi.selectionFromDistances(preview.geometry, selection.removedSegments, Number($('gpxStartDistance').value), Number($('gpxEndDistance').value))
          : { ...selection, startPoints: Number($('gpxStart').value), endPoints: Number($('gpxEnd').value) };
      } catch (_) { selection = { ...selection, startPoints: preview.counts.points, endPoints: 0 }; }
      updatePreview();
    }
    function resetSelection() {
      selection = { startPoints: 0, endPoints: 0, removedSegments: [] };
      $('gpxSegments').querySelectorAll('input').forEach((el) => { el.checked = false; });
      $('gpxStart').value = $('gpxEnd').value = $('gpxStartDistance').value = $('gpxEndDistance').value = '0';
      updatePreview();
    }
    async function showPreview(data, expectedEpoch = epoch) {
      if (expectedEpoch !== epoch) { cancelImport(data.importId); return; }
      preview = data;
      $('gpxEmpty').hidden = true;
      $('gpxPreview').hidden = false;
      $('gpxMap').setAttribute('aria-label', host.mapCopy.routeLabel);
      await Promise.all([geometry(), publicTrack()]);
      if (expectedEpoch !== epoch) return;
      $('gpxCounts').textContent = msg('counts').replace('{points}', String(data.counts.points)).replace('{segments}', String(data.counts.segments)).replace('{waypoints}', String(data.counts.waypoints));
      $('gpxReplaceScope').hidden = route.version === null;
      $('gpxReplaceConfirmLabel').hidden = route.version === null;
      $('gpxReplaceConfirm').checked = false;
      $('gpxStart').value = '0'; $('gpxEnd').value = '0'; $('gpxStartDistance').value = '0'; $('gpxEndDistance').value = '0';
      const segmentList = $('gpxSegments');
      segmentList.replaceChildren();
      data.geometry.segments.forEach((segment, index) => {
        const label = document.createElement('label');
        label.className = 'gpx-segment';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = String(index);
        checkbox.addEventListener('change', () => { selection.removedSegments = [...segmentList.querySelectorAll('input:checked')].map((el) => Number(el.value)); recalculate(); });
        const text = document.createElement('span'); text.textContent = msg('segment').replace('{index}', String(index + 1)).replace('{count}', String(segment.points.length));
        label.append(checkbox, text); segmentList.append(label);
      });
      const points = data.geometry.segments.reduce((n, s) => n + s.points.length, 0);
      $('gpxStart').max = String(points); $('gpxEnd').max = String(points);
      const pointsOnly = data.geometry.segments.length === 0 && data.waypoints.length > 0;
      attach.hidden = pointsOnly;
      const waypointList = $('gpxWaypoints'); waypointList.replaceChildren();
      data.waypoints.forEach((point, index) => {
        const row = document.createElement('div'); row.className = 'gpx-waypoint';
        const check = document.createElement('input'); check.type = 'checkbox'; check.value = String(index); check.setAttribute('aria-label', msg('adoptWaypoints') + ' ' + (index + 1));
        const name = document.createElement('input'); name.type = 'text'; name.value = point.name || ''; name.setAttribute('aria-label', msg('waypointName') + ' ' + (index + 1));
        check.addEventListener('change', () => updatePreview(false));
        row.append(check, name); waypointList.append(row);
      });
      $('gpxAdopt').hidden = !data.waypoints.length;
      $('gpxWaypointsHeading').hidden = !data.waypoints.length;
      $('gpxWaypointWarning').hidden = !data.waypoints.length;
      $('gpxAdoptConfirmLabel').hidden = !data.waypoints.length;
      $('gpxAdoptionNote').hidden = !data.waypoints.length;
      $('gpxAdoptConfirm').checked = false;
      $('gpxPrivacy').hidden = pointsOnly;
      try {
        if (host.map) {
          const created = await host.map.create({ container: $('gpxMap'), statusElement: $('gpxMapStatus'), copy: host.mapCopy, signal: controller?.signal });
          if (expectedEpoch !== epoch) { created.destroy(); return; }
          map = created;
        }
      } catch (_) { $('gpxMapStatus').textContent = msg('mapWebglFallback'); }
      updatePreview();
    }
    async function importFile(selected) {
      clearError();
      if (!selected) return;
      teardownPreview();
      if (selected.size > 5 * 1024 * 1024) { fail('fileTooLarge'); return; }
      const myEpoch = ++epoch;
      controller = new AbortController();
      setBusy(true); say('loading');
      const form = new FormData(); form.append('file', selected, 'route.gpx');
      try {
        const data = await request('/gpx/imports', { method: 'POST', body: form, signal: controller.signal });
        if (myEpoch !== epoch) { cancelImport(data.importId); return; }
        await showPreview(data, myEpoch);
        if (myEpoch === epoch) say('importSuccess');
      } catch (e) { if (myEpoch === epoch && !e.handled && e.name !== 'AbortError') fail(errorKey(e)); }
      finally { if (myEpoch === epoch) { controller = null; setBusy(false); } }
    }
    async function refreshRoute() {
      const tk = host.getPost().tk;
      const current = ++routeEpoch;
      routeLoaded = false;
      setBusy(busy);
      if (!tk) {
        route = { version: null, geometry: null, originalAvailable: false };
        routeTk = null; routeLoaded = true; renderRoute(); setBusy(busy); return;
      }
      try {
        const loaded = await request('/posts/' + encodeURIComponent(tk) + '/route', { method: 'GET' });
        if (current !== routeEpoch || tk !== host.getPost().tk) return;
        if (!loaded || !(loaded.version === null || (typeof loaded.version === 'string' && loaded.version))) throw new Error('invalid route state');
        route = loaded; routeTk = tk; routeLoaded = true; renderRoute(); setBusy(busy);
      } catch (e) { if (current === routeEpoch && !e.handled) fail(errorKey(e)); }
    }
    function publishVersion() {
      if (!routeLoaded || routeTk !== host.getPost().tk || outcomeUnknown || mutationPending || preview) {
        fail(outcomeUnknown ? 'unknown' : 'routeNotReviewed');
        throw new Error(msg('routeNotReviewed'));
      }
      return route.version;
    }
    function renderRoute() {
      $('gpxRouteStatus').textContent = route.geometry ? msg('statusAttached') : msg(route.version === null ? 'statusNone' : 'statusDetached');
      $('gpxReimport').hidden = !route.originalAvailable;
      $('gpxDownload').hidden = !route.originalAvailable;
      $('gpxDetach').hidden = !route.geometry || outcomeUnknown;
      $('gpxImportOpen').hidden = false;
    }
    function openDialog(button) {
      clearError();
      setBusy(false);
      opener = button;
      inspectorWasOpen = host.inspector.isOpen();
      if (inspectorWasOpen) host.inspector.close();
      dialog.showModal();
      $('gpxClose').focus();
    }
    function closeDialog() {
      if (mutationPending) return;
      teardownPreview(); clearError(); say('');
      dialog.close();
      if (outcomeUnknown) fail('unknown');
      else if (cleanupUnconfirmed) say('');
      if (inspectorWasOpen) host.inspector.open();
      if (opener && opener.isConnected) opener.focus();
    }
    async function importOriginal(button) {
      openDialog(button);
      teardownPreview();
      const myEpoch = ++epoch;
      controller = new AbortController();
      setBusy(true); say('loading'); clearError();
      try {
        const data = await request(postUrl('/import'), { method: 'POST', signal: controller.signal });
        if (myEpoch !== epoch) { cancelImport(data.importId); return; }
        await showPreview(data, myEpoch);
        if (myEpoch === epoch) say('importSuccess');
      } catch (e) { if (myEpoch === epoch && !e.handled && e.name !== 'AbortError') fail(errorKey(e)); }
      finally { if (myEpoch === epoch) { controller = null; setBusy(false); } }
    }
    async function attachRoute() {
      if (busy || outcomeUnknown || !preview) return;
      const computed = renderStats(); if (!computed.valid) { fail('allTrimmed'); return; }
      if (!candidate || !routeLoaded) { fail('candidateUnavailable'); return; }
      if (route.version !== null && !$('gpxReplaceConfirm').checked) { fail('replaceUnconfirmed'); $('gpxReplaceConfirm').focus(); return; }
      const existing = !!host.getPost().tk;
      mutationPending = true;
      setBusy(true); clearError(); say('loading');
      let savedNewPost = false;
      try {
        if (!existing) {
          if (!await host.saveDraft() || !host.getPost().tk) {
            fail('saveFailedNotAttached', true, host.saveError?.() || '');
            return;
          }
          savedNewPost = true;
        }
        const tokens = host.getPost();
        const body = { importId: preview.importId, baseVersion: route.version, baseUpdatedAt: tokens.baseUpdatedAt, selection, confirmReplace: true };
        const result = await request(postUrl(''), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, true);
        host.setBaseUpdatedAt(result.updatedAt);
        route = result; routeTk = host.getPost().tk; routeLoaded = true; renderRoute();
        preview = null; mutationPending = false;
        closeDialog();
        if (result.cleanupPending) fail('cleanupPending'); else say('attachSuccess');
      } catch (e) {
        if (e.code === 'gpx_outcome_unknown') {
          outcomeUnknown = true;
          try { route = await request(postUrl(''), { method: 'GET' }); renderRoute(); } catch (_) { /* Keep attach disabled until reload. */ }
          fail('unknown');
        } else if (e.code === 'gpx_import_unavailable') {
          teardownPreview();
          fail(savedNewPost ? 'attachFailureSaved' : 'previewExpired', true, savedNewPost ? msg('previewExpired') : '');
        } else fail(savedNewPost ? 'attachFailureSaved' : errorKey(e));
      } finally { mutationPending = false; setBusy(false); }
    }
    async function detachRoute() {
      if (busy || outcomeUnknown || !route.geometry) return;
      const ok = await host.confirm({ title: msg('detachTitle'), body: msg('detachBody'), confirmLabel: msg('detachLabel'), danger: true });
      if (!ok) return;
      mutationPending = true; setBusy(true); clearError();
      let detached = false;
      try {
        const tokens = host.getPost();
        const result = await request(postUrl(''), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseVersion: route.version, baseUpdatedAt: tokens.baseUpdatedAt, confirmDetach: true }) }, true);
        host.setBaseUpdatedAt(result.updatedAt); route = result; renderRoute();
        detached = true;
        if (result.cleanupPending) fail('cleanupPending'); else say('detachSuccess');
      } catch (e) {
        if (e.code === 'gpx_outcome_unknown') { outcomeUnknown = true; await refreshRoute(); fail('unknown'); }
        else fail(errorKey(e));
      }
      finally {
        mutationPending = false; setBusy(false);
        if (detached && !errorCode) $($('gpxReimport').hidden ? 'gpxImportOpen' : 'gpxReimport').focus();
      }
    }
    async function adopt() {
      if (busy || outcomeUnknown || !preview) return;
      const selected = selectedWaypoints(); if (!selected.length || !$('gpxAdoptConfirm').checked) return;
      const rows = [...$('gpxWaypoints').querySelectorAll('.gpx-waypoint')];
      const stops = selected.map((index) => ({ name: rows[index].querySelector('input[type=text]').value.trim(), lat: preview.waypoints[index].lat, lng: preview.waypoints[index].lng }));
      if (stops.some((stop) => !stop.name)) { fail('waypointNameRequired'); return; }
      try {
        host.adoptStops(stops);
        rows.forEach((row) => { const checkbox = row.querySelector('input[type=checkbox]'); checkbox.checked = false; });
        $('gpxAdoptConfirm').checked = false;
        updateAdopt();
        say('adoptedSuccess');
      } catch (_) { fail('failed'); }
    }
    $('gpxTrimMethod').addEventListener('change', () => { metresMode = $('gpxTrimMethod').value === 'distance'; recalculate(); });
    ['gpxStart', 'gpxEnd', 'gpxStartDistance', 'gpxEndDistance'].forEach((id) => $(id).addEventListener('input', recalculate));
    $('gpxReset').addEventListener('click', resetSelection);
    $('gpxClose').addEventListener('click', closeDialog);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
    $('gpxImportOpen').addEventListener('click', () => openDialog($('gpxImportOpen')));
    async function downloadOriginal() {
      try {
        const response = await fetch(postUrl('/original'));
        if (response.status === 401) { host.on401(); return; }
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw { code: body.error || 'gpx_request_failed' };
        }
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url; link.download = 'route.gpx'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      } catch (e) { fail(errorKey(e)); }
    }
    $('gpxReimport').addEventListener('click', () => importOriginal($('gpxReimport')));
    $('gpxFile').addEventListener('change', () => importFile(file.files[0]));
    $('gpxAttach').addEventListener('click', attachRoute);
    $('gpxAdopt').addEventListener('click', adopt);
    $('gpxAdoptConfirm').addEventListener('change', updateAdopt);
    $('gpxReplaceConfirm').addEventListener('change', () => updatePreview(false));
    $('gpxDetach').addEventListener('click', detachRoute);
    $('gpxDownload').addEventListener('click', downloadOriginal);
    $('gpxDiscard').addEventListener('click', () => { teardownPreview(); say(''); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && preview) say('navigationWarning'); });
    window.addEventListener('beforeunload', (event) => { if (preview) { event.preventDefault(); event.returnValue = ''; } });
    const backLink = document.getElementById('backToPosts');
    backLink?.addEventListener('click', (event) => {
      if (!preview) return;
      event.preventDefault();
      say('navigationWarning');
    });
    return {
      refresh: refreshRoute,
      publishVersion,
      noteCreated: (tk) => {
        if (routeLoaded && routeTk === null && route.version === null) routeTk = tk;
      },
      publishError: (code) => {
        if (code === 'track_public_limit' || code === 'track_empty_after_rounding') {
          fail('publishRouteRecovery', false);
          host.inspector.reveal(feedback);
          return msg('publishRouteRecovery');
        }
        if (code === 'conflict') return msg('conflict');
        if (code === 'publish_busy') return msg('busy');
        if (typeof code === 'string' && code.startsWith('gpx_')) return msg(errorKey({ code }));
        return null;
      },
      hasPreview: () => !!preview,
      discard: teardownPreview,
      revisionNotice: () => say('revisionRouteNotice'),
      guardAction: () => {
        if (outcomeUnknown) fail('unknown');
        else if (preview) say('pendingPreviewGuard');
        return !preview && !outcomeUnknown && !mutationPending;
      },
    };
  }
  root.GpxEditor = { wire };
})(window);
