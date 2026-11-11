// The "how it works" animation in the hero: a fake trydash 2.0 window that plays
// five steps in a loop (start from the terminal, share the URL, see the requests,
// follow logs and traffic, publish a folder). The step buttons jump to a step; with reduced motion the final
// state is shown without animating.
(function () {
  var root = document.getElementById('demo');
  if (!root) return;
  var demo = root.querySelector('.demo');
  var el = {};
  root.querySelectorAll('[data-el]').forEach(function (node) { el[node.dataset.el] = node; });
  var buttons = Array.prototype.slice.call(root.querySelectorAll('[data-step]'));
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var t = window.trydashT;
  var locale = window.trydashLang === 'it' ? 'it-IT' : 'en-US';

  var URL = 'https://quiet-river-lamp.trycloudflare.com';
  var DURATIONS = [4200, 4300, 6800, 4600, 4400];
  var CANCEL = {};
  var run = 0;
  var clock = 0;

  function sleep(ms, fast) {
    var mine = run;
    if (fast) return Promise.resolve();
    return new Promise(function (resolve) { setTimeout(resolve, ms); }).then(function () {
      if (mine !== run) throw CANCEL;
    });
  }

  function toggle(node, name, on) { node.classList.toggle(name, on); }

  function time() {
    clock += 1 + Math.floor(Math.random() * 2);
    var d = new Date(Date.UTC(2026, 0, 1, 9, 41, 0) + clock * 1000);
    return d.toISOString().slice(11, 19);
  }

  function log(level, text, highlight) {
    var li = document.createElement('li');
    li.className = level + (highlight ? ' hl' : '');
    [['t', time()], ['l', level.toUpperCase()], ['m', text]].forEach(function (part) {
      var span = document.createElement('span');
      span.className = part[0];
      span.textContent = part[1];
      li.appendChild(span);
    });
    el.logs.appendChild(li);
    while (el.logs.children.length > 8) el.logs.removeChild(el.logs.firstChild);
  }

  function moveCursor(target, fast) {
    var box = demo.getBoundingClientRect();
    var r = target ? target.getBoundingClientRect() : box;
    var x = r.left - box.left + r.width * (target ? 0.6 : 0.5);
    var y = r.top - box.top + r.height * (target ? 0.55 : 0.6);
    if (fast) el.cursor.style.transition = 'none';
    el.cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    if (fast) { el.cursor.getBoundingClientRect(); el.cursor.style.transition = ''; }
  }

  function press(node, fast) {
    if (fast) return Promise.resolve();
    node.classList.add('press');
    return sleep(160).then(function () { node.classList.remove('press'); });
  }

  function type(node, text, speed, fast) {
    if (fast) { node.textContent = text; return Promise.resolve(); }
    var i = 0;
    function next() {
      if (i >= text.length) return Promise.resolve();
      node.textContent = text.slice(0, ++i);
      return sleep(speed).then(next);
    }
    return next();
  }

  function count(node, to, ms, fast) {
    if (fast) { node.textContent = to.toLocaleString(locale); return Promise.resolve(); }
    var steps = 20;
    var i = 0;
    function next() {
      if (i >= steps) return Promise.resolve();
      i += 1;
      node.textContent = Math.round((to * i) / steps).toLocaleString(locale);
      return sleep(ms / steps).then(next);
    }
    return next();
  }

  function request(method, status, path, opts) {
    var o = opts || {};
    var li = document.createElement('li');
    [['t', time()], ['mth', method], ['st', String(status)], ['p', path]].forEach(function (part) {
      var span = document.createElement('span');
      span.className = part[0] === 'st' ? 'd-st s' + String(status).charAt(0) : part[0];
      if (part[0] === 'p' && o.replay) {
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '↻ ';
        span.appendChild(tag);
        span.appendChild(document.createTextNode(part[1]));
      } else {
        span.textContent = part[1];
      }
      li.appendChild(span);
    });
    if (o.top) el.reqs.insertBefore(li, el.reqs.firstChild);
    else el.reqs.appendChild(li);
    el.rcount.textContent = String(el.reqs.children.length);
    return li;
  }

  function showTab(reqs) {
    toggle(el.main, 'reqs', reqs);
    toggle(el.treqs, 'on', reqs);
    toggle(el.tlogs, 'on', !reqs);
  }

  // Skipped steps leave no toast behind.
  function toast(text, fast) {
    if (fast) return Promise.resolve();
    el.toast.textContent = text;
    toggle(el.toast, 'show', true);
    return sleep(1300, fast).then(function () { if (!fast) toggle(el.toast, 'show', false); });
  }

  function reset() {
    clock = 0;
    toggle(el.term, 'hide', false);
    el.cmd.textContent = '';
    toggle(el.tout, 'show', false);
    el.addr.textContent = '127.0.0.1:8787';
    toggle(el.addr, 'token', false);
    el.port.textContent = '';
    toggle(el.port.parentNode, 'focus', false);
    toggle(el.session, 'show', false);
    toggle(el.session, 'live', false);
    toggle(el.folder, 'show', false);
    toggle(el.folder, 'live', false);
    el.sstate.textContent = t('starting');
    el.fstate.textContent = t('starting');
    el.bar.style.width = '0';
    toggle(el.empty, 'hide', false);
    toggle(el.head, 'show', false);
    toggle(el.tabs, 'show', false);
    toggle(el.stats, 'show', false);
    toggle(el.chip, 'live', false);
    el.chip.textContent = t('startingChip');
    toggle(el.url, 'live', false);
    el.url.textContent = t('waitingUrl');
    toggle(el.copy, 'ready', false);
    toggle(el.qrbtn, 'ready', false);
    toggle(el.qr, 'show', false);
    toggle(el.detail, 'show', false);
    showTab(false);
    el.inflight.textContent = '0';
    el.total.textContent = '0';
    el.rcount.textContent = '0';
    toggle(el.spark.parentNode, 'draw', false);
    el.logs.textContent = '';
    el.reqs.textContent = '';
    toggle(el.toast, 'show', false);
    toggle(el.cursor, 'show', false);
    moveCursor(null, true);
  }

  var STEPS = [
    // 1. `./trydash 3000`: the tunnel starts and the browser opens by itself, token included.
    function (fast) {
      return sleep(400, fast)
        .then(function () { return type(el.cmd, './trydash 3000', 80, fast); })
        .then(function () { return sleep(300, fast); })
        .then(function () { toggle(el.tout, 'show', true); return sleep(700, fast); })
        .then(function () {
          toggle(el.term, 'hide', true);
          el.addr.textContent = '127.0.0.1:8787/?token=k3fQ…';
          toggle(el.addr, 'token', true);
          toggle(el.empty, 'hide', true);
          toggle(el.session, 'show', true);
          toggle(el.head, 'show', true);
          toggle(el.tabs, 'show', true);
          log('inf', 'Starting tunnel · cloudflared 2026.10.0');
          return sleep(900, fast);
        })
        .then(function () {
          // The token moves into a cookie and leaves the address bar.
          el.addr.textContent = '127.0.0.1:8787';
          toggle(el.addr, 'token', false);
          log('inf', 'Requesting new quick Tunnel on trycloudflare.com…');
        });
    },
    // 2. The URL is live: copy it, then show it as a QR code.
    function (fast) {
      return sleep(700, fast)
        .then(function () {
          log('inf', '|  ' + URL + '  |', true);
          el.url.textContent = URL;
          toggle(el.url, 'live', true);
          el.chip.textContent = t('liveChip');
          toggle(el.chip, 'live', true);
          toggle(el.session, 'live', true);
          el.sstate.textContent = t('live');
          toggle(el.copy, 'ready', true);
          toggle(el.qrbtn, 'ready', true);
          toggle(el.cursor, 'show', true);
          return sleep(300, fast);
        })
        .then(function () { moveCursor(el.copy, fast); return sleep(800, fast); })
        .then(function () { return press(el.copy, fast); })
        .then(function () { return toast(t('urlCopied'), fast); })
        .then(function () { moveCursor(el.qrbtn, fast); return sleep(700, fast); })
        .then(function () { return press(el.qrbtn, fast); })
        .then(function () { toggle(el.qr, 'show', true); return sleep(1100, fast); });
    },
    // 3. Webhook requests come in; the failed one is opened and replayed.
    function (fast) {
      toggle(el.qr, 'show', false);
      var failed = null;
      return sleep(300, fast)
        .then(function () { moveCursor(el.treqs, fast); return sleep(700, fast); })
        .then(function () { showTab(true); request('GET', 200, '/'); return sleep(350, fast); })
        .then(function () { request('GET', 200, '/assets/app.js'); return sleep(450, fast); })
        .then(function () { failed = request('POST', 500, '/webhooks/stripe'); return sleep(600, fast); })
        .then(function () { moveCursor(failed, fast); return sleep(800, fast); })
        .then(function () { return press(failed, fast); })
        .then(function () { toggle(failed, 'sel', true); toggle(el.detail, 'show', true); return sleep(900, fast); })
        .then(function () { moveCursor(el.replay, fast); return sleep(800, fast); })
        .then(function () { return press(el.replay, fast); })
        .then(function () {
          toggle(failed, 'sel', false);
          toggle(el.detail, 'show', false);
          var again = request('POST', 200, '/webhooks/stripe', { replay: true });
          toggle(again, 'sel', true);
          return toast(t('replayed'), fast);
        });
    },
    // 4. Back to the logs: traffic and the edge connections.
    function (fast) {
      moveCursor(el.tlogs, fast);
      return sleep(700, fast)
        .then(function () {
          showTab(false);
          toggle(el.stats, 'show', true);
          toggle(el.spark.parentNode, 'draw', true);
          el.bar.style.width = '19%';
          log('inf', 'Registered tunnel connection connIndex=0 location=mxp01');
          return Promise.all([count(el.total, 1284, 2200, fast), count(el.inflight, 37, 1900, fast)]);
        })
        .then(function () { log('inf', 'Registered tunnel connection connIndex=1 location=fra08'); return sleep(600, fast); })
        .then(function () { log('inf', 'Registered tunnel connection connIndex=2 location=mxp02'); });
    },
    // 5. A second tunnel: a folder, published as it is.
    function (fast) {
      return sleep(200, fast)
        .then(function () { moveCursor(el.port.parentNode, fast); return sleep(800, fast); })
        .then(function () { toggle(el.port.parentNode, 'focus', true); return type(el.port, '~/site/dist', 95, fast); })
        .then(function () { return sleep(250, fast); })
        .then(function () { moveCursor(el.create, fast); return sleep(750, fast); })
        .then(function () { return press(el.create, fast); })
        .then(function () {
          el.port.textContent = '';
          toggle(el.port.parentNode, 'focus', false);
          toggle(el.folder, 'show', true);
          return sleep(1200, fast);
        })
        .then(function () {
          toggle(el.folder, 'live', true);
          el.fstate.textContent = t('live');
          if (!fast) toggle(el.cursor, 'show', false);
        });
    },
  ];

  function highlight(i, duration) {
    buttons.forEach(function (b, j) {
      b.classList.remove('on');
      b.setAttribute('aria-pressed', String(j === i));
    });
    var b = buttons[i];
    if (!b) return;
    b.style.setProperty('--dur', (reduced ? 0 : duration) + 'ms');
    b.getBoundingClientRect();
    b.classList.add('on');
  }

  function play(from) {
    run += 1;
    var mine = run;
    reset();
    var chain = Promise.resolve();
    for (var i = 0; i < from; i += 1) chain = chain.then(STEPS[i].bind(null, true));
    if (reduced) {
      chain.then(function () { return STEPS[from](true); }).then(function () { highlight(from, 0); });
      return;
    }
    function step(i) {
      if (mine !== run) return Promise.resolve();
      if (i === STEPS.length) return sleep(2500).then(function () { play(0); });
      var start = Date.now();
      highlight(i, DURATIONS[i]);
      return STEPS[i](false).then(function () {
        return sleep(Math.max(0, DURATIONS[i] - (Date.now() - start)));
      }).then(function () { return step(i + 1); });
    }
    chain.then(function () { return step(from); }).catch(function (err) { if (err !== CANCEL) throw err; });
  }

  buttons.forEach(function (b, i) { b.addEventListener('click', function () { play(i); }); });

  if (reduced) { play(STEPS.length - 1); return; }
  if (!('IntersectionObserver' in window)) { play(0); return; }
  var started = false;
  new IntersectionObserver(function (entries, observer) {
    if (started || !entries.some(function (e) { return e.isIntersecting; })) return;
    started = true;
    observer.disconnect();
    play(0);
  }, { threshold: 0.3 }).observe(demo);
})();
