(function (root) {
  'use strict';

  // The "Saved" tab: requests pinned from the Requests tab or imported from
  // Postman, HAR or curl, kept by the server. Each one can be edited and sent to
  // the tunnel on screen; it only ever reaches that tunnel's origin.
  var api = root.TryDash || (root.TryDash = {});

  function el(id) {
    return document.getElementById(id);
  }

  function headerText(list) {
    return (list || []).map(function (pair) { return pair[0] + ': ' + pair[1]; }).join('\n');
  }

  function sourceLabel(source) {
    var key = { captured: 'ui.saved.fromCaptured', postman: 'Postman', har: 'HAR', curl: 'curl', manual: 'ui.saved.fromManual' }[source];
    return key && key.indexOf('ui.') === 0 ? api.t(key) : key || source || '';
  }

  function matches(item, q) {
    var needle = String(q || '').trim().toLowerCase();
    if (!needle) return true;
    return (item.name + ' ' + item.method + ' ' + item.path).toLowerCase().indexOf(needle) >= 0;
  }

  function buildSavedPane() {
    var h = api.h;
    return h('div', { id: 'pane-saved', className: 'tab-pane', role: 'tabpanel', 'aria-labelledby': 'tab-saved', hidden: true }, [
      h('div', { className: 'log-toolbar' }, [
        h('button', { type: 'button', className: 'chip', text: api.t('ui.saved.import'), dataset: { action: 'saved-import-open' } }),
        h('a', { id: 'saved-export', className: 'chip chip-link', href: '/api/collection/export?format=postman', download: 'trydash.postman_collection.json', text: api.t('ui.saved.export') }),
        h('span', { id: 'saved-count', className: 'log-count' }),
        h('label', { className: 'search' }, [
          h('span', { className: 'search-ico', 'aria-hidden': 'true', text: '⌕' }),
          h('input', { id: 'saved-search', type: 'search', placeholder: api.t('ui.saved.search'), 'aria-label': api.t('ui.saved.search'), autocomplete: 'off', spellcheck: 'false' }),
        ]),
      ]),
      h('div', { className: 'log-body' }, [
        h('div', { className: 'log-pane' }, [
          h('div', { className: 'log-scroller', tabindex: '0', 'aria-label': api.t('ui.tabs.saved') }, [
            h('ol', { id: 'saved-rows', className: 'req-rows mono', role: 'listbox', 'aria-label': api.t('ui.tabs.saved') }),
            h('p', { id: 'saved-empty', className: 'req-empty', hidden: true }),
          ]),
        ]),
        h('aside', { id: 'saved-detail', className: 'detail req-detail', hidden: true, 'aria-label': api.t('ui.saved.detail') }),
      ]),
    ]);
  }

  function buildEditor(item, session) {
    var h = api.h;
    var canSend = !!(session && session.inspect && session.inspect.enabled);
    var binary = !!item.bodyBase64;
    return [
      h('div', { className: 'detail-head' }, [
        h('input', { id: 'saved-name', className: 'input saved-name', value: item.name, 'aria-label': api.t('ui.saved.name'), spellcheck: 'false', autocomplete: 'off' }),
        h('button', { type: 'button', className: 'link-btn', 'aria-label': api.t('ui.closeDetail'), text: '✕', dataset: { action: 'saved-close' } }),
      ]),
      h('p', { className: 'body-note', text: sourceLabel(item.source) + ' · ' + api.t('ui.saved.onlyOrigin') }),
      h('div', { className: 'edit-line' }, [
        h('input', { id: 'saved-method', className: 'input mono edit-method', value: item.method, 'aria-label': api.t('ui.edit.method'), spellcheck: 'false', autocomplete: 'off' }),
        h('input', { id: 'saved-path', className: 'input mono', value: item.path, 'aria-label': api.t('ui.edit.path'), spellcheck: 'false', autocomplete: 'off' }),
      ]),
      h('label', { className: 'field edit-field' }, [
        h('span', { className: 'k', text: api.t('ui.edit.headers') }),
        h('textarea', { id: 'saved-headers', className: 'input mono', rows: '6', spellcheck: 'false', text: headerText(item.headers) }),
      ]),
      h('label', { className: 'field edit-field' }, [
        h('span', { className: 'k', text: api.t('ui.edit.body') }),
        h('textarea', { id: 'saved-body', className: 'input mono', rows: '8', spellcheck: 'false', disabled: binary, text: binary ? '' : (item.body || '') }),
      ]),
      binary ? h('p', { className: 'body-note', text: api.t('ui.edit.binaryNote') }) : null,
      h('div', { className: 'req-actions' }, [
        h('button', { type: 'button', className: 'btn inv', text: api.t('ui.saved.send'), disabled: !canSend, title: canSend ? api.t('ui.saved.sendTitle') : api.t('inspect.disabled'), dataset: { action: 'saved-send' } }),
        h('button', { type: 'button', className: 'btn', text: api.t('ui.saved.save'), dataset: { action: 'saved-save' } }),
        h('button', { type: 'button', className: 'btn danger', text: api.t('ui.saved.delete'), dataset: { action: 'saved-delete' } }),
      ]),
    ].filter(Boolean);
  }

  function buildImport(result) {
    var h = api.h;
    return [
      h('div', { className: 'detail-head' }, [
        h('h2', { className: 'req-title', text: api.t('ui.saved.importTitle') }),
        h('button', { type: 'button', className: 'link-btn', 'aria-label': api.t('ui.closeDetail'), text: '✕', dataset: { action: 'saved-close' } }),
      ]),
      h('p', { className: 'body-note', text: api.t('ui.saved.importLead') }),
      h('textarea', { id: 'saved-import-text', className: 'input mono saved-import', rows: '12', spellcheck: 'false', placeholder: api.t('ui.saved.importPlaceholder') }),
      h('label', { className: 'saved-file' }, [
        h('span', { text: api.t('ui.saved.importFile') }),
        h('input', { id: 'saved-import-file', type: 'file', accept: '.json,.har,.txt,.sh,application/json' }),
      ]),
      h('div', { className: 'req-actions' }, [
        h('button', { type: 'button', className: 'btn inv', text: api.t('ui.saved.importGo'), dataset: { action: 'saved-import-go' } }),
      ]),
      result ? h('div', { id: 'saved-import-result', className: 'saved-result' }, [
        h('p', { className: 'body-note', text: result.text }),
        result.warnings && result.warnings.length ? h('ul', { className: 'saved-warnings' }, result.warnings.map(function (w) { return h('li', { text: w }); })) : null,
      ]) : null,
    ].filter(Boolean);
  }

  function createSavedView() {
    var h = api.h;
    var session = null;
    var active = false;
    var items = [];
    var loaded = false;
    var q = '';
    var selected = null;
    var item = null;
    var mode = null; // 'edit' or 'import'
    var importResult = null;
    var armedDelete = false;

    function paintTab() {
      var label = el('tab-saved-count');
      if (!label) return;
      label.textContent = items.length ? String(items.length) : '';
      label.hidden = !items.length;
    }

    function paintExport() {
      var link = el('saved-export');
      if (!link) return;
      var href = '/api/collection/export?format=postman' + (session ? '&session=' + encodeURIComponent(session.id) : '');
      link.setAttribute('href', href);
    }

    function paintList() {
      var list = el('saved-rows');
      var empty = el('saved-empty');
      if (!list || !empty) return;
      var shown = items.filter(function (it) { return matches(it, q); });
      list.replaceChildren.apply(list, shown.map(function (it) {
        var on = it.id === selected;
        return h('li', {
          className: 'req-row saved-row' + (on ? ' is-selected' : ''),
          role: 'option',
          'aria-selected': on ? 'true' : 'false',
          title: it.method + ' ' + it.path,
          dataset: { saved: it.id },
        }, [
          h('span', { className: 'req-method', text: it.method }),
          h('span', { className: 'saved-name-cell', text: it.name }),
          h('span', { className: 'req-path', text: it.path }),
          h('span', { className: 'req-num', text: sourceLabel(it.source) }),
        ]);
      }));
      empty.hidden = shown.length > 0;
      empty.textContent = items.length ? api.t('ui.req.noMatch') : api.t('ui.saved.empty');
      var count = el('saved-count');
      if (count) count.textContent = q ? api.t('ui.req.count', { shown: shown.length, total: items.length }) : '';
      paintTab();
    }

    function paintDetail() {
      var pane = el('saved-detail');
      if (!pane) return;
      if (mode === 'import') {
        pane.hidden = false;
        pane.replaceChildren.apply(pane, buildImport(importResult));
        return;
      }
      if (mode === 'edit' && item) {
        pane.hidden = false;
        pane.replaceChildren.apply(pane, buildEditor(item, session));
        return;
      }
      pane.hidden = true;
      pane.replaceChildren();
    }

    function load() {
      return fetch('/api/collection').then(function (response) {
        return response.ok ? response.json() : null;
      }).then(function (data) {
        if (!data) return;
        items = data.requests || [];
        loaded = true;
        if (selected && !items.some(function (it) { return it.id === selected; })) {
          selected = null;
          item = null;
          if (mode === 'edit') mode = null;
          paintDetail();
        }
        paintList();
      }, function () {});
    }

    function update(summary) {
      var changed = !session || !summary || session.id !== summary.id;
      session = summary || null;
      paintExport();
      if (!loaded) load();
      // Send depends on the tunnel: redraw the editor when another tunnel is shown.
      if (changed && mode === 'edit') paintDetail();
    }

    function setActive(on) {
      active = !!on;
      if (active) load();
    }

    function select(id) {
      selected = id;
      mode = 'edit';
      armedDelete = false;
      paintList();
      return fetch('/api/collection/' + encodeURIComponent(id)).then(function (response) {
        return response.ok ? response.json() : null;
      }).then(function (data) {
        if (!data || selected !== id) return;
        item = data.request;
        paintDetail();
      }, function () {});
    }

    function close() {
      if (!mode) return false;
      mode = null;
      selected = null;
      item = null;
      importResult = null;
      paintDetail();
      paintList();
      return true;
    }

    function openImport() {
      mode = 'import';
      selected = null;
      importResult = null;
      paintList();
      paintDetail();
    }

    function readEditor() {
      var value = function (id) { var node = el(id); return node ? String(node.value == null ? '' : node.value) : ''; };
      var bodyNode = el('saved-body');
      var patch = {
        name: value('saved-name').trim(),
        method: value('saved-method').trim().toUpperCase(),
        path: value('saved-path').trim(),
        headers: api.parseHeaderLines(value('saved-headers')),
      };
      if (bodyNode && !bodyNode.disabled) patch.body = value('saved-body');
      return patch;
    }

    function save() {
      if (!item) return Promise.resolve(null);
      var id = item.id;
      return api.request('PATCH', '/api/collection/' + encodeURIComponent(id), readEditor()).then(function (data) {
        item = data.request;
        return load().then(function () {
          paintDetail();
          return item;
        });
      });
    }

    // Saves what is in the editor first, so what is sent is what is shown.
    function send() {
      if (!item || !session) return Promise.resolve(null);
      var sid = session.id;
      return save().then(function (saved) {
        if (!saved) return null;
        return api.request('POST', '/api/collection/' + encodeURIComponent(saved.id) + '/send', { session: sid }).then(function (data) {
          return data.request;
        });
      });
    }

    // Two clicks: the first one only asks.
    function remove(button) {
      if (!item) return Promise.resolve(false);
      if (!armedDelete) {
        armedDelete = true;
        if (button) {
          button.textContent = api.t('ui.confirm.remove');
          button.className = button.className + ' is-armed';
        }
        setTimeout(function () { armedDelete = false; }, 3000);
        return Promise.resolve(false);
      }
      var id = item.id;
      return api.request('DELETE', '/api/collection/' + encodeURIComponent(id)).then(function () {
        close();
        return load().then(function () { return true; });
      });
    }

    function importText(text) {
      return api.request('POST', '/api/collection/import', { text: text }).then(function (data) {
        importResult = { text: api.t('ui.saved.imported', { n: data.added, format: data.format }), warnings: data.warnings };
        return load().then(function () {
          paintDetail();
          return data;
        });
      }, function (err) {
        importResult = { text: err.message, warnings: [] };
        paintDetail();
        throw err;
      });
    }

    function setQuery(value) {
      q = String(value || '').trim();
      paintList();
    }

    return {
      update: update,
      setActive: setActive,
      select: select,
      close: close,
      openImport: openImport,
      save: save,
      send: send,
      remove: remove,
      importText: importText,
      setQuery: setQuery,
      reload: load,
      items: function () { return items; },
      mode: function () { return mode; },
    };
  }

  api.buildSavedPane = buildSavedPane;
  api.createSavedView = createSavedView;
  api.savedMatches = matches;
})(globalThis);
