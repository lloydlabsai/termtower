'use strict';
// towerd: holds the in-memory session registry, listens on the local socket
// for wrappers and CLI clients, and serves the status board over localhost HTTP.

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const proto = require('./protocol');

const WEB_DIR = path.join(__dirname, '..', 'web');

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

// An escape sequence split across two output chunks must be reassembled before
// stripping, so the partial line is stored RAW and sanitized only when the line
// completes (or on read, for display).
function sanitizePartial(raw) {
  // also trim a trailing incomplete escape so it never shows as literal junk
  return sanitize(String(raw).replace(/\x1b(?:\[[0-9;?]*[ -\/]*|\][^\x07\x1b]*|)$/, ''));
}

class RingBuffer {
  constructor(maxLines = 200) {
    this.maxLines = maxLines;
    this.lines = [];
    this.partial = ''; // the unterminated last line, raw; this is where prompts live
  }
  push(chunk) {
    const data = (this.partial + String(chunk)).replace(/\r\n/g, '\n');
    const segs = data.split('\n');
    this.partial = segs.pop();
    for (const seg of segs) this.lines.push(collapseCR(sanitize(seg)));
    if (this.partial.length > 4000) this.partial = this.partial.slice(-4000);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
  }
  tailLine() {
    const p = collapseCR(sanitizePartial(this.partial));
    if (p.trim() !== '') return p;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i].trim() !== '') return this.lines[i];
    }
    return '';
  }
  toLines() {
    const out = this.lines.slice();
    const p = collapseCR(sanitizePartial(this.partial));
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

// ---------- status board: localhost HTTP + server-sent events ----------

let httpPort = null;
const sseClients = new Set();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const httpServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  if (u.pathname === '/') {
    return fs.readFile(path.join(WEB_DIR, 'index.html'), (err, data) => {
      if (err) return json(res, 500, { error: 'board page missing' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }
  if (u.pathname === '/api/state') return json(res, 200, { sessions: lightList() });
  if (u.pathname === '/api/events') return serveEvents(req, res);
  const m = u.pathname.match(/^\/api\/session\/([\w-]+)$/);
  if (m) {
    const sess = sessions.get(m[1]);
    if (!sess) return json(res, 404, { error: 'no such session' });
    return json(res, 200, { ...lightSession(sess), lines: sess.buffer.toLines() });
  }
  return json(res, 404, { error: 'not found' });
});

function serveEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':ok\n\n');
  sseClients.add(res);
  sseSendTo(res, { type: 'sessions', sessions: lightList() });
  req.on('close', () => sseClients.delete(res));
}

function sseSendTo(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseBroadcast(obj) {
  if (!sseClients.size) return;
  const frame = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

let sessionsTimer = null;
function broadcastSessionsSoon() {
  if (sessionsTimer || !sseClients.size) return;
  sessionsTimer = setTimeout(() => {
    sessionsTimer = null;
    sseBroadcast({ type: 'sessions', sessions: lightList() });
  }, 100);
}

const outputTimers = new Map();
function outputChanged(id) {
  if (!sseClients.size || outputTimers.has(id)) return;
  outputTimers.set(id, setTimeout(() => {
    outputTimers.delete(id);
    const sess = sessions.get(id);
    if (sess) sseBroadcast({ type: 'output', id, lines: sess.buffer.toLines() });
  }, 150));
}

function startHttp() {
  let fellBack = false;
  httpServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && !fellBack) {
      fellBack = true;
      log(`port ${proto.DEFAULT_PORT} is taken, falling back to an ephemeral port`);
      httpServer.listen(0, '127.0.0.1');
    } else {
      log('http server error:', e.message);
      process.exit(1);
    }
  });
  httpServer.on('listening', () => {
    httpPort = httpServer.address().port;
    try {
      fs.writeFileSync(proto.daemonInfoPath(), JSON.stringify({ pid: process.pid, port: httpPort, startedAt: Date.now() }), { mode: 0o600 });
    } catch (e) { log('could not write daemon.json:', e.message); }
    log(`status board on http://127.0.0.1:${httpPort}/`);
  });
  httpServer.listen(proto.DEFAULT_PORT, '127.0.0.1');
}

// ---------- persistence: a daemon restart is not amnesia ----------

let saveTimer = null;

function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveStateNow, 1000);
  if (saveTimer.unref) saveTimer.unref();
}

function saveStateNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const data = {
    savedAt: Date.now(),
    sessions: [...sessions.values()].map((s) => ({ ...lightSession(s), lines: s.buffer.toLines() })),
  };
  try { fs.writeFileSync(proto.statePath(), JSON.stringify(data), { mode: 0o600 }); } catch { /* best effort */ }
}

function loadState() {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(proto.statePath(), 'utf8')); } catch { return; }
  const now = Date.now();
  for (const s of data.sessions || []) {
    if (!s || typeof s.id !== 'string') continue;
    const buffer = new RingBuffer();
    buffer.loadLines(s.lines);
    const sess = {
      id: s.id,
      name: String(s.name || 'session'),
      cwd: String(s.cwd || ''),
      command: String(s.command || ''),
      pid: s.pid,
      childPid: s.childPid,
      startedAt: s.startedAt,
      lastOutputAt: s.lastOutputAt,
      exited: !!s.exited,
      exitCode: typeof s.exitCode === 'number' ? s.exitCode : null,
      exitSignal: s.exitSignal || null,
      exitedAt: s.exitedAt || null,
      stale: false,
      pty: !!s.pty,
      buffer,
      sock: null,
    };
    if (!sess.exited) {
      if (pidAlive(sess.pid) || pidAlive(sess.childPid)) {
        // Its wrapper is alive and will reconnect within a few seconds.
        sess.stale = true;
      } else {
        sess.exited = true;
        sess.exitCode = null;
        sess.exitedAt = data.savedAt || now;
      }
    }
    if (sess.exited && now - (sess.exitedAt || 0) > proto.EXITED_TTL_MS) continue;
    sessions.set(sess.id, sess);
  }
  if (sessions.size) log(`restored ${sessions.size} session(s) from ${proto.statePath()}`);
}

// Stale sessions whose processes are gone become exited; old exited cards expire.
function cleanupSweep() {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) {
    if (!s.exited && s.stale && !pidAlive(s.pid) && !pidAlive(s.childPid)) {
      s.exited = true;
      s.exitCode = null;
      s.exitedAt = now;
      changed = true;
    }
    if (s.exited && now - (s.exitedAt || 0) > proto.EXITED_TTL_MS) {
      sessions.delete(id);
      changed = true;
    }
  }
  if (changed) notifyChange();
}

// ---------- change notification ----------

function notifyChange() {
  broadcastSessionsSoon();
  saveStateSoon();
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
          sess.stale = false; // output is proof of life
          outputChanged(sess.id);
          notifyChange();
        }
        break;
      }
      case 'exit':
        handleExit(msg);
        break;
      case 'ping':
        proto.send(sock, { type: 'pong', pid: process.pid, port: httpPort });
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
    if (!sessionId) return;
    // Only the session's CURRENT socket closing means the wrapper is gone;
    // a late close from a superseded connection must not mark it stale.
    const sess = sessions.get(sessionId);
    if (sess && sess.sock !== sock) return;
    markDisconnected(sessionId);
  });
});

let boundSocket = false; // never unlink a socket path this process does not own

function shutdown(code) {
  saveStateNow();
  try { server.close(); } catch { /* already closed */ }
  try { httpServer.close(); } catch { /* already closed */ }
  for (const res of sseClients) { try { res.end(); } catch { /* fine */ } }
  if (boundSocket) {
    try { fs.unlinkSync(proto.daemonInfoPath()); } catch { /* fine */ }
  }
  removeSocketFile();
  process.exit(code);
}

function removeSocketFile() {
  if (boundSocket && process.platform !== 'win32') {
    try { fs.unlinkSync(proto.socketPath()); } catch { /* fine */ }
  }
}

// Claim the socket bind-first: EADDRINUSE means a live daemon (bow out) or a
// stale file from a crash. Stale recovery (unlink + rebind) is serialized
// through an O_EXCL lock file so two racing daemons cannot unlink each other's
// freshly bound socket.
function claimSocketAndListen(onReady) {
  const sp = proto.socketPath();
  const lockPath = path.join(proto.TOWER_DIR, 'towerd.lock');
  let recovered = false;

  function bowOut() {
    log('another towerd is already running; exiting');
    process.exit(0);
  }

  function recoverStaleSocket() {
    if (recovered) {
      log(`cannot claim ${sp}`);
      process.exit(1);
    }
    recovered = true;
    let locked = false;
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      locked = true;
    } catch {
      let owner = NaN;
      try { owner = parseInt(fs.readFileSync(lockPath, 'utf8'), 10); } catch { /* fine */ }
      if (owner && pidAlive(owner)) bowOut(); // someone else is mid-recovery
      // stale lock from a crashed recovery; steal it once
      try { fs.unlinkSync(lockPath); } catch { /* fine */ }
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        locked = true;
      } catch { bowOut(); }
    }
    if (!locked) bowOut();
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(sp); } catch { /* fine */ }
    }
    server.listen(sp);
  }

  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') {
      log('socket server error:', e.message);
      process.exit(1);
    }
    // Someone holds the path. A live daemon answers a probe; silence means a
    // stale file left by a crash.
    const probe = net.createConnection(sp);
    probe.on('connect', () => { probe.end(); bowOut(); });
    probe.on('error', recoverStaleSocket);
  });

  server.on('listening', () => {
    boundSocket = true;
    try { fs.unlinkSync(lockPath); } catch { /* fine (only ours if we recovered) */ }
    if (process.platform !== 'win32') {
      try { fs.chmodSync(sp, 0o600); } catch { /* best effort */ }
    }
    log(`towerd listening on ${sp}`);
    onReady();
  });

  server.listen(sp);
}

function start() {
  proto.ensureTowerDir();
  if (process.platform !== 'win32') {
    // files created by older versions may predate the 0600 modes
    for (const f of [proto.statePath(), proto.daemonInfoPath(), proto.daemonLogPath()]) {
      try { fs.chmodSync(f, 0o600); } catch { /* fine */ }
    }
  }
  loadState();
  claimSocketAndListen(() => {
    startHttp();
    // Statuses drift with time (running -> idle -> waiting); keep watchers current.
    setInterval(() => {
      if (sseClients.size) sseBroadcast({ type: 'sessions', sessions: lightList() });
    }, 1000);
    setInterval(cleanupSweep, 30000);
  });
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('exit', removeSocketFile);
}

if (require.main === module) start();

module.exports = { start, sessions, RingBuffer };
