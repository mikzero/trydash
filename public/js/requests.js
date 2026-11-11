(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});

  var DISABLED = {
    hello: 'Il tunnel Hello World non passa dall’ispettore.',
    http2: 'L’ispettore non supporta un’origine HTTP/2: questo tunnel va dritto all’origine.',
    off: 'Ispettore spento per questo tunnel. Per usarlo, crea il tunnel con «Ispeziona richieste» attivo, in Opzioni origine.',
  };
  // Headers a copied curl leaves out: curl sets them itself, or Cloudflare added them.
  var CURL_SKIP = /^(host|content-length|connection|accept-encoding|transfer-encoding|cdn-loop|cf-[\w-]+)$/i;

  function formatBytes(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    if (n < 1000) return n + ' B';
    if (n < 1000 * 1000) return (n / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' kB';
    return (n / 1000 / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' MB';
  }

  function formatDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '…';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' s';
    return Math.floor(ms / 60000) + ' min';
  }

  // One class per row colour: 2xx, 3xx, 4xx, 5xx, still pending, or failed without a status.
  function statusGroup(row) {
    if (row.state === 'pending' && row.status == null) return 'pending';
    if (row.status == null) return 'error';
    var hundred = Math.floor(row.status / 100);
    if (hundred >= 1 && hundred <= 5) return hundred + 'xx';
    return 'error';
  }

  function isProblem(row) {
    return row.state === 'error' || row.state === 'aborted' || (row.status != null && row.status >= 400);
  }

  function statusLabel(row) {
    if (row.status != null) return String(row.status);
    if (row.state === 'pending') return '…';
    return row.state === 'aborted' ? 'ANN' : 'ERR';
  }

  function requestMatches(row, filter) {
    var options = filter || {};
    if (options.onlyProblems && !isProblem(row)) return false;
    var q = String(options.q || '').trim().toLowerCase();
    if (!q) return true;
    var text = (row.method + ' ' + row.path + ' ' + (row.status == null ? '' : row.status)).toLowerCase();
    return text.indexOf(q) >= 0;
  }

  function headerOf(list, name) {
    var wanted = name.toLowerCase();
    for (var i = 0; i < (list || []).length; i += 1) {
      if (String(list[i][0]).toLowerCase() === wanted) return list[i][1];
    }
    return '';
  }

  // The same request against the local origin, ready for a terminal.
  function curlFor(detail, base) {
    var word = api.shellWord;
    var url;
    try {
      var parsed = new URL(base);
      url = parsed.protocol + '//' + parsed.host + detail.path;
    } catch (err) {
      url = detail.path;
    }
    var first = 'curl';
    if (detail.method === 'HEAD') first += ' -I';
    else if (detail.method !== 'GET') first += ' -X ' + word(detail.method);
    var parts = [first];
    (detail.requestHeaders || []).forEach(function (pair) {
      if (CURL_SKIP.test(pair[0])) return;
      parts.push('-H ' + word(pair[0] + ': ' + pair[1]));
    });
    var body = detail.requestBody || {};
    var note = '';
    if (body.size > 0) {
      if (body.text != null && !body.truncated && !body.decoded) parts.push('--data-raw ' + word(body.text));
      else note = '# body non incluso: ' + (body.truncated ? 'troppo grande' : 'binario') + '\n';
    }
    parts.push(word(url));
    return note + parts.join(' \\\n  ');
  }

  function prettyText(view) {
    if (!view || view.text == null) return '';
    if (!view.truncated && /json/i.test(view.contentType || '')) {
      try {
        return JSON.stringify(JSON.parse(view.text), null, 2);
      } catch (err) {
        return view.text;
      }
    }
    return view.text;
  }

  function clock(iso) {
    var match = /T(\d{2}:\d{2}:\d{2})/.exec(iso || '');
    return match ? match[1] : '—';
  }

  function el(id) {
    return document.getElementById(id);
  }

  function buildRequestsPane() {
    var h = api.h;
    return h('div', { id: 'pane-requests', className: 'tab-pane', role: 'tabpanel', 'aria-labelledby': 'tab-requests', hidden: true }, [
      h('div', { className: 'log-toolbar' }, [
        h('div', { id: 'req-chips', className: 'chips', role: 'group', 'aria-label': 'Filtro richieste' }),
        h('span', { id: 'req-count', className: 'log-count' }),
        h('button', { type: 'button', id: 'req-clear', className: 'chip', text: 'Svuota', dataset: { action: 'clear-requests' } }),
        h('label', { className: 'search' }, [
          h('span', { className: 'search-ico', 'aria-hidden': 'true', text: '⌕' }),
          h('input', {
            id: 'req-search',
            type: 'search',
            placeholder: 'Filtra per percorso, metodo o stato',
            'aria-label': 'Filtra richieste',
            autocomplete: 'off',
            spellcheck: 'false',
          }),
          h('kbd', { className: 'search-kbd', text: '/' }),
        ]),
      ]),
      h('div', { className: 'log-body' }, [
        h('div', { className: 'log-pane' }, [
          h('div', { id: 'req-scroller', className: 'log-scroller', tabindex: '0', 'aria-label': 'Richieste' }, [
            h('ol', { id: 'req-rows', className: 'req-rows mono', role: 'listbox', 'aria-label': 'Richieste' }),
            h('p', { id: 'req-empty', className: 'req-empty', hidden: true }),
          ]),
        ]),
        h('aside', { id: 'req-detail', className: 'detail req-detail', hidden: true, 'aria-label': 'Dettaglio richiesta' }),
      ]),
    ]);
  }

  function statusPill(row) {
    return api.h('span', { className: 'req-status s-' + statusGroup(row), text: statusLabel(row) });
  }

  function headerList(list) {
    var h = api.h;
    var rows = (list || []).map(function (pair) {
      return h('div', { className: 'hdr' }, [
        h('span', { className: 'hdr-k', text: pair[0] }),
        h('span', { className: 'hdr-v', text: pair[1] }),
      ]);
    });
    return h('details', { className: 'hdrs', open: true }, [
      h('summary', { text: 'Header · ' + rows.length }),
      h('div', { className: 'hdr-list mono' }, rows),
    ]);
  }

  function bodyBlock(view) {
    var h = api.h;
    if (!view || !view.size) return h('p', { className: 'body-note', text: 'Nessun body' });
    var notes = [];
    if (view.decoded) notes.push('decompresso da ' + view.decoded);
    if (view.truncated) notes.push('mostrati solo i primi byte di ' + formatBytes(view.size));
    if (view.binary) {
      var what = view.encoding ? 'compresso (' + view.encoding + ')' : 'binario';
      return h('p', { className: 'body-note', text: 'Contenuto ' + what + ' · ' + formatBytes(view.size) + (view.contentType ? ' · ' + view.contentType : '') });
    }
    return h('div', { className: 'body' }, [
      h('p', { className: 'body-note', text: formatBytes(view.size) + (view.contentType ? ' · ' + view.contentType : '') + (notes.length ? ' · ' + notes.join(' · ') : '') }),
      h('pre', { className: 'raw body-text', text: prettyText(view) }),
    ]);
  }

  function buildRequestDetail(detail) {
    var h = api.h;
    var field = function (label, node) {
      return h('div', { className: 'field' }, [h('p', { className: 'k', text: label }), node]);
    };
    var replayTitle = detail.websocket ? api.t('inspect.replayWebsocket')
      : !detail.replayable ? api.t('inspect.replayTruncated') : 'Manda di nuovo questa richiesta alla tua origine';
    return [
      h('div', { className: 'detail-head' }, [
        h('h2', { className: 'req-title mono', title: detail.method + ' ' + detail.path, text: detail.method + ' ' + detail.path }),
        h('button', { type: 'button', className: 'link-btn', 'aria-label': 'Chiudi dettaglio', text: '✕', dataset: { action: 'close-req' } }),
      ]),
      h('div', { className: 'detail-meta' }, [
        field('Stato', h('p', { className: 'v mono' }, [statusPill(detail), detail.statusText ? ' ' + detail.statusText : null])),
        field('Durata', h('p', { className: 'v mono', text: formatDuration(detail.durationMs) })),
        field('Ora', h('p', { className: 'v mono', text: clock(detail.startedAt) })),
        detail.remote ? field('Da', h('p', { className: 'v mono', text: detail.remote })) : null,
      ]),
      detail.replayOf != null ? h('p', { className: 'replay-note' }, [
        '↻ Rimandata dalla ',
        h('button', { type: 'button', className: 'link-btn', text: 'richiesta #' + detail.replayOf, dataset: { req: String(detail.replayOf) } }),
      ]) : null,
      detail.error ? h('p', { className: 'req-error', text: detail.state === 'aborted' ? 'Interrotta da chi l’ha mandata' : 'Errore: ' + detail.error }) : null,
      h('div', { className: 'req-actions' }, [
        h('button', { type: 'button', className: 'btn inv', text: '↻ Rimanda', title: replayTitle, disabled: !detail.replayable, dataset: { action: 'replay' } }),
        h('button', { type: 'button', className: 'btn', text: 'Copia come curl', dataset: { action: 'copy-curl' } }),
      ]),
      h('section', { className: 'req-side' }, [
        h('h3', { text: 'Richiesta' }),
        headerList(detail.requestHeaders),
        bodyBlock(detail.requestBody),
      ]),
      h('section', { className: 'req-side' }, [
        h('h3', { text: detail.websocket ? 'Risposta · WebSocket' : 'Risposta' }),
        detail.status == null ? h('p', { className: 'body-note', text: detail.state === 'pending' ? 'In attesa della risposta…' : 'Nessuna risposta' }) : headerList(detail.responseHeaders),
        detail.status == null ? null : bodyBlock(detail.responseBody),
      ]),
    ].filter(Boolean);
  }

  function createRequestView() {
    var h = api.h;
    var session = null;
    var active = false;
    var version = null;
    var total = 0;
    var rows = [];
    var loading = false;
    var q = '';
    var onlyProblems = false;
    var selected = null;
    var detail = null;
    var detailSig = '';
    var listSig = '';

    function enabled() {
      return !!(session && session.inspect && session.inspect.enabled);
    }

    function visible() {
      return rows.filter(function (row) { return requestMatches(row, { q: q, onlyProblems: onlyProblems }); });
    }

    function paintTab() {
      var label = el('tab-requests-count');
      if (!label) return;
      var count = enabled() ? session.inspect.count : 0;
      label.textContent = count ? String(count) : '';
      label.hidden = !count;
    }

    function paintChips() {
      var host = el('req-chips');
      if (!host) return;
      var problems = rows.filter(isProblem).length;
      var chip = function (value, text, on) {
        return h('button', {
          type: 'button',
          className: 'chip' + (on ? ' is-on' : ''),
          'aria-pressed': on ? 'true' : 'false',
          text: text,
          dataset: { action: 'req-filter', filter: value },
        });
      };
      host.replaceChildren(
        chip('all', 'Tutte · ' + rows.length, !onlyProblems),
        chip('problems', 'Errori · ' + problems, onlyProblems)
      );
      var count = el('req-count');
      if (count) {
        var shown = visible().length;
        if (q || onlyProblems) count.textContent = shown + ' di ' + rows.length;
        else if (total > rows.length) count.textContent = 'ultime ' + rows.length + ' di ' + total;
        else count.textContent = '';
      }
      var clear = el('req-clear');
      if (clear) clear.disabled = !rows.length;
    }

    function rowNode(row) {
      var isSelected = row.seq === selected;
      var path = h('span', { className: 'req-path' });
      if (row.replayOf != null) path.append(h('span', { className: 'req-tag', title: 'Rimandata dalla #' + row.replayOf, text: '↻' }));
      if (row.websocket) path.append(h('span', { className: 'req-tag', text: 'WS' }));
      api.highlightParts(row.path, q).forEach(function (part) {
        path.append(part.mark ? h('mark', { text: part.text }) : document.createTextNode(part.text));
      });
      return h('li', {
        className: 'req-row' + (isSelected ? ' is-selected' : '') + (isProblem(row) ? ' is-problem' : ''),
        role: 'option',
        'aria-selected': isSelected ? 'true' : 'false',
        title: row.method + ' ' + row.path,
        dataset: { req: String(row.seq) },
      }, [
        h('span', { className: 'ts', text: clock(row.startedAt) }),
        h('span', { className: 'req-method', text: row.method }),
        statusPill(row),
        path,
        h('span', { className: 'req-num', text: formatDuration(row.durationMs) }),
        h('span', { className: 'req-num req-size', text: formatBytes(row.responseSize) }),
      ]);
    }

    function paintList() {
      var list = el('req-rows');
      var empty = el('req-empty');
      if (!list || !empty) return;
      var search = el('req-search');
      if (search) search.disabled = !enabled();
      if (!enabled()) {
        list.replaceChildren();
        empty.hidden = false;
        empty.textContent = session ? DISABLED[session.inspect ? session.inspect.reason : 'off'] || DISABLED.off : '';
        listSig = '';
        paintChips();
        return;
      }
      var shown = visible();
      var sig = JSON.stringify([version, q, onlyProblems, selected]);
      paintChips();
      if (sig === listSig) return;
      listSig = sig;
      list.replaceChildren.apply(list, shown.map(rowNode));
      empty.hidden = shown.length > 0;
      if (!rows.length) empty.textContent = 'Ancora nessuna richiesta. Apri l’URL del tunnel o manda un webhook: le richieste compaiono qui.';
      else empty.textContent = 'Nessuna richiesta corrisponde ai filtri.';
    }

    function paintDetail() {
      var pane = el('req-detail');
      if (!pane) return;
      if (!detail) {
        pane.hidden = true;
        pane.replaceChildren();
        detailSig = '';
        return;
      }
      var sig = JSON.stringify([detail.seq, detail.state, detail.status, detail.responseSize, detail.durationMs]);
      pane.hidden = false;
      if (sig === detailSig) return;
      detailSig = sig;
      pane.replaceChildren.apply(pane, buildRequestDetail(detail));
    }

    function fetchDetail(seq) {
      if (!session) return Promise.resolve();
      var id = session.id;
      return fetch('/api/sessions/' + encodeURIComponent(id) + '/requests/' + seq).then(function (response) {
        return response.ok ? response.json() : null;
      }).then(function (data) {
        if (!session || session.id !== id || selected !== seq) return;
        detail = data ? data.request : null;
        if (!detail) selected = null;
        paintDetail();
        paintList();
      }, function () {});
    }

    // A pending request that finished since the detail was drawn is fetched again.
    function refreshDetail() {
      if (selected == null || !detail) return;
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        if (row.seq !== selected) continue;
        if (row.state !== detail.state || row.status !== detail.status || row.responseSize !== detail.responseSize) fetchDetail(selected);
        return;
      }
    }

    function load(force) {
      if (!active || !enabled() || loading) return Promise.resolve();
      if (!force && version === session.inspect.version) return Promise.resolve();
      loading = true;
      var id = session.id;
      return fetch('/api/sessions/' + encodeURIComponent(id) + '/requests').then(function (response) {
        if (!response.ok) throw new Error(api.t('client.requestsUnavailable'));
        return response.json();
      }).then(function (data) {
        loading = false;
        if (!session || session.id !== id) return;
        rows = data.requests || [];
        total = data.total || rows.length;
        version = data.version;
        paintList();
        refreshDetail();
      }, function () {
        loading = false;
      });
    }

    function reset() {
      version = null;
      total = 0;
      rows = [];
      q = '';
      onlyProblems = false;
      selected = null;
      detail = null;
      listSig = '';
      var search = el('req-search');
      if (search) search.value = '';
      paintDetail();
    }

    function update(summary) {
      var changed = !session || !summary || session.id !== summary.id;
      session = summary || null;
      if (changed) reset();
      paintTab();
      if (!session) return;
      if (active) {
        paintList();
        load(false);
      }
    }

    function setActive(on) {
      active = !!on;
      if (active) {
        listSig = '';
        paintList();
        load(false);
      }
    }

    function select(seq) {
      if (!enabled()) return Promise.resolve();
      selected = seq;
      if (!detail || detail.seq !== seq) detail = null;
      paintList();
      paintDetail();
      return fetchDetail(seq);
    }

    function move(delta) {
      var shown = visible();
      if (!shown.length) return;
      var at = -1;
      for (var i = 0; i < shown.length; i += 1) if (shown[i].seq === selected) at = i;
      var next = at < 0 ? (delta > 0 ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, at + delta));
      select(shown[next].seq);
      var list = el('req-rows');
      var node = list && list.children ? list.children[next] : null;
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    }

    function closeDetail() {
      if (selected == null && !detail) return false;
      selected = null;
      detail = null;
      paintDetail();
      paintList();
      return true;
    }

    function setQuery(value) {
      q = String(value || '').trim();
      paintList();
    }

    function setFilter(value) {
      onlyProblems = value === 'problems';
      paintList();
    }

    function replay() {
      if (!session || !detail) return Promise.resolve(null);
      var id = session.id;
      return api.request('POST', '/api/sessions/' + encodeURIComponent(id) + '/requests/' + detail.seq + '/replay').then(function (data) {
        if (!session || session.id !== id) return null;
        selected = data.request.seq;
        detail = null;
        return load(true).then(function () {
          fetchDetail(data.request.seq);
          return data.request;
        });
      });
    }

    function clear() {
      if (!session) return Promise.resolve();
      var id = session.id;
      return api.request('DELETE', '/api/sessions/' + encodeURIComponent(id) + '/requests').then(function () {
        if (!session || session.id !== id) return;
        selected = null;
        detail = null;
        paintDetail();
        return load(true);
      });
    }

    return {
      update: update,
      setActive: setActive,
      select: select,
      move: move,
      closeDetail: closeDetail,
      setQuery: setQuery,
      setFilter: setFilter,
      replay: replay,
      clear: clear,
      curl: function () {
        if (!detail || !session) return '';
        return curlFor(detail, session.origin || (session.inspect && session.inspect.target) || '');
      },
      detail: function () { return detail; },
    };
  }

  api.formatBytes = formatBytes;
  api.formatDuration = formatDuration;
  api.statusGroup = statusGroup;
  api.isProblemRequest = isProblem;
  api.requestMatches = requestMatches;
  api.requestHeader = headerOf;
  api.curlFor = curlFor;
  api.prettyBody = prettyText;
  api.buildRequestsPane = buildRequestsPane;
  api.buildRequestDetail = buildRequestDetail;
  api.createRequestView = createRequestView;
})(globalThis);
