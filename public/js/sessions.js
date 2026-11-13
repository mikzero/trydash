(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var TRAFFIC_KEEP = 150;
  // A chatty or stuck cloudflared must not fill the memory: past MAX_ENTRIES the
  // oldest LOG_DROP lines go. `index` keeps counting, so a line keeps its number.
  var MAX_ENTRIES = 20000;
  var MAX_LINKS = 50;
  var MAX_COMMENTS = 500;
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

    function linkName(value) {
      var name = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (!name || name.length > 60) throw api.appError('BAD_REQUEST', 'links.badName', { max: 60 });
      return name;
    }

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
          // Personal links for clients, and the key of the owner's own (set by the server).
          links: [],
          ownerKey: null,
          // What clients wrote on the pages, oldest first; the version moves on every change.
          comments: [],
          commentsVersion: 0,
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
          localRedirect: null,
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
      // The preview options live in trydash's proxy: they change on a running tunnel,
      // and the URL stays. Anything else needs a new tunnel.
      updatePreview: function (id, patch) {
        var session = requireSession(id);
        var next = Object.assign({}, session.options);
        ['rewrite', 'noindex', 'badge', 'blocked', 'queue', 'linksOnly', 'comments'].forEach(function (key) {
          if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
        });
        var normalized = api.normalizeTunnelOptions(next);
        if (normalized.inspect && !session.options.inspect) throw api.appError('CONFLICT', 'options.needsInspector');
        session.options = normalized;
        session.invocation = api.buildQuickTunnelCommand(session.origin, normalized, session.invocation.target);
        if (normalized.rewrite) session.localRedirect = null;
        return session;
      },
      // The origin sent visitors to its local address (see the inspector): worth a banner.
      // `kind`: redirect (a Location to localhost), links (local URLs in a page) or host (Vite's host check).
      recordLocalRedirect: function (id, location, kind) {
        var session = requireSession(id);
        session.localRedirect = { at: now(), location: String(location).slice(0, 300), kind: kind || 'redirect' };
        return session;
      },
      // Points cloudflared at the inspector's proxy; kept across restarts.
      setTarget: function (id, target) {
        var session = requireSession(id);
        session.invocation = api.buildQuickTunnelCommand(session.origin, session.options, target);
        return session;
      },
      // ---- Personal links -------------------------------------------------------
      setOwnerKey: function (id, key) {
        requireSession(id).ownerKey = String(key);
      },
      // `link`: { id, name, key, pinHash }, made by the server (it has the random bytes).
      addLink: function (id, link) {
        var session = requireSession(id);
        var name = linkName(link.name);
        if (session.links.length >= MAX_LINKS) throw api.appError('LIMIT', 'links.tooMany', { max: MAX_LINKS });
        var item = {
          id: String(link.id),
          name: name,
          key: String(link.key),
          pinHash: link.pinHash || null,
          createdAt: link.createdAt || now(),
          revoked: !!link.revoked,
          visits: Number(link.visits) || 0,
          firstSeen: link.firstSeen || null,
          lastSeen: link.lastSeen || null,
        };
        session.links.push(item);
        return item;
      },
      getLink: function (id, linkId) {
        var session = requireSession(id);
        for (var i = 0; i < session.links.length; i += 1) if (session.links[i].id === linkId) return session.links[i];
        throw api.appError('NOT_FOUND', 'links.notFound');
      },
      linkByKey: function (id, key) {
        var session = this.get(id);
        if (!session || !key) return null;
        for (var i = 0; i < session.links.length; i += 1) if (session.links[i].key === key) return session.links[i];
        return null;
      },
      updateLink: function (id, linkId, patch) {
        var link = this.getLink(id, linkId);
        if (patch.name != null) link.name = linkName(patch.name);
        if (patch.revoked != null) link.revoked = !!patch.revoked;
        if (Object.prototype.hasOwnProperty.call(patch, 'pinHash')) link.pinHash = patch.pinHash || null;
        return link;
      },
      removeLink: function (id, linkId) {
        var session = requireSession(id);
        this.getLink(id, linkId);
        session.links = session.links.filter(function (link) { return link.id !== linkId; });
      },
      // A page opened through the link: counted, with the first and the latest time.
      recordVisit: function (id, linkId) {
        var session = this.get(id);
        if (!session) return null;
        for (var i = 0; i < session.links.length; i += 1) {
          var link = session.links[i];
          if (link.id !== linkId) continue;
          link.visits += 1;
          link.lastSeen = now();
          if (!link.firstSeen) link.firstSeen = link.lastSeen;
          return link;
        }
        return null;
      },
      // ---- Comments from the pages ----------------------------------------------
      addComment: function (id, comment) {
        var session = requireSession(id);
        if (session.comments.length >= MAX_COMMENTS) {
          // Room is made from the oldest resolved ones; open ones are never dropped.
          var resolvedAt = -1;
          for (var i = 0; i < session.comments.length; i += 1) {
            if (session.comments[i].resolved) { resolvedAt = i; break; }
          }
          if (resolvedAt < 0) throw api.appError('LIMIT', 'comments.tooMany', { max: MAX_COMMENTS });
          session.comments.splice(resolvedAt, 1);
        }
        session.comments.push(comment);
        session.commentsVersion += 1;
        return comment;
      },
      getComment: function (id, commentId) {
        var session = requireSession(id);
        for (var i = 0; i < session.comments.length; i += 1) if (session.comments[i].id === commentId) return session.comments[i];
        throw api.appError('NOT_FOUND', 'comments.notFound');
      },
      setCommentResolved: function (id, commentId, resolved) {
        var comment = this.getComment(id, commentId);
        comment.resolved = !!resolved;
        comment.resolvedAt = resolved ? now() : null;
        requireSession(id).commentsVersion += 1;
        return comment;
      },
      // The client changed their own words.
      editComment: function (id, commentId, text) {
        var comment = this.getComment(id, commentId);
        comment.text = String(text);
        comment.editedAt = now();
        requireSession(id).commentsVersion += 1;
        return comment;
      },
      removeComment: function (id, commentId) {
        var session = requireSession(id);
        this.getComment(id, commentId);
        session.comments = session.comments.filter(function (c) { return c.id !== commentId; });
        session.commentsVersion += 1;
      },
      // The origin answered again: the "not responding" banner goes at once, not after a minute.
      recordOriginBack: function (id) {
        var session = requireSession(id);
        if (session.lastOriginError) session.lastOriginError = null;
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
  api.MAX_LINKS = MAX_LINKS;
  api.MAX_COMMENTS = MAX_COMMENTS;
  api.LOG_DROP = LOG_DROP;
  api.createSessionStore = createSessionStore;
})(globalThis);
