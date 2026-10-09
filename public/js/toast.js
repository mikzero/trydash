(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var MAX = 4;

  function toast(message, opts) {
    if (typeof document === 'undefined') return;
    var host = document.getElementById('toasts');
    if (!host) return;
    var kind = opts && opts.kind === 'error' ? 'error' : 'info';
    var node = api.h('div', { className: 'toast toast-' + kind, role: kind === 'error' ? 'alert' : 'status' }, [
      api.h('span', { className: 'toast-icon', 'aria-hidden': 'true', text: kind === 'error' ? '!' : '✓' }),
      api.h('span', { className: 'toast-text', text: message }),
    ]);
    var dismiss = function () { if (node.parentNode) node.remove(); };
    node.addEventListener('click', dismiss);
    host.append(node);
    while (host.children.length > MAX) host.children[0].remove();
    setTimeout(dismiss, kind === 'error' ? 6000 : 3000);
  }

  api.toast = toast;
})(globalThis);
