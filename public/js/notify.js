(function (root) {
  'use strict';

  // Browser notifications, for when the tab is in the background: on with the 🔔
  // button (which asks the browser), off again with the same button.
  var api = root.TryDash || (root.TryDash = {});
  var KEY = 'trydash.notify';

  function Notifier() {
    return typeof root.Notification === 'function' ? root.Notification : null;
  }

  function stored() {
    try {
      return root.localStorage ? root.localStorage.getItem(KEY) === 'on' : false;
    } catch (err) {
      return false;
    }
  }

  function store(on) {
    try {
      if (root.localStorage) root.localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch (err) {
      /* storage unavailable: the choice lasts for this page */
    }
  }

  var wanted = null;

  function supported() {
    return !!Notifier();
  }

  function enabled() {
    var N = Notifier();
    if (wanted == null) wanted = stored();
    return !!(N && wanted && N.permission === 'granted');
  }

  // Resolves with the new state; a refusal from the browser leaves them off.
  function toggle() {
    var N = Notifier();
    if (!N) return Promise.resolve(false);
    if (enabled()) {
      wanted = false;
      store(false);
      return Promise.resolve(false);
    }
    var ask = N.permission === 'granted' ? Promise.resolve('granted') : Promise.resolve(N.requestPermission());
    return ask.then(function (permission) {
      wanted = permission === 'granted';
      store(wanted);
      return wanted;
    }, function () {
      return false;
    });
  }

  function inBackground() {
    var doc = root.document;
    if (!doc) return false;
    if (doc.hidden) return true;
    return typeof doc.hasFocus === 'function' ? !doc.hasFocus() : false;
  }

  // `tag` replaces an older notice about the same thing instead of piling up.
  function show(title, body, opts) {
    var N = Notifier();
    if (!N || !enabled() || !inBackground()) return null;
    var options = opts || {};
    try {
      var note = new N(title, { body: body || '', tag: options.tag || undefined, icon: 'favicon.png' });
      note.onclick = function () {
        if (root.focus) root.focus();
        if (options.onClick) options.onClick();
        note.close();
      };
      return note;
    } catch (err) {
      return null;
    }
  }

  // What changed between two polls that is worth a notice.
  function noticesFor(prev, next, nowMs) {
    var list = [];
    if (!prev) return list;
    var name = next.url ? next.url.replace(/^https?:\/\//, '') : api.originLabel(next);
    if (prev.status !== next.status) {
      if (next.status === 'running' && next.url) list.push({ kind: 'ready', title: api.t('ui.notify.ready'), body: next.url });
      if (next.status === 'exited') list.push({ kind: 'exited', title: api.t('ui.notify.exited'), body: api.originLabel(next) });
      if (next.status === 'stopped' && next.expired) list.push({ kind: 'expired', title: api.t('ui.notify.expired'), body: api.originLabel(next) });
    }
    var error = next.lastOriginError;
    var fresh = error && (!prev.lastOriginError || prev.lastOriginError.at !== error.at);
    var recent = error && nowMs - Date.parse(error.at) <= (api.ORIGIN_DOWN_MS || 60000);
    // One notice per outage: only when the previous error was over a minute old, or none.
    var newOutage = !prev.lastOriginError || Date.parse(error ? error.at : 0) - Date.parse(prev.lastOriginError.at) > (api.ORIGIN_DOWN_MS || 60000);
    if (next.active && next.mode !== 'hello' && fresh && recent && newOutage) {
      list.push({ kind: 'origin-down', title: api.t('ui.notify.originDown'), body: api.t('ui.warn.originDown', { origin: api.shortOrigin(next.origin || '') }) + ' · ' + name });
    }
    return list;
  }

  api.notifications = { supported: supported, enabled: enabled, toggle: toggle, show: show, noticesFor: noticesFor };
})(globalThis);
