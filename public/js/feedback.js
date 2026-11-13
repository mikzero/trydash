(function (root) {
  'use strict';

  // The Comments tab: what clients wrote on the pages, with where, on which screen and
  // browser, and the JavaScript errors the page had. Resolve, copy, delete.
  var api = root.TryDash || (root.TryDash = {});
  var FILTERS = ['open', 'resolved', 'all'];

  function el(id) {
    return document.getElementById(id);
  }

  // The page as the client saw it, with the pin highlighted. With "links only", the owner's key.
  function commentUrl(session, comment) {
    if (!session || !session.url) return null;
    var base = session.url.replace(/\/+$/, '');
    var page = comment.page || '/';
    if (session.options && session.options.linksOnly && session.ownerKey) {
      page += (page.indexOf('?') >= 0 ? '&' : '?') + 'tdk=' + encodeURIComponent(session.ownerKey);
    }
    return base + page + '#trydash-comment=' + encodeURIComponent(comment.id);
  }

  // "Chrome 131 · macOS": enough to reproduce, no fingerprinting library.
  function browserOf(ua) {
    var text = String(ua || '');
    var name = /Edg\/(\d+)/.exec(text) ? 'Edge ' + /Edg\/(\d+)/.exec(text)[1]
      : /Firefox\/(\d+)/.exec(text) ? 'Firefox ' + /Firefox\/(\d+)/.exec(text)[1]
        : /Chrome\/(\d+)/.exec(text) ? 'Chrome ' + /Chrome\/(\d+)/.exec(text)[1]
          : /Version\/(\d+)[\d.]* .*Safari/.exec(text) ? 'Safari ' + /Version\/(\d+)/.exec(text)[1] : '';
    var os = /iPhone|iPad/.test(text) ? 'iOS' : /Android/.test(text) ? 'Android' : /Mac OS X/.test(text) ? 'macOS'
      : /Windows/.test(text) ? 'Windows' : /Linux/.test(text) ? 'Linux' : '';
    return [name, os].filter(Boolean).join(' · ');
  }

  function authorOf(comment) {
    return comment.author || api.t('ui.comments.anonymous');
  }

  function elementOf(comment) {
    if (!comment.element || !comment.element.tag) return '';
    var text = comment.element.text ? ' “' + (comment.element.text.length > 60 ? comment.element.text.slice(0, 59) + '…' : comment.element.text) + '”' : '';
    return '<' + comment.element.tag + '>' + text;
  }

  function screenOf(comment) {
    var v = comment.viewport || {};
    return v.w && v.h ? v.w + '×' + v.h : '';
  }

  // One comment as Markdown, for an issue or a chat.
  function commentMarkdown(session, comment) {
    var when = new Date(comment.at).toLocaleString(api.locale ? api.locale() : undefined);
    var lines = ['**' + authorOf(comment) + '** · ' + when + ' · `' + comment.page + '`' + (comment.title ? ' (“' + comment.title + '”)' : '')];
    lines.push('> ' + String(comment.text).split('\n').join('\n> '));
    var details = [elementOf(comment) ? '`' + elementOf(comment) + '`' : '', screenOf(comment), browserOf(comment.userAgent)].filter(Boolean);
    if (details.length) lines.push(details.join(' · '));
    if (comment.errors && comment.errors.length) lines.push(api.t('ui.comments.errorsLabel') + ':\n' + comment.errors.map(function (e) { return '- `' + e + '`'; }).join('\n'));
    var link = commentUrl(session, comment);
    if (link) lines.push(link.replace(/[?&]tdk=[^#&]+/, ''));
    return lines.join('\n');
  }

  function buildCommentsPane() {
    var h = api.h;
    return h('div', { id: 'pane-comments', className: 'tab-pane clients-pane', role: 'tabpanel', 'aria-labelledby': 'tab-comments', hidden: true }, [
      h('div', { className: 'clients-head' }, [
        h('p', { id: 'comments-intro', className: 'quick-note', text: api.t('ui.comments.intro') }),
        h('label', { id: 'comments-on-label', className: 'check' }, [
          h('input', { id: 'comments-on', type: 'checkbox' }),
          h('span', { text: api.t('ui.comments.toggle') }),
        ]),
      ]),
      h('div', { className: 'log-toolbar comments-toolbar' }, [
        h('div', { id: 'comments-chips', className: 'chips', role: 'group', 'aria-label': api.t('ui.comments.filter') }),
        h('button', { type: 'button', className: 'chip', text: api.t('ui.comments.copyAll'), dataset: { action: 'copy-comments' } }),
      ]),
      h('div', { id: 'comments-list', className: 'links-list' }),
    ]);
  }

  function createCommentsView(fetchJson) {
    var h = api.h;
    var state = { sessionId: null, version: -1, comments: [], filter: 'open', loading: false };

    function visible() {
      return state.comments.filter(function (c) {
        return state.filter === 'all' || (state.filter === 'resolved' ? c.resolved : !c.resolved);
      });
    }

    function card(session, comment, nowMs) {
      var url = commentUrl(session, comment);
      var errors = comment.errors || [];
      return h('div', { className: 'link-card comment-card' + (comment.resolved ? ' is-revoked' : ''), dataset: { comment: comment.id } }, [
        h('div', { className: 'link-top' }, [
          h('strong', { className: 'link-name', text: authorOf(comment) }),
          comment.linkId && comment.linkId !== 'owner' ? h('span', { className: 'req-tag q-client', text: api.t('ui.comments.viaLink') }) : null,
          comment.resolved ? h('span', { className: 'req-tag q-delivered', text: api.t('ui.comments.resolvedTag') }) : null,
          h('span', { className: 'link-seen', title: comment.at, text: api.relativeTime(comment.at, nowMs) }),
        ]),
        h('p', { className: 'comment-text', text: comment.text }),
        h('p', { className: 'comment-where mono' }, [
          url ? h('a', { href: url, target: '_blank', rel: 'noopener', text: comment.page + ' ↗' }) : h('span', { text: comment.page }),
          comment.title ? h('span', { className: 'comment-title', text: ' · ' + comment.title }) : null,
        ]),
        h('p', { className: 'comment-meta', text: [elementOf(comment), screenOf(comment), browserOf(comment.userAgent)].filter(Boolean).join(' · ') }),
        errors.length ? h('details', { className: 'comment-errors' }, [
          h('summary', { text: api.tn('ui.comments.errors', errors.length) }),
          h('ul', null, errors.map(function (e) { return h('li', { className: 'mono', text: e }); })),
        ]) : null,
        h('div', { className: 'req-actions' }, [
          h('button', { type: 'button', className: 'btn' + (comment.resolved ? '' : ' inv'), text: comment.resolved ? api.t('ui.comments.reopen') : api.t('ui.comments.resolve'), dataset: { action: 'resolve-comment', comment: comment.id } }),
          h('button', { type: 'button', className: 'btn', text: api.t('ui.comments.copy'), dataset: { action: 'copy-comment', comment: comment.id } }),
          h('button', { type: 'button', className: 'btn danger', text: api.t('ui.comments.remove'), dataset: { action: 'delete-comment', comment: comment.id } }),
        ]),
      ]);
    }

    function paintChips() {
      var box = el('comments-chips');
      if (!box) return;
      var open = state.comments.filter(function (c) { return !c.resolved; }).length;
      var counts = { open: open, resolved: state.comments.length - open, all: state.comments.length };
      box.replaceChildren.apply(box, FILTERS.map(function (name) {
        return h('button', {
          type: 'button',
          className: 'chip' + (state.filter === name ? ' is-on' : ''),
          'aria-pressed': state.filter === name ? 'true' : 'false',
          text: api.t('ui.comments.f.' + name) + ' · ' + counts[name],
          dataset: { action: 'comments-filter', filter: name },
        });
      }));
    }

    function render(session) {
      var list = el('comments-list');
      if (!list) return;
      paintChips();
      var on = el('comments-on');
      if (on) on.checked = !!(session && session.options && session.options.comments);
      var label = el('comments-on-label');
      var inspect = session && session.inspect && session.inspect.enabled;
      if (label) label.hidden = !inspect;
      if (!inspect) {
        list.replaceChildren(h('p', { className: 'quick-note', text: api.t('ui.comments.needsInspector') }));
        return;
      }
      var items = visible();
      if (!items.length) {
        list.replaceChildren(h('p', { className: 'links-empty', text: state.comments.length ? api.t('ui.comments.noneHere') : api.t(session.options.comments ? 'ui.comments.emptyOn' : 'ui.comments.emptyOff') }));
        return;
      }
      var nowMs = Date.now();
      list.replaceChildren.apply(list, items.map(function (c) { return card(session, c, nowMs); }));
    }

    // Asks the server again only when the session's comments version moved.
    function refresh(session, force) {
      if (!session) return Promise.resolve();
      var version = session.comments ? session.comments.version : 0;
      if (session.id !== state.sessionId) {
        state.sessionId = session.id;
        state.version = -1;
        state.comments = [];
      }
      if (!force && version === state.version) {
        // Nothing new: only the switch follows the options, the cards stay as they are.
        var on = el('comments-on');
        if (on) on.checked = !!(session.options && session.options.comments);
        return Promise.resolve();
      }
      if (state.loading) return Promise.resolve();
      state.loading = true;
      return fetchJson('/api/sessions/' + encodeURIComponent(session.id) + '/comments').then(function (data) {
        state.loading = false;
        if (state.sessionId !== session.id) return;
        state.version = data.version;
        state.comments = data.comments || [];
        render(session);
      }, function () {
        state.loading = false;
      });
    }

    return {
      refresh: refresh,
      setFilter: function (name, session) {
        state.filter = FILTERS.indexOf(name) >= 0 ? name : 'open';
        render(session);
      },
      get: function (id) {
        for (var i = 0; i < state.comments.length; i += 1) if (state.comments[i].id === id) return state.comments[i];
        return null;
      },
      visible: visible,
    };
  }

  api.commentUrl = commentUrl;
  api.browserOf = browserOf;
  api.commentMarkdown = commentMarkdown;
  api.buildCommentsPane = buildCommentsPane;
  api.createCommentsView = createCommentsView;
})(globalThis);
