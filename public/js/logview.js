(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var GROUPS = [
    { group: 'info', label: 'Info', tag: 'INFO' },
    { group: 'warn', label: 'Avvisi', tag: 'WARN' },
    { group: 'error', label: 'Errori', tag: 'ERR' },
    { group: 'debug', label: 'Debug', tag: 'DBG' },
  ];
  var STATUS_PILL = { starting: 'IN AVVIO', running: 'ATTIVO', stopped: 'FERMATO', exited: 'TERMINATO' };
  var OVERSCAN = 30;
  var BOTTOM_SLACK = 4;
  var PLACEHOLDERS = 6;

  function chipGroups(counts) {
    var source = counts || {};
    return GROUPS.filter(function (item) {
      return source[item.group] > 0;
    }).map(function (item) {
      return { group: item.group, label: item.label, count: source[item.group] };
    });
  }

  function tagFor(level) {
    var group = api.levelGroup(level);
    for (var i = 0; i < GROUPS.length; i += 1) {
      if (GROUPS[i].group === group) return GROUPS[i].tag;
    }
    return String(level || '').toUpperCase().slice(0, 4);
  }

  function highlightParts(text, q) {
    var source = String(text == null ? '' : text);
    var needle = String(q || '').toLowerCase();
    if (!needle) return [{ text: source, mark: false }];
    var lower = source.toLowerCase();
    var parts = [];
    var from = 0;
    var at = lower.indexOf(needle);
    while (at >= 0) {
      if (at > from) parts.push({ text: source.slice(from, at), mark: false });
      parts.push({ text: source.slice(at, at + needle.length), mark: true });
      from = at + needle.length;
      at = lower.indexOf(needle, from);
    }
    if (from < source.length) parts.push({ text: source.slice(from), mark: false });
    return parts.length ? parts : [{ text: source, mark: false }];
  }

  function relativeTime(iso, nowMs) {
    var then = Date.parse(iso);
    if (!Number.isFinite(then)) return '';
    var seconds = Math.max(0, Math.floor(((nowMs == null ? Date.now() : nowMs) - then) / 1000));
    if (seconds < 60) return 'adesso';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes === 1 ? '1 minuto fa' : minutes + ' minuti fa';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours === 1 ? '1 ora fa' : hours + ' ore fa';
    var days = Math.floor(hours / 24);
    return days === 1 ? '1 giorno fa' : days + ' giorni fa';
  }

  function clock(timestamp) {
    if (!timestamp) return '—';
    var match = /T(\d{2}:\d{2}:\d{2})/.exec(timestamp);
    return match ? match[1] : timestamp;
  }

  function hostOf(origin) {
    try {
      return new URL(origin).host;
    } catch (err) {
      return String(origin || '');
    }
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SPARK_W = 150;
  var SPARK_H = 24;

  function formatCount(n) {
    return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('it-IT') : '—';
  }

  // Right-aligned on one slot per sample, so a fresh tunnel grows from the right edge.
  function sparkPoints(history, width, height, max) {
    var list = history || [];
    if (!list.length) return '';
    var top = max || api.INFLIGHT_LIMIT || 200;
    var slot = width / SPARK_W;
    var round = function (n) { return Math.round(n * 100) / 100; };
    return list.slice(-SPARK_W).map(function (value, i, kept) {
      var x = (SPARK_W - kept.length + i) * slot;
      var y = height - Math.max(Math.min(value || 0, top) / top * height, 1);
      return round(x) + ',' + round(y);
    }).join(' ');
  }

  function buildSpark() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + SPARK_W + ' ' + SPARK_H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    var line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('id', 'traffic-line');
    line.setAttribute('fill', 'none');
    svg.append(line);
    return svg;
  }

  // Scrolling up always leaves follow mode; reaching the bottom re-enters it.
  function followAfterScroll(pos) {
    if (pos.top < pos.lastTop) return false;
    if (pos.scrollHeight - pos.top - pos.clientHeight <= BOTTOM_SLACK) return true;
    return pos.top === pos.lastTop ? pos.follow : false;
  }

  function buildMain(vm) {
    var h = api.h;
    var can = function (action) { return vm.actions.indexOf(action) >= 0; };
    return h('section', { id: 'tunnel-view', className: 'tunnel-view', hidden: true }, [
      h('header', { className: 'tunnel-head' }, [
        h('div', { className: 'head-main' }, [
          h('div', { className: 'head-title' }, [
            h('span', { id: 'tunnel-status', className: 'pill' }),
            h('a', { id: 'tunnel-url', className: 'tunnel-url', target: '_blank', rel: 'noopener' }),
          ]),
          h('div', { className: 'head-sub' }, [
            h('span', { id: 'tunnel-sub' }),
            h('code', { id: 'tunnel-cmd', className: 'head-cmd' }),
            h('button', { type: 'button', className: 'link-btn', title: 'Copia comando', 'aria-label': 'Copia comando', text: '⧉', dataset: { action: 'copy-cmd' } }),
          ]),
          h('div', { id: 'tunnel-badges', className: 'head-badges' }),
          h('div', { id: 'tunnel-traffic', className: 'head-traffic mono', hidden: true }, [
            h('span', { id: 'traffic-inflight' }),
            h('span', { id: 'traffic-spark', className: 'spark' }, [buildSpark()]),
            h('span', { id: 'traffic-total' }),
            h('span', { id: 'traffic-errors' }),
            h('span', { id: 'traffic-conn' }),
            h('span', { id: 'traffic-stale', className: 'stale', hidden: true, text: 'dati non aggiornati' }),
          ]),
        ]),
        h('div', { className: 'head-actions' }, [
          h('button', { type: 'button', className: 'btn inv', 'aria-label': 'Copia URL', dataset: { action: 'copy-url' } }, [
            h('span', { className: 'ico', 'aria-hidden': 'true', text: '⧉' }),
            h('span', { className: 'lbl', text: 'Copia URL' }),
          ]),
          h('a', { id: 'open-url', className: 'btn', target: '_blank', rel: 'noopener', 'aria-label': 'Apri URL', dataset: { action: 'open' } }, [
            h('span', { className: 'lbl', text: 'Apri' }),
            h('span', { className: 'ico', 'aria-hidden': 'true', text: '↗' }),
          ]),
          can('stop') ? h('button', { type: 'button', className: 'btn', 'aria-label': 'Ferma', dataset: { action: 'stop' } }, [
            h('span', { className: 'ico', 'aria-hidden': 'true', text: '■' }),
            h('span', { className: 'lbl', text: 'Ferma' }),
          ]) : null,
          h('button', { type: 'button', className: 'btn', 'aria-label': 'Riavvia', dataset: { action: 'restart' } }, [
            h('span', { className: 'ico', 'aria-hidden': 'true', text: '↻' }),
            h('span', { className: 'lbl', text: 'Riavvia' }),
          ]),
          can('remove') ? h('button', { type: 'button', className: 'btn danger', 'aria-label': 'Rimuovi', dataset: { action: 'remove' } }, [
            h('span', { className: 'ico', 'aria-hidden': 'true', text: '✕' }),
            h('span', { className: 'lbl', text: 'Rimuovi' }),
          ]) : null,
        ]),
      ]),
      h('div', { id: 'tunnel-warnings', className: 'tunnel-warnings', role: 'status' }),
      h('div', { className: 'log-toolbar' }, [
        h('div', { id: 'level-chips', className: 'chips', role: 'group', 'aria-label': 'Livelli' }),
        h('span', { id: 'log-count', className: 'log-count' }),
        h('label', { className: 'search' }, [
          h('span', { className: 'search-ico', 'aria-hidden': 'true', text: '⌕' }),
          h('input', {
            id: 'log-search',
            type: 'search',
            placeholder: 'Cerca nei log',
            'aria-label': 'Cerca nei log',
            autocomplete: 'off',
            spellcheck: 'false',
          }),
          h('kbd', { className: 'search-kbd', text: '/' }),
        ]),
      ]),
      h('div', { className: 'log-body' }, [
        h('div', { className: 'log-pane' }, [
          h('div', { id: 'log-scroller', className: 'log-scroller', tabindex: '0', 'aria-label': 'Righe di log' }, [
            h('div', { id: 'log-spacer', className: 'log-spacer' }, [
              h('ol', { id: 'log-rows', className: 'log-rows mono', role: 'listbox', 'aria-label': 'Log' }),
            ]),
            h('p', { id: 'log-empty', className: 'log-empty', hidden: true }),
          ]),
          h('button', { type: 'button', id: 'new-rows', className: 'new-rows', hidden: true, dataset: { action: 'tail' } }),
        ]),
        h('aside', { id: 'log-detail', className: 'detail', hidden: true, 'aria-label': 'Dettaglio riga' }),
      ]),
    ]);
  }

  function buildDetail(entry) {
    var h = api.h;
    var field = function (label, node) {
      return h('div', { className: 'field' }, [h('p', { className: 'k', text: label }), node]);
    };
    return [
      h('div', { className: 'detail-head' }, [
        h('h2', { text: 'Riga #' + entry.index }),
        h('button', { type: 'button', className: 'link-btn', 'aria-label': 'Chiudi dettaglio', text: '✕', dataset: { action: 'close-detail' } }),
      ]),
      h('div', { className: 'detail-meta' }, [
        field('Livello', h('span', { className: 'lv mono l-' + api.levelGroup(entry.level), text: tagFor(entry.level) })),
        field('Ora', h('p', { className: 'v mono', text: entry.timestamp || 'nessun timestamp' })),
      ]),
      entry.url ? field('URL', h('p', { className: 'v mono', text: entry.url })) : null,
      field('Messaggio', h('pre', { className: 'message', text: entry.message })),
      field('Riga originale', h('pre', { className: 'raw', text: entry.raw })),
      h('div', null, [h('button', { type: 'button', className: 'btn', text: 'Copia riga', dataset: { action: 'copy-row' } })]),
    ].filter(Boolean);
  }

  function el(id) {
    return document.getElementById(id);
  }

  function paintBadges(summary) {
    var box = el('tunnel-badges');
    if (!box) return;
    var h = api.h;
    var options = summary.options || {};
    var mails = options.allowedMail || [];
    var badges = [];
    if (mails.length) {
      badges.push(h('span', { className: 'badge-protected', title: mails.join(', '), text: '🔒 Protetto · solo: ' + mails.join(', ') + ' — chi visita deve fare l\'accesso' }));
    }
    if (options.noTlsVerify) {
      badges.push(h('span', { className: 'badge-tls', text: '⚠ Certificato dell\'origine non verificato' }));
    }
    var sig = JSON.stringify([mails, !!options.noTlsVerify]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.replaceChildren.apply(box, badges);
  }

  function paintTraffic(summary) {
    var strip = el('tunnel-traffic');
    if (!strip) return;
    var traffic = summary.traffic;
    strip.hidden = !traffic;
    if (!traffic) return;
    var live = !!summary.active;
    var stale = live && traffic.ok === false;
    strip.className = 'head-traffic mono' + (stale ? ' is-stale' : '');
    var set = function (id, text, hidden) {
      var node = el(id);
      if (!node) return;
      if (text != null) node.textContent = text;
      node.hidden = !!hidden;
    };
    var limit = api.INFLIGHT_LIMIT || 200;
    set('traffic-inflight', 'in corso ' + formatCount(traffic.inflight) + '/' + limit, !live);
    set('traffic-spark', null, !live);
    set('traffic-total', 'richieste ' + formatCount(traffic.total));
    set('traffic-errors', 'errori ' + formatCount(traffic.errors));
    set('traffic-conn', 'connessioni ' + formatCount(traffic.connections), !live);
    set('traffic-stale', null, !stale);
    var line = el('traffic-line');
    if (line && live) line.setAttribute('points', sparkPoints(traffic.history, SPARK_W, SPARK_H));
  }

  // Rebuilt only when the list changes, so a button armed for confirmation survives polling.
  function paintWarnings(summary, nowMs) {
    var box = el('tunnel-warnings');
    if (!box) return;
    var list = api.warningsFor(summary, nowMs);
    var sig = JSON.stringify([summary.id, list.map(function (w) { return [w.id, w.text]; })]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    var h = api.h;
    box.replaceChildren.apply(box, list.map(function (warning) {
      return h('div', { className: 'warning k-' + warning.kind }, [
        h('span', { className: 'warning-text', text: warning.text }),
        warning.actions.indexOf('restart') >= 0
          ? h('button', { type: 'button', className: 'btn', text: 'Riavvia', dataset: { action: 'force-restart' } })
          : null,
        warning.actions.indexOf('hello') >= 0
          ? h('button', { type: 'button', className: 'btn', text: 'Prova con Hello World', dataset: { action: 'hello' } })
          : null,
      ]);
    }));
  }

  function paintTunnelExtras(summary, nowMs) {
    if (!summary) return;
    paintBadges(summary);
    paintTraffic(summary);
    paintWarnings(summary, nowMs == null ? Date.now() : nowMs);
  }

  function createLogView() {
    var h = api.h;
    var ROW_H = api.ROW_H;
    var session = null;
    var levels = [];
    var q = '';
    var follow = true;
    var newRows = 0;
    var lastCount = -1;
    var selectedIndex = null;
    var selectedPos = null;
    var detail = null;
    var frame = 0;
    var lastScrollTop = 0;
    var chipsPainted = { host: null, sig: null };
    var cache = api.createPageCache(function (key, page) {
      var id = key.split('|')[0];
      var params = 'offset=' + page * api.LOG_WINDOW_CAP + '&limit=' + api.LOG_WINDOW_CAP;
      if (levels.length) params += '&levels=' + encodeURIComponent(levels.join(','));
      if (q) params += '&q=' + encodeURIComponent(q);
      return fetch('/api/sessions/' + encodeURIComponent(id) + '/logs?' + params).then(function (response) {
        if (!response.ok) throw new Error(api.t('client.logsUnavailable'));
        return response.json();
      });
    });

    function filterActive() {
      return levels.length > 0 || q !== '';
    }

    function cacheKey() {
      return session ? session.id + '|' + levels.join(',') + '|' + q : '';
    }

    function schedule() {
      if (frame) return;
      var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); };
      frame = raf(function () {
        frame = 0;
        render();
      });
    }

    function scrollToBottom() {
      var scroller = el('log-scroller');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }

    function messageNode(text) {
      var span = h('span', { className: 'msg' });
      highlightParts(text, q).forEach(function (part) {
        span.append(part.mark ? h('mark', { text: part.text }) : document.createTextNode(part.text));
      });
      return span;
    }

    function rowNode(entry, pos) {
      var selected = entry.index === selectedIndex;
      if (selected) selectedPos = pos;
      return h('li', {
        className: 'row' + (selected ? ' is-selected' : ''),
        role: 'option',
        'aria-selected': selected ? 'true' : 'false',
        title: entry.message,
        dataset: { index: String(entry.index), pos: String(pos) },
      }, [
        h('span', { className: 'ts', text: clock(entry.timestamp) }),
        h('span', { className: 'lv l-' + api.levelGroup(entry.level), text: tagFor(entry.level) }),
        messageNode(entry.message),
      ]);
    }

    function placeholder() {
      return h('li', { className: 'row ph', 'aria-hidden': 'true' }, [
        h('span', { className: 'ph-bar ph-ts' }),
        h('span', { className: 'ph-bar ph-lv' }),
        h('span', { className: 'ph-bar ph-msg' }),
      ]);
    }

    function paintEmpty(total) {
      var empty = el('log-empty');
      if (!empty) return;
      var waiting = session && session.status === 'starting' && total === 0 && !filterActive();
      if (total > 0) {
        empty.hidden = true;
      } else {
        empty.hidden = false;
        if (waiting) empty.textContent = 'In attesa dell’URL…';
        else if (filterActive()) empty.textContent = 'Nessuna riga corrisponde ai filtri.';
        else empty.textContent = 'Ancora nessuna riga.';
      }
      return waiting;
    }

    function render() {
      var scroller = el('log-scroller');
      var spacer = el('log-spacer');
      var list = el('log-rows');
      if (!scroller || !spacer || !list || !session) return;
      var total = cache.total;
      var waiting = paintEmpty(total);
      if (waiting) {
        spacer.style.height = PLACEHOLDERS * ROW_H + 'px';
        list.style.transform = 'translateY(0px)';
        var phs = [];
        for (var p = 0; p < PLACEHOLDERS; p += 1) phs.push(placeholder());
        list.replaceChildren.apply(list, phs);
        return;
      }
      spacer.style.height = total * ROW_H + 'px';
      if (follow) scroller.scrollTop = scroller.scrollHeight;
      var range = api.visibleRange(scroller.scrollTop, scroller.clientHeight || 600, ROW_H, total, OVERSCAN);
      list.style.transform = 'translateY(' + range.start * ROW_H + 'px)';
      var nodes = [];
      for (var i = range.start; i < range.end; i += 1) {
        var entry = cache.entryAt(i);
        nodes.push(entry ? rowNode(entry, i) : placeholder());
      }
      list.replaceChildren.apply(list, nodes);
      var missing = api.pagesFor(range, api.LOG_WINDOW_CAP).filter(function (page) { return !cache.has(page); });
      if (missing.length) cache.ensure(missing).then(schedule, function () {});
      paintNewRows();
    }

    function paintNewRows() {
      var button = el('new-rows');
      if (!button) return;
      button.hidden = follow || newRows <= 0;
      button.textContent = newRows === 1 ? '↓ 1 nuova riga' : '↓ ' + newRows + ' nuove righe';
    }

    function paintChips() {
      var host = el('level-chips');
      if (!host || !session) return;
      var count = el('log-count');
      if (count) count.textContent = filterActive() ? cache.total + ' di ' + session.entryCount + ' righe' : '';
      var sig = JSON.stringify([session.entryCount, session.counts, levels]);
      if (chipsPainted.host === host && chipsPainted.sig === sig) return;
      chipsPainted.host = host;
      chipsPainted.sig = sig;
      var chip = function (group, text, on) {
        return h('button', {
          type: 'button',
          className: 'chip' + (on ? ' is-on' : ''),
          'aria-pressed': on ? 'true' : 'false',
          text: text,
          dataset: { action: 'chip', group: group },
        });
      };
      var chips = [chip('', 'Tutti · ' + session.entryCount, levels.length === 0)];
      chipGroups(session.counts).forEach(function (item) {
        var text = item.group === 'info' ? item.label : item.label + ' · ' + item.count;
        chips.push(chip(item.group, text, levels.indexOf(item.group) >= 0));
      });
      levels.forEach(function (group) {
        if (!session.counts || !session.counts[group]) chips.push(chip(group, GROUPS.filter(function (g) { return g.group === group; })[0].label + ' · 0', true));
      });
      host.replaceChildren.apply(host, chips);
    }

    function paintHeader() {
      if (!session) return;
      var status = el('tunnel-status');
      if (status) {
        status.textContent = STATUS_PILL[session.status] || session.status;
        status.className = 'pill st-' + session.status;
      }
      var url = el('tunnel-url');
      if (url) {
        if (session.url) {
          url.textContent = session.url.replace(/^https?:\/\//, '');
          url.setAttribute('href', session.url);
          url.className = 'tunnel-url';
        } else {
          url.textContent = api.statusText(session);
          url.removeAttribute('href');
          url.className = 'tunnel-url is-pending';
        }
      }
      var sub = el('tunnel-sub');
      if (sub) {
        var when = session.active
          ? 'avviato ' + relativeTime(session.startedAt)
          : 'fermato ' + relativeTime(session.stoppedAt || session.startedAt);
        sub.textContent = (session.mode === 'hello' ? 'Hello World' : hostOf(session.origin)) + ' · ' + when;
      }
      var cmd = el('tunnel-cmd');
      if (cmd) {
        cmd.textContent = session.equivalent;
        cmd.title = session.equivalent;
      }
      var open = el('open-url');
      if (open) {
        if (session.url) {
          open.setAttribute('href', session.url);
          open.removeAttribute('aria-disabled');
        } else {
          open.removeAttribute('href');
          open.setAttribute('aria-disabled', 'true');
        }
      }
      var copy = document.querySelector('[data-action="copy-url"]');
      if (copy) copy.disabled = !session.url;
      var stop = document.querySelector('[data-action="stop"]');
      var restart = document.querySelector('[data-action="restart"]');
      if (stop) stop.hidden = !session.active;
      if (restart) restart.hidden = !!session.active;
      paintTunnelExtras(session);
    }

    function paintDetail() {
      var pane = el('log-detail');
      if (!pane) return;
      if (!detail) {
        pane.hidden = true;
        pane.replaceChildren();
        return;
      }
      pane.hidden = false;
      pane.replaceChildren.apply(pane, buildDetail(detail));
    }

    function reload() {
      cache.reset(cacheKey());
      newRows = 0;
      selectedPos = null;
      var scroller = el('log-scroller');
      if (scroller && !follow) scroller.scrollTop = 0;
      return cache.refreshTail().then(function () {
        paintChips();
        if (follow) scrollToBottom();
        render();
      }, function () {});
    }

    function update(summary) {
      if (!summary) {
        session = null;
        return;
      }
      var changed = !session || session.id !== summary.id;
      var restarted = session && !changed && summary.restarts !== session.restarts;
      session = summary;
      paintHeader();
      if (changed) {
        levels = [];
        q = '';
        var search = el('log-search');
        if (search) search.value = '';
        follow = true;
        selectedIndex = null;
        detail = null;
        paintDetail();
        lastCount = summary.entryCount;
        paintChips();
        reload();
        return;
      }
      if (restarted) follow = true;
      paintChips();
      if (summary.entryCount !== lastCount) {
        lastCount = summary.entryCount;
        var before = cache.total;
        cache.refreshTail().then(function (applied) {
          if (!applied) return;
          var added = Math.max(0, cache.total - before);
          if (!follow) newRows += added;
          paintChips();
          render();
        }, function () {});
      } else if (session.status === 'starting') {
        render();
      }
    }

    function setFilter(next) {
      if (next.levels) levels = next.levels.slice();
      if (next.q != null) q = String(next.q).trim();
      paintChips();
      if (session) reload();
    }

    function toggleLevel(group) {
      if (!group) {
        setFilter({ levels: [] });
        return;
      }
      var at = levels.indexOf(group);
      var next = levels.slice();
      if (at >= 0) next.splice(at, 1);
      else next.push(group);
      setFilter({ levels: next });
    }

    function select(index, pos) {
      if (!session) return;
      follow = false;
      selectedIndex = index;
      selectedPos = pos;
      detail = pos != null ? cache.entryAt(pos) || detail : detail;
      paintDetail();
      render();
      var id = session.id;
      fetch('/api/sessions/' + encodeURIComponent(id) + '/entries/' + index).then(function (response) {
        return response.ok ? response.json() : null;
      }).then(function (data) {
        if (!data || selectedIndex !== index || !session || session.id !== id) return;
        detail = data.detail;
        paintDetail();
      }, function () {});
    }

    function revealPos(pos) {
      var scroller = el('log-scroller');
      if (!scroller) return;
      var top = pos * ROW_H;
      var height = scroller.clientHeight || 0;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (top + ROW_H > scroller.scrollTop + height) scroller.scrollTop = top + ROW_H - height;
    }

    function move(delta) {
      var total = cache.total;
      if (!total) return;
      var start = selectedPos == null ? (delta > 0 ? -1 : total) : selectedPos;
      var pos = Math.max(0, Math.min(total - 1, start + delta));
      var page = Math.floor(pos / api.LOG_WINDOW_CAP);
      cache.ensure([page]).then(function () {
        var entry = cache.entryAt(pos);
        if (!entry) return;
        revealPos(pos);
        select(entry.index, pos);
      }, function () {});
    }

    function closeDetail() {
      if (!detail && selectedIndex == null) return false;
      detail = null;
      selectedIndex = null;
      selectedPos = null;
      paintDetail();
      render();
      return true;
    }

    function onScroll() {
      var scroller = el('log-scroller');
      if (!scroller) return;
      follow = followAfterScroll({
        lastTop: lastScrollTop,
        top: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        follow: follow,
      });
      lastScrollTop = scroller.scrollTop;
      if (follow) newRows = 0;
      schedule();
    }

    function jumpToTail() {
      follow = true;
      newRows = 0;
      scrollToBottom();
      schedule();
    }

    return {
      update: update,
      setFilter: setFilter,
      toggleLevel: toggleLevel,
      select: select,
      move: move,
      closeDetail: closeDetail,
      onScroll: onScroll,
      jumpToTail: jumpToTail,
      render: schedule,
      detail: function () { return detail; },
      session: function () { return session; },
    };
  }

  api.formatCount = formatCount;
  api.sparkPoints = sparkPoints;
  api.paintTunnelExtras = paintTunnelExtras;
  api.chipGroups = chipGroups;
  api.highlightParts = highlightParts;
  api.relativeTime = relativeTime;
  api.buildMain = buildMain;
  api.buildDetail = buildDetail;
  api.followAfterScroll = followAfterScroll;
  api.createLogView = createLogView;
})(globalThis);
