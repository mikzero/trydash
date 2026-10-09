(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var LOCAL_HOSTS = ['127.0.0.1', 'localhost', '0.0.0.0', '[::1]'];

  function shortOrigin(origin) {
    try {
      var url = new URL(origin);
      var path = url.pathname === '/' ? '' : url.pathname;
      if (LOCAL_HOSTS.indexOf(url.hostname) >= 0 && url.port) return ':' + url.port + path;
      return url.host + path;
    } catch (err) {
      return String(origin || '');
    }
  }

  function lines(count) {
    return count === 1 ? '1 riga' : (count || 0) + ' righe';
  }

  function statusText(session) {
    if (session.status === 'starting') return 'in attesa dell’URL…';
    if (session.status === 'running') return session.url ? session.url.replace(/^https?:\/\//, '') : 'attivo';
    if (session.status === 'stopped') return 'fermato · ' + lines(session.entryCount);
    if (session.status === 'exited') {
      return 'terminato (codice ' + (session.exitCode == null ? '?' : session.exitCode) + ')';
    }
    return session.status || '';
  }

  function pickCurrentId(sessions, preferredId) {
    var list = sessions || [];
    for (var i = 0; i < list.length; i += 1) {
      if (preferredId && list[i].id === preferredId) return preferredId;
    }
    return list.length ? list[0].id : null;
  }

  function readHash(hash) {
    try {
      return decodeURIComponent(String(hash || '').replace(/^#/, ''));
    } catch (err) {
      return '';
    }
  }

  function buildCreateForm() {
    var form = createFormMarkup();
    paintRecentMail(form);
    return form;
  }

  function createFormMarkup() {
    var h = api.h;
    return h('form', { id: 'create-form', className: 'create-form', autocomplete: 'off' }, [
      h('div', { className: 'create-row' }, [
        h('input', {
          name: 'origin',
          id: 'origin',
          type: 'text',
          className: 'input mono',
          placeholder: '3000 o http://127.0.0.1:3000',
          'aria-label': 'Origine locale',
          'aria-describedby': 'origin-preview',
          autocomplete: 'off',
          spellcheck: 'false',
        }),
        h('button', { type: 'submit', className: 'btn inv', text: 'Crea', dataset: { action: 'create' } }),
      ]),
      h('p', { id: 'origin-preview', className: 'origin-preview mono', 'aria-live': 'polite' }),
      h('details', { id: 'mail-details', className: 'create-more' }, [
        h('summary', { id: 'mail-summary', text: 'Accesso via email' }),
        h('textarea', {
          id: 'allowed-mail',
          name: 'allowedMail',
          rows: '1',
          className: 'input mono',
          placeholder: 'nome@cliente.it, *@azienda.it',
          'aria-label': 'Email autorizzate',
          spellcheck: 'false',
        }),
        h('div', { id: 'recent-mail', className: 'recent-mail' }),
      ]),
      h('details', { id: 'origin-details', className: 'create-more' }, [
        h('summary', { id: 'origin-summary', text: 'Opzioni origine' }),
        h('label', { className: 'field' }, [
          h('span', { text: 'Host header' }),
          h('input', { id: 'host-header', name: 'hostHeader', type: 'text', className: 'input mono', autocomplete: 'off', spellcheck: 'false' }),
        ]),
        h('div', { className: 'checks' }, [
          h('label', { className: 'check' }, [
            h('input', { id: 'no-tls-verify', name: 'noTlsVerify', type: 'checkbox' }),
            h('span', { text: 'Non verificare TLS' }),
          ]),
          h('label', { className: 'check' }, [
            h('input', { id: 'http2-origin', name: 'http2Origin', type: 'checkbox' }),
            h('span', { text: 'Origine HTTP/2' }),
          ]),
        ]),
      ]),
      h('p', { className: 'quick-note', text: 'Solo per prove · niente SSE · nessuna garanzia di uptime' }),
      h('div', { className: 'hello-row' }, [
        h('span', { className: 'hello-or', text: '— oppure —' }),
        h('button', { type: 'button', className: 'btn', text: 'Prova con Hello World', dataset: { action: 'hello' } }),
      ]),
    ]);
  }

  function field(form, id) {
    return form && form.querySelector ? form.querySelector('#' + id) : null;
  }

  function readCreateOptions(form) {
    var mail = field(form, 'allowed-mail');
    var host = field(form, 'host-header');
    var tls = field(form, 'no-tls-verify');
    var h2 = field(form, 'http2-origin');
    return {
      allowedMail: mail ? String(mail.value || '') : '',
      hostHeader: host ? String(host.value || '') : '',
      noTlsVerify: !!(tls && tls.checked),
      http2Origin: !!(h2 && h2.checked),
    };
  }

  function paintRecentMail(form) {
    var slot = field(form, 'recent-mail');
    if (!slot) return;
    var list = api.readRecentMail();
    slot.hidden = list.length === 0;
    if (!list.length) {
      slot.replaceChildren();
      return;
    }
    var h = api.h;
    slot.replaceChildren.apply(slot, [h('span', { className: 'recent-label', text: 'recenti:' })].concat(list.map(function (mail) {
      return h('button', { type: 'button', className: 'chip mono', text: mail, dataset: { action: 'recent-mail', value: mail } });
    })));
  }

  function summaries(form, options) {
    var mailSummary = field(form, 'mail-summary');
    var originSummary = field(form, 'origin-summary');
    var mails;
    try {
      mails = api.normalizeTunnelOptions({ allowedMail: options.allowedMail }).allowedMail.length;
    } catch (err) {
      mails = options.allowedMail.split(/[\s,;]+/).filter(Boolean).length;
    }
    if (mailSummary) mailSummary.textContent = 'Accesso via email' + (mails ? ' · ' + mails : '');
    var active = (options.hostHeader.trim() ? 1 : 0) + (options.noTlsVerify ? 1 : 0) + (options.http2Origin ? 1 : 0);
    var label = options.noTlsVerify ? ' · TLS non verificato' : (active ? ' · ' + active : '');
    if (originSummary) originSummary.textContent = 'Opzioni origine' + label;
  }

  function hasOptions(options) {
    return !!(String(options.allowedMail || '').trim() || String(options.hostHeader || '').trim() || options.noTlsVerify || options.http2Origin);
  }

  function previewCommand(originValue, rawOptions) {
    var preview = document.getElementById('origin-preview');
    if (!preview) return;
    var options = rawOptions || {};
    if (!String(originValue || '').trim() && !hasOptions(options)) {
      preview.textContent = '';
      preview.className = 'origin-preview mono';
      return;
    }
    try {
      preview.textContent = '→ ' + api.buildQuickTunnelCommand(originValue, options).equivalent;
      preview.className = 'origin-preview mono';
    } catch (err) {
      preview.textContent = err.key ? api.t(err.key, err.params) : err.message;
      preview.className = 'origin-preview mono bad';
    }
  }

  function refreshCreateForm(form) {
    if (!form) return;
    var options = readCreateOptions(form);
    var origin = field(form, 'origin');
    summaries(form, options);
    previewCommand(origin ? origin.value : '', options);
  }

  function buildSidebar(vm) {
    var h = api.h;
    var version = vm.workspace && vm.workspace.version ? vm.workspace.version : '';
    return h('aside', { id: 'sidebar', className: 'sidebar', 'aria-label': 'Tunnel' }, [
      h('div', { className: 'brand-row' }, [
        h('span', { className: 'brand' }, [
          h('img', { src: 'logo.svg', alt: '', width: '22', height: '22', className: 'brand-logo' }),
          h('span', { text: 'trydash' }),
        ]),
        h('button', {
          type: 'button',
          id: 'theme-toggle',
          className: 'theme-toggle',
          title: 'Tema',
          text: api.theme ? api.theme.label(api.theme.get()) : '◐ auto',
          dataset: { action: 'theme' },
        }),
      ]),
      h('div', { id: 'new-tunnel', className: 'new-tunnel' }, [
        h('button', {
          type: 'button',
          className: 'new-toggle',
          text: '＋ Nuovo tunnel',
          'aria-expanded': 'false',
          'aria-controls': 'create-form',
          dataset: { action: 'new' },
        }),
        h('div', { id: 'create-slot', className: 'create-slot' }, [buildCreateForm()]),
      ]),
      h('p', { id: 'tunnel-list-empty', className: 'tunnel-list-empty', text: 'Nessun tunnel ancora.' }),
      h('ul', { id: 'tunnel-list', className: 'tunnel-list', 'aria-label': 'Tunnel' }),
      h('p', { id: 'cf-version', className: 'cf-version mono', title: version, text: version }),
    ]);
  }

  function originLabel(session) {
    return session.mode === 'hello' ? 'Hello World' : shortOrigin(session.origin);
  }

  function hasLoadBar(session) {
    return !!(session.active && session.traffic && typeof session.traffic.inflight === 'number');
  }

  function setLoad(bar, fill, traffic) {
    var share = Math.min(traffic.inflight / api.INFLIGHT_LIMIT, 1);
    var level = api.loadLevel(traffic.inflight);
    bar.className = 'load-bar' + (traffic.ok === false ? ' is-stale' : '');
    bar.title = traffic.inflight + '/' + api.INFLIGHT_LIMIT + ' richieste in corso';
    fill.className = 'load-fill' + (level ? ' ' + level : '');
    fill.style.width = Math.round(share * 100) + '%';
  }

  function loadBar(session) {
    if (!hasLoadBar(session)) return null;
    var h = api.h;
    var fill = h('span', { className: 'load-fill' });
    var bar = h('span', { className: 'load-bar' }, [fill]);
    setLoad(bar, fill, session.traffic);
    return bar;
  }

  function tunnelItem(session, selected) {
    var h = api.h;
    var errors = session.counts && session.counts.error ? session.counts.error : 0;
    var options = session.options || {};
    var mails = options.allowedMail || [];
    return h('li', { className: 'tunnel' + (selected ? ' is-selected' : '') + ' st-' + session.status }, [
      h('button', {
        type: 'button',
        className: 'tunnel-btn',
        dataset: { session: session.id },
        'aria-current': selected ? 'true' : null,
        title: session.mode === 'hello' ? 'Hello World' : session.origin,
      }, [
        h('span', { className: 'dot st-' + session.status, 'aria-hidden': 'true' }),
        h('span', { className: 'tunnel-text' }, [
          h('span', { className: 'tunnel-origin' }, [
            h('span', { className: 'mono', text: originLabel(session) }),
            mails.length ? h('span', { className: 'lock', title: mails.join(', '), 'aria-label': 'Protetto', text: '🔒' }) : null,
            options.noTlsVerify ? h('span', { className: 'tls-off', title: 'Certificato dell\'origine non verificato', 'aria-label': 'TLS non verificato', text: '⚠' }) : null,
            errors ? h('span', { className: 'badge-err', text: errors === 1 ? '1 errore' : errors + ' errori' }) : null,
          ]),
          h('span', { className: 'tunnel-sub', text: statusText(session) }),
          loadBar(session),
        ]),
      ]),
    ]);
  }

  var painted = { list: null, sig: null };

  function sidebarSignature(state) {
    return JSON.stringify([state.currentId, state.sessions.map(function (s) {
      // Traffic changes every sample: only the bar appearing or going away rebuilds.
      return [s.id, s.origin, s.status, s.url, s.entryCount, s.exitCode, s.counts ? s.counts.error || 0 : 0, hasLoadBar(s)];
    })]);
  }

  function paintSidebar(state) {
    var list = document.getElementById('tunnel-list');
    if (!list) return;
    // Rebuilding on every poll would swallow clicks and drop keyboard focus.
    var sig = sidebarSignature(state);
    if (painted.list !== list || painted.sig !== sig) {
      list.replaceChildren.apply(list, state.sessions.map(function (session) {
        return tunnelItem(session, session.id === state.currentId);
      }));
      painted.list = list;
      painted.sig = sig;
    }
    state.sessions.forEach(function (session, i) {
      var item = list.children[i];
      var bar = item && item.querySelector ? item.querySelector('.load-bar') : null;
      var fill = bar ? bar.querySelector('.load-fill') : null;
      if (fill && hasLoadBar(session)) setLoad(bar, fill, session.traffic);
    });
    var empty = document.getElementById('tunnel-list-empty');
    if (empty) empty.hidden = state.sessions.length > 0;
    var toggle = document.getElementById('theme-toggle');
    if (toggle && api.theme) toggle.textContent = api.theme.label(api.theme.get());
  }

  api.shortOrigin = shortOrigin;
  api.originLabel = originLabel;
  api.statusText = statusText;
  api.pickCurrentId = pickCurrentId;
  api.readHash = readHash;
  api.buildSidebar = buildSidebar;
  api.paintSidebar = paintSidebar;
  api.buildCreateForm = buildCreateForm;
  api.readCreateOptions = readCreateOptions;
  api.paintRecentMail = paintRecentMail;
  api.previewCommand = previewCommand;
  api.refreshCreateForm = refreshCreateForm;
})(globalThis);
