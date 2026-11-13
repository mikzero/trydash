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
    saved: null,
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
    if (state.scanningPorts) return;
    fetch('/api/ports').then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (data) {
      if (data) state.lastPorts = data.ports;
      if (data && !state.scanningPorts) api.paintPortHints(document.getElementById('create-form'), data.ports);
    }, function () {});
  }

  // The full scan: every listening port asked once what it is. Takes a second or two.
  function scanPorts() {
    if (state.scanningPorts) return;
    state.scanningPorts = true;
    var form = document.getElementById('create-form');
    api.paintPortHints(form, state.lastPorts || [], true);
    fetch('/api/ports?scan=1').then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (data) {
      state.scanningPorts = false;
      portsAt = Date.now();
      var ports = data ? data.ports : [];
      api.paintPortHints(form, ports);
      var web = ports.filter(function (item) { return item.scan && item.scan.http; }).length;
      notify(web ? api.tn('ui.ports.found', web) : api.t('ui.ports.none'));
    }, function () {
      state.scanningPorts = false;
      refreshPorts(true);
    });
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
    if (state.comments && session) state.comments.refresh(session);
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
    if (state.saved) state.saved.update(session);
  }

  function setTab(tab) {
    state.tab = ['requests', 'saved', 'clients', 'comments'].indexOf(tab) >= 0 ? tab : 'log';
    if (state.tab === 'comments' && state.comments) state.comments.refresh(currentSession(), true);
    api.showTab(state.tab);
    if (state.requests) state.requests.setActive(state.tab === 'requests');
    if (state.saved) state.saved.setActive(state.tab === 'saved');
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

  function paintNotifyToggle() {
    var button = document.getElementById('notify-toggle');
    if (!button || !api.notifications) return;
    var on = api.notifications.enabled();
    button.textContent = on ? '🔔' : '🔕';
    button.title = api.t(on ? 'ui.notify.turnOff' : 'ui.notify.turnOn');
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // "New comment from Mario: …", for the newest ones (at most three at a time).
  function announceComments(session, count) {
    api_('GET', '/api/sessions/' + encodeURIComponent(session.id) + '/comments').then(function (data) {
      (data.comments || []).slice(0, Math.min(count, 3)).forEach(function (comment) {
        var who = comment.author || api.t('ui.comments.anonymous');
        var title = api.t('ui.comments.new', { name: who });
        notify(title + ': ' + (comment.text.length > 80 ? comment.text.slice(0, 79) + '…' : comment.text));
        if (api.notifications) api.notifications.show(title, comment.text, { tag: session.id + ':comment:' + comment.id });
      });
      if (state.comments && session.id === state.currentId) state.comments.refresh(session, true);
    }).catch(function () {});
  }

  function announceTransitions(sessions) {
    var next = {};
    var nowMs = Date.now();
    sessions.forEach(function (session) {
      var prev = state.prevById[session.id];
      if (api.notifications) {
        api.notifications.noticesFor(prev, session, nowMs).forEach(function (notice) {
          api.notifications.show(notice.title, notice.body, {
            tag: session.id + ':' + notice.kind,
            onClick: function () {
              state.currentId = session.id;
              resetView();
              writeHash(session.id);
              paintShell();
            },
          });
        });
      }
      if (prev && api.firstVisits) {
        api.firstVisits(prev.links, session.links).forEach(function (link) {
          var text = api.t('ui.clients.opened', { name: link.name });
          notify(text);
          if (api.notifications) api.notifications.show(text, session.url ? session.url.replace(/^https?:\/\//, '') : '', { tag: session.id + ':link:' + link.id });
        });
      }
      var before = prev && prev.comments ? prev.comments.total : null;
      if (before != null && session.comments && session.comments.total > before) announceComments(session, session.comments.total - before);
      if (prev && prev.status !== session.status) {
        if (session.status === 'running' && session.url) notify(api.t('ui.toast.newUrl', { url: session.url }));
        if (session.status === 'stopped' && session.expired) notify(api.t('ui.toast.expired'));
        if (session.status === 'exited') {
          notify(api.t('ui.toast.exited', { code: session.exitCode == null ? '?' : session.exitCode }), 'error');
        }
      }
      next[session.id] = { status: session.status, lastOriginError: session.lastOriginError, links: session.links, comments: session.comments };
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
      state.saved = nextPhase === 'workspace' ? api.createSavedView() : null;
      state.comments = nextPhase === 'workspace' && api.createCommentsView ? api.createCommentsView(function (p) { return api_('GET', p); }) : null;
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
    ['no-tls-verify', 'http2-origin', 'queue'].forEach(function (id) {
      var node = form.querySelector('#' + id);
      if (node) node.checked = false;
    });
    var inspect = form.querySelector('#inspect');
    if (inspect) inspect.checked = true;
    var expires = form.querySelector('#expires');
    if (expires) expires.value = '';
    ['rewrite', 'badge', 'comments'].forEach(function (id) {
      var node = form.querySelector('#' + id);
      if (node) node.checked = false;
    });
    var noindex = form.querySelector('#noindex');
    if (noindex) noindex.checked = true;
    var blocked = form.querySelector('#blocked');
    if (blocked) blocked.value = '';
    ['mail-details', 'origin-details', 'preview-details'].forEach(function (id) {
      var node = form.querySelector('#' + id);
      if (node) node.open = false;
    });
    api.paintRecentMail(form);
    api.refreshCreateForm(form);
  }

  // Preview options change on the running tunnel: same URL, effect from the next request.
  async function updatePreview(patch, message) {
    var session = currentSession();
    if (!session) return;
    await api_('PATCH', '/api/sessions/' + encodeURIComponent(session.id) + '/options', patch);
    api.closePreview();
    notify(message);
    await refresh();
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

  // A personal link for one client, on the tunnel on screen.
  async function createLink() {
    var session = currentSession();
    if (!session) return;
    var input = api.readLinkForm();
    var body = { name: input.name };
    if (input.pin) body.pin = input.pin;
    await api_('POST', '/api/sessions/' + encodeURIComponent(session.id) + '/links', body);
    api.resetLinkForm();
    notify(api.t('ui.clients.created', { name: input.name }));
    await refresh();
  }

  function linkById(id) {
    var session = currentSession();
    var links = (session && session.links) || [];
    for (var i = 0; i < links.length; i += 1) if (links[i].id === id) return links[i];
    return null;
  }

  function onSubmit(event) {
    var form = event.target;
    if (form && form.id === 'link-form') {
      event.preventDefault();
      createLink().catch(fail);
      return;
    }
    if (!form || form.id !== 'create-form') return;
    event.preventDefault();
    createSession(form).catch(fail);
  }

  function onInput(event) {
    var target = event.target;
    if (!target) return;
    if (target.closest && target.closest('#create-form')) api.refreshCreateForm(document.getElementById('create-form'));
    if (target.id === 'comments-on' && event.type === 'change') {
      updatePreview({ comments: !!target.checked }, target.checked ? api.t('ui.comments.on') : api.t('ui.comments.off')).catch(fail);
    }
    if (target.id === 'links-only' && event.type === 'change') {
      updatePreview({ linksOnly: !!target.checked }, target.checked ? api.t('ui.clients.onlyOn') : api.t('ui.clients.onlyOff')).catch(fail);
    }
    if (target.id === 'req-queue' && event.type === 'change') {
      updatePreview({ queue: !!target.checked }, target.checked ? api.t('ui.queue.on') : api.t('ui.queue.off')).catch(fail);
    }
    if (target.id === 'saved-search' && state.saved) {
      state.saved.setQuery(target.value);
    }
    // A file picked for import lands in the text box, to look at before importing.
    if (target.id === 'saved-import-file' && event.type === 'change' && target.files && target.files[0] && typeof FileReader === 'function') {
      var reader = new FileReader();
      reader.onload = function () {
        var area = document.getElementById('saved-import-text');
        if (area) area.value = String(reader.result || '');
      };
      reader.readAsText(target.files[0]);
    }
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
    var node = event.target.closest ? event.target.closest('[data-action], [data-index], [data-session], [data-req], [data-saved]') : null;
    if (!node) return;
    var action = node.dataset.action;
    if (action === 'hello') {
      createHello(!!(node.closest && node.closest('#tunnel-warnings'))).catch(fail);
      return;
    }
    if (action === 'pick-port') {
      api.applyPortPick(document.getElementById('create-form'), node);
      return;
    }
    if (action === 'scan-ports') {
      scanPorts();
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
    if (action === 'notify') {
      api.notifications.toggle().then(function (on) {
        paintNotifyToggle();
        notify(api.t(on ? 'ui.notify.nowOn' : (typeof Notification === 'function' && Notification.permission === 'denied' ? 'ui.notify.denied' : 'ui.notify.nowOff')));
      });
      return;
    }
    if (action === 'lang') {
      // Every text is drawn once, so a new language is a reload away.
      api.langPref.set(api.langPref.other());
      if (typeof location !== 'undefined' && location.reload) location.reload();
      return;
    }
    if (action === 'theme') {
      api.theme.cycle();
      api.paintThemeToggle(node);
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
    if (action === 'qr') {
      var withUrl = currentSession();
      if (!api.closeQr() && withUrl && withUrl.url) api.openQr(withUrl.url);
      return;
    }
    if (action === 'qr-close') {
      api.closeQr();
      return;
    }
    if (action === 'comments-filter' && state.comments) {
      state.comments.setFilter(node.dataset.filter, currentSession());
      return;
    }
    if ((action === 'resolve-comment' || action === 'copy-comment' || action === 'delete-comment' || action === 'copy-comments') && state.comments) {
      var forComment = currentSession();
      if (!forComment) return;
      if (action === 'copy-comments') {
        var all = state.comments.visible().map(function (c) { return api.commentMarkdown(forComment, c); });
        if (all.length) copyText(all.join('\n\n---\n\n'), api.tn('ui.comments.copiedAll', all.length));
        return;
      }
      var comment = state.comments.get(node.dataset.comment);
      if (!comment) return;
      var commentPath = '/api/sessions/' + encodeURIComponent(forComment.id) + '/comments/' + encodeURIComponent(comment.id);
      if (action === 'copy-comment') {
        copyText(api.commentMarkdown(forComment, comment), api.t('ui.comments.copied'));
      } else if (action === 'resolve-comment') {
        api_('PATCH', commentPath, { resolved: !comment.resolved }).then(function () {
          notify(api.t(comment.resolved ? 'ui.comments.reopened' : 'ui.comments.resolved'));
          return refresh();
        }).catch(fail);
      } else if (node.dataset.armed === '1') {
        api_('DELETE', commentPath).then(function () {
          notify(api.t('ui.comments.removed'));
          return refresh();
        }).catch(fail);
      } else {
        node.dataset.armed = '1';
        node.textContent = api.t('ui.clients.confirmRemove');
        setTimeout(function () {
          if (node.dataset.armed !== '1') return;
          node.dataset.armed = '';
          node.textContent = api.t('ui.comments.remove');
        }, 4000);
      }
      return;
    }
    if (action === 'copy-link' || action === 'link-qr' || action === 'toggle-link' || action === 'delete-link') {
      var link = linkById(node.dataset.link);
      var forLink = currentSession();
      if (!link || !forLink) return;
      var linkPath = '/api/sessions/' + encodeURIComponent(forLink.id) + '/links/' + encodeURIComponent(link.id);
      if (action === 'copy-link') {
        copyText(api.linkUrl(forLink, link), api.t('ui.clients.copied', { name: link.name }));
      } else if (action === 'link-qr') {
        api.closePreview();
        api.closeQr();
        api.openQr(api.linkUrl(forLink, link));
      } else if (action === 'toggle-link') {
        api_('PATCH', linkPath, { revoked: !link.revoked }).then(function () {
          notify(api.t(link.revoked ? 'ui.clients.restored' : 'ui.clients.revoked', { name: link.name }));
          return refresh();
        }).catch(fail);
      } else if (node.dataset.armed === '1') {
        api_('DELETE', linkPath).then(function () {
          notify(api.t('ui.clients.removed', { name: link.name }));
          return refresh();
        }).catch(fail);
      } else {
        // Deleting a link breaks it for good: the first click asks, the second deletes.
        node.dataset.armed = '1';
        node.textContent = api.t('ui.clients.confirmRemove');
        setTimeout(function () {
          if (node.dataset.armed !== '1') return;
          node.dataset.armed = '';
          node.textContent = api.t('ui.clients.remove');
        }, 4000);
      }
      return;
    }
    if (action === 'deliver-queue' || action === 'drop-queue') {
      var forQueue = currentSession();
      if (!forQueue) return;
      var queuePath = '/api/sessions/' + encodeURIComponent(forQueue.id) + '/queue' + (action === 'deliver-queue' ? '/deliver' : '');
      api_(action === 'deliver-queue' ? 'POST' : 'DELETE', queuePath).then(function (data) {
        notify(action === 'deliver-queue'
          ? (data.left ? api.t('ui.queue.stillDown', { n: data.left }) : api.tn('ui.queue.delivered', data.delivered))
          : api.tn('ui.queue.dropped', data.dropped));
        return refresh();
      }).catch(fail);
      return;
    }
    if (action === 'block-preset') {
      api.addPreset(document.getElementById(node.dataset.target), node.dataset.preset);
      api.refreshCreateForm(document.getElementById('create-form'));
      return;
    }
    if (action === 'preview') {
      var forPreview = currentSession();
      if (!api.closePreview() && forPreview) {
        api.closeQr();
        api.openPreview(forPreview);
      }
      return;
    }
    if (action === 'preview-close') {
      api.closePreview();
      return;
    }
    if (action === 'preview-apply' || action === 'enable-rewrite') {
      var pop = document.getElementById('preview-pop');
      var patch = action === 'enable-rewrite' ? { rewrite: true } : api.readPreviewFields(pop, 'pv-');
      updatePreview(patch, action === 'enable-rewrite' ? api.t('ui.toast.rewriteOn') : api.t('ui.toast.previewSaved')).catch(fail);
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
    if (state.saved && savedAction(action, node)) return;
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
        api.closeQr();
        api.closePreview();
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

  function sentToast(row) {
    var result = row.status == null ? (row.error || api.t('ui.toast.noResponse')) : row.status;
    notify(api.t('ui.toast.sent', { result: result }), api.isProblemRequest(row) ? 'error' : 'info');
  }

  // Clicks inside the Saved tab; true when handled.
  function savedAction(action, node) {
    var view = state.saved;
    if (action === 'saved-import-open') {
      view.openImport();
      return true;
    }
    if (action === 'saved-close') {
      view.close();
      return true;
    }
    if (action === 'saved-import-go') {
      var area = document.getElementById('saved-import-text');
      var text = area ? String(area.value || '') : '';
      if (!text.trim()) return true;
      node.disabled = true;
      view.importText(text).then(function (data) {
        notify(api.t('ui.saved.imported', { n: data.added, format: data.format }));
      }, fail);
      return true;
    }
    if (action === 'saved-save') {
      view.save().then(function () { notify(api.t('ui.toast.saved')); }, fail);
      return true;
    }
    if (action === 'saved-send') {
      node.disabled = true;
      view.send().then(function (row) {
        node.disabled = false;
        if (row) sentToast(row);
      }, function (err) {
        node.disabled = false;
        fail(err);
      });
      return true;
    }
    if (action === 'saved-delete') {
      view.remove(node).then(function (gone) { if (gone) notify(api.t('ui.toast.savedRemoved')); }, fail);
      return true;
    }
    if (!action && node.dataset.saved) {
      view.select(node.dataset.saved);
      return true;
    }
    return false;
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
    if (action === 'save-request') {
      var current = view.detail();
      var sid = view.sessionId();
      if (!current || !sid) return true;
      api.request('POST', '/api/collection', { session: sid, seq: current.seq }).then(function () {
        notify(api.t('ui.toast.saved'));
        if (state.saved) state.saved.reload();
      }, fail);
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
      if (api.closeQr() || api.closePreview()) {
        event.preventDefault();
        return;
      }
      if (target.id === 'req-search' && target.value) {
        target.value = '';
        if (state.requests) state.requests.setQuery('');
        return;
      }
      if (state.tab === 'requests' && state.requests && state.requests.closeDetail()) {
        event.preventDefault();
        return;
      }
      if (state.tab === 'saved' && state.saved && state.saved.close()) {
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
