(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var TRAFFIC_KEEP = 150;
  // A chatty or stuck cloudflared must not fill the memory: past MAX_ENTRIES the
  // oldest LOG_DROP lines go. `index` keeps counting, so a line keeps its number.
  var MAX_ENTRIES = 20000;
  var LOG_DROP = 5000;

  function now() {
    return new Date().toISOString();
  }

  function trim(session) {
    var gone = session.entries.splice(0, LOG_DROP);
    for (var i = 0; i < gone.length; i += 1) {
      var group = api.levelGroup(gone[i].level);
      if (session.counts[group]) session.counts[group] -= 1;
    }
    session.droppedEntries += gone.length;
  }

  function push(session, fields) {
    if (session.entries.length >= MAX_ENTRIES) trim(session);
    var stored = {
      index: session.droppedEntries + session.entries.length,
      level: fields.level,
      message: fields.message,
      timestamp: fields.timestamp,
      url: fields.url,
      raw: fields.raw,
    };
    session.entries.push(stored);
    var group = api.levelGroup(stored.level);
    session.counts[group] = (session.counts[group] || 0) + 1;
    return stored;
  }

  function synthetic(session, level, message) {
    return push(session, { level: level, message: message, timestamp: now(), url: null, raw: message });
  }

  function expiry(session) {
    var minutes = session.options && session.options.expiresIn;
    return minutes ? new Date(Date.parse(session.startedAt) + minutes * 60000).toISOString() : null;
  }

  function createSessionStore() {
    var seq = 1;
    var sessions = new Map();

    function requireSession(id) {
      var session = sessions.get(id);
      if (!session) {
        throw api.appError('NOT_FOUND', 'session.notFound');
      }
      return session;
    }

    return {
      create: function (origin, options) {
        var invocation = api.buildQuickTunnelCommand(origin, options);
        var session = {
          id: 's' + seq,
          origin: invocation.origin,
          mode: invocation.mode,
          options: invocation.options,
          invocation: invocation,
          metricsUrl: null,
          traffic: null,
          lastOriginError: null,
          status: 'starting',
          active: true,
          exitCode: null,
          startedAt: now(),
          stoppedAt: null,
          restarts: 0,
          counts: {},
          entries: [],
          droppedEntries: 0,
          url: null,
          selected: null,
          expiresAt: null,
          expired: false,
        };
        session.expiresAt = expiry(session);
        seq += 1;
        sessions.set(session.id, session);
        return session;
      },
      appendChunk: function (id, text) {
        var session = requireSession(id);
        var parsed = api.parseLogStream(text);
        for (var i = 0; i < parsed.length; i += 1) {
          var entry = parsed[i];
          push(session, {
            level: entry.level,
            message: entry.message,
            timestamp: entry.timestamp,
            url: entry.url,
            raw: entry.raw,
          });
          if (entry.metricsAddr && !session.metricsUrl) session.metricsUrl = 'http://' + entry.metricsAddr + '/metrics';
          if (entry.originError) session.lastOriginError = { at: now(), message: entry.message };
          if (entry.url && !session.url) {
            session.url = entry.url;
            if (session.status === 'starting') session.status = 'running';
          }
        }
        return session;
      },
      select: function (id, index) {
        var session = requireSession(id);
        var entry = session.entries[index - session.droppedEntries];
        if (!entry) {
          throw api.appError('NOT_FOUND', 'entry.notFound');
        }
        session.selected = index;
        return entry;
      },
      detail: function (id) {
        var session = requireSession(id);
        if (session.selected == null) return null;
        return session.entries[session.selected - session.droppedEntries] || null;
      },
      stop: function (id) {
        var session = requireSession(id);
        session.status = 'stopped';
        session.active = false;
        session.stoppedAt = now();
        return session;
      },
      // Active tunnels whose time is up; the caller stops their process and calls expire().
      dueToExpire: function (nowMs) {
        return Array.from(sessions.values()).filter(function (session) {
          return session.active && session.expiresAt && Date.parse(session.expiresAt) <= nowMs;
        });
      },
      expire: function (id) {
        var session = requireSession(id);
        if (!session.active) return session;
        session.status = 'stopped';
        session.active = false;
        session.stoppedAt = now();
        session.expired = true;
        synthetic(session, 'info', 'tunnel expired after ' + session.options.expiresIn + ' min');
        return session;
      },
      markExited: function (id, code) {
        var session = requireSession(id);
        if (!session.active) return session;
        session.status = 'exited';
        session.active = false;
        session.exitCode = code == null ? null : code;
        session.stoppedAt = now();
        var label = code == null ? '?' : String(code);
        synthetic(session, code === 0 ? 'info' : 'error', 'cloudflared exited (code ' + label + ')');
        return session;
      },
      // Points cloudflared at the inspector's proxy; kept across restarts.
      setTarget: function (id, target) {
        var session = requireSession(id);
        session.invocation = api.buildQuickTunnelCommand(session.origin, session.options, target);
        return session;
      },
      // The inspector's proxy answers 502 itself, so cloudflared never logs these.
      recordOriginError: function (id, message) {
        var session = requireSession(id);
        session.lastOriginError = { at: now(), message: message };
        synthetic(session, 'error', message);
        return session;
      },
      restart: function (id) {
        var session = requireSession(id);
        if (session.active) {
          throw api.appError('CONFLICT', 'session.alreadyActive');
        }
        session.invocation = api.buildQuickTunnelCommand(session.origin, session.options, session.invocation.target);
        session.metricsUrl = null;
        session.traffic = null;
        session.lastOriginError = null;
        session.status = 'starting';
        session.active = true;
        session.url = null;
        session.exitCode = null;
        session.stoppedAt = null;
        session.startedAt = now();
        session.expiresAt = expiry(session);
        session.expired = false;
        session.restarts += 1;
        synthetic(session, 'info', '— restart #' + session.restarts + ' —');
        return session;
      },
      recordTraffic: function (id, sample) {
        var session = requireSession(id);
        var history = session.traffic ? session.traffic.history.slice() : [];
        history.push(sample.inflight == null ? 0 : sample.inflight);
        if (history.length > TRAFFIC_KEEP) history = history.slice(history.length - TRAFFIC_KEEP);
        session.traffic = {
          inflight: sample.inflight,
          total: sample.total,
          errors: sample.errors,
          connections: sample.connections,
          updatedAt: now(),
          history: history,
          ok: true,
        };
        return session;
      },
      markTrafficStale: function (id) {
        var session = requireSession(id);
        if (session.traffic) session.traffic.ok = false;
        return session;
      },
      remove: function (id) {
        var session = requireSession(id);
        session.status = 'removed';
        session.active = false;
        sessions.delete(id);
        return session;
      },
      list: function () {
        return Array.from(sessions.values());
      },
      listActive: function () {
        return Array.from(sessions.values()).filter(function (session) {
          return session.active;
        });
      },
      get: function (id) {
        return sessions.get(id) || null;
      },
    };
  }

  api.TRAFFIC_KEEP = TRAFFIC_KEEP;
  api.MAX_ENTRIES = MAX_ENTRIES;
  api.LOG_DROP = LOG_DROP;
  api.createSessionStore = createSessionStore;
})(globalThis);
