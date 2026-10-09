(function (root) {
  'use strict';

  var api = root.TryDash || (root.TryDash = {});
  var messages = api.messages || (api.messages = {});

  messages.it = {
    'origin.empty': 'Scrivi un’origine, per esempio http://127.0.0.1:3000',
    'origin.notHttp': 'L’origine deve essere un URL http o https',
    'origin.credentials': 'L’origine non deve contenere credenziali',
    'origin.badPort': 'La porta dell’origine non è valida',
    'options.mailInvalid': 'Indirizzo email non valido: {value}',
    'options.mailTooMany': 'Al massimo {max} indirizzi email',
    'options.hostHeaderInvalid': 'Host header non valido: {value}',
    'session.notFound': 'Sessione non trovata',
    'entry.notFound': 'Riga non trovata',
    'session.alreadyActive': 'Il tunnel è già attivo',
    'request.bodyTooLarge': 'Body troppo grande',
    'request.badJson': 'JSON non valido',
    'request.methodNotAllowed': 'Metodo non consentito',
    'request.forbidden': 'Richiesta non consentita: arriva da un’altra origine',
    'cloudflared.unavailable': 'cloudflared non è disponibile',
    'server.error': 'Errore del server: {detail}',
    'client.failed': 'Operazione non riuscita',
    'client.copyFailed': 'Copia non riuscita',
    'client.offline': 'Server non raggiungibile',
    'client.offlineRetry': 'Server non raggiungibile — riprovo…',
    'client.stateUnavailable': 'Stato non disponibile',
    'client.logsUnavailable': 'Log non disponibili',
  };
})(globalThis);
