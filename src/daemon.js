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

// ---------- output ring buffer ----------
// Stores the last ~200 plain-text lines per session. ANSI escapes are stripped
// (the board renders text, the user's own terminal already showed the colors)
// and carriage-return overwrites are collapsed so progress bars keep only
// their latest state.

const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g; // keeps \t \n \r

function sanitize(text) {
  return String(text).replace(ANSI_RE, '').replace(CTRL_RE, '');
}

function collapseCR(seg) {
  if (!seg.includes('\r')) return seg;
  const parts = seg.split('\r');
  let line = parts.pop();
  while (line === '' && parts.length) line = parts.pop();
  return line;
}

class RingBuffer {
  constructor(maxLines = 200) {
    this.maxLines = maxLines;
    this.lines = [];
    this.partial = ''; // the unterminated last line; this is where prompts live
  }
  push(chunk) {
    const data = this.partial + sanitize(chunk).replace(/\r\n/g, '\n');
    const segs = data.split('\n');
    this.partial = segs.pop();
    for (const seg of segs) this.lines.push(collapseCR(seg));
    if (this.partial.length > 4000) this.partial = collapseCR(this.partial).slice(-4000);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
  }
  tailLine() {
    const p = collapseCR(this.partial);
    if (p.trim() !== '') return p;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i].trim() !== '') return this.lines[i];
    }
    return '';
  }
  toLines() {
    const out = this.lines.slice();
    const p = collapseCR(this.partial);
    if (p !== '') out.push(p);
    return out.slice(-this.maxLines);
  }
  loadLines(lines) {
    this.lines = (Array.isArray(lines) ? lines : []).map(String).slice(-this.maxLines);
    this.partial = '';
  }
}

function lightSession(sess, now = Date.now()) {
  const tailLine = sess.buffer.tailLine();
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
    status: proto.deriveStatus({ ...sess, tailLine }, now),
    tail: tailLine.slice(-160),
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
      buffer: new RingBuffer(),
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

function outputChanged(_id) {
  // Extended by the status board step (per-session SSE output events).
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
          sess.buffer.push(msg.chunk);
          sess.lastOutputAt = Date.now();
          outputChanged(sess.id);
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

module.exports = { start, sessions, RingBuffer };
