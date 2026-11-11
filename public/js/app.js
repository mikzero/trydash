(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var POLL_MS = 1000;
  var OFFLINE_AFTER = 3;

  function h(tag, props, children) {
    return api.h(tag, props, children);
  }

  function renderFileGate(parent) {
    parent.replaceChildren(h('main', { className: 'gate', dataset: { phase: 'file' } }, [
      h('section', { className: 'gate-card' }, [
        h('p', { className: 'eyebrow', text: 'try.cloudflare.com' }),
        h('h1', { text: api.t('ui.fileGate.title') }),
        h('p', { className: 'lead', text: api.t('ui.fileGate.lead') }),
        h('pre', { className: 'cmd', text: 'bun server.js' }),
        h('p', { className: 'lead', style: { marginTop: '14px' }, text: api.t('ui.fileGate.then') }),
      ]),
    ]));
  }

  // A dashboard started with a token answers 401 until the browser has it.
  function renderAuthGate(parent) {
    parent.replaceChildren(h('main', { className: 'gate', dataset: { phase: 'auth' } }, [
      h('section', { className: 'gate-card' }, [
        h('p', { className: 'eyebrow', text: 'try.cloudflare.com' }),
        h('h1', { text: api.t('ui.auth.title') }),
        h('p', { className: 'lead', text: api.t('ui.auth.lead') }),
        h('pre', { className: 'cmd', text: 'http://127.0.0.1:8787/?token=…' }),
        h('p', { className: 'lead', style: { marginTop: '14px' }, text: api.t('ui.auth.hint') }),
      ]),
    ]));
  }

  function renderChecking(parent) {
    parent.replaceChildren(h('main', { className: 'gate', dataset: { phase: 'checking' } }, [
      h('section', { className: 'gate-card' }, [
        h('p', { className: 'eyebrow', text: 'try.cloudflare.com' }),
        h('p', { className: 'lead', text: api.t('ui.checking') }),
      ]),
    ]));
  }

  function buildInstall(vm) {
    var steps = vm.install.steps.map(function (step) {
      return h('li', { className: 'step' }, [
        h('div', { className: 'step-head' }, [
          h('h2', { text: step.title }),
          h('button', { type: 'button', className: 'btn', text: api.t('ui.copy'), dataset: { action: 'copy' } }),
        ]),
        h('pre', { className: 'cmd', text: step.command }),
      ]);
    });
    return h('main', { className: 'install', dataset: { phase: 'install' } }, [
      h('section', { className: 'install-card' }, [
        h('p', { className: 'eyebrow', text: 'try.cloudflare.com' }),
        h('h1', { text: api.t('ui.install.title') }),
        h('p', { className: 'lead', text: vm.install.summary }),
        h('p', { className: 'missing', text: vm.install.missing }),
        h('ol', { className: 'steps' }, steps),
        h('div', { className: 'install-actions' }, [
          vm.actions.indexOf('recheck') >= 0
            ? h('button', { type: 'button', className: 'btn inv', text: api.t('ui.install.recheck'), dataset: { action: 'recheck' } })
            : null,
        ]),
        h('p', { id: 'probe-status', className: 'status', text: api.t('ui.install.notInPath') }),
      ]),
      toastHost(),
    ]);
  }

  function toastHost() {
    return h('div', { id: 'toasts', className: 'toasts', 'aria-live': 'polite' });
  }

  function buildEmptyState() {
    return h('section', { id: 'empty-state', className: 'empty-state' }, [
      h('div', { className: 'hero' }, [
        h('h2', { className: 'hero-title', text: api.t('ui.hero.title') }),
        h('p', { className: 'hero-lead', text: api.t('ui.hero.lead') }),
        h('div', { id: 'hero-slot', className: 'hero-slot' }),
        h('p', { className: 'hero-hint', text: api.t('ui.hero.hint') }),
      ]),
    ]);
  }

  function buildWorkspace(vm) {
    var sidebar = api.buildSidebar(vm);
    return h('div', { id: 'workspace', className: 'workspace', dataset: { phase: 'workspace' } }, [
      sidebar,
      h('div', { className: 'nav-scrim', 'aria-hidden': 'true', dataset: { action: 'menu-close' } }),
      h('main', { className: 'main-area' }, [
        h('div', { className: 'mobile-bar' }, [
          h('button', { type: 'button', className: 'btn icon', 'aria-label': api.t('ui.tunnels'), 'aria-controls': 'sidebar', text: '☰', dataset: { action: 'menu' } }),
          h('span', { className: 'brand' }, [
            h('img', { src: 'logo.svg', alt: '', width: '22', height: '22', className: 'brand-logo' }),
            h('span', { text: 'trydash' }),
          ]),
        ]),
        h('div', { id: 'offline-banner', className: 'offline-banner', role: 'status', hidden: true, text: api.t('client.offlineRetry') }),
        buildEmptyState(),
        api.buildMain(vm),
      ]),
      toastHost(),
    ]);
  }

  function renderPhase(parent, probe) {
    var vm = api.viewForProbe(probe);
    if (vm.phase === 'install') parent.replaceChildren(buildInstall(vm));
    else parent.replaceChildren(buildWorkspace(vm));
    return vm;
  }

  var state = {
    app: null,
    probe: null,
    phase: '',
    sessions: [],
    currentId: null,
    prevById: {},
    pollFailures: 0,
    creating: false,
    busy: false,
    wasEmpty: false,
    newOpen: false,
    view: null,
    armed: null,
    searchTimer: 0,
    timer: 0,
    tab: 'log',
    requests: null,
    reqSearchTimer: 0,
  };

  function currentSession() {
    for (var i = 0; i < state.sessions.length; i += 1) {
      if (state.sessions[i].id === state.currentId) return state.sessions[i];
    }
    return null;
  }

  function notify(message, kind) {
    api.toast(message, { kind: kind || 'info' });
  }

  function fail(err) {
    notify(err && err.message ? err.message : api.t('client.failed'), 'error');
  }

  function hashId() {
    return api.readHash(typeof location !== 'undefined' ? location.hash : '');
  }

  function writeHash(id) {
    if (typeof history === 'undefined' || !history.replaceState) return;
    history.replaceState(null, '', id ? '#' + encodeURIComponent(id) : location.pathname + location.search);
  }

  function placeCreateForm() {
    var form = document.getElementById('create-form');
    var hero = document.getElementById('hero-slot');
    var slot = document.getElementById('create-slot');
    var sidebarNew = document.getElementById('new-tunnel');
    if (!form || !hero || !slot) return;
    var empty = state.sessions.length === 0;
    var target = empty ? hero : slot;
    if (form.parentNode !== target) target.append(form);
    if (!sidebarNew) return;
    var open = state.newOpen && !empty;
    sidebarNew.className = 'new-tunnel' + (empty ? ' is-hero' : '') + (open ? ' is-open' : '');
    var toggle = sidebarNew.querySelector('[data-action="new"]');
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  var PORTS_EVERY_MS = 4000;
  var portsAt = 0;

  // Asks the server which dev ports are listening, at most every few seconds.
  function refreshPorts(force) {
    if (!force && Date.now() - portsAt < PORTS_EVERY_MS) return;
    portsAt = Date.now();
    fetch('/api/ports').then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (data) {
      if (data) api.paintPortHints(document.getElementById('create-form'), data.ports);
    }, function () {});
  }

  function setNewOpen(open) {
    if (state.sessions.length === 0) return;
    state.newOpen = open;
    placeCreateForm();
    if (open) refreshPorts(true);
    if (open) {
      var input = document.getElementById('origin');
      if (input) input.focus();
    }
  }

  function paintShell() {
    var session = currentSession();
    api.paintSidebar(state);
    placeCreateForm();
    var empty = document.getElementById('empty-state');
    var view = document.getElementById('tunnel-view');
    var isEmpty = state.sessions.length === 0;
    if (empty) empty.hidden = !isEmpty;
    if (view) view.hidden = !session;
    if (isEmpty) refreshPorts(false);
    if (isEmpty && !state.wasEmpty) {
      var input = document.getElementById('origin');
      if (input) input.focus();
    }
    state.wasEmpty = isEmpty;
    if (state.view) state.view.update(session);
    if (state.requests) state.requests.update(session);
  }

  function setTab(tab) {
    state.tab = tab === 'requests' ? 'requests' : 'log';
    api.showTab(state.tab);
    if (state.requests) state.requests.setActive(state.tab === 'requests');
    if (state.tab === 'log' && state.view) state.view.render();
  }

  async function copyText(text, done) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        if (done) notify(done);
        return;
      }
    } catch (err) {
      /* fallback below */
    }
    try {
      var area = document.createElement('textarea');
      area.value = text;
      document.body.append(area);
      area.select();
      var ok = document.execCommand('copy');
      area.remove();
      if (!ok) throw new Error('copy');
      if (done) notify(done);
    } catch (err) {
      notify(api.t('client.copyFailed'), 'error');
    }
  }

  function resetView() {
    disarm();
  }

  function announceTransitions(sessions) {
    var next = {};
    sessions.forEach(function (session) {
      var prev = state.prevById[session.id];
      if (prev && prev.status !== session.status) {
        if (session.status === 'running' && session.url) notify(api.t('ui.toast.newUrl', { url: session.url }));
        if (session.status === 'stopped' && session.expired) notify(api.t('ui.toast.expired'));
        if (session.status === 'exited') {
          notify(api.t('ui.toast.exited', { code: session.exitCode == null ? '?' : session.exitCode }), 'error');
        }
      }
      next[session.id] = { status: session.status };
    });
    state.prevById = next;
  }

  function setOffline(failed) {
    state.pollFailures = failed ? state.pollFailures + 1 : 0;
    var banner = document.getElementById('offline-banner');
    if (banner) banner.hidden = state.pollFailures < OFFLINE_AFTER;
  }

  function offlineError(message) {
    var error = new Error(message);
    error.offline = true;
    return error;
  }

  async function refresh() {
    var response;
    try {
      response = await fetch('/api/state');
    } catch (err) {
      throw offlineError(api.t('client.offline'));
    }
    if (response.status === 401) {
      if (state.phase !== 'auth') renderAuthGate(state.app);
      state.phase = 'auth';
      state.view = null;
      state.requests = null;
      return;
    }
    if (!response.ok) throw offlineError(api.t('client.stateUnavailable'));
    var data = await response.json();
    var nextPhase = api.viewForProbe(data.probe).phase;
    var phaseChanged = nextPhase !== state.phase;
    state.probe = data.probe;
    state.phase = nextPhase;
    api.platform = data.probe && data.probe.platform;
    if (phaseChanged) {
      api.renderPhase(state.app, data.probe);
      state.view = nextPhase === 'workspace' ? api.createLogView() : null;
      state.requests = nextPhase === 'workspace' ? api.createRequestView() : null;
      if (state.requests) api.showTab(state.tab);
      if (state.requests) state.requests.setActive(state.tab === 'requests');
    }
    if (nextPhase === 'install') {
      var status = document.getElementById('probe-status');
      if (status) status.textContent = api.t('ui.install.notInPath');
      return;
    }
    announceTransitions(data.sessions);
    state.sessions = data.sessions;
    var nextId = api.pickCurrentId(state.sessions, state.currentId || hashId());
    if (nextId !== state.currentId) {
      state.currentId = nextId;
      resetView();
      writeHash(nextId);
    }
    paintShell();
  }

  function poll() {
    return refresh().then(function () {
      setOffline(false);
    }, function (err) {
      if (err && err.offline) {
        setOffline(true);
        return;
      }
      setOffline(false);
      if (typeof console !== 'undefined') console.error(err);
    });
  }

  async function api_(method, path, body) {
    var headers = { 'Accept-Language': api.lang || 'en' };
    if (body) headers['Content-Type'] = 'application/json';
    var response = await fetch(path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = {};
    try { data = await response.json(); } catch (err) { /* empty body */ }
    if (!response.ok) throw new Error(data.error || api.t('client.failed'));
    return data;
  }

  async function createSession(form) {
    if (state.creating) return;
    var input = form.querySelector('input[name="origin"]');
    var submit = form.querySelector('[data-action="create"]');
    state.creating = true;
    if (submit) submit.disabled = true;
    try {
      var options = api.readCreateOptions(form);
      var origin = input ? input.value : '';
      if (api.looksLikeFolder(origin)) {
        options.mode = 'folder';
        options.folder = origin.trim();
        origin = '';
      }
      var data = await api_('POST', '/api/sessions', { origin: origin, options: options });
      api.rememberMail(data.session.options ? data.session.options.allowedMail : []);
      resetCreateForm(form);
      await selectCreated(data.session, api.t('ui.toast.created'));
    } finally {
      state.creating = false;
      if (submit) submit.disabled = false;
    }
  }

  function resetCreateForm(form) {
    ['origin', 'allowed-mail', 'host-header'].forEach(function (id) {
      var node = form.querySelector('#' + id);
      if (node) node.value = '';
    });
    ['no-tls-verify', 'http2-origin'].forEach(function (id) {
      var node = form.querySelector('#' + id);
      if (node) node.checked = false;
    });
    var inspect = form.querySelector('#inspect');
    if (inspect) inspect.checked = true;
    var expires = form.querySelector('#expires');
    if (expires) expires.value = '';
    ['mail-details', 'origin-details'].forEach(function (id) {
      var node = form.querySelector('#' + id);
      if (node) node.open = false;
    });
    api.paintRecentMail(form);
    api.refreshCreateForm(form);
  }

  async function selectCreated(session, message) {
    state.currentId = session.id;
    resetView();
    writeHash(session.id);
    setNewOpen(false);
    notify(message);
    await refresh();
  }

  // From a banner the current tunnel's emails are reused; from the form, the field's.
  async function createHello(fromBanner) {
    if (state.creating) return;
    var form = document.getElementById('create-form');
    var session = currentSession();
    var formOptions = api.readCreateOptions(form);
    var allowedMail = fromBanner && session && session.options
      ? session.options.allowedMail
      : formOptions.allowedMail;
    var expiresIn = fromBanner && session && session.options ? session.options.expiresIn : formOptions.expiresIn;
    state.creating = true;
    try {
      var data = await api_('POST', '/api/sessions', { options: { mode: 'hello', allowedMail: allowedMail, expiresIn: expiresIn } });
      api.rememberMail(data.session.options ? data.session.options.allowedMail : []);
      if (form && !fromBanner) api.paintRecentMail(form);
      await selectCreated(data.session, api.t('ui.toast.helloCreated'));
    } finally {
      state.creating = false;
    }
  }

  function addRecentMail(value) {
    var form = document.getElementById('create-form');
    var field = form ? form.querySelector('#allowed-mail') : null;
    if (!field || !value) return;
    var current = String(field.value || '').split(/[\s,;]+/).filter(Boolean);
    if (current.map(function (item) { return item.toLowerCase(); }).indexOf(value.toLowerCase()) >= 0) return;
    current.push(value);
    field.value = current.join(', ');
    api.refreshCreateForm(form);
  }

  var CONFIRM_MS = 3000;
  var DOUBLE_CLICK_MS = 300;

  // A new URL or a lost log is worth a second click.
  function needsConfirm(action, session) {
    if (action === 'restart' || action === 'force-restart') return true;
    if (action === 'remove') return !!(session && session.active);
    return false;
  }

  function armedLabel(action) {
    return action === 'remove' ? api.t('ui.confirm.remove') : api.t('ui.confirm.restart');
  }

  function confirmStep(armed, action, nowMs) {
    if (!armed || armed.action !== action) return 'arm';
    // A double-click must not arm and confirm in one gesture.
    if (nowMs - armed.at < DOUBLE_CLICK_MS) return 'wait';
    return 'go';
  }

  function labelNode(button) {
    return (button.querySelector && button.querySelector('.lbl')) || button;
  }

  function arm(button, action) {
    disarm();
    if (!button) return;
    var label = labelNode(button);
    state.armed = {
      action: action,
      at: Date.now(),
      button: button,
      text: label.textContent,
      className: button.className,
      timer: setTimeout(disarm, CONFIRM_MS),
    };
    label.textContent = armedLabel(action);
    button.className = button.className + ' is-armed';
  }

  function disarm() {
    var armed = state.armed;
    state.armed = null;
    if (!armed) return;
    clearTimeout(armed.timer);
    labelNode(armed.button).textContent = armed.text;
    armed.button.className = armed.className;
  }

  async function sessionAction(action, button) {
    var session = currentSession();
    if (!session || state.busy) return;
    if (needsConfirm(action, session)) {
      var step = confirmStep(state.armed, action, Date.now());
      if (step === 'arm') {
        arm(button, action);
        return;
      }
      if (step === 'wait') return;
      disarm();
    }
    state.busy = true;
    try {
      await runAction(action, session);
    } finally {
      state.busy = false;
    }
  }

  async function runAction(action, session) {
    var id = encodeURIComponent(session.id);
    if (action === 'stop') {
      await api_('POST', '/api/sessions/' + id + '/stop');
      notify(api.t('ui.toast.stopped'));
    } else if (action === 'restart') {
      notify(api.t('ui.toast.restarting'));
      await api_('POST', '/api/sessions/' + id + '/restart');
    } else if (action === 'force-restart') {
      notify(api.t('ui.toast.restarting'));
      await api_('POST', '/api/sessions/' + id + '/stop');
      await api_('POST', '/api/sessions/' + id + '/restart');
    } else if (action === 'remove') {
      await api_('DELETE', '/api/sessions/' + id);
      state.currentId = null;
      resetView();
      writeHash(null);
      notify(api.t('ui.toast.removed'));
    }
    await refresh();
  }

  function onSubmit(event) {
    var form = event.target;
    if (!form || form.id !== 'create-form') return;
    event.preventDefault();
    createSession(form).catch(fail);
  }

  function onInput(event) {
    var target = event.target;
    if (!target) return;
    if (target.closest && target.closest('#create-form')) api.refreshCreateForm(document.getElementById('create-form'));
    if (target.id === 'req-search' && state.requests) {
      clearTimeout(state.reqSearchTimer);
      state.reqSearchTimer = setTimeout(function () {
        state.requests.setQuery(target.value);
      }, 150);
    }
    if (target.id === 'log-search' && state.view) {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(function () {
        state.view.setFilter({ q: target.value });
      }, 200);
    }
  }

  function onScroll(event) {
    if (event.target && event.target.id === 'log-scroller' && state.view) state.view.onScroll();
  }

  function onClick(event) {
    var node = event.target.closest ? event.target.closest('[data-action], [data-index], [data-session], [data-req]') : null;
    if (!node) return;
    var action = node.dataset.action;
    if (action === 'hello') {
      createHello(!!(node.closest && node.closest('#tunnel-warnings'))).catch(fail);
      return;
    }
    if (action === 'pick-port') {
      var originField = document.getElementById('origin');
      if (originField) {
        originField.value = node.dataset.origin;
        api.refreshCreateForm(document.getElementById('create-form'));
        originField.focus();
      }
      return;
    }
    if (action === 'recent-mail') {
      addRecentMail(node.dataset.value);
      return;
    }
    if (action === 'recheck') {
      var status = document.getElementById('probe-status');
      if (status) status.textContent = api.t('ui.install.checkingShort');
      fetch('/api/probe?fresh=1').then(refresh).catch(function (err) {
        if (status) status.textContent = err.message;
      });
      return;
    }
    if (action === 'copy') {
      var step = node.closest('.step');
      var pre = step && step.querySelector('.cmd');
      if (pre) copyText(pre.textContent, api.t('ui.toast.commandCopied'));
      return;
    }
    if (action === 'menu') {
      var ws = document.getElementById('workspace');
      setNav(!(ws && /nav-open/.test(ws.className)));
      return;
    }
    if (action === 'menu-close') {
      closeNav();
      return;
    }
    if (action === 'lang') {
      // Every text is drawn once, so a new language is a reload away.
      api.langPref.set(api.langPref.other());
      if (typeof location !== 'undefined' && location.reload) location.reload();
      return;
    }
    if (action === 'theme') {
      var mode = api.theme.cycle();
      node.textContent = api.theme.label(mode);
      return;
    }
    if (action === 'new') {
      setNewOpen(!state.newOpen);
      return;
    }
    if (action === 'copy-url') {
      var session = currentSession();
      if (session && session.url) copyText(session.url, api.t('ui.toast.urlCopied'));
      return;
    }
    if (action === 'stop' || action === 'restart' || action === 'force-restart' || action === 'remove') {
      sessionAction(action, node).catch(fail);
      return;
    }
    if (action === 'copy-cmd') {
      var current = currentSession();
      if (current) copyText(api.commandFor(current), api.platform === 'win32' ? api.t('ui.toast.commandCopiedWindows') : api.t('ui.toast.commandCopied'));
      return;
    }
    if (action === 'open') {
      if (!(currentSession() && currentSession().url)) event.preventDefault();
      return;
    }
    if (action === 'tab') {
      setTab(node.dataset.tab);
      return;
    }
    if (state.requests && requestAction(action, node)) return;
    if (!state.view) return;
    if (action === 'chip') {
      state.view.toggleLevel(node.dataset.group || '');
      return;
    }
    if (action === 'tail') {
      state.view.jumpToTail();
      return;
    }
    if (action === 'close-detail') {
      state.view.closeDetail();
      return;
    }
    if (action === 'copy-row') {
      var entry = state.view.detail();
      if (entry) copyText(entry.raw, api.t('ui.toast.rowCopied'));
      return;
    }
    if (node.dataset.session) {
      if (node.dataset.session !== state.currentId) {
        state.currentId = node.dataset.session;
        resetView();
        writeHash(state.currentId);
        paintShell();
        closeNav();
      }
      return;
    }
    if (node.dataset.index && node.dataset.pos) {
      state.view.select(Number(node.dataset.index), Number(node.dataset.pos));
    }
  }

  // Clicks inside the Requests tab; true when handled.
  function requestAction(action, node) {
    var view = state.requests;
    if (action === 'req-filter') {
      view.setFilter(node.dataset.filter);
      return true;
    }
    if (action === 'clear-requests') {
      view.clear().then(function () { notify(api.t('ui.toast.requestsCleared')); }, fail);
      return true;
    }
    if (action === 'close-req') {
      view.closeDetail();
      return true;
    }
    if (action === 'copy-curl') {
      var curl = view.curl();
      if (curl) copyText(curl, api.t('ui.toast.curlCopied'));
      return true;
    }
    if (action === 'edit-replay') {
      view.startEdit();
      return true;
    }
    if (action === 'cancel-edit') {
      view.cancelEdit();
      return true;
    }
    if (action === 'send-edited') {
      node.disabled = true;
      view.sendEdited().then(function (row) {
        if (row) notify(api.t('ui.toast.replayed', { result: row.status == null ? (row.error || api.t('ui.toast.noResponse')) : row.status }), api.isProblemRequest(row) ? 'error' : 'info');
      }, function (err) {
        node.disabled = false;
        fail(err);
      });
      return true;
    }
    if (action === 'replay') {
      node.disabled = true;
      view.replay().then(function (row) {
        if (row) notify(api.t('ui.toast.replayed', { result: row.status == null ? (row.error || api.t('ui.toast.noResponse')) : row.status }), row && api.isProblemRequest(row) ? 'error' : 'info');
      }, function (err) {
        node.disabled = false;
        fail(err);
      });
      return true;
    }
    if (!action && node.dataset.req) {
      view.select(Number(node.dataset.req));
      return true;
    }
    return false;
  }

  function onKey(event) {
    var target = event.target || {};
    var typing = target.matches && target.matches('input, textarea, select');
    if (event.key === 'Escape') {
      if (target.id === 'req-search' && target.value) {
        target.value = '';
        if (state.requests) state.requests.setQuery('');
        return;
      }
      if (state.tab === 'requests' && state.requests && state.requests.closeDetail()) {
        event.preventDefault();
        return;
      }
      if (target.id === 'origin') {
        setNewOpen(false);
        return;
      }
      if (target.id === 'log-search' && target.value) {
        target.value = '';
        if (state.view) state.view.setFilter({ q: '' });
        return;
      }
      if (state.view && state.view.closeDetail()) event.preventDefault();
      closeNav();
      return;
    }
    if (typing || !state.view) return;
    if (state.tab === 'requests' && state.requests) {
      if (event.key === '/') {
        var reqSearch = document.getElementById('req-search');
        if (reqSearch) {
          event.preventDefault();
          reqSearch.focus();
        }
      } else if (event.key === 'ArrowDown' || event.key === 'j') {
        event.preventDefault();
        state.requests.move(1);
      } else if (event.key === 'ArrowUp' || event.key === 'k') {
        event.preventDefault();
        state.requests.move(-1);
      }
      return;
    }
    if (event.key === '/') {
      var search = document.getElementById('log-search');
      if (search) {
        event.preventDefault();
        search.focus();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault();
      state.view.move(1);
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault();
      state.view.move(-1);
    }
  }

  function setNav(open) {
    var workspace = document.getElementById('workspace');
    if (!workspace) return;
    workspace.className = 'workspace' + (open ? ' nav-open' : '');
    var button = document.querySelector('[data-action="menu"]');
    if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function closeNav() {
    setNav(false);
  }

  function wire(app) {
    app.addEventListener('submit', onSubmit);
    app.addEventListener('click', onClick);
    app.addEventListener('input', onInput);
    app.addEventListener('focusin', function (event) {
      if (event.target && event.target.id === 'origin') refreshPorts(false);
    });
    app.addEventListener('change', onInput);
    document.addEventListener('keydown', onKey);
    app.addEventListener('scroll', onScroll, true);
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', function () { if (state.view) state.view.render(); });
    }
  }

  function boot(app) {
    state.app = app;
    api.theme.apply();
    wire(app);
    renderChecking(app);
    refresh().catch(function (err) {
      var status = document.getElementById('probe-status');
      if (status) status.textContent = err.message;
    });
    state.timer = setInterval(function () {
      if (document.hidden || state.phase !== 'workspace') return;
      poll();
    }, POLL_MS);
  }

  function start() {
    if (typeof document === 'undefined') return;
    var app = document.getElementById('app');
    if (!app) return;
    api.lang = api.langPref.choose(typeof navigator !== 'undefined' && navigator ? navigator.language : '');
    if (document.documentElement) document.documentElement.lang = api.lang;
    var protocol = typeof location !== 'undefined' && location ? location.protocol : 'http:';
    if (protocol === 'file:') {
      renderFileGate(app);
      return;
    }
    boot(app);
  }

  if (typeof document !== 'undefined' && document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  api.request = api_;
  api.needsConfirm = needsConfirm;
  api.armedLabel = armedLabel;
  api.confirmStep = confirmStep;
  api.renderFileGate = renderFileGate;
  api.renderChecking = renderChecking;
  api.renderAuthGate = renderAuthGate;
  api.renderPhase = renderPhase;
})(globalThis);
