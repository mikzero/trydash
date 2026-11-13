(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});

  var DISABLED = { hello: 'ui.req.disabled.hello', http2: 'ui.req.disabled.http2', off: 'ui.req.disabled.off' };
  // Headers a copied curl leaves out: curl sets them itself, or Cloudflare added them.
  var CURL_SKIP = /^(host|content-length|connection|accept-encoding|transfer-encoding|cdn-loop|cf-[\w-]+)$/i;

  function formatBytes(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    if (n < 1000) return n + ' B';
    if (n < 1000 * 1000) return (n / 1000).toLocaleString(api.locale(), { maximumFractionDigits: 1 }) + ' kB';
    return (n / 1000 / 1000).toLocaleString(api.locale(), { maximumFractionDigits: 1 }) + ' MB';
  }

  function formatDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '…';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toLocaleString(api.locale(), { maximumFractionDigits: 1 }) + ' s';
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
    return row.state === 'aborted' ? api.t('ui.req.abortedShort') : 'ERR';
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
      else note = api.t('ui.req.curlNoBody', { why: body.truncated ? api.t('ui.req.curlTooLarge') : api.t('ui.req.curlBinary') }) + '\n';
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
        h('div', { id: 'req-chips', className: 'chips', role: 'group', 'aria-label': api.t('ui.req.filterGroup') }),
        h('span', { id: 'req-count', className: 'log-count' }),
        h('button', { type: 'button', id: 'req-clear', className: 'chip', text: api.t('ui.req.clear'), dataset: { action: 'clear-requests' } }),
        h('label', { id: 'req-queue-label', className: 'check req-queue', title: api.t('ui.queue.toggleTitle') }, [
          h('input', { id: 'req-queue', type: 'checkbox' }),
          h('span', { text: api.t('ui.queue.toggle') }),
        ]),
        h('span', { className: 'req-export' }, [
          h('span', { className: 'log-count', text: api.t('ui.req.export') }),
          h('a', { id: 'req-export-postman', className: 'chip chip-link', href: '#', download: 'trydash.postman_collection.json', text: 'Postman' }),
          h('a', { id: 'req-export-har', className: 'chip chip-link', href: '#', download: 'trydash.har', text: 'HAR' }),
        ]),
        h('label', { className: 'search' }, [
          h('span', { className: 'search-ico', 'aria-hidden': 'true', text: '⌕' }),
          h('input', {
            id: 'req-search',
            type: 'search',
            placeholder: api.t('ui.req.search'),
            'aria-label': api.t('ui.req.searchLabel'),
            autocomplete: 'off',
            spellcheck: 'false',
          }),
          h('kbd', { className: 'search-kbd', text: '/' }),
        ]),
      ]),
      h('div', { className: 'log-body' }, [
        h('div', { className: 'log-pane' }, [
          h('div', { id: 'req-scroller', className: 'log-scroller', tabindex: '0', 'aria-label': api.t('ui.tabs.requests') }, [
            h('ol', { id: 'req-rows', className: 'req-rows mono', role: 'listbox', 'aria-label': api.t('ui.tabs.requests') }),
            h('p', { id: 'req-empty', className: 'req-empty', hidden: true }),
          ]),
        ]),
        h('aside', { id: 'req-detail', className: 'detail req-detail', hidden: true, 'aria-label': api.t('ui.req.detail') }),
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
      h('summary', { text: api.t('ui.req.headers', { n: rows.length }) }),
      h('div', { className: 'hdr-list mono' }, rows),
    ]);
  }

  function bodyBlock(view) {
    var h = api.h;
    if (!view || !view.size) return h('p', { className: 'body-note', text: api.t('ui.req.noBody') });
    var notes = [];
    if (view.decoded) notes.push(api.t('ui.req.decoded', { enc: view.decoded }));
    if (view.truncated) notes.push(api.t('ui.req.truncated', { size: formatBytes(view.size) }));
    if (view.binary) {
      var what = view.encoding ? api.t('ui.req.compressed', { enc: view.encoding }) : api.t('ui.req.binary');
      return h('p', { className: 'body-note', text: what + ' · ' + formatBytes(view.size) + (view.contentType ? ' · ' + view.contentType : '') });
    }
    return h('div', { className: 'body' }, [
      h('p', { className: 'body-note', text: formatBytes(view.size) + (view.contentType ? ' · ' + view.contentType : '') + (notes.length ? ' · ' + notes.join(' · ') : '') }),
      h('pre', { className: 'raw body-text', text: prettyText(view) }),
    ]);
  }

  // "Name: value" lines, as typed in the editor; empty lines and lines without a name are ignored.
  function parseHeaderLines(text) {
    var pairs = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var at = line.indexOf(':');
      if (at <= 0) return;
      var name = line.slice(0, at).trim();
      if (name) pairs.push([name, line.slice(at + 1).trim()]);
    });
    return pairs;
  }

  function headerLines(list) {
    return (list || []).filter(function (pair) {
      return String(pair[0]).toLowerCase() !== 'content-length';
    }).map(function (pair) { return pair[0] + ': ' + pair[1]; }).join('\n');
  }

  // The editor that replaces the details while a replay is being changed.
  function buildReplayEditor(detail) {
    var h = api.h;
    var body = detail.requestBody || {};
    var bodyEditable = !body.binary;
    var bodyText = body.truncated || body.text == null ? '' : body.text;
    var note = body.binary ? api.t('ui.edit.binaryNote') : body.truncated ? api.t('ui.edit.truncatedNote') : '';
    return [
      h('div', { className: 'detail-head' }, [
        h('h2', { className: 'req-title', text: api.t('ui.edit.title', { n: detail.seq }) }),
        h('button', { type: 'button', className: 'link-btn', 'aria-label': api.t('ui.edit.cancel'), text: '✕', dataset: { action: 'cancel-edit' } }),
      ]),
      h('div', { className: 'edit-line' }, [
        h('input', { id: 'edit-method', className: 'input mono edit-method', value: detail.method, 'aria-label': api.t('ui.edit.method'), spellcheck: 'false', autocomplete: 'off' }),
        h('input', { id: 'edit-path', className: 'input mono', value: detail.path, 'aria-label': api.t('ui.edit.path'), spellcheck: 'false', autocomplete: 'off' }),
      ]),
      h('label', { className: 'field edit-field' }, [
        h('span', { className: 'k', text: api.t('ui.edit.headers') }),
        h('textarea', { id: 'edit-headers', className: 'input mono', rows: '6', spellcheck: 'false', text: headerLines(detail.requestHeaders) }),
      ]),
      h('label', { className: 'field edit-field' }, [
        h('span', { className: 'k', text: api.t('ui.edit.body') }),
        h('textarea', { id: 'edit-body', className: 'input mono', rows: '8', spellcheck: 'false', disabled: !bodyEditable, text: bodyText }),
      ]),
      note ? h('p', { className: 'body-note', text: note }) : null,
      h('p', { className: 'body-note', text: api.t('ui.edit.lengthNote') }),
      h('div', { className: 'req-actions' }, [
        h('button', { type: 'button', className: 'btn inv', text: api.t('ui.req.replay'), dataset: { action: 'send-edited' } }),
        h('button', { type: 'button', className: 'btn', text: api.t('ui.edit.cancel'), dataset: { action: 'cancel-edit' } }),
      ]),
    ].filter(Boolean);
  }

  function buildRequestDetail(detail) {
    var h = api.h;
    var field = function (label, node) {
      return h('div', { className: 'field' }, [h('p', { className: 'k', text: label }), node]);
    };
    var replayTitle = detail.websocket ? api.t('inspect.replayWebsocket')
      : !detail.replayable ? api.t('inspect.replayTruncated') : api.t('ui.req.replayTitle');
    return [
      h('div', { className: 'detail-head' }, [
        h('h2', { className: 'req-title mono', title: detail.method + ' ' + detail.path, text: detail.method + ' ' + detail.path }),
        h('button', { type: 'button', className: 'link-btn', 'aria-label': api.t('ui.closeDetail'), text: '✕', dataset: { action: 'close-req' } }),
      ]),
      h('div', { className: 'detail-meta' }, [
        field(api.t('ui.req.status'), h('p', { className: 'v mono' }, [statusPill(detail), detail.statusText ? ' ' + detail.statusText : null])),
        field(api.t('ui.req.duration'), h('p', { className: 'v mono', text: formatDuration(detail.durationMs) })),
        field(api.t('ui.timeLabel'), h('p', { className: 'v mono', text: clock(detail.startedAt) })),
        detail.remote ? field(api.t('ui.req.from'), h('p', { className: 'v mono', text: detail.remote })) : null,
      ]),
      detail.blocked ? h('p', { className: 'replay-note', text: api.t('ui.req.blockedNote', { path: detail.blocked }) }) : null,
      detail.queued === 'waiting' ? h('p', { className: 'replay-note', text: api.t('ui.queue.noteWaiting') }) : null,
      detail.queued === 'dropped' ? h('p', { className: 'replay-note', text: api.t('ui.queue.noteDropped') }) : null,
      detail.queued === 'delivered' ? h('p', { className: 'replay-note' }, [
        api.t('ui.queue.noteDelivered') + ' ',
        h('button', { type: 'button', className: 'link-btn', text: api.t('ui.req.requestN', { n: detail.deliveredAs }), dataset: { req: String(detail.deliveredAs) } }),
      ]) : null,
      detail.replayOf != null ? h('p', { className: 'replay-note' }, [
        api.t('ui.req.replayOf') + ' ',
        h('button', { type: 'button', className: 'link-btn', text: api.t('ui.req.requestN', { n: detail.replayOf }), dataset: { req: String(detail.replayOf) } }),
      ]) : null,
      detail.error ? h('p', { className: 'req-error', text: detail.state === 'aborted' ? api.t('ui.req.aborted') : api.t('ui.req.error', { error: detail.error }) }) : null,
      h('div', { className: 'req-actions' }, [
        h('button', { type: 'button', className: 'btn inv', text: api.t('ui.req.replay'), title: replayTitle, disabled: !detail.replayable, dataset: { action: 'replay' } }),
        h('button', { type: 'button', className: 'btn', text: api.t('ui.req.edit'), disabled: !!detail.websocket, dataset: { action: 'edit-replay' } }),
        h('button', { type: 'button', className: 'btn', text: api.t('ui.req.save'), disabled: !detail.replayable, dataset: { action: 'save-request' } }),
        h('button', { type: 'button', className: 'btn', text: api.t('ui.req.copyCurl'), dataset: { action: 'copy-curl' } }),
      ]),
      h('section', { className: 'req-side' }, [
        h('h3', { text: api.t('ui.req.request') }),
        headerList(detail.requestHeaders),
        bodyBlock(detail.requestBody),
      ]),
      h('section', { className: 'req-side' }, [
        h('h3', { text: detail.websocket ? api.t('ui.req.responseWs') : api.t('ui.req.response') }),
        detail.status == null ? h('p', { className: 'body-note', text: detail.state === 'pending' ? api.t('ui.req.pending') : api.t('ui.req.noResponse') }) : headerList(detail.responseHeaders),
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
    var editing = false;
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
        chip('all', api.t('ui.req.all', { n: rows.length }), !onlyProblems),
        chip('problems', api.t('ui.req.problems', { n: problems }), onlyProblems)
      );
      var count = el('req-count');
      if (count) {
        var shown = visible().length;
        if (q || onlyProblems) count.textContent = api.t('ui.req.count', { shown: shown, total: rows.length });
        else if (total > rows.length) count.textContent = api.t('ui.req.latest', { shown: rows.length, total: total });
        else count.textContent = '';
      }
      var clear = el('req-clear');
      if (clear) clear.disabled = !rows.length;
      // The exports are plain links: the browser downloads them with the dashboard's cookie.
      ['postman', 'har'].forEach(function (format) {
        var link = el('req-export-' + format);
        if (!link || !session) return;
        var href = '/api/sessions/' + encodeURIComponent(session.id) + '/requests/export?format=' + format;
        link.setAttribute('href', href);
        link.setAttribute('aria-disabled', rows.length && enabled() ? 'false' : 'true');
      });
    }

    function rowNode(row) {
      var isSelected = row.seq === selected;
      var path = h('span', { className: 'req-path' });
      if (row.blocked) path.append(h('span', { className: 'req-tag', title: api.t('ui.req.blockedTag', { path: row.blocked }), text: '⛔' }));
      if (row.client) path.append(h('span', { className: 'req-tag q-client', title: api.t('ui.clients.requestTag', { name: row.client }), text: row.client }));
      if (row.queued) path.append(h('span', { className: 'req-tag q-' + row.queued, title: api.t('ui.queue.tag.' + row.queued, { n: row.deliveredAs }), text: row.queued === 'delivered' ? '→ #' + row.deliveredAs : api.t('ui.queue.short.' + row.queued) }));
      if (row.saved) path.append(h('span', { className: 'req-tag', title: api.t('ui.req.savedTag', { name: row.saved }), text: '☆' }));
      if (row.replayOf != null) {
        path.append(row.delivery
          ? h('span', { className: 'req-tag q-delivered', title: api.t('ui.queue.deliveryTag', { n: row.replayOf }), text: api.t('ui.queue.short.delivery') })
          : h('span', { className: 'req-tag', title: api.t('ui.req.replayTag', { n: row.replayOf }), text: row.edited ? '↻✎' : '↻' }));
      }
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
        empty.textContent = session ? api.t(DISABLED[session.inspect ? session.inspect.reason : 'off'] || DISABLED.off) : '';
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
      if (!rows.length) empty.textContent = api.t('ui.req.empty');
      else empty.textContent = api.t('ui.req.noMatch');
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
      // While editing, polling must not wipe what is being typed.
      var sig = editing ? 'edit:' + detail.seq : JSON.stringify([detail.seq, detail.state, detail.status, detail.responseSize, detail.durationMs]);
      pane.hidden = false;
      if (sig === detailSig) return;
      detailSig = sig;
      pane.replaceChildren.apply(pane, editing ? buildReplayEditor(detail) : buildRequestDetail(detail));
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
      editing = false;
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
      if (cancelEdit()) return true;
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

    function startEdit() {
      if (!detail || detail.websocket) return false;
      editing = true;
      paintDetail();
      return true;
    }

    function cancelEdit() {
      if (!editing) return false;
      editing = false;
      paintDetail();
      return true;
    }

    // What the editor holds; the body only when it could be edited.
    function readEdits() {
      var value = function (id) { var node = el(id); return node ? String(node.value == null ? '' : node.value) : ''; };
      var bodyNode = el('edit-body');
      var edits = {
        method: value('edit-method').trim().toUpperCase(),
        path: value('edit-path').trim(),
        headers: parseHeaderLines(value('edit-headers')),
      };
      if (bodyNode && !bodyNode.disabled) edits.body = value('edit-body');
      return edits;
    }

    function replay(edits) {
      if (!session || !detail) return Promise.resolve(null);
      var id = session.id;
      return api.request('POST', '/api/sessions/' + encodeURIComponent(id) + '/requests/' + detail.seq + '/replay', edits || undefined).then(function (data) {
        if (!session || session.id !== id) return null;
        editing = false;
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
      startEdit: startEdit,
      cancelEdit: cancelEdit,
      sendEdited: function () { return replay(readEdits()); },
      editing: function () { return editing; },
      curl: function () {
        if (!detail || !session) return '';
        return curlFor(detail, session.origin || (session.inspect && session.inspect.target) || '');
      },
      detail: function () { return detail; },
      sessionId: function () { return session ? session.id : null; },
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
  api.buildReplayEditor = buildReplayEditor;
  api.parseHeaderLines = parseHeaderLines;
  api.createRequestView = createRequestView;
})(globalThis);
