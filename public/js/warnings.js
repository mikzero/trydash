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
        text: 'Il tuo server su ' + api.shortOrigin(summary.origin) + ' non risponde — è avviato?',
        actions: ['restart', 'hello'],
      });
    }
    var traffic = summary.traffic;
    if (traffic && traffic.ok !== false && typeof traffic.inflight === 'number' && traffic.inflight >= NEAR_LIMIT) {
      list.push({
        id: 'near-limit',
        kind: 'warn',
        text: 'Vicino al limite di ' + INFLIGHT_LIMIT + ' richieste: le altre riceveranno 429.',
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
