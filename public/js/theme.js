(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var KEY = 'trylogs.theme';
  var MODES = ['auto', 'light', 'dark'];
  var LABELS = { auto: 'ui.theme.auto', light: 'ui.theme.light', dark: 'ui.theme.dark' };
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
    return api.t(LABELS[mode] || LABELS.auto);
  }

  // Just the symbol, for the narrow button; the label goes in its tooltip.
  function icon(mode) {
    return label(mode).split(' ')[0];
  }

  api.theme = { get: get, set: set, cycle: cycle, apply: apply, label: label, icon: icon };

  // The interface language: the one picked with the EN/IT button, else the browser's.
  var LANG_KEY = 'trydash.lang';

  function storedLang() {
    try {
      var value = root.localStorage ? root.localStorage.getItem(LANG_KEY) : null;
      return (api.SUPPORTED_LANGS || []).indexOf(value) >= 0 ? value : null;
    } catch (err) {
      return null;
    }
  }

  function chooseLang(browserLang) {
    return storedLang() || api.pickLang(browserLang);
  }

  function setLang(lang) {
    try {
      if (root.localStorage) root.localStorage.setItem(LANG_KEY, lang);
    } catch (err) {
      /* storage unavailable: the choice lasts until the page reloads */
    }
    api.lang = lang;
  }

  function otherLang() {
    return api.lang === 'it' ? 'en' : 'it';
  }

  api.langPref = { choose: chooseLang, set: setLang, other: otherLang };
})(globalThis);
