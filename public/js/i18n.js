(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var SUPPORTED = ['it', 'en'];
  // A browser in neither language gets English, the language of the site.
  var FALLBACK = 'en';

  function catalog(lang) {
    var messages = api.messages || {};
    return messages[lang] || null;
  }

  function t(key, params, lang) {
    var wanted = lang || api.lang || FALLBACK;
    var own = catalog(wanted);
    var base = catalog(FALLBACK);
    var text = own && typeof own[key] === 'string' ? own[key]
      : base && typeof base[key] === 'string' ? base[key]
        : key;
    var values = params || {};
    return text.replace(/\{(\w+)\}/g, function (hole, name) {
      return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : hole;
    });
  }

  // Works for navigator.language ("en-US") and Accept-Language ("fr-FR,en;q=0.8").
  // `{n}` plus a `.one` or `.other` key, for counts.
  function tn(key, n, params, lang) {
    var values = Object.assign({ n: n }, params || {});
    return t(key + (n === 1 ? '.one' : '.other'), values, lang);
  }

  function locale(lang) {
    return (lang || api.lang || FALLBACK) === 'it' ? 'it-IT' : 'en-US';
  }

  function pickLang(input) {
    var parts = String(input == null ? '' : input).split(',');
    for (var i = 0; i < parts.length; i += 1) {
      var primary = parts[i].split(';')[0].trim().split('-')[0].toLowerCase();
      if (SUPPORTED.indexOf(primary) >= 0) return primary;
    }
    return FALLBACK;
  }

  function appError(code, key, params) {
    var error = new Error(t(key, params, FALLBACK));
    error.code = code;
    error.key = key;
    error.params = params || {};
    return error;
  }

  function errorBody(err, lang) {
    if (err && err.key) {
      return { error: t(err.key, err.params, lang), key: err.key, params: err.params || {} };
    }
    var params = { detail: err && err.message ? err.message : String(err) };
    return { error: t('server.error', params, lang), key: 'server.error', params: params };
  }

  api.t = t;
  api.tn = tn;
  api.locale = locale;
  api.SUPPORTED_LANGS = SUPPORTED;
  api.pickLang = pickLang;
  api.appError = appError;
  api.errorBody = errorBody;
})(globalThis);
