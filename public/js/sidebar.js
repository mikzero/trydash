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

  // The client-preview controls, in the form (prefix '') and in the tunnel's panel ('pv-').
  function buildPreviewFields(prefix, options) {
    var h = api.h;
    var o = options || {};
    var id = function (name) { return prefix + name; };
    var check = function (name, checked, label, title) {
      return h('label', { className: 'check', title: title || '' }, [
        h('input', { id: id(name), name: name, type: 'checkbox', checked: !!checked }),
        h('span', { text: label }),
      ]);
    };
    return h('div', { className: 'preview-fields' }, [
      h('div', { className: 'checks' }, [
        check('rewrite', o.rewrite, api.t('ui.preview.rewrite'), api.t('ui.preview.rewriteTitle')),
        check('noindex', o.noindex !== false, api.t('ui.preview.noindex')),
        check('badge', o.badge, api.t('ui.preview.badge')),
      ]),
      h('label', { className: 'field' }, [
        h('span', { text: api.t('ui.preview.blocked') }),
        h('input', {
          id: id('blocked'),
          name: 'blocked',
          type: 'text',
          className: 'input mono',
          placeholder: '/wp-admin, /wp-login.php',
          value: (o.blocked || []).join(', '),
          autocomplete: 'off',
          spellcheck: 'false',
        }),
      ]),
      h('div', { className: 'recent-mail preset-row' }, [h('span', { className: 'recent-label', text: api.t('ui.preview.presets') })].concat(
        Object.keys(api.BLOCK_PRESETS).map(function (name) {
          return h('button', {
            type: 'button',
            className: 'chip',
            title: api.BLOCK_PRESETS[name].join(', '),
            text: PRESET_LABELS[name] || name,
            dataset: { action: 'block-preset', preset: name, target: id('blocked') },
          });
        })
      )),
    ]);
  }

  var PRESET_LABELS = { wordpress: 'WordPress', laravel: 'Laravel', django: 'Django' };

  function readPreviewFields(root, prefix) {
    var get = function (name) { return root && root.querySelector ? root.querySelector('#' + prefix + name) : null; };
    var rewrite = get('rewrite');
    var noindex = get('noindex');
    var badge = get('badge');
    var blocked = get('blocked');
    return {
      rewrite: !!(rewrite && rewrite.checked),
      noindex: !noindex || !!noindex.checked,
      badge: !!(badge && badge.checked),
      blocked: blocked ? String(blocked.value || '') : '',
    };
  }

  // A preset adds its paths to the field, without repeating the ones already there.
  function addPreset(input, name) {
    var paths = api.BLOCK_PRESETS[name];
    if (!input || !paths) return;
    var have = String(input.value || '').split(/[\s,;]+/).filter(Boolean);
    paths.forEach(function (item) {
      if (have.map(function (v) { return v.toLowerCase().replace(/\/+$/, ''); }).indexOf(item) < 0) have.push(item);
    });
    input.value = have.join(', ');
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
      h('details', { id: 'preview-details', className: 'create-more' }, [
        h('summary', { id: 'preview-summary', text: api.t('ui.preview.title') }),
        h('p', { className: 'quick-note', text: api.t('ui.preview.intro') }),
        buildPreviewFields('', { noindex: true }),
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
    var preview = readPreviewFields(form, '');
    return {
      expiresIn: expires && expires.value ? Number(expires.value) : null,
      allowedMail: mail ? String(mail.value || '') : '',
      hostHeader: host ? String(host.value || '') : '',
      noTlsVerify: !!(tls && tls.checked),
      http2Origin: !!(h2 && h2.checked),
      inspect: !inspect || !!inspect.checked,
      rewrite: preview.rewrite,
      noindex: preview.noindex,
      badge: preview.badge,
      blocked: preview.blocked,
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
    // The preview lives in trydash's proxy: not with HTTP/2 to the origin.
    var previewSummary = field(form, 'preview-summary');
    var on = (options.rewrite ? 1 : 0) + (options.badge ? 1 : 0) + (String(options.blocked || '').trim() ? 1 : 0);
    if (previewSummary) {
      previewSummary.textContent = api.t('ui.preview.title') + (options.http2Origin ? ' · ' + api.t('ui.preview.offH2') : on ? ' · ' + on : '');
    }
    ['rewrite', 'noindex', 'badge', 'blocked'].forEach(function (name) {
      var node = field(form, name);
      if (node) node.disabled = !!options.http2Origin;
    });
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
    if (api.looksBare(originValue)) {
      var name = String(originValue).trim();
      var url = api.buildQuickTunnelCommand(originValue, options).origin;
      preview.textContent = api.t('ui.form.bareHint', { name: name, url: url });
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

  // What a chip says about a port: the scan's finding, else the usual use, else the process.
  function portLabel(item) {
    var scan = item.scan || {};
    // Once scanned, what answered beats the guess from the port number.
    var guess = item.scan && item.scan.http ? '' : (item.hint ? item.hint.split(',')[0] : '');
    var title = scan.title && scan.title.length > 24 ? scan.title.slice(0, 23) + '…' : scan.title;
    var what = scan.label || title || guess || item.process || '';
    return ':' + item.port + (what ? ' · ' + what : '');
  }

  function portTitle(item) {
    var scan = item.scan || {};
    if (item.busy) return api.t('ui.ports.busy');
    var parts = [];
    if (scan.title) parts.push('“' + scan.title + '”');
    if (scan.label && item.hint && scan.label !== item.hint) parts.push(item.hint);
    if (item.process) parts.push(api.t('ui.ports.process', { name: item.process }));
    if (scan.http === false) parts.push(api.t('ui.ports.noHttp'));
    if (scan.suggest && scan.suggest.rewrite) parts.push(api.t('ui.ports.suggestRewrite'));
    return parts.join(' · ') || item.hint || item.origin;
  }

  // Servers found on this machine, as chips that fill the origin field, and the scan button.
  function paintPortHints(form, ports, scanning) {
    var slot = field(form, 'port-hints');
    if (!slot) return;
    var list = ports || [];
    var sig = JSON.stringify([list, !!scanning]);
    if (slot.dataset.sig === sig) return;
    slot.dataset.sig = sig;
    slot.hidden = false;
    var h = api.h;
    var chips = list.map(function (item) {
      var scan = item.scan || {};
      var suggest = scan.suggest || {};
      return h('button', {
        type: 'button',
        className: 'chip mono' + (item.busy ? ' is-busy' : '') + (scan.kind ? ' is-known' : '') + (scan.http === false ? ' is-quiet' : ''),
        title: portTitle(item),
        text: portLabel(item),
        dataset: {
          action: 'pick-port',
          origin: scan.tls && /^\d+$/.test(item.origin) ? 'https://localhost:' + item.port : item.origin,
          rewrite: suggest.rewrite ? '1' : '',
          preset: suggest.preset || '',
          tls: scan.tls ? '1' : '',
        },
      });
    });
    var scanButton = h('button', {
      type: 'button',
      className: 'chip scan-chip',
      title: api.t('ui.ports.scanTitle'),
      disabled: !!scanning,
      text: scanning ? api.t('ui.ports.scanning') : api.t(list.length ? 'ui.ports.scan' : 'ui.ports.scanEmpty'),
      dataset: { action: 'scan-ports' },
    });
    var head = list.length ? [h('span', { className: 'recent-label', text: api.t('ui.ports.label') })] : [];
    slot.replaceChildren.apply(slot, head.concat(chips, [scanButton]));
  }

  // A picked chip fills the origin and, for a known kind of site, the suggested options.
  function applyPortPick(form, node) {
    var origin = field(form, 'origin');
    if (origin) origin.value = node.dataset.origin;
    if (node.dataset.tls === '1') {
      var tls = field(form, 'no-tls-verify');
      if (tls) tls.checked = true;
      var originDetails = field(form, 'origin-details');
      if (originDetails) originDetails.open = true;
    }
    if (node.dataset.rewrite === '1' || node.dataset.preset) {
      var rewrite = field(form, 'rewrite');
      if (rewrite && node.dataset.rewrite === '1') rewrite.checked = true;
      if (node.dataset.preset) addPreset(field(form, 'blocked'), node.dataset.preset);
      var details = field(form, 'preview-details');
      if (details) details.open = true;
    }
    refreshCreateForm(form);
    if (origin && origin.focus) origin.focus();
  }


  function paintThemeToggle(button) {
    var full = api.t('ui.side.theme') + ': ' + api.theme.label(api.theme.get());
    button.textContent = api.theme.icon(api.theme.get());
    button.title = full;
    button.setAttribute('aria-label', full);
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
        h('div', { className: 'brand-tools' }, [
          h('button', {
            type: 'button',
            id: 'theme-toggle',
            className: 'theme-toggle',
            title: api.t('ui.side.theme') + ': ' + (api.theme ? api.theme.label(api.theme.get()) : '◐ auto'),
            'aria-label': api.t('ui.side.theme') + ': ' + (api.theme ? api.theme.label(api.theme.get()) : '◐ auto'),
            text: api.theme ? api.theme.icon(api.theme.get()) : '◐',
            dataset: { action: 'theme' },
          }),
        h('button', {
          type: 'button',
          id: 'notify-toggle',
          className: 'theme-toggle',
          hidden: !(api.notifications && api.notifications.supported()),
          title: api.t(api.notifications && api.notifications.enabled() ? 'ui.notify.turnOff' : 'ui.notify.turnOn'),
          'aria-pressed': api.notifications && api.notifications.enabled() ? 'true' : 'false',
          text: api.notifications && api.notifications.enabled() ? '🔔' : '🔕',
          dataset: { action: 'notify' },
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
      h('div', { className: 'side-foot' }, [
        h('a', { className: 'donate', href: 'https://ko-fi.com/P8V12A631E', target: '_blank', rel: 'noopener noreferrer', title: api.t('ui.side.donateTitle') }, [
          h('img', { src: 'kofi-symbol.svg', alt: '', width: '16', height: '13', className: 'donate-cup' }),
          h('span', { text: api.t('ui.side.donate') }),
        ]),
        h('p', { id: 'cf-version', className: 'cf-version mono', title: version, text: version }),
      ]),
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
    if (toggle && api.theme) paintThemeToggle(toggle);
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
  api.buildPreviewFields = buildPreviewFields;
  api.readPreviewFields = readPreviewFields;
  api.addPreset = addPreset;
  api.paintRecentMail = paintRecentMail;
  api.previewCommand = previewCommand;
  api.refreshCreateForm = refreshCreateForm;
  api.paintPortHints = paintPortHints;
  api.applyPortPick = applyPortPick;
  api.portLabel = portLabel;
  api.paintThemeToggle = paintThemeToggle;
})(globalThis);
