(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});

  function h(tag, props, children) {
    var node = document.createElement(tag);
    var options = props || {};
    Object.keys(options).forEach(function (key) {
      var value = options[key];
      if (value == null || value === false) return;
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style') Object.assign(node.style, value);
      else {
        if (key === 'id') node.id = String(value);
        node.setAttribute(key, value === true ? '' : String(value));
      }
    });
    var flat = [];
    (children || []).forEach(function (child) {
      if (Array.isArray(child)) flat.push.apply(flat, child);
      else if (child) flat.push(child);
    });
    if (flat.length) node.append.apply(node, flat);
    return node;
  }

  api.h = h;
})(globalThis);
