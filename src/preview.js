// Client previews through the inspector's proxy: local URLs rewritten to the public
// one (and back), paths visitors cannot open, a noindex header and a small label.
// Only pure helpers here; src/inspector.js applies them to the traffic.

export const MODIFY_CAP = 8 * 1024 * 1024;
export const NOINDEX = 'noindex, nofollow';

// Bodies worth rewriting: pages, styles, scripts, data. Images, fonts and the rest pass as they are.
export const REWRITE_TYPE = /^(text\/(html|css|javascript|plain|xml)|application\/([\w.+-]*\+)?(json|xml|javascript|ecmascript|x-javascript|manifest\+json)|image\/svg\+xml)\b/i;
export const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)\b/i;

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SLASHES = '(\\/\\/|\\\\\\/\\\\\\/)'; // `//`, or `\/\/` inside JSON
const NOT_LONGER = '(?![\\w-]|\\.[a-z0-9-]|:\\d)';
const ENC_NOT_LONGER = '(?![\\w-]|\\.[a-z0-9-]|%3a\\d)';

function secure(scheme) {
  const s = scheme.toLowerCase();
  return s === 'http' ? 'https' : s === 'ws' ? 'wss' : s;
}

function plain(scheme, isSecure) {
  const s = scheme.toLowerCase();
  if (isSecure) return s;
  return s === 'https' ? 'http' : s === 'wss' ? 'ws' : s;
}

// The names the origin answers to: localhost and friends on its port, its own
// hostname, and the --host-header name on any port.
export function localHostPattern(originUrl, hostHeader, { encoded = false } = {}) {
  const port = originUrl.port;
  const names = new Set(['localhost', '127.0.0.1', '0.0.0.0', originUrl.hostname.toLowerCase()]);
  if (!encoded) names.add('[::1]');
  const colon = encoded ? '%3a' : ':';
  const portPart = port ? `${colon}${port}` : `(?:${colon}(?:80|443))?`;
  const alts = [`(?:${Array.from(names).map(escapeRe).join('|')})${portPart}`];
  if (hostHeader) {
    const name = String(hostHeader).toLowerCase().replace(/:\d+$/, '');
    alts.push(`${escapeRe(name)}(?:${colon}\\d+)?`);
  }
  return `(?:${alts.join('|')})`;
}

export function createRewriter({ originUrl, hostHeader = '', publicUrl, siteHost = '' }) {
  const pub = new URL(publicUrl);
  const publicHost = pub.host;
  const localHost = siteHost || (hostHeader ? String(hostHeader).toLowerCase() : originUrl.host);
  const originSecure = originUrl.protocol === 'https:';

  const toPublicRe = new RegExp(`(?:\\b(https?|wss?):)?${SLASHES}${localHostPattern(originUrl, hostHeader)}${NOT_LONGER}`, 'gi');
  const toPublicEncRe = new RegExp(`\\b(https?|wss?)%3a%2f%2f${localHostPattern(originUrl, hostHeader, { encoded: true })}${ENC_NOT_LONGER}`, 'gi');
  const toLocalRe = new RegExp(`(?:\\b(https?|wss?):)?${SLASHES}${escapeRe(publicHost)}${NOT_LONGER}`, 'gi');
  const toLocalEncRe = new RegExp(`\\b(https?|wss?)%3a%2f%2f${escapeRe(publicHost)}${ENC_NOT_LONGER}`, 'gi');
  const localEnc = encodeURIComponent(localHost);

  return {
    publicHost,
    localHost,
    // Local URLs → the public one, over https.
    toPublic(text) {
      return String(text)
        .replace(toPublicRe, (m, scheme, slashes) => `${scheme ? `${secure(scheme)}:` : ''}${slashes}${publicHost}`)
        .replace(toPublicEncRe, (m, scheme) => `${secure(scheme)}%3A%2F%2F${publicHost}`);
    },
    // The public URL → the address the site knows, for what visitors send.
    toLocal(text) {
      return String(text)
        .replace(toLocalRe, (m, scheme, slashes) => `${scheme ? `${plain(scheme, originSecure)}:` : ''}${slashes}${localHost}`)
        .replace(toLocalEncRe, (m, scheme) => `${plain(scheme, originSecure)}%3A%2F%2F${localEnc}`);
    },
  };
}

// The host a local URL names, when it is one of the origin's names: `localhost:8080`.
export function localHostOf(location, originUrl, hostHeader) {
  const re = new RegExp(`^(?:https?|wss?):\\/\\/(${localHostPattern(originUrl, hostHeader)})${NOT_LONGER}`, 'i');
  const match = re.exec(String(location || '').trim());
  return match ? match[1].toLowerCase() : null;
}

// Hints that a site sends visitors to its local address (when rewriting is off).
export function localLinkIn(html, originUrl, hostHeader) {
  const re = new RegExp(`(?:href|src|action)\\s*=\\s*["']?((?:https?:)?\\/\\/${localHostPattern(originUrl, hostHeader)})${NOT_LONGER}`, 'i');
  const match = re.exec(String(html || ''));
  return match ? match[1] : null;
}

// Vite, webpack-dev-server and Angular refuse an unknown Host with these words.
export function hostCheckIn(text) {
  return /Blocked request\. This host|Invalid Host header/i.test(String(text || ''));
}

// The ways the origin may read a path: dot segments resolved, %xx decoded, case,
// repeated slashes, trailing dots and `;params` ignored. `null` when it cannot be
// decoded (then it is refused).
export function pathForms(rawUrl) {
  const raw = String(rawUrl || '/');
  let pathname;
  try {
    pathname = new URL(`http://x${raw.startsWith('/') ? '' : '/'}${raw}`).pathname;
  } catch {
    return null;
  }
  let decoded = pathname;
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(decoded); i += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
  }
  if (decoded.includes('\0')) return null;
  const tidy = (p) => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/[.\s]+$/, '').toLowerCase() || '/';
  const forms = new Set([tidy(pathname), tidy(decoded)]);
  // Decoding can bring new dot segments (`%2e%2e`, `%2f`): resolve them once more.
  try {
    forms.add(tidy(new URL(`http://x/${decoded.replace(/\\/g, '/').replace(/^\/+/, '')}`).pathname));
  } catch {
    return null;
  }
  for (const form of Array.from(forms)) forms.add(tidy(form.replace(/;[^/]*/g, '')));
  return Array.from(forms);
}

// The blocked entry a request falls under, or null. `/wp-admin` covers `/wp-admin/…` too.
export function blockedBy(rawUrl, blocked) {
  if (!blocked || !blocked.length) return null;
  const forms = pathForms(rawUrl);
  if (forms == null) return '?';
  for (const entry of blocked) {
    if (forms.some((p) => p === entry || p.startsWith(`${entry}/`))) return entry;
  }
  return null;
}

function italian(acceptLanguage) {
  return /^\s*it\b/i.test(String(acceptLanguage || ''));
}

export function blockedPage(acceptLanguage) {
  const it = italian(acceptLanguage);
  const title = it ? 'Non disponibile in questa anteprima' : 'Not available in this preview';
  const text = it
    ? 'Questa pagina non è aperta a chi guarda l’anteprima.'
    : 'This page is not open to people viewing the preview.';
  return `<!doctype html><html lang="${it ? 'it' : 'en'}"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>`
    + `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2937"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body></html>\n`;
}

export function badgeHtml(acceptLanguage) {
  const label = italian(acceptLanguage) ? 'Anteprima' : 'Preview';
  return `<div id="trydash-preview" title="trydash" style="all:initial;position:fixed;z-index:2147483647;left:12px;bottom:12px;padding:4px 10px;border-radius:999px;background:#1f2937;color:#fff;font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.03em;opacity:.85;pointer-events:none">${label}</div>`;
}

// The label goes before the last </body>, or at the end.
export function injectBadge(html, acceptLanguage) {
  const badge = badgeHtml(acceptLanguage);
  const at = html.toLowerCase().lastIndexOf('</body');
  return at < 0 ? html + badge : html.slice(0, at) + badge + html.slice(at);
}

// Set-Cookie for the public host: a Domain=localhost would make the browser drop it.
export function publicCookie(value, rewriter) {
  return rewriter.toPublic(value).replace(/;\s*domain=[^;]*/gi, '');
}
