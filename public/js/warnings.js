(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var INFLIGHT_LIMIT = 200;
  var NEAR_LIMIT = 150;
  var ORIGIN_DOWN_MS = 60000;

  function loadLevel(inflight) {
    if (typeof inflight !== 'number') return '';
    if (inflight >= INFLIGHT_LIMIT) return 'danger';
    if (inflight >= NEAR_LIMIT) return 'warn';
    return '';
  }

  // Banner warnings only; badges and fixed notes are drawn from options directly.
  function warningsFor(summary, nowMs) {
    var list = [];
    if (!summary || !summary.active) return list;
    var lastError = summary.lastOriginError;
    if (summary.mode !== 'hello' && lastError && nowMs - Date.parse(lastError.at) <= ORIGIN_DOWN_MS) {
      list.push({
        id: 'origin-down',
        kind: 'error',
        text: api.t('ui.warn.originDown', { origin: api.shortOrigin(summary.origin) }),
        actions: ['restart', 'hello'],
      });
    }
    // Requests kept while the origin is down.
    var queued = summary.inspect && summary.inspect.queued;
    if (queued) {
      list.push({
        id: 'queued',
        kind: 'warn',
        text: api.tn('ui.warn.queued', queued),
        actions: ['deliver-queue', 'drop-queue'],
      });
    }
    // The site sends visitors to its local address: rewriting fixes it.
    var local = summary.localRedirect;
    var options = summary.options || {};
    if (local && options.inspect && !options.rewrite && summary.mode !== 'folder') {
      list.push({
        id: 'local-redirect',
        kind: 'warn',
        text: api.t(local.kind === 'host' ? 'ui.warn.localHost' : local.kind === 'links' ? 'ui.warn.localLinks' : 'ui.warn.localRedirect', { location: local.location }),
        actions: ['rewrite'],
      });
    }
    var traffic = summary.traffic;
    if (traffic && traffic.ok !== false && typeof traffic.inflight === 'number' && traffic.inflight >= NEAR_LIMIT) {
      list.push({
        id: 'near-limit',
        kind: 'warn',
        text: api.t('ui.warn.nearLimit', { limit: INFLIGHT_LIMIT }),
        actions: [],
      });
    }
    return list;
  }

  api.INFLIGHT_LIMIT = INFLIGHT_LIMIT;
  api.NEAR_LIMIT = NEAR_LIMIT;
  api.ORIGIN_DOWN_MS = ORIGIN_DOWN_MS;
  api.loadLevel = loadLevel;
  api.warningsFor = warningsFor;
})(globalThis);
