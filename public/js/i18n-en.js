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
    'inspect.disabled': 'The inspector is not on for this tunnel',
    'inspect.requestNotFound': 'Request not found: the inspector keeps only the latest ones',
    'inspect.replayWebsocket': 'A WebSocket connection cannot be replayed',
    'inspect.replayTruncated': 'The request body is too large to replay',
    'inspect.replayFailed': 'The replayed request did not reach the origin',
    'client.requestsUnavailable': 'Requests unavailable',
    'folder.empty': 'Type the path of a folder',
    'folder.invalid': 'Invalid folder path',
    'folder.notFound': 'Folder not found: {path}',
    'folder.notDirectory': 'Not a folder: {path}',
  };
})(globalThis);
