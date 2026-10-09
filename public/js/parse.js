(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});

  var LEVELS = {
    TRC: 'trace',
    TRACE: 'trace',
    DBG: 'debug',
    DEBUG: 'debug',
    INF: 'info',
    INFO: 'info',
    WRN: 'warn',
    WARN: 'warn',
    WARNING: 'warn',
    ERR: 'error',
    ERROR: 'error',
    FTL: 'fatal',
    FATAL: 'fatal',
    PANIC: 'fatal',
  };

  var TS = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})';
  var LEVEL_TOKEN = 'TRC|DBG|INF|WRN|ERR|FTL|TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC';
  var TEXT_RE = new RegExp('^(?:(' + TS + ')\\s+)?(' + LEVEL_TOKEN + ')\\s*(.*)$');
  // The api. host appears in cloudflared's own request errors; it is never a tunnel.
  var URL_RE = /https:\/\/(?!api\.)[A-Za-z0-9-]+\.trycloudflare\.com/i;
  // Only a loopback address from cloudflared's own message is trusted.
  var METRICS_RE = /^Starting metrics server on (127\.0\.0\.1:\d{1,5})\/metrics$/i;
  // In JSON logs this text sits in the "error" field, so it is matched on the raw line.
  var ORIGIN_ERROR_RE = /unable to reach the origin service/i;

  function normalizeLevel(level) {
    if (typeof level !== 'string') return null;
    var key = level.trim().toUpperCase();
    if (!key) return null;
    return LEVELS[key] || level.trim().toLowerCase();
  }

  function findUrl(text) {
    if (typeof text !== 'string' || !text) return null;
    var match = URL_RE.exec(text);
    URL_RE.lastIndex = 0;
    return match ? match[0] : null;
  }

  function timestampFrom(value) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    return null;
  }

  function parseLogLine(line) {
    var raw = String(line).replace(/\r$/, '').trim();
    if (!raw) return null;

    var level = 'info';
    var message = raw;
    var timestamp = null;
    var parsedJson = false;

    if (raw.charAt(0) === '{') {
      try {
        var obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          var hasField = 'message' in obj || 'msg' in obj || 'level' in obj || 'time' in obj || 'timestamp' in obj || 'ts' in obj;
          if (hasField) {
            parsedJson = true;
            level = normalizeLevel(obj.level) || 'info';
            if (typeof obj.message === 'string') message = obj.message;
            else if (typeof obj.msg === 'string') message = obj.msg;
            else message = raw;
            timestamp = timestampFrom(obj.time != null ? obj.time : (obj.timestamp != null ? obj.timestamp : obj.ts));
          }
        }
      } catch (err) {
        parsedJson = false;
      }
    }

    if (!parsedJson) {
      var match = TEXT_RE.exec(raw);
      if (match) {
        timestamp = match[1] || null;
        level = normalizeLevel(match[2]) || 'info';
        message = (match[3] || '').trim();
      }
    }

    var metrics = METRICS_RE.exec(message);
    return {
      level: level,
      message: message,
      timestamp: timestamp,
      url: findUrl(message) || findUrl(raw),
      raw: raw,
      metricsAddr: metrics ? metrics[1] : null,
      originError: ORIGIN_ERROR_RE.test(raw),
    };
  }

  function parseLogStream(text) {
    var lines = String(text == null ? '' : text).split(/\n/);
    var entries = [];
    for (var i = 0; i < lines.length; i += 1) {
      var entry = parseLogLine(lines[i]);
      if (!entry) continue;
      entry.index = entries.length;
      entries.push(entry);
    }
    return entries;
  }

  api.parseLogLine = parseLogLine;
  api.parseLogStream = parseLogStream;
  api.findTrycloudflareUrl = findUrl;
})(globalThis);
