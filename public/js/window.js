(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var LOG_WINDOW_CAP = 200;
  var ROW_H = 28;

  function logWindow(entries, query) {
    var list = entries || [];
    var offset = query && Number(query.offset);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    offset = Math.trunc(offset);
    if (offset > list.length) offset = list.length;

    var limit = query && query.limit != null ? Number(query.limit) : LOG_WINDOW_CAP;
    if (!Number.isFinite(limit) || limit < 0) limit = LOG_WINDOW_CAP;
    limit = Math.trunc(limit);
    if (limit > LOG_WINDOW_CAP) limit = LOG_WINDOW_CAP;

    return {
      offset: offset,
      limit: limit,
      total: list.length,
      entries: list.slice(offset, offset + limit),
    };
  }

  function resolveWindowEntry(entries, offset) {
    var window = logWindow(entries, { offset: offset, limit: 1 });
    var entry = window.entries[0] || null;
    return { window: window, entry: entry, detail: entry };
  }

  function levelGroup(level) {
    if (level === 'error' || level === 'fatal') return 'error';
    if (level === 'debug' || level === 'trace') return 'debug';
    return level;
  }

  function filterEntries(entries, query) {
    var list = entries || [];
    var levels = query && query.levels && query.levels.length ? query.levels : null;
    var q = query && query.q ? String(query.q).toLowerCase() : '';
    if (!levels && !q) return list.slice();
    return list.filter(function (entry) {
      if (levels && levels.indexOf(levelGroup(entry.level)) < 0) return false;
      if (!q) return true;
      return String(entry.message).toLowerCase().indexOf(q) >= 0
        || String(entry.raw).toLowerCase().indexOf(q) >= 0;
    });
  }

  function visibleRange(scrollTop, viewportH, rowH, total, overscan) {
    var start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
    var end = Math.min(total, Math.ceil((scrollTop + viewportH) / rowH) + overscan);
    if (start > end) start = end;
    return { start: start, end: end };
  }

  function pagesFor(range, pageSize) {
    var pages = [];
    if (range.end <= range.start) return pages;
    var last = Math.floor((range.end - 1) / pageSize);
    for (var page = Math.floor(range.start / pageSize); page <= last; page += 1) pages.push(page);
    return pages;
  }

  // Pages of a (possibly filtered) log, keyed by session + filter.
  // A response for a key that has since been reset is dropped.
  function createPageCache(fetchPage) {
    var size = LOG_WINDOW_CAP;
    var pages = new Map();
    var inflight = new Map();
    var gen = 0;
    var seq = 0;
    var cache = { key: null, total: 0, pageSize: size };

    function load(page) {
      var key = cache.key;
      var myGen = gen;
      seq += 1;
      var mySeq = seq;
      var request = Promise.resolve(fetchPage(key, page)).then(function (data) {
        if (myGen !== gen || inflight.get(page) !== request) return false;
        inflight.delete(page);
        pages.set(page, (data && data.entries) || []);
        cache.total = data && Number.isFinite(data.total) ? data.total : cache.total;
        return true;
      }, function (err) {
        if (myGen === gen && inflight.get(page) === request) inflight.delete(page);
        throw err;
      });
      request.seq = mySeq;
      inflight.set(page, request);
      return request;
    }

    cache.reset = function (key) {
      cache.key = key;
      cache.total = 0;
      pages = new Map();
      inflight = new Map();
      gen += 1;
    };
    // A cached page is complete when it is full or reaches the known end of the log.
    function complete(page) {
      var rows = pages.get(page);
      if (!rows) return false;
      return rows.length >= size || page * size + rows.length >= cache.total;
    }

    cache.has = complete;
    cache.ensure = function (list) {
      return Promise.all(list.filter(function (page) {
        return !complete(page);
      }).map(function (page) {
        return inflight.get(page) || load(page);
      })).then(function () {});
    };
    cache.entryAt = function (index) {
      var page = pages.get(Math.floor(index / size));
      return page ? page[index % size] : undefined;
    };
    cache.refreshTail = function () {
      var last = Math.floor(Math.max(cache.total - 1, 0) / size);
      return load(last);
    };
    return cache;
  }

  api.LOG_WINDOW_CAP = LOG_WINDOW_CAP;
  api.ROW_H = ROW_H;
  api.levelGroup = levelGroup;
  api.filterEntries = filterEntries;
  api.visibleRange = visibleRange;
  api.pagesFor = pagesFor;
  api.createPageCache = createPageCache;
  api.logWindow = logWindow;
  api.resolveWindowEntry = resolveWindowEntry;
})(globalThis);
