(function (root) {
  'use strict';

  // The Clients tab: personal links for the people who look at the preview. Each one
  // says who opened it and when; it can have a PIN, and it can be revoked.
  var api = root.TryDash || (root.TryDash = {});

  function el(id) {
    return document.getElementById(id);
  }

  // The link a client gets: the tunnel's URL with the key. Null until the tunnel has a URL.
  function linkUrl(session, link) {
    if (!session || !session.url || !link) return null;
    return session.url.replace(/\/+$/, '') + '/?tdk=' + encodeURIComponent(link.key);
  }

  // The dashboard's own Open: with "links only", the owner's key lets you in.
  function ownerUrl(session) {
    if (!session || !session.url) return null;
    if (session.options && session.options.linksOnly && session.ownerKey) {
      return session.url.replace(/\/+$/, '') + '/?tdk=' + encodeURIComponent(session.ownerKey);
    }
    return session.url;
  }

  function buildClientsPane() {
    var h = api.h;
    return h('div', { id: 'pane-clients', className: 'tab-pane clients-pane', role: 'tabpanel', 'aria-labelledby': 'tab-clients', hidden: true }, [
      h('div', { className: 'clients-head' }, [
        h('p', { className: 'quick-note', text: api.t('ui.clients.intro') }),
        h('label', { id: 'links-only-label', className: 'check', title: api.t('ui.clients.onlyTitle') }, [
          h('input', { id: 'links-only', type: 'checkbox' }),
          h('span', { text: api.t('ui.clients.only') }),
        ]),
      ]),
      h('form', { id: 'link-form', className: 'link-form', autocomplete: 'off' }, [
        h('input', { id: 'link-name', type: 'text', className: 'input', maxlength: '60', placeholder: api.t('ui.clients.namePlaceholder'), 'aria-label': api.t('ui.clients.name') }),
        h('input', { id: 'link-pin', type: 'text', className: 'input mono', inputmode: 'numeric', maxlength: '8', placeholder: api.t('ui.clients.pinPlaceholder'), 'aria-label': api.t('ui.clients.pin') }),
        h('button', { type: 'submit', className: 'btn inv', text: api.t('ui.clients.create'), dataset: { action: 'create-link' } }),
      ]),
      h('div', { id: 'links-list', className: 'links-list' }),
    ]);
  }

  function seenText(link, nowMs) {
    if (!link.visits) return api.t('ui.clients.never');
    return api.tn('ui.clients.visits', link.visits) + ' · ' + api.t('ui.clients.last', { when: api.relativeTime(link.lastSeen, nowMs) });
  }

  function buildLink(session, link, nowMs) {
    var h = api.h;
    var url = linkUrl(session, link);
    return h('div', { className: 'link-card' + (link.revoked ? ' is-revoked' : ''), dataset: { link: link.id } }, [
      h('div', { className: 'link-top' }, [
        h('strong', { className: 'link-name', text: link.name }),
        link.hasPin ? h('span', { className: 'req-tag', title: api.t('ui.clients.pinTag'), text: 'PIN' }) : null,
        link.revoked ? h('span', { className: 'req-tag q-dropped', text: api.t('ui.clients.revokedTag') }) : null,
        h('span', { className: 'link-seen' + (link.visits ? ' is-seen' : ''), title: link.firstSeen ? api.t('ui.clients.first', { when: api.relativeTime(link.firstSeen, nowMs) }) : '', text: seenText(link, nowMs) }),
      ]),
      h('code', { className: 'link-url mono', text: url || api.t('ui.clients.noUrl') }),
      h('div', { className: 'req-actions' }, [
        h('button', { type: 'button', className: 'btn', disabled: !url || link.revoked, text: api.t('ui.clients.copy'), dataset: { action: 'copy-link', link: link.id } }),
        h('button', { type: 'button', className: 'btn', disabled: !url || link.revoked, text: 'QR', dataset: { action: 'link-qr', link: link.id } }),
        h('button', { type: 'button', className: 'btn', text: link.revoked ? api.t('ui.clients.restore') : api.t('ui.clients.revoke'), dataset: { action: 'toggle-link', link: link.id } }),
        h('button', { type: 'button', className: 'btn danger', text: api.t('ui.clients.remove'), dataset: { action: 'delete-link', link: link.id } }),
      ]),
    ]);
  }

  // Rebuilt only when something shown changes, so typing in the form is never disturbed.
  function paintClients(session, nowMs) {
    var list = el('links-list');
    if (!list || !session) return;
    var links = session.links || [];
    var only = el('links-only');
    if (only) only.checked = !!(session.options && session.options.linksOnly);
    var label = el('links-only-label');
    if (label) label.hidden = !(session.inspect && session.inspect.enabled);
    var at = nowMs == null ? Date.now() : nowMs;
    var sig = JSON.stringify([session.id, session.url, links, Math.floor(at / 60000)]);
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    var h = api.h;
    if (!(session.inspect && session.inspect.enabled)) {
      list.replaceChildren(h('p', { className: 'quick-note', text: api.t('ui.clients.needsInspector') }));
      return;
    }
    if (!links.length) {
      list.replaceChildren(h('p', { className: 'links-empty', text: api.t('ui.clients.empty') }));
      return;
    }
    list.replaceChildren.apply(list, links.map(function (link) { return buildLink(session, link, at); }));
  }

  function readLinkForm() {
    var name = el('link-name');
    var pin = el('link-pin');
    return { name: name ? String(name.value || '').trim() : '', pin: pin ? String(pin.value || '').trim() : '' };
  }

  function resetLinkForm() {
    var name = el('link-name');
    var pin = el('link-pin');
    if (name) name.value = '';
    if (pin) pin.value = '';
  }

  // "Mario opened the preview": once per link, the first time it is used.
  function firstVisits(prevLinks, links) {
    var before = {};
    (prevLinks || []).forEach(function (link) { before[link.id] = link; });
    return (links || []).filter(function (link) {
      var old = before[link.id];
      return old && !old.firstSeen && link.firstSeen;
    });
  }

  function linkCount(session) {
    return ((session && session.links) || []).filter(function (link) { return !link.revoked; }).length;
  }

  api.linkUrl = linkUrl;
  api.ownerUrl = ownerUrl;
  api.buildClientsPane = buildClientsPane;
  api.paintClients = paintClients;
  api.readLinkForm = readLinkForm;
  api.resetLinkForm = resetLinkForm;
  api.firstVisits = firstVisits;
  api.linkCount = linkCount;
})(globalThis);
