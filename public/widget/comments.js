// trydash: the "Comment" button that the preview adds to each page.
// Served by trydash's proxy at /__trydash/comments.js, never by the site. It lives in a
// shadow root, so the site's styles and the widget's don't touch each other.
(function () {
  'use strict';

  if (window.__trydashComments) return;
  window.__trydashComments = true;

  var API = '/__trydash/comments';
  // A screenshot for the dashboard asks for the client's language and a clean bubble.
  var shotMode = /[#&]trydash-shot=1\b/.test(location.hash);
  var hashLang = /[#&]trydash-lang=([a-z]{2})\b/i.exec(location.hash);
  var it = /^it\b/i.test(hashLang ? hashLang[1] : (navigator.language || ''));
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
    edit: 'Modifica',
    save: 'Salva',
    remove: 'Elimina',
    removeSure: 'Elimina davvero',
    removed: 'Commento eliminato',
    edited: 'modificato',
    bigger: 'Elemento più grande',
    smaller: 'Elemento più piccolo',
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
    edit: 'Edit',
    save: 'Save',
    remove: 'Delete',
    removeSure: 'Really delete',
    removed: 'Comment deleted',
    edited: 'edited',
    bigger: 'Bigger element',
    smaller: 'Smaller element',
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
    // The bar lets the pointer through to the page; only its Cancel button takes clicks.
    '.hint { position: fixed; left: 50%; top: 12px; bottom: auto; transform: translateX(-50%); z-index: 2147483646; display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 24px); padding: 6px 6px 6px 12px; border-radius: 10px; background: rgba(31,41,55,.92); color: #fff; font-size: 13px; pointer-events: none; transition: top .2s, bottom .2s; }',
    '.hint.low { top: auto; bottom: 12px; }',
    '.hint .btn { pointer-events: auto; padding: 5px 10px; font-size: 13px; border-color: rgba(255,255,255,.4); background: transparent; color: #fff; }',
    '.pins.dim .pin { opacity: .3; pointer-events: none; }',
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
    '.target { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #6b7280; }',
    '.target code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px ui-monospace, monospace; color: #c2410c; }',
    '.mini { padding: 2px 8px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; color: #1f2937; font-size: 12px; cursor: pointer; }',
    '.mini:disabled { opacity: .4; cursor: default; }',
    '.btn.danger { color: #b42318; border-color: #f3b4ab; }',
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
    hl.style.display = 'none';
  }

  // The keys that let this browser change its own anonymous comments.
  function editKeys() {
    try { return JSON.parse(localStorage.getItem('trydash-comment-keys') || '{}') || {}; } catch (err) { return {}; }
  }
  function saveEditKey(id, key) {
    var keys = editKeys();
    if (key) keys[id] = key;
    else delete keys[id];
    try { localStorage.setItem('trydash-comment-keys', JSON.stringify(keys)); } catch (err) { /* private mode */ }
  }

  function highlight(el) {
    if (!el) { hl.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
  }

  // Everything under the point, smallest first: an invisible overlay (a card's link, a
  // slider) doesn't hide the text or the picture under it.
  function stackAt(x, y) {
    var all = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
    var seen = [];
    all.forEach(function (el) {
      if (!el || el === hostNode || el === document.documentElement || el === document.body) return;
      if (hostNode.contains(el)) return;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      seen.push({ el: el, area: r.width * r.height });
    });
    seen.sort(function (a, b) { return a.area - b.area; });
    return seen.map(function (item) { return item.el; });
  }

  function label(el) {
    var text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    return '<' + el.tagName.toLowerCase() + '>' + (text ? ' ' + (text.length > 40 ? text.slice(0, 39) + '…' : text) : '');
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

  function button(text, cls, onClick) {
    var node = make('button', cls, text);
    node.type = 'button';
    node.addEventListener('click', function (e) {
      e.stopPropagation();
      onClick(node);
    });
    return node;
  }

  function changeComment(c, method, body) {
    return fetch(API + '/' + c.id, {
      method: method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ editKey: editKeys()[c.id] || null }, body || {})),
    }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  }

  // A pin opened: the comment, and for its author Edit and Delete.
  function showComment(c, x, y) {
    closePop();
    pop = make('div', 'pop');
    var when = new Date(c.at).toLocaleString(it ? 'it-IT' : 'en-US');
    pop.appendChild(make('div', 'meta', T.by + ' ' + (c.author || T.anon) + ' · ' + when + (c.editedAt ? ' · ' + T.edited : '')));
    var body = make('div', 'text', c.text);
    pop.appendChild(body);
    var row = make('div', 'row');
    var mine = !shotMode && (c.mine || !!editKeys()[c.id]);
    if (mine) {
      row.appendChild(button(T.remove, 'btn danger', function (node) {
        if (node.dataset.sure !== '1') {
          node.dataset.sure = '1';
          node.textContent = T.removeSure;
          return;
        }
        changeComment(c, 'DELETE').then(function () {
          saveEditKey(c.id, null);
          list = list.filter(function (item) { return item.id !== c.id; });
          closePop();
          drawPins();
          toast(T.removed);
        }).catch(function () { toast(T.failed); });
      }));
      row.appendChild(button(T.edit, 'btn', function () {
        var area = make('textarea');
        area.value = c.text;
        area.maxLength = 2000;
        body.replaceWith(area);
        row.replaceChildren(
          button(T.cancel, 'btn', function () { showComment(c, x, y); }),
          button(T.save, 'btn main', function (node) {
            var text = String(area.value || '').trim();
            if (!text) { area.focus(); return; }
            node.disabled = true;
            changeComment(c, 'PATCH', { text: text }).then(function (data) {
              Object.assign(c, data.comment);
              drawPins();
              showComment(c, x, y);
            }).catch(function () {
              node.disabled = false;
              toast(T.failed);
            });
          })
        );
        area.focus();
      }));
    }
    if (!shotMode) row.appendChild(button(T.close, 'btn', closePop));
    if (row.children.length) pop.appendChild(row);
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
          // Opened from the dashboard (or for its screenshot): straight to the pin, bubble open.
          var target = pins.querySelector('[data-id="' + m[1] + '"]');
          var wanted = list.filter(function (c) { return c.id === m[1]; })[0];
          if (target && wanted) {
            window.scrollTo(0, Math.max(0, parseFloat(target.style.top) - window.innerHeight / 3));
            target.classList.add('pulse');
            var r = target.getBoundingClientRect();
            showComment(wanted, r.left, r.top);
          }
        }
      })
      .catch(function () {});
  }

  var dodgeTimer = null;

  // While commenting, the button steps aside and the bar on top carries Cancel; nothing
  // of ours stays over the page for good.
  function setMode(on) {
    mode = on;
    fab.style.display = on ? 'none' : '';
    pins.className = 'pins' + (on ? ' dim' : '');
    hl.style.display = 'none';
    clearTimeout(dodgeTimer);
    dodgeTimer = null;
    if (on && !hint) {
      hint = make('div', 'hint');
      hint.appendChild(make('span', null, T.hint));
      var cancel = make('button', 'btn', T.cancel);
      cancel.type = 'button';
      cancel.addEventListener('click', function (e) {
        e.stopPropagation();
        setMode(false);
      });
      hint.appendChild(cancel);
      shadow.appendChild(hint);
    }
    if (!on && hint) {
      hint.remove();
      hint = null;
    }
    document.documentElement.style.cursor = on ? 'crosshair' : '';
  }

  // Resting on something the bar covers: the bar moves to the other edge. A quick pass on
  // the way to Cancel doesn't move it.
  function dodge(e) {
    if (!hint) return;
    var r = hint.getBoundingClientRect();
    var over = e.clientX >= r.left - 8 && e.clientX <= r.right + 8 && e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8;
    if (!over) {
      clearTimeout(dodgeTimer);
      dodgeTimer = null;
      return;
    }
    if (dodgeTimer) return;
    dodgeTimer = setTimeout(function () {
      dodgeTimer = null;
      if (hint) hint.classList.toggle('low');
    }, 350);
  }

  function ours(e) {
    return e.composedPath ? e.composedPath().indexOf(hostNode) >= 0 : e.target === hostNode;
  }

  function onMove(e) {
    if (!mode) return;
    if (ours(e)) {
      // On the Cancel button itself: stay put.
      clearTimeout(dodgeTimer);
      dodgeTimer = null;
      return;
    }
    dodge(e);
    highlight(stackAt(e.clientX, e.clientY)[0] || e.target);
  }

  function spotFor(el, x, y) {
    var r = el.getBoundingClientRect();
    return {
      selector: selectorOf(el),
      x: r.width ? Math.min(1, Math.max(0, (x - r.left) / r.width)) : 0,
      y: r.height ? Math.min(1, Math.max(0, (y - r.top) / r.height)) : 0,
      docX: Math.round(x + window.scrollX),
      docY: Math.round(y + window.scrollY),
      element: { tag: el.tagName.toLowerCase(), text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) },
    };
  }

  function onPick(e) {
    if (!mode || ours(e)) return;
    e.preventDefault();
    e.stopPropagation();
    var stack = stackAt(e.clientX, e.clientY);
    if (!stack.length) stack = [e.target];
    setMode(false);
    ask(stack, e.clientX, e.clientY);
  }

  // The new comment: the element it is about (▲ ▼ to pick a bigger or smaller one), the text.
  function ask(stack, x, y) {
    closePop();
    var index = 0;
    var spot = spotFor(stack[0], x, y);
    pop = make('div', 'pop');
    var target = make('div', 'target');
    var code = make('code');
    var up = button('▲', 'mini', function () { pick(index + 1); });
    up.title = T.bigger;
    var down = button('▼', 'mini', function () { pick(index - 1); });
    down.title = T.smaller;
    target.appendChild(code);
    target.appendChild(up);
    target.appendChild(down);
    pop.appendChild(target);
    function pick(i) {
      index = Math.max(0, Math.min(stack.length - 1, i));
      spot = spotFor(stack[index], x, y);
      code.textContent = label(stack[index]);
      up.disabled = index >= stack.length - 1;
      down.disabled = index <= 0;
      highlight(stack[index]);
    }
    pick(0);
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
        if (data.editKey) saveEditKey(data.comment.id, data.editKey);
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
    if (shotMode) fab.style.display = 'none';
    // On <html>, not <body>: a positioned or margined body would shift the pins.
    document.documentElement.appendChild(hostNode);
    load();
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
