(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var KEY = 'trylogs.theme';
  var MODES = ['auto', 'light', 'dark'];
  var LABELS = { auto: '◐ auto', light: '☀ chiaro', dark: '☾ scuro' };
  var current = null;

  function read() {
    try {
      var value = root.localStorage ? root.localStorage.getItem(KEY) : null;
      return MODES.indexOf(value) >= 0 ? value : 'auto';
    } catch (err) {
      return 'auto';
    }
  }

  function get() {
    if (current == null) current = read();
    return current;
  }

  function apply() {
    var el = root.document && root.document.documentElement;
    if (!el) return;
    if (get() === 'auto') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', get());
  }

  function set(mode) {
    current = MODES.indexOf(mode) >= 0 ? mode : 'auto';
    try {
      if (root.localStorage) root.localStorage.setItem(KEY, current);
    } catch (err) {
      /* storage unavailable: keep the choice for this page only */
    }
    apply();
  }

  function cycle() {
    var next = MODES[(MODES.indexOf(get()) + 1) % MODES.length];
    set(next);
    return next;
  }

  function label(mode) {
    return LABELS[mode] || LABELS.auto;
  }

  api.theme = { get: get, set: set, cycle: cycle, apply: apply, label: label };
})(globalThis);
