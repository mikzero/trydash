(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var TRAFFIC_KEEP = 150;

  function now() {
    return new Date().toISOString();
  }

  function push(session, fields) {
    var stored = {
      index: session.entries.length,
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
          url: null,
          selected: null,
        };
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
        var entry = session.entries[index];
        if (!entry) {
          throw api.appError('NOT_FOUND', 'entry.notFound');
        }
        session.selected = index;
        return entry;
      },
      detail: function (id) {
        var session = requireSession(id);
        if (session.selected == null) return null;
        return session.entries[session.selected] || null;
      },
      stop: function (id) {
        var session = requireSession(id);
        session.status = 'stopped';
        session.active = false;
        session.stoppedAt = now();
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
        synthetic(session, code === 0 ? 'info' : 'error', 'cloudflared terminato (codice ' + label + ')');
        return session;
      },
      restart: function (id) {
        var session = requireSession(id);
        if (session.active) {
          throw api.appError('CONFLICT', 'session.alreadyActive');
        }
        session.invocation = api.buildQuickTunnelCommand(session.origin, session.options);
        session.metricsUrl = null;
        session.traffic = null;
        session.lastOriginError = null;
        session.status = 'starting';
        session.active = true;
        session.url = null;
        session.exitCode = null;
        session.stoppedAt = null;
        session.startedAt = now();
        session.restarts += 1;
        synthetic(session, 'info', '— riavvio #' + session.restarts + ' —');
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
  api.createSessionStore = createSessionStore;
})(globalThis);
