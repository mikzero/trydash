(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var KEY = 'trydash.recentMail';
  var MAX = 8;

  function storageOf(storage) {
    if (storage) return storage;
    try {
      return root.localStorage || null;
    } catch (err) {
      return null;
    }
  }

  function readRecentMail(storage) {
    try {
      var store = storageOf(storage);
      var parsed = JSON.parse(store ? store.getItem(KEY) || '[]' : '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (item) { return api.isMailEntry(item); }).slice(0, MAX);
    } catch (err) {
      return [];
    }
  }

  // Most recent first: the newest list leads, older entries follow without duplicates.
  function rememberMail(list, storage) {
    var next = [];
    (list || []).concat(readRecentMail(storage)).forEach(function (item) {
      if (api.isMailEntry(item) && next.indexOf(item) < 0) next.push(item);
    });
    next = next.slice(0, MAX);
    try {
      var store = storageOf(storage);
      if (store) store.setItem(KEY, JSON.stringify(next));
    } catch (err) {
      /* storage unavailable: suggestions just stay empty */
    }
    return next;
  }

  api.readRecentMail = readRecentMail;
  api.rememberMail = rememberMail;
})(globalThis);
