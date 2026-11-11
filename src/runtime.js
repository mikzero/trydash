import { spawn } from 'node:child_process';

// One line from cloudflared is short; a line past MAX_LINE is cut, and the rest
// of it, up to the next newline, is skipped instead of growing a buffer forever.
export const MAX_LINE = 16 * 1024;

function clip(line, max) {
  return line.length > max ? `${line.slice(0, max)} … [line cut]` : line;
}

export function lineSplitter(onLine, max = MAX_LINE) {
  let buffer = '';
  let skipping = false;
  return {
    push(text) {
      buffer += text;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (skipping) skipping = false;
        else if (line.trim()) onLine(clip(line, max));
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > max) {
        if (!skipping) onLine(clip(buffer, max));
        skipping = true;
        buffer = '';
      }
    },
    end() {
      if (!skipping && buffer.trim()) onLine(clip(buffer, max));
      buffer = '';
      skipping = false;
    },
  };
}

async function pump(stream, onLine) {
  if (stream == null) return;
  const lines = lineSplitter(onLine);
  if (typeof stream === 'string' || Buffer.isBuffer(stream)) {
    lines.push(stream.toString());
    lines.end();
    return;
  }
  try {
    for await (const chunk of stream) {
      lines.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    }
  } catch {
    // The process closed the pipe.
  }
  lines.end();
}

// isCurrent lets the caller drop late lines from a process a restart has replaced.
export function bindProcess(store, sessionId, proc, isCurrent = () => true) {
  const onLine = (line) => {
    if (!store.get(sessionId) || !isCurrent(sessionId, proc)) return;
    store.appendChunk(sessionId, line);
  };
  const stdout = proc ? proc.stdout : null;
  const stderr = proc ? proc.stderr : null;
  return Promise.all([pump(stdout, onLine), pump(stderr, onLine)]).then(() => store.get(sessionId));
}

// Past this, a cloudflared that ignored SIGTERM gets SIGKILL: "stopped" must
// mean the tunnel is gone, not that it was asked to go.
export const KILL_AFTER_MS = 5000;

// Used when a second shutdown signal must not wait out the SIGTERM grace period.
export function signalProcess(proc, name) {
  if (!proc || proc.killed) return;
  if (proc.exitCode != null || proc.signalCode != null) return;
  signal(proc, name);
}

function signal(proc, name) {
  // Real children run in their own process group (detached), so the whole group goes.
  if (typeof proc.kill === 'function' && proc.pid && proc.spawnfile) {
    try {
      process.kill(-proc.pid, name);
      return;
    } catch {
      // No group (Windows) or already gone: fall back to the child itself.
    }
  }
  if (typeof proc.kill === 'function') {
    try { proc.kill(name); } catch { /* already gone */ }
  }
}

function hasExited(proc) {
  return proc.exitCode != null || proc.signalCode != null;
}

// Resolves when the process has exited; fake processes without `once` resolve at once.
export function stopProcess(proc, { killAfterMs = KILL_AFTER_MS } = {}) {
  if (!proc || proc.killed) return Promise.resolve();
  // Once reaped, the pid (and its group) may belong to another process.
  if (hasExited(proc)) return Promise.resolve();
  const waitable = typeof proc.once === 'function';
  const exited = waitable ? new Promise((resolve) => proc.once('exit', resolve)) : Promise.resolve();
  signal(proc, 'SIGTERM');
  if (!waitable) return exited;
  // Not unref'd: the SIGKILL must happen even if nothing else keeps the event loop alive.
  const timer = setTimeout(() => {
    if (!hasExited(proc)) signal(proc, 'SIGKILL');
  }, killAfterMs);
  return exited.then(() => clearTimeout(timer));
}

export function spawnForSession(store, session, spawnImpl = spawn, isCurrent = undefined) {
  const proc = spawnImpl(session.invocation.bin, session.invocation.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
  });
  const done = bindProcess(store, session.id, proc, isCurrent);
  return { proc, done };
}

export function openQuickTunnel(store, origin, spawnImpl = spawn, options = undefined, isCurrent = undefined) {
  const session = store.create(origin, options);
  let spawned;
  try {
    spawned = spawnForSession(store, session, spawnImpl, isCurrent);
  } catch (error) {
    store.remove(session.id);
    throw error;
  }
  return { session, proc: spawned.proc, done: spawned.done };
}
