// Personal links: `https://….trycloudflare.com/?tdk=<key>` for one client. The proxy swaps
// the key for an HttpOnly cookie and takes it away before the origin sees the request.
// A link can have a PIN; only a hash of it is kept, and wrong guesses are limited.

import crypto from 'node:crypto';

export const KEY_PARAM = 'tdk';
export const COOKIE = 'trydash_link';
export const RESERVED = '/__trydash/';
const PIN_RE = /^\d{6,8}$/;
export const PIN_TRIES = 5;
export const PIN_LOCK_MS = 10 * 60 * 1000;

export function newKey() {
  return crypto.randomBytes(16).toString('base64url');
}

export function newId() {
  return `l${crypto.randomBytes(5).toString('hex')}`;
}

export function checkPin(pin) {
  const text = String(pin == null ? '' : pin).trim();
  if (!text) return null;
  if (!PIN_RE.test(text)) throw Object.assign(new Error('links.badPin'), { code: 'BAD_REQUEST', key: 'links.badPin', params: {} });
  return text;
}

// The key salts the hash, so the same PIN on two links gives two hashes.
export function pinHash(key, pin) {
  return crypto.createHash('sha256').update(`${key}:${pin}`).digest('hex');
}

export function pinMatches(link, pin) {
  if (!link.pinHash || !PIN_RE.test(String(pin || ''))) return false;
  const a = Buffer.from(pinHash(link.key, String(pin)), 'hex');
  const b = Buffer.from(link.pinHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The cookie names the link and proves it was opened (with its PIN, if it has one).
export function cookieValue(secret, link) {
  const mac = crypto.createHmac('sha256', secret).update(`${link.id}:${link.key}:${link.pinHash || ''}`).digest('base64url');
  return `${link.id}.${mac}`;
}

export function cookieLinkId(secret, value, find) {
  const m = /^(l[0-9a-f]{10}|owner)\.([A-Za-z0-9_-]{43})$/.exec(String(value || ''));
  if (!m) return null;
  const link = find(m[1]);
  if (!link) return null;
  const expected = Buffer.from(cookieValue(secret, link));
  const given = Buffer.from(String(value));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? link : null;
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

// The Cookie header without trydash's own cookie: the origin never sees it.
export function withoutCookie(header, name) {
  if (header == null) return header;
  const kept = String(header).split(/;\s*/).filter((part) => part && !part.startsWith(`${name}=`));
  return kept.length ? kept.join('; ') : null;
}

// The path and query without `tdk`, for the redirect after the key became a cookie.
export function withoutKey(rawUrl) {
  const url = new URL(rawUrl, 'http://x');
  url.searchParams.delete(KEY_PARAM);
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ''}`;
}

export function setCookie(value, { clear = false } = {}) {
  return `${COOKIE}=${clear ? '' : value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${clear ? 0 : 30 * 24 * 3600}`;
}

// What the dashboard shows of a link: never the PIN hash.
export function publicLink(link) {
  return {
    id: link.id,
    name: link.name,
    key: link.key,
    hasPin: !!link.pinHash,
    revoked: !!link.revoked,
    visits: link.visits || 0,
    firstSeen: link.firstSeen || null,
    lastSeen: link.lastSeen || null,
    createdAt: link.createdAt || null,
  };
}

// What is saved with the tunnel.
export function savedLink(link) {
  return { ...publicLink(link), pinHash: link.pinHash || null };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TEXT = {
  it: {
    pinTitle: 'Inserisci il PIN',
    pinText: 'Questa anteprima è protetta da un PIN. Te l’ha dato chi ti ha mandato il link.',
    pinWrong: 'PIN errato.',
    pinLocked: 'Troppi tentativi: riprova tra qualche minuto.',
    open: 'Apri',
    invalidTitle: 'Link non valido',
    invalidText: 'Questo link non è valido o è stato revocato. Chiedi un nuovo link a chi te l’ha mandato.',
    requiredTitle: 'Serve un link personale',
    requiredText: 'Questa anteprima si apre solo con il link personale che hai ricevuto.',
  },
  en: {
    pinTitle: 'Enter the PIN',
    pinText: 'This preview is protected by a PIN. The person who sent you the link has it.',
    pinWrong: 'Wrong PIN.',
    pinLocked: 'Too many tries: try again in a few minutes.',
    open: 'Open',
    invalidTitle: 'Link not valid',
    invalidText: 'This link isn’t valid or was revoked. Ask the person who sent it for a new one.',
    requiredTitle: 'A personal link is needed',
    requiredText: 'This preview opens only with the personal link you received.',
  },
};

export function langOf(acceptLanguage) {
  return /^\s*it\b/i.test(String(acceptLanguage || '')) ? 'it' : 'en';
}

function page(lang, title, body) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>`
    + `<body style="font:16px/1.5 system-ui,sans-serif;max-width:26rem;margin:15vh auto;padding:0 1rem;color:#1f2937"><h1 style="font-size:1.4rem">${title}</h1>${body}</body></html>\n`;
}

export function gatePage(kind, acceptLanguage, { key = '', back = '/', error = null } = {}) {
  const lang = langOf(acceptLanguage);
  const t = TEXT[lang];
  if (kind === 'pin') {
    const note = error ? `<p role="alert" style="color:#b42318">${t[error]}</p>` : '';
    return page(lang, t.pinTitle, `<p>${t.pinText}</p>${note}<form method="post" action="${RESERVED}pin">`
      + `<input type="hidden" name="key" value="${escapeHtml(key)}"><input type="hidden" name="back" value="${escapeHtml(back)}">`
      + '<input name="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}" required autofocus aria-label="PIN" '
      + 'style="font:inherit;font-size:1.4rem;letter-spacing:.3em;width:10ch;padding:.4rem .6rem;border:1px solid #9ca3af;border-radius:8px"> '
      + `<button style="font:inherit;padding:.5rem 1rem;border:0;border-radius:8px;background:#1f2937;color:#fff">${t.open}</button></form>`);
  }
  if (kind === 'invalid') return page(lang, t.invalidTitle, `<p>${t.invalidText}</p>`);
  return page(lang, t.requiredTitle, `<p>${t.requiredText}</p>`);
}

// A `back` path from the PIN form: same site only. Characters a URL parser would
// delete (tab, newline) are refused, so "/\t/evil.com" cannot become "//evil.com".
export function safeBack(value) {
  const text = String(value || '/');
  if (/[\u0000-\u001f\u007f]/.test(text) || !text.startsWith('/') || text.startsWith('//') || text.includes('\\')) return '/';
  try {
    const url = new URL(text, 'https://trydash.invalid');
    if (url.host !== 'trydash.invalid' || url.username || url.password) return '/';
    return `${url.pathname}${url.search}`;
  } catch {
    return '/';
  }
}
