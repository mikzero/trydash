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

  function looksLikeFolder(value) {
    return FOLDER_RE.test(String(value == null ? '' : value).trim());
  }

  function folderPath(value) {
    var folder = String(value == null ? '' : value).trim();
    if (!folder) badOptions('folder.empty');
    if (folder.indexOf('\0') >= 0 || folder.length > 4096) badOptions('folder.invalid');
    return folder;
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
      // The inspector's proxy speaks HTTP/1.1 only, so an HTTP/2 origin skips it.
      // A folder is always served by trydash, so its requests are always recorded.
      inspect: folder || (!hello && !http2Origin && input.inspect !== false),
    };
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
    };
  }

  api.normalizeOrigin = normalizeOrigin;
  api.normalizeTunnelOptions = normalizeTunnelOptions;
  api.isMailEntry = isMailEntry;
  api.buildQuickTunnelCommand = buildQuickTunnelCommand;
  api.shellWord = shellWord;
  api.looksLikeFolder = looksLikeFolder;
})(globalThis);
