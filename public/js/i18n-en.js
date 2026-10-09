(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var messages = api.messages || (api.messages = {});

  messages.en = {
    'origin.empty': 'Enter an origin, for example http://127.0.0.1:3000',
    'origin.notHttp': 'The origin must be an http or https URL',
    'origin.credentials': 'The origin must not contain credentials',
    'origin.badPort': 'The origin port is not valid',
    'options.mailInvalid': 'Invalid email address: {value}',
    'options.mailTooMany': 'At most {max} email addresses',
    'options.hostHeaderInvalid': 'Invalid host header: {value}',
    'session.notFound': 'Session not found',
    'entry.notFound': 'Line not found',
    'session.alreadyActive': 'The tunnel is already running',
    'request.bodyTooLarge': 'Request body too large',
    'request.badJson': 'Invalid JSON',
    'request.methodNotAllowed': 'Method not allowed',
    'request.forbidden': 'Request not allowed: it comes from another origin',
    'cloudflared.unavailable': 'cloudflared is not available',
    'server.error': 'Server error: {detail}',
    'client.failed': 'Operation failed',
    'client.copyFailed': 'Copy failed',
    'client.offline': 'Server unreachable',
    'client.offlineRetry': 'Server unreachable — retrying…',
    'client.stateUnavailable': 'State unavailable',
    'client.logsUnavailable': 'Logs unavailable',
  };
})(globalThis);
