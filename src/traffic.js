// Reads each running cloudflared's Prometheus endpoint (--metrics) and keeps
// the numbers in the session store.

const METRICS = {
  inflight: 'cloudflared_tunnel_concurrent_requests_per_tunnel',
  total: 'cloudflared_tunnel_total_requests',
  errors: 'cloudflared_tunnel_request_errors',
  connections: 'cloudflared_tunnel_ha_connections',
};

export function parseMetrics(text) {
  const sums = new Map();
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{[^}]*\})?\s+(\S+)/.exec(trimmed);
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    sums.set(match[1], (sums.get(match[1]) || 0) + value);
  }
  const result = {};
  for (const [field, name] of Object.entries(METRICS)) {
    result[field] = sums.has(name) ? sums.get(name) : null;
  }
  return result;
}

function withTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  const request = Promise.resolve()
    .then(() => fetchImpl(url, { signal: controller.signal }))
    .then(async (response) => {
      if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : '?'}`);
      return response.text();
    });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

export function createTrafficSampler({ store, fetchImpl = fetch, intervalMs = 2000, timeoutMs = 1500 }) {
  let timer = null;
  let running = null;

  async function sample(session) {
    const id = session.id;
    let parsed = null;
    try {
      parsed = parseMetrics(await withTimeout(fetchImpl, session.metricsUrl, timeoutMs));
    } catch {
      parsed = null;
    }
    // The session may have been removed or restarted while we waited.
    const current = store.get(id);
    if (!current || !current.active || current.metricsUrl !== session.metricsUrl) return;
    const empty = !parsed || Object.values(parsed).every((value) => value == null);
    if (empty) store.markTrafficStale(id);
    else store.recordTraffic(id, parsed);
  }

  function tick() {
    if (running) return running;
    const targets = store.list().filter((session) => session.active && session.metricsUrl);
    running = Promise.all(targets.map((session) => sample({ id: session.id, metricsUrl: session.metricsUrl })))
      .finally(() => { running = null; });
    return running;
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
