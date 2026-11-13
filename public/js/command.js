(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});

  function fail(key) {
    throw api.appError('BAD_ORIGIN', key);
  }

  function normalizeOrigin(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw) fail('origin.empty');
    if (/^\d{2,5}$/.test(raw)) raw = 'http://127.0.0.1:' + raw;
    else if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/.test(raw)) raw = 'http://' + raw;
    else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'http://' + raw;

    var url;
    try {
      url = new URL(raw);
    } catch (err) {
      fail('origin.notHttp');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      fail('origin.notHttp');
    }
    if (url.username || url.password) fail('origin.credentials');
    if (url.port === '0') fail('origin.badPort');

    var path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return url.protocol + '//' + url.host + path + url.search;
  }

  var MAX_MAIL = 20;
  var MAIL_RE = /^(\*|[a-z0-9._%+-]+)@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
  var HOST_HEADER_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/;
  var SHELL_SAFE_RE = /^[A-Za-z0-9@%+=:,.\/_-]+$/;

  function badOptions(key, params) {
    throw api.appError('BAD_OPTIONS', key, params);
  }

  // Outlook copies recipients as `Name <addr>; "Last, First" <addr>`: those segments
  // (split on `;`) keep only the bracketed address; plain lists split on spaces, `,`, `;`.
  function mailItems(text) {
    if (text.indexOf('<') < 0) return text.split(/[\s,;]+/);
    var items = [];
    text.split(/;|\n/).forEach(function (segment) {
      var bracket = /<([^>]*)>/.exec(segment);
      if (bracket) items.push(bracket[1]);
      else items.push.apply(items, segment.split(/[\s,]+/));
    });
    return items;
  }

  function mailList(value) {
    var items = Array.isArray(value) ? value : mailItems(String(value == null ? '' : value));
    var seen = [];
    for (var i = 0; i < items.length; i += 1) {
      var item = String(items[i] == null ? '' : items[i]).trim().toLowerCase();
      if (!item) continue;
      if (!MAIL_RE.test(item)) badOptions('options.mailInvalid', { value: item });
      if (seen.indexOf(item) < 0) seen.push(item);
      // Stop at the limit: a huge list must not cost quadratic dedup time.
      if (seen.length > MAX_MAIL) badOptions('options.mailTooMany', { max: MAX_MAIL });
    }
    return seen;
  }

  // A path, not an origin: `/srv/site`, `~/site`, `./dist`, `C:\\site`, `\\\\server\\share`.
  var FOLDER_RE = /^(\/|~(?:[\\/]|$)|\.{1,2}(?:[\\/]|$)|[A-Za-z]:[\\/]|\\\\)/;

  // `site` or `site/dist`: a host name or a folder next to trydash; only the server can tell.
  function looksBare(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw || /^\d+$/.test(raw) || raw.indexOf(':') >= 0 || looksLikeFolder(raw)) return false;
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)([\\/]|$)/i.test(raw)) return false;
    // `example.com` is almost always a domain: the hint is for plain names like `site`.
    return /^[\w\-]+([\\/][\w.\- ]*)*$/.test(raw);
  }

  function looksLikeFolder(value) {
    return FOLDER_RE.test(String(value == null ? '' : value).trim());
  }

  function folderPath(value) {
    var folder = String(value == null ? '' : value).trim();
    if (!folder) badOptions('folder.empty');
    if (folder.indexOf('\0') >= 0 || folder.length > 4096) badOptions('folder.invalid');
    return folder;
  }

  // Minutes after which the tunnel stops by itself: at most a week, none by default.
  var MAX_EXPIRES = 7 * 24 * 60;

  function expiresIn(value) {
    if (value == null || value === '' || value === 0 || value === '0') return null;
    var minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_EXPIRES) badOptions('options.expiresInvalid', { max: MAX_EXPIRES });
    return minutes;
  }

  // Paths visitors get a 403 for, like `/wp-admin`: lowercase, no trailing slash.
  var MAX_BLOCKED = 30;
  var BLOCKED_RE = /^\/[^\s\u0000-\u001f\u007f?#]{1,199}$/;

  function blockedPaths(value) {
    var items = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
    var out = [];
    for (var i = 0; i < items.length; i += 1) {
      var given = String(items[i] == null ? '' : items[i]).trim();
      if (!given) continue;
      // `/` alone would block the whole site: that is what Stop is for.
      var item = given.toLowerCase().replace(/\/+$/, '');
      if (!BLOCKED_RE.test(item)) badOptions('options.blockedInvalid', { value: items[i] });
      if (out.indexOf(item) < 0) out.push(item);
      if (out.length > MAX_BLOCKED) badOptions('options.blockedTooMany', { max: MAX_BLOCKED });
    }
    return out;
  }

  function normalizeTunnelOptions(raw) {
    var input = raw || {};
    var hello = input.mode === 'hello';
    var folder = !hello && input.mode === 'folder';
    // Hello World and a folder have no origin, so the origin options do not apply.
    var noOrigin = hello || folder;
    var hostHeader = noOrigin ? '' : String(input.hostHeader == null ? '' : input.hostHeader).trim();
    if (hostHeader && !HOST_HEADER_RE.test(hostHeader)) badOptions('options.hostHeaderInvalid', { value: hostHeader });
    var http2Origin = !noOrigin && input.http2Origin === true;
    var options = {
      mode: hello ? 'hello' : folder ? 'folder' : 'origin',
      allowedMail: mailList(input.allowedMail),
      hostHeader: hostHeader,
      noTlsVerify: !noOrigin && input.noTlsVerify === true,
      http2Origin: http2Origin,
      expiresIn: expiresIn(input.expiresIn),
    };
    // Preview options work in trydash's proxy (or folder server), which an HTTP/2 origin skips.
    var proxied = !hello && !http2Origin;
    options.rewrite = proxied && !folder && input.rewrite === true;
    options.blocked = proxied ? blockedPaths(input.blocked) : [];
    options.badge = proxied && input.badge === true;
    // Requests that find the origin down wait in trydash's proxy (webhooks, mostly).
    options.queue = proxied && !folder && input.queue === true;
    // The inspector's proxy speaks HTTP/1.1 only, so an HTTP/2 origin skips it.
    // A folder is always served by trydash; the preview options need the proxy too.
    options.inspect = folder || (proxied && (input.inspect !== false || options.rewrite || options.badge || options.queue || options.blocked.length > 0));
    // Previews stay out of search engines unless asked otherwise.
    options.noindex = options.inspect && input.noindex !== false;
    if (folder) options.folder = folderPath(input.folder);
    return options;
  }

  function isMailEntry(value) {
    return typeof value === 'string' && MAIL_RE.test(value);
  }

  // A copied command must paste as-is: anything beyond plain URL/flag characters
  // (`*`, `&`, `$(`, quotes…) goes in single quotes, with `'` written as `'\''`.
  function shellWord(value) {
    return SHELL_SAFE_RE.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
  }

  // Windows has two shells with opposite rules: cmd.exe treats `'` as a letter (so
  // `&` after it runs a command), PowerShell expands `$` and `` ` `` inside `"…"`.
  // Double quotes are safe in both once `$`, `` ` `` and `"` are percent-encoded,
  // which a URL reads the same way; the other values never contain them.
  function windowsWord(value) {
    if (SHELL_SAFE_RE.test(value)) return value;
    return '"' + value.replace(/[$`"]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    }) + '"';
  }

  // Quick tunnel: `cloudflared tunnel --url <origin>` or `--hello-world`.
  // `--metrics` feeds the traffic view; `--output json` only changes the log shape.
  // No named tunnel, login, or route.
  // `target` is the inspector's local proxy: cloudflared connects there instead of the
  // origin, while `equivalent` keeps the command a user would run without trydash.
  function buildQuickTunnelCommand(originInput, rawOptions, target) {
    var options = normalizeTunnelOptions(rawOptions);
    var origin = options.mode === 'origin' ? normalizeOrigin(originInput) : null;
    var source = options.mode === 'hello' ? ['--hello-world']
      : options.mode === 'folder' ? ['--url', target || 'http://127.0.0.1:0']
        : ['--url', origin];
    var spawned = options.mode === 'origin' && target ? ['--url', target] : source;
    var chosen = [];
    options.allowedMail.forEach(function (mail) { chosen.push('--allowed-mail', mail); });
    if (options.hostHeader) chosen.push('--http-host-header', options.hostHeader);
    if (options.noTlsVerify) chosen.push('--no-tls-verify');
    if (options.http2Origin) chosen.push('--http2-origin');
    var args = ['tunnel'].concat(spawned, chosen, ['--metrics', '127.0.0.1:0', '--output', 'json', '--no-autoupdate']);
    return {
      bin: 'cloudflared',
      args: args,
      origin: origin,
      target: options.mode !== 'hello' && target ? target : null,
      mode: options.mode,
      options: options,
      equivalent: ['cloudflared', 'tunnel'].concat(source, chosen).map(shellWord).join(' '),
      equivalentWindows: ['cloudflared', 'tunnel'].concat(source, chosen).map(windowsWord).join(' '),
    };
  }

  api.normalizeOrigin = normalizeOrigin;
  api.normalizeTunnelOptions = normalizeTunnelOptions;
  api.isMailEntry = isMailEntry;
  api.MAX_EXPIRES = MAX_EXPIRES;
  api.MAX_BLOCKED = MAX_BLOCKED;
  api.blockedPaths = blockedPaths;
  // Ready-made lists for the form: admin areas a client has no reason to open.
  api.BLOCK_PRESETS = {
    wordpress: ['/wp-admin', '/wp-login.php', '/xmlrpc.php'],
    laravel: ['/telescope', '/horizon', '/_ignition'],
    django: ['/admin'],
  };
  api.buildQuickTunnelCommand = buildQuickTunnelCommand;
  api.shellWord = shellWord;
  api.windowsWord = windowsWord;
  // The command for the machine that runs cloudflared (api.platform comes from the probe).
  api.commandFor = function (item) {
    if (!item) return '';
    return api.platform === 'win32' && item.equivalentWindows ? item.equivalentWindows : item.equivalent;
  };
  api.looksLikeFolder = looksLikeFolder;
  api.looksBare = looksBare;
})(globalThis);
