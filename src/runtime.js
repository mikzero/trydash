import { spawn } from 'node:child_process';

function drain(buffer, onLine) {
  let rest = buffer;
  let nl = rest.indexOf('\n');
  while (nl >= 0) {
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (line.trim()) onLine(line);
    nl = rest.indexOf('\n');
  }
  return rest;
}

async function pump(stream, onLine) {
  if (stream == null) return;
  if (typeof stream === 'string' || Buffer.isBuffer(stream)) {
    const text = stream.toString();
    const rest = drain(text, onLine);
    if (rest.trim()) onLine(rest);
    return;
  }
  let buffer = '';
  try {
    for await (const chunk of stream) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      buffer = drain(buffer, onLine);
    }
  } catch {
    // The process closed the pipe.
  }
  if (buffer.trim()) onLine(buffer);
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

export function stopProcess(proc) {
  if (!proc || proc.killed) return;
  // Once reaped, the pid (and its group) may belong to another process.
  if (proc.exitCode != null || proc.signalCode != null) return;
  if (typeof proc.kill === 'function' && proc.pid && proc.spawnfile) {
    try {
      process.kill(-proc.pid, 'SIGTERM');
      return;
    } catch {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      return;
    }
  }
  if (typeof proc.kill === 'function') {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  }
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
