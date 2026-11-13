// trydash: the "Comment" button that the preview adds to each page.
// Served by trydash's proxy at /__trydash/comments.js, never by the site. It lives in a
// shadow root, so the site's styles and the widget's don't touch each other.
(function () {
  'use strict';

  if (window.__trydashComments) return;
  window.__trydashComments = true;

  var API = '/__trydash/comments';
  var it = /^it\b/i.test(navigator.language || '');
  var T = it ? {
    button: 'Commenta',
    hint: 'Clicca sul punto da commentare · Esc per annullare',
    placeholder: 'Cosa vuoi dire su questo punto?',
    name: 'Il tuo nome',
    send: 'Invia',
    cancel: 'Annulla',
    sent: 'Grazie, commento inviato',
    failed: 'Non sono riuscito a inviare il commento. Riprova.',
    by: 'di',
    anon: 'anonimo',
    close: 'Chiudi',
  } : {
    button: 'Comment',
    hint: 'Click the spot to comment on · Esc to cancel',
    placeholder: 'What would you like to say about this spot?',
    name: 'Your name',
    send: 'Send',
    cancel: 'Cancel',
    sent: 'Thanks, comment sent',
    failed: 'The comment could not be sent. Please try again.',
    by: 'by',
    anon: 'anonymous',
    close: 'Close',
  };

  // JavaScript errors on the page go with the comment: often they are the real problem.
  var errors = [];
  function keepError(text) {
    if (errors.length < 10) errors.push(String(text).slice(0, 300));
  }
  window.addEventListener('error', function (e) {
    var where = e.filename ? ' (' + String(e.filename).split('/').pop() + ':' + e.lineno + ')' : '';
    keepError((e.message || 'Error') + where);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    keepError('Unhandled rejection: ' + (reason && reason.message ? reason.message : String(reason)));
  });
  var consoleError = console.error;
  console.error = function () {
    try { keepError(Array.prototype.map.call(arguments, String).join(' ')); } catch (err) { /* ignore */ }
    return consoleError.apply(this, arguments);
  };

  var CSS = [
    ':host { all: initial; }',
    '* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }',
    '.fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; display: inline-flex; align-items: center; gap: 6px; padding: 10px 14px; border: 0; border-radius: 999px; background: #1f2937; color: #fff; font-size: 14px; font-weight: 600; box-shadow: 0 6px 20px rgba(0,0,0,.25); cursor: pointer; }',
    '.fab.on { background: #c2410c; }',
    '.hint { position: fixed; left: 50%; top: 12px; transform: translateX(-50%); z-index: 2147483646; padding: 8px 12px; border-radius: 8px; background: #1f2937; color: #fff; font-size: 13px; pointer-events: none; }',
    '.hl { position: fixed; z-index: 2147483645; border: 2px solid #c2410c; background: rgba(194,65,12,.08); border-radius: 4px; pointer-events: none; display: none; }',
    '.pins { position: absolute; left: 0; top: 0; width: 0; height: 0; }',
    '.pin { position: absolute; z-index: 2147483644; width: 26px; height: 26px; margin: -13px 0 0 -13px; border: 2px solid #fff; border-radius: 50% 50% 50% 0; background: #c2410c; color: #fff; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(0,0,0,.3); cursor: pointer; }',
    '.pin.pulse { animation: pulse 1s ease-in-out 3; }',
    '@keyframes pulse { 50% { transform: scale(1.5); } }',
    '.pop { position: fixed; z-index: 2147483647; width: min(320px, calc(100vw - 24px)); padding: 12px; border-radius: 12px; background: #fff; color: #1f2937; box-shadow: 0 10px 30px rgba(0,0,0,.3); display: grid; gap: 8px; font-size: 14px; }',
    '.pop textarea, .pop input { width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; color: #111827; background: #fff; }',
    '.pop textarea { min-height: 84px; resize: vertical; }',
    '.row { display: flex; gap: 8px; justify-content: flex-end; }',
    '.btn { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; color: #1f2937; font-size: 14px; cursor: pointer; }',
    '.btn.main { border-color: #1f2937; background: #1f2937; color: #fff; }',
    '.meta { font-size: 12px; color: #6b7280; }',
    '.text { white-space: pre-wrap; overflow-wrap: anywhere; }',
    '.toast { position: fixed; right: 16px; bottom: 70px; z-index: 2147483647; padding: 10px 14px; border-radius: 8px; background: #1f2937; color: #fff; font-size: 14px; }',
  ].join('\n');

  var hostNode = document.createElement('trydash-comments');
  hostNode.setAttribute('style', 'all: initial; position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647;');
  var shadow = hostNode.attachShadow ? hostNode.attachShadow({ mode: 'open' }) : hostNode;
  try {
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch (err) {
    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
  }

  function make(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  var fab = make('button', 'fab', '💬 ' + T.button);
  fab.type = 'button';
  var hl = make('div', 'hl');
  var pins = make('div', 'pins');
  shadow.appendChild(pins);
  shadow.appendChild(hl);
  shadow.appendChild(fab);

  var me = null;
  var list = [];
  var mode = false;
  var pop = null;
  var hint = null;

  function toast(text) {
    var node = make('div', 'toast', text);
    shadow.appendChild(node);
    setTimeout(function () { node.remove(); }, 3000);
  }

  function closePop() {
    if (pop) pop.remove();
    pop = null;
  }

  function place(node, x, y) {
    var w = 320;
    var left = Math.max(12, Math.min(x + 12, window.innerWidth - w - 12));
    var top = Math.max(12, Math.min(y + 12, window.innerHeight - 260));
    node.style.left = left + 'px';
    node.style.top = top + 'px';
  }

  // A CSS path that finds the element again: an id when unique, else tags with their position.
  function selectorOf(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && parts.length < 8) {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll('#' + el.id).length === 1) {
        parts.unshift('#' + el.id);
        return parts.join(' > ');
      }
      var i = 1;
      var sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i += 1;
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    if (el === document.body) parts.unshift('body');
    return parts.join(' > ');
  }

  function find(selector) {
    try { return selector ? document.querySelector(selector) : null; } catch (err) { return null; }
  }

  function pinPosition(c) {
    var el = find(c.selector);
    if (el) {
      var r = el.getBoundingClientRect();
      if (r.width || r.height) return { x: r.left + window.scrollX + r.width * c.x, y: r.top + window.scrollY + r.height * c.y };
    }
    return { x: c.docX || 0, y: c.docY || 0 };
  }

  function drawPins() {
    pins.replaceChildren();
    list.forEach(function (c, i) {
      var pos = pinPosition(c);
      var pin = make('div', 'pin', String(i + 1));
      pin.style.left = pos.x + 'px';
      pin.style.top = pos.y + 'px';
      pin.dataset.id = c.id;
      pin.title = (c.author || T.anon) + ': ' + c.text;
      pin.addEventListener('click', function (e) {
        e.stopPropagation();
        showComment(c, e.clientX, e.clientY);
      });
      pins.appendChild(pin);
    });
  }

  function showComment(c, x, y) {
    closePop();
    pop = make('div', 'pop');
    pop.appendChild(make('div', 'meta', T.by + ' ' + (c.author || T.anon) + ' · ' + new Date(c.at).toLocaleString(it ? 'it-IT' : 'en-US')));
    pop.appendChild(make('div', 'text', c.text));
    var row = make('div', 'row');
    var close = make('button', 'btn', T.close);
    close.type = 'button';
    close.addEventListener('click', closePop);
    row.appendChild(close);
    pop.appendChild(row);
    place(pop, x, y);
    shadow.appendChild(pop);
  }

  function page() {
    return location.pathname + location.search;
  }

  function load() {
    fetch(API + '?page=' + encodeURIComponent(page()), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        me = data.me || null;
        list = data.comments || [];
        drawPins();
        var m = /trydash-comment=([\w-]+)/.exec(location.hash);
        if (m) {
          var target = pins.querySelector('[data-id="' + m[1] + '"]');
          if (target) {
            window.scrollTo({ top: Math.max(0, parseFloat(target.style.top) - window.innerHeight / 3), behavior: 'smooth' });
            target.classList.add('pulse');
          }
        }
      })
      .catch(function () {});
  }

  function setMode(on) {
    mode = on;
    fab.className = 'fab' + (on ? ' on' : '');
    fab.textContent = on ? '✕ ' + T.cancel : '💬 ' + T.button;
    hl.style.display = 'none';
    if (on && !hint) {
      hint = make('div', 'hint', T.hint);
      shadow.appendChild(hint);
    }
    if (!on && hint) {
      hint.remove();
      hint = null;
    }
    document.documentElement.style.cursor = on ? 'crosshair' : '';
  }

  function ours(e) {
    return e.composedPath ? e.composedPath().indexOf(hostNode) >= 0 : e.target === hostNode;
  }

  function onMove(e) {
    if (!mode || ours(e)) return;
    var r = e.target.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
  }

  function onPick(e) {
    if (!mode || ours(e)) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    var r = el.getBoundingClientRect();
    var spot = {
      selector: selectorOf(el),
      x: r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0,
      y: r.height ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : 0,
      docX: Math.round(e.clientX + window.scrollX),
      docY: Math.round(e.clientY + window.scrollY),
      element: { tag: el.tagName.toLowerCase(), text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) },
    };
    setMode(false);
    ask(spot, e.clientX, e.clientY);
  }

  function ask(spot, x, y) {
    closePop();
    pop = make('div', 'pop');
    var text = make('textarea');
    text.placeholder = T.placeholder;
    text.maxLength = 2000;
    pop.appendChild(text);
    var name = null;
    if (!me) {
      name = make('input');
      name.placeholder = T.name;
      name.maxLength = 60;
      try { name.value = localStorage.getItem('trydash-comment-name') || ''; } catch (err) { /* private mode */ }
      pop.appendChild(name);
    }
    var row = make('div', 'row');
    var cancel = make('button', 'btn', T.cancel);
    cancel.type = 'button';
    cancel.addEventListener('click', closePop);
    var send = make('button', 'btn main', T.send);
    send.type = 'button';
    send.addEventListener('click', function () {
      var body = String(text.value || '').trim();
      if (!body) { text.focus(); return; }
      var author = name ? String(name.value || '').trim() : '';
      if (name) { try { localStorage.setItem('trydash-comment-name', author); } catch (err) { /* private mode */ } }
      send.disabled = true;
      fetch(API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: page(),
          title: document.title.slice(0, 200),
          text: body,
          name: author,
          selector: spot.selector,
          x: spot.x,
          y: spot.y,
          docX: spot.docX,
          docY: spot.docY,
          element: spot.element,
          viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
          errors: errors.slice(),
        }),
      }).then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      }).then(function (data) {
        closePop();
        list.push(data.comment);
        drawPins();
        toast(T.sent);
      }).catch(function () {
        send.disabled = false;
        toast(T.failed);
      });
    });
    row.appendChild(cancel);
    row.appendChild(send);
    pop.appendChild(row);
    place(pop, x, y);
    shadow.appendChild(pop);
    text.focus();
  }

  fab.addEventListener('click', function (e) {
    e.stopPropagation();
    closePop();
    setMode(!mode);
  });
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onPick, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (mode) setMode(false);
    closePop();
  });
  var redraw = null;
  window.addEventListener('resize', function () {
    clearTimeout(redraw);
    redraw = setTimeout(drawPins, 150);
  });
  window.addEventListener('load', drawPins);
  // Single-page apps change page without a reload: the pins follow.
  function reloadSoon() { setTimeout(load, 300); }
  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    history[name] = function () {
      var out = original.apply(this, arguments);
      reloadSoon();
      return out;
    };
  });
  window.addEventListener('popstate', reloadSoon);

  function mount() {
    // On <html>, not <body>: a positioned or margined body would shift the pins.
    document.documentElement.appendChild(hostNode);
    load();
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
