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
    return api.tn('ui.lines', count || 0);
  }

  function statusText(session) {
    if (session.status === 'starting') return api.t('ui.side.waiting');
    if (session.status === 'running') return session.url ? session.url.replace(/^https?:\/\//, '') : api.t('ui.side.running');
    if (session.status === 'stopped' && session.expired) return api.t('ui.side.expired', { lines: lines(session.entryCount) });
    if (session.status === 'stopped') return api.t('ui.side.stopped', { lines: lines(session.entryCount) });
    if (session.status === 'exited') {
      return api.t('ui.side.exited', { code: session.exitCode == null ? '?' : session.exitCode });
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

  // The expiry menu: minutes, or empty for never.
  var EXPIRY_CHOICES = [
    { value: '', label: 'ui.expires.never' },
    { value: '30', label: 'ui.expires.m30' },
    { value: '60', label: 'ui.expires.h1' },
    { value: '120', label: 'ui.expires.h2' },
    { value: '480', label: 'ui.expires.h8' },
    { value: '1440', label: 'ui.expires.d1' },
  ];

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
          placeholder: api.t('ui.form.placeholder'),
          'aria-label': api.t('ui.form.origin'),
          'aria-describedby': 'origin-preview',
          autocomplete: 'off',
          spellcheck: 'false',
        }),
        h('button', { type: 'submit', className: 'btn inv', text: api.t('ui.form.create'), dataset: { action: 'create' } }),
      ]),
      h('p', { id: 'origin-preview', className: 'origin-preview mono', 'aria-live': 'polite' }),
      h('div', { id: 'port-hints', className: 'port-hints', hidden: true }),
      h('label', { className: 'expires-row' }, [
        h('span', { text: api.t('ui.form.expires') }),
        h('select', { id: 'expires', name: 'expiresIn', className: 'input' }, EXPIRY_CHOICES.map(function (choice) {
          return h('option', { value: choice.value, text: api.t(choice.label) });
        })),
      ]),
      h('details', { id: 'mail-details', className: 'create-more' }, [
        h('summary', { id: 'mail-summary', text: api.t('ui.form.mail') }),
        h('textarea', {
          id: 'allowed-mail',
          name: 'allowedMail',
          rows: '1',
          className: 'input mono',
          placeholder: api.t('ui.form.mailPlaceholder'),
          'aria-label': api.t('ui.form.mailLabel'),
          spellcheck: 'false',
        }),
        h('div', { id: 'recent-mail', className: 'recent-mail' }),
      ]),
      h('details', { id: 'origin-details', className: 'create-more' }, [
        h('summary', { id: 'origin-summary', text: api.t('ui.form.originOptions') }),
        h('label', { className: 'field' }, [
          h('span', { text: 'Host header' }),
          h('input', { id: 'host-header', name: 'hostHeader', type: 'text', className: 'input mono', autocomplete: 'off', spellcheck: 'false' }),
        ]),
        h('div', { className: 'checks' }, [
          h('label', { className: 'check' }, [
            h('input', { id: 'no-tls-verify', name: 'noTlsVerify', type: 'checkbox' }),
            h('span', { text: api.t('ui.form.noTls') }),
          ]),
          h('label', { className: 'check' }, [
            h('input', { id: 'http2-origin', name: 'http2Origin', type: 'checkbox' }),
            h('span', { text: api.t('ui.form.http2') }),
          ]),
          h('label', { className: 'check', title: api.t('ui.form.inspectTitle') }, [
            h('input', { id: 'inspect', name: 'inspect', type: 'checkbox', checked: true }),
            h('span', { id: 'inspect-label', text: api.t('ui.form.inspect') }),
          ]),
        ]),
      ]),
      h('p', { className: 'quick-note', text: api.t('ui.form.note') }),
      h('div', { className: 'hello-row' }, [
        h('span', { className: 'hello-or', text: api.t('ui.form.or') }),
        h('button', { type: 'button', className: 'btn', text: api.t('ui.hello'), dataset: { action: 'hello' } }),
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
    var inspect = field(form, 'inspect');
    var expires = field(form, 'expires');
    return {
      expiresIn: expires && expires.value ? Number(expires.value) : null,
      allowedMail: mail ? String(mail.value || '') : '',
      hostHeader: host ? String(host.value || '') : '',
      noTlsVerify: !!(tls && tls.checked),
      http2Origin: !!(h2 && h2.checked),
      inspect: !inspect || !!inspect.checked,
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
    slot.replaceChildren.apply(slot, [h('span', { className: 'recent-label', text: api.t('ui.form.recent') })].concat(list.map(function (mail) {
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
    if (mailSummary) mailSummary.textContent = api.t('ui.form.mail') + (mails ? ' · ' + mails : '');
    var active = (options.hostHeader.trim() ? 1 : 0) + (options.noTlsVerify ? 1 : 0) + (options.http2Origin ? 1 : 0);
    var label = options.noTlsVerify ? ' · ' + api.t('ui.form.tlsOff') : (active ? ' · ' + active : '');
    if (!options.inspect || options.http2Origin) label += ' · ' + api.t('ui.form.noInspector');
    if (originSummary) originSummary.textContent = api.t('ui.form.originOptions') + label;
    // The inspector's proxy speaks HTTP/1.1 only.
    var inspect = field(form, 'inspect');
    var inspectLabel = field(form, 'inspect-label');
    if (inspect) inspect.disabled = !!options.http2Origin;
    if (inspectLabel) inspectLabel.textContent = options.http2Origin ? api.t('ui.form.inspectNoH2') : api.t('ui.form.inspect');
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
    if (api.looksLikeFolder(originValue)) {
      preview.textContent = api.t('ui.form.folderPreview', { path: String(originValue).trim() });
      preview.className = 'origin-preview mono';
      return;
    }
    try {
      preview.textContent = '→ ' + api.commandFor(api.buildQuickTunnelCommand(originValue, options));
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

  // Dev servers found on this machine, as chips that fill the origin field.
  function paintPortHints(form, ports) {
    var slot = field(form, 'port-hints');
    if (!slot) return;
    var list = ports || [];
    var sig = JSON.stringify(list);
    if (slot.dataset.sig === sig) return;
    slot.dataset.sig = sig;
    slot.hidden = list.length === 0;
    var h = api.h;
    slot.replaceChildren.apply(slot, list.length ? [h('span', { className: 'recent-label', text: api.t('ui.ports.label') })].concat(list.map(function (item) {
      var label = ':' + item.port + (item.hint ? ' · ' + item.hint.split(',')[0] : '');
      return h('button', {
        type: 'button',
        className: 'chip mono' + (item.busy ? ' is-busy' : ''),
        title: item.busy ? api.t('ui.ports.busy') : (item.hint || item.origin),
        text: label,
        dataset: { action: 'pick-port', origin: item.origin },
      });
    })) : []);
  }

  function buildSidebar(vm) {
    var h = api.h;
    var version = vm.workspace && vm.workspace.version ? vm.workspace.version : '';
    return h('aside', { id: 'sidebar', className: 'sidebar', 'aria-label': api.t('ui.tunnels') }, [
      h('div', { className: 'brand-row' }, [
        h('span', { className: 'brand' }, [
          h('img', { src: 'logo.svg', alt: '', width: '22', height: '22', className: 'brand-logo' }),
          h('span', { text: 'trydash' }),
        ]),
        h('button', {
          type: 'button',
          id: 'theme-toggle',
          className: 'theme-toggle',
          title: api.t('ui.side.theme'),
          text: api.theme ? api.theme.label(api.theme.get()) : '◐ auto',
          dataset: { action: 'theme' },
        }),
        h('button', {
          type: 'button',
          id: 'lang-toggle',
          className: 'theme-toggle',
          title: api.t('ui.lang'),
          'aria-label': api.t('ui.lang'),
          text: api.lang === 'it' ? 'IT' : 'EN',
          dataset: { action: 'lang' },
        }),
      ]),
      h('div', { id: 'new-tunnel', className: 'new-tunnel' }, [
        h('button', {
          type: 'button',
          className: 'new-toggle',
          text: api.t('ui.side.new'),
          'aria-expanded': 'false',
          'aria-controls': 'create-form',
          dataset: { action: 'new' },
        }),
        h('div', { id: 'create-slot', className: 'create-slot' }, [buildCreateForm()]),
      ]),
      h('p', { id: 'tunnel-list-empty', className: 'tunnel-list-empty', text: api.t('ui.side.empty') }),
      h('ul', { id: 'tunnel-list', className: 'tunnel-list', 'aria-label': api.t('ui.tunnels') }),
      h('p', { id: 'cf-version', className: 'cf-version mono', title: version, text: version }),
    ]);
  }

  function folderName(folder) {
    var parts = String(folder || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(folder || '/');
  }

  function originLabel(session) {
    if (session.mode === 'hello') return 'Hello World';
    if (session.mode === 'folder') return '📁 ' + folderName(session.options && session.options.folder);
    return shortOrigin(session.origin);
  }

  function originTitle(session) {
    if (session.mode === 'hello') return 'Hello World';
    if (session.mode === 'folder') return session.options && session.options.folder;
    return session.origin;
  }

  function hasLoadBar(session) {
    return !!(session.active && session.traffic && typeof session.traffic.inflight === 'number');
  }

  function setLoad(bar, fill, traffic) {
    var share = Math.min(traffic.inflight / api.INFLIGHT_LIMIT, 1);
    var level = api.loadLevel(traffic.inflight);
    bar.className = 'load-bar' + (traffic.ok === false ? ' is-stale' : '');
    bar.title = api.t('ui.side.load', { n: traffic.inflight, limit: api.INFLIGHT_LIMIT });
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
        title: originTitle(session),
      }, [
        h('span', { className: 'dot st-' + session.status, 'aria-hidden': 'true' }),
        h('span', { className: 'tunnel-text' }, [
          h('span', { className: 'tunnel-origin' }, [
            h('span', { className: 'mono', text: originLabel(session) }),
            mails.length ? h('span', { className: 'lock', title: mails.join(', '), 'aria-label': api.t('ui.side.protected'), text: '🔒' }) : null,
            options.noTlsVerify ? h('span', { className: 'tls-off', title: api.t('ui.side.tlsTitle'), 'aria-label': api.t('ui.form.tlsOff'), text: '⚠' }) : null,
            errors ? h('span', { className: 'badge-err', text: api.tn('ui.side.errors', errors) }) : null,
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
  api.originTitle = originTitle;
  api.folderName = folderName;
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
  api.paintPortHints = paintPortHints;
})(globalThis);
