'use strict';
// towerd: holds the in-memory session registry, listens on the local socket
// for wrappers and CLI clients, and serves the status board over localhost HTTP.

const net = require('net');
const fs = require('fs');
const proto = require('./protocol');

const sessions = new Map(); // id -> session record

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function deriveStatus(sess) {
  if (sess.exited) {
    if (sess.exitCode === 0) return 'exited-ok';
    if (sess.exitCode === null || sess.exitCode === undefined) return 'exited-unknown';
    return 'exited-error';
  }
  if (sess.stale) return 'stale';
  return 'running';
}

function lightSession(sess) {
  return {
    id: sess.id,
    name: sess.name,
    cwd: sess.cwd,
    command: sess.command,
    pid: sess.pid,
    childPid: sess.childPid,
    startedAt: sess.startedAt,
    lastOutputAt: sess.lastOutputAt,
    exited: sess.exited,
    exitCode: sess.exitCode,
    exitSignal: sess.exitSignal,
    exitedAt: sess.exitedAt,
    stale: sess.stale,
    pty: sess.pty,
    status: deriveStatus(sess),
  };
}

function lightList() {
  return [...sessions.values()].map((s) => lightSession(s));
}

// "daemon" is reserved so `tower kill daemon` is unambiguous.
function dedupeName(base) {
  const taken = new Set(['daemon']);
  for (const s of sessions.values()) if (!s.exited) taken.add(s.name);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function handleRegister(sock, raw) {
  const s = raw || {};
  if (!s.id || typeof s.id !== 'string') return null;
  let sess = sessions.get(s.id);
  if (sess) {
    // A wrapper reconnecting after a daemon restart or a dropped connection.
    sess.sock = sock;
    sess.stale = false;
    sess.pid = s.pid;
    sess.childPid = s.childPid;
  } else {
    sess = {
      id: s.id,
      name: dedupeName(String(s.name || 'session')),
      cwd: String(s.cwd || ''),
      command: String(s.command || ''),
      pid: s.pid,
      childPid: s.childPid,
      startedAt: s.startedAt || Date.now(),
      lastOutputAt: s.startedAt || Date.now(),
      exited: false,
      exitCode: null,
      exitSignal: null,
      exitedAt: null,
      stale: false,
      pty: !!s.pty,
      sock,
    };
    sessions.set(sess.id, sess);
    log(`registered ${sess.name} (${sess.command})`);
  }
  proto.send(sock, { type: 'registered', id: sess.id, name: sess.name });
  notifyChange();
  return sess.id;
}

function handleExit(msg) {
  const sess = sessions.get(msg.id);
  if (!sess) return;
  sess.exited = true;
  sess.exitCode = typeof msg.code === 'number' ? msg.code : null;
  sess.exitSignal = msg.signal || null;
  sess.exitedAt = Date.now();
  log(`exited ${sess.name} code=${sess.exitCode} signal=${sess.exitSignal || '-'}`);
  notifyChange();
}

function markDisconnected(id) {
  const sess = sessions.get(id);
  if (!sess || sess.exited) return;
  // The wrapper vanished without sending an exit. If its process is gone,
  // the session is over; otherwise keep it around as stale so a reconnect heals it.
  if (pidAlive(sess.pid) || pidAlive(sess.childPid)) {
    sess.stale = true;
  } else {
    sess.exited = true;
    sess.exitCode = null;
    sess.exitedAt = Date.now();
  }
  notifyChange();
}

function killSession(name) {
  let target = null;
  for (const s of sessions.values()) {
    if ((s.name === name || s.id === name) && !s.exited) { target = s; break; }
  }
  if (!target) return { type: 'error', message: `no running session named "${name}"` };
  if (target.sock && !target.sock.destroyed) {
    proto.send(target.sock, { type: 'kill', id: target.id });
  } else if (pidAlive(target.childPid)) {
    try { process.kill(target.childPid, 'SIGTERM'); } catch { /* best effort */ }
  }
  return { type: 'ok', name: target.name };
}

// ---------- change notification (persistence + board updates hook in later) ----------

function notifyChange() {
  // Extended by later build steps (state persistence, SSE broadcast).
}

// ---------- socket server ----------

const server = net.createServer((sock) => {
  let sessionId = null;
  sock.on('error', () => { /* client went away mid-write */ });
  proto.onMessages(sock, (msg) => {
    switch (msg.type) {
      case 'register':
        sessionId = handleRegister(sock, msg.session);
        break;
      case 'output': {
        const sess = sessions.get(msg.id);
        if (sess && typeof msg.chunk === 'string') {
          sess.lastOutputAt = Date.now();
          notifyChange();
        }
        break;
      }
      case 'exit':
        handleExit(msg);
        break;
      case 'ping':
        proto.send(sock, { type: 'pong', pid: process.pid, port: null });
        break;
      case 'list':
        proto.send(sock, { type: 'sessions', sessions: lightList() });
        break;
      case 'kill-session':
        proto.send(sock, killSession(String(msg.name || '')));
        break;
      case 'shutdown':
        proto.send(sock, { type: 'ok' });
        log('shutdown requested');
        setTimeout(() => shutdown(0), 100);
        break;
      default:
        break;
    }
  });
  sock.on('close', () => {
    if (sessionId) markDisconnected(sessionId);
  });
});

function shutdown(code) {
  try { server.close(); } catch { /* already closed */ }
  removeSocketFile();
  process.exit(code);
}

function removeSocketFile() {
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(proto.socketPath()); } catch { /* fine */ }
  }
}

function claimSocketAndListen() {
  const sp = proto.socketPath();
  // If another daemon is alive, bow out quietly.
  const probe = net.createConnection(sp);
  probe.on('connect', () => {
    probe.end();
    log('another towerd is already running; exiting');
    process.exit(0);
  });
  probe.on('error', () => {
    // Nothing answered. On unix a stale socket file may remain from a crash.
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(sp); } catch { /* fine */ }
    }
    server.on('error', (e) => {
      log('socket server error:', e.message);
      process.exit(1);
    });
    server.listen(sp, () => log(`towerd listening on ${sp}`));
  });
}

function start() {
  proto.ensureTowerDir();
  claimSocketAndListen();
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('exit', removeSocketFile);
}

if (require.main === module) start();

module.exports = { start, sessions, deriveStatus };
