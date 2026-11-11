// Dev servers listening on this machine, for the suggestions under the form.
// Only well-known development ports are tried, with a plain TCP connect: nothing
// is sent to them, so no request shows up in their logs.

import net from 'node:net';

export const COMMON_PORTS = [
  { port: 3000, hint: 'Next.js, React, Express, Rails' },
  { port: 3001, hint: null },
  { port: 3333, hint: 'AdonisJS' },
  { port: 4000, hint: 'Phoenix, Gatsby' },
  { port: 4173, hint: 'Vite preview' },
  { port: 4200, hint: 'Angular' },
  { port: 4321, hint: 'Astro' },
  { port: 5000, hint: 'Flask' },
  { port: 5173, hint: 'Vite' },
  { port: 5174, hint: 'Vite' },
  { port: 5500, hint: 'Live Server' },
  { port: 6006, hint: 'Storybook' },
  { port: 7860, hint: 'Gradio' },
  { port: 8000, hint: 'Django, Laravel, http.server' },
  { port: 8080, hint: null },
  { port: 8081, hint: null },
  { port: 8501, hint: 'Streamlit' },
  { port: 8888, hint: 'Jupyter' },
  { port: 9000, hint: null },
  { port: 1313, hint: 'Hugo' },
  { port: 19006, hint: 'Expo' },
];

export function isListening(port, host, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// IPv4 first; a server only on ::1 (Vite on some systems) gets an [::1] origin,
// because the 127.0.0.1 one would not reach it.
export async function scanPorts({ ports = COMMON_PORTS, exclude = [], timeoutMs = 250 } = {}) {
  const skip = new Set(exclude.map(Number));
  const checks = ports.filter((item) => !skip.has(item.port)).map(async (item) => {
    if (await isListening(item.port, '127.0.0.1', timeoutMs)) return { ...item, origin: String(item.port) };
    if (await isListening(item.port, '::1', timeoutMs)) return { ...item, origin: `http://[::1]:${item.port}` };
    return null;
  });
  return (await Promise.all(checks)).filter(Boolean).sort((a, b) => a.port - b.port);
}
